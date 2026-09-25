/**
 * The board's post markup: a small BBCode subset, rendered server-side.
 *
 *   [b] [i] [u] [s]          bold, italic, underline, strike
 *   [quote] [quote=name]     a quote, optionally attributed; `post=123` links the source
 *   [code]                   preformatted; nothing inside is parsed
 *   [url] [url=https://…]    links (http and https only); bare URLs are linked too
 *
 * Safety comes from the shape of the renderer, not from a sanitizer pass:
 * every piece of user text goes through escapeHtml, and the only markup in
 * the output is what this file writes. Anything that doesn't parse as a known,
 * well-formed tag is shown literally.
 */

export const MARKUP_VERSION = 1;

export interface RenderOptions {
  /** URL of a post permalink, used to link attributed quotes to their source. */
  postUrl: (postId: number) => string;
}

type Tag = "b" | "i" | "u" | "s" | "quote" | "code" | "url";

interface TextNode {
  kind: "text";
  text: string;
}

interface ElementNode {
  kind: "element";
  tag: Tag;
  attr: string | null;
  /** The opening tag as written, shown literally if the element never closes. */
  raw: string;
  children: Node[];
}

type Node = TextNode | ElementNode;

const TAG_RE = /\[(\/?)(b|i|u|s|quote|code|url)(?:=([^\]\n]*))?\]/gi;
const BLOCK_TAGS: ReadonlySet<Tag> = new Set(["quote", "code"]);
const MAX_DEPTH = 24;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** Whether an opening tag's attribute is acceptable for that tag. */
function attrIsValid(tag: Tag, attr: string | null): boolean {
  switch (tag) {
    case "url":
      return attr === null || isHttpUrl(attr.trim());
    case "quote":
      return true;
    default:
      return attr === null;
  }
}

function parse(src: string): Node[] {
  const root: ElementNode = { kind: "element", tag: "b", attr: null, raw: "", children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const pushText = (text: string) => {
    if (text === "") return;
    const children = top().children;
    const last = children[children.length - 1];
    if (last?.kind === "text") last.text += text;
    else children.push({ kind: "text", text });
  };
  // An element that never closed is shown as it was typed: its opening tag
  // as text, then its children, all moved up into its parent.
  const flatten = (el: ElementNode) => {
    pushText(el.raw);
    for (const child of el.children) {
      if (child.kind === "text") pushText(child.text);
      else top().children.push(child);
    }
  };

  let pos = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [raw, slash, name, attr] = m;
    const tag = name!.toLowerCase() as Tag;
    pushText(src.slice(pos, m.index));
    pos = m.index + raw.length;

    if (slash) {
      const idx = stack.findLastIndex((el, i) => i > 0 && el.tag === tag);
      if (idx === -1) {
        pushText(raw);
        continue;
      }
      while (stack.length - 1 > idx) flatten(stack.pop()!);
      const el = stack.pop()!;
      top().children.push(el);
      continue;
    }

    const attrValue = attr === undefined ? null : attr;
    if (!attrIsValid(tag, attrValue) || stack.length > MAX_DEPTH) {
      pushText(raw);
      continue;
    }

    if (tag === "code") {
      // Code is verbatim: find its closing tag directly and skip parsing.
      const rest = src.slice(pos);
      const close = /\[\/code\]/i.exec(rest);
      if (!close) {
        pushText(raw);
        continue;
      }
      top().children.push({
        kind: "element",
        tag,
        attr: attrValue,
        raw,
        children: [{ kind: "text", text: rest.slice(0, close.index) }],
      });
      pos += close.index + close[0].length;
      TAG_RE.lastIndex = pos;
      continue;
    }

    stack.push({ kind: "element", tag, attr: attrValue, raw, children: [] });
  }
  pushText(src.slice(pos));
  while (stack.length > 1) flatten(stack.pop()!);
  return root.children;
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'\[\]]+/gi;

/**
 * Sentence punctuation after a URL is almost never part of it, and neither is
 * a closing paren unless the URL opened one (Wikipedia's Foo_(bar) style).
 */
function trimTrailingPunctuation(url: string): string {
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last !== undefined && ".,;:!?".includes(last)) out = out.slice(0, -1);
    else if (last === ")" && count(out, ")") > count(out, "(")) out = out.slice(0, -1);
    else return out;
  }
}

/** Escapes text, turning newlines into <br> and, optionally, bare URLs into links. */
function renderText(text: string, autolink: boolean): string {
  const lines = (s: string) => escapeHtml(s).replace(/\n/g, "<br>\n");
  if (!autolink) return lines(text);

  let out = "";
  let pos = 0;
  URL_IN_TEXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_IN_TEXT_RE.exec(text)) !== null) {
    const url = trimTrailingPunctuation(m[0]);
    if (!isHttpUrl(url)) continue;
    out += lines(text.slice(pos, m.index));
    out += link(url, escapeHtml(url));
    pos = m.index + url.length;
    URL_IN_TEXT_RE.lastIndex = pos;
  }
  return out + lines(text.slice(pos));
}

function link(href: string, innerHtml: string): string {
  return `<a href="${escapeHtml(href)}" rel="nofollow ugc noopener">${innerHtml}</a>`;
}

interface QuoteAttr {
  name: string | null;
  postId: number | null;
}

export function parseQuoteAttr(attr: string | null): QuoteAttr {
  if (attr === null) return { name: null, postId: null };
  const m = /^\s*(?:"([^"]*)"|(.*?))(?:\s+post=(\d+))?\s*$/.exec(attr);
  const name = (m?.[1] ?? m?.[2] ?? "").trim();
  const postId = m?.[3] ? Number(m[3]) : null;
  return { name: name === "" ? null : name, postId };
}

/** Trims the one newline people naturally type after an opening block tag. */
function trimBlockEdges(children: Node[]): Node[] {
  if (children.length === 0) return children;
  const out = children.slice();
  const first = out[0]!;
  if (first.kind === "text") out[0] = { kind: "text", text: first.text.replace(/^\n/, "") };
  const lastIdx = out.length - 1;
  const last = out[lastIdx]!;
  if (last.kind === "text") out[lastIdx] = { kind: "text", text: last.text.replace(/\n$/, "") };
  return out;
}

function renderNodes(nodes: Node[], opts: RenderOptions, inLink: boolean): string {
  let out = "";
  let afterBlock = false;
  for (const node of nodes) {
    if (node.kind === "text") {
      // Likewise the newline after a closing block tag.
      const text = afterBlock ? node.text.replace(/^\n/, "") : node.text;
      out += renderText(text, !inLink);
      afterBlock = false;
    } else {
      out += renderElement(node, opts, inLink);
      afterBlock = BLOCK_TAGS.has(node.tag);
    }
  }
  return out;
}

function renderElement(el: ElementNode, opts: RenderOptions, inLink: boolean): string {
  const inner = () => renderNodes(el.children, opts, inLink);
  switch (el.tag) {
    case "b":
      return `<strong>${inner()}</strong>`;
    case "i":
      return `<em>${inner()}</em>`;
    case "u":
      return `<u>${inner()}</u>`;
    case "s":
      return `<s>${inner()}</s>`;
    case "code": {
      const text = el.children[0]?.kind === "text" ? el.children[0].text : "";
      return `<pre><code>${escapeHtml(text.replace(/^\n/, "").replace(/\n$/, ""))}</code></pre>`;
    }
    case "url": {
      if (inLink) return renderNodes(el.children, opts, true);
      if (el.attr !== null) {
        return link(el.attr.trim(), renderNodes(el.children, opts, true));
      }
      const only = el.children.length === 1 ? el.children[0] : undefined;
      if (only?.kind === "text" && isHttpUrl(only.text.trim())) {
        return link(only.text.trim(), escapeHtml(only.text.trim()));
      }
      return escapeHtml(el.raw) + inner() + "[/url]";
    }
    case "quote": {
      const { name, postId } = parseQuoteAttr(el.attr);
      let cite = "";
      if (name !== null) {
        const who = `${escapeHtml(name)} wrote:`;
        cite = postId !== null
          ? `<cite><a href="${escapeHtml(opts.postUrl(postId))}">${who}</a></cite>`
          : `<cite>${who}</cite>`;
      }
      const body = renderNodes(trimBlockEdges(el.children), opts, inLink);
      return `<blockquote>${cite}${body}</blockquote>`;
    }
  }
}

export function renderBBCode(src: string, opts: RenderOptions): string {
  const normalized = src.replace(/\r\n?/g, "\n").trim();
  return renderNodes(parse(normalized), opts, false);
}

/**
 * The text the Quote button pre-fills: the source post with its own quotes
 * removed, so replies don't nest ever-deeper towers of quotes.
 */
export function quoteFor(username: string, postId: number, body: string): string {
  let stripped = body.replace(/\r\n?/g, "\n");
  const innermost = /\[quote(?:=[^\]\n]*)?\](?:(?!\[quote)[\s\S])*?\[\/quote\]\n?/gi;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(innermost, "");
  } while (stripped !== prev);
  return `[quote="${username}" post=${postId}]\n${stripped.trim()}\n[/quote]\n`;
}
