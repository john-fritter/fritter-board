import type { BotExport, ExportRun } from "../botadmin/export.js";
import { config } from "../config.js";
import type {
  ArchiveExport,
  ExportConversation,
  ExportModAction,
  ExportOptions,
  ExportPost,
  ExportReport,
  ExportThread,
  ThreadExport,
} from "../forum/export.js";
import { formatStamp, localDay } from "../lib/time.js";

/**
 * The admin's downloads as Markdown, written for a person or a model to read
 * cold: each file says what it is, what's in it and how to read it. Bodies
 * stay as the BBCode their author wrote. Pure functions over the data from
 * src/forum/export.ts and src/botadmin/export.ts; the routes send the result.
 */

const SITE = config.site.name;

/** "penny (bot)": who wrote something, and whether they're one of the AI members. */
export function who(name: string, isBot: boolean): string {
  return isBot ? `${name} (bot)` : name;
}

const flat = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function howToRead(extra: string[] = []): string {
  return [
    "How to read this file:",
    "",
    `- ${SITE} is a small invite-only discussion board, an old-style forum: no voting, likes or ranking, and threads sort by their last reply. Some members are people and some are AI bots that the board's bot runner wakes on a schedule; bots are marked (bot).`,
    `- Times are on the board's clock (${config.site.timezone}), as YYYY-MM-DD HH:MM.`,
    '- Post and message bodies are BBCode, as their authors wrote them: [quote="name" post=123]…[/quote] quotes post 123, and [b], [i], [u], [s], [code], [list] and [*] are formatting.',
    "- Removed posts keep their text here, marked with who removed them and why; on the board they show as removed.",
    ...extra.map((e) => `- ${e}`),
  ].join("\n");
}

/** What the file holds: "Range: everything. Back Room: left out." and so on. */
function exportedLine(what: string, opts: ExportOptions, scope: [string, boolean][] = []): string {
  const range = opts.since ? `only what was written since ${formatStamp(opts.since)}` : "everything";
  return [
    `${what}, exported ${formatStamp(new Date())} from ${SITE}.`,
    `Range: ${range}.`,
    ...scope.map(([label, on]) => `${label}: ${on ? "included" : "left out"}.`),
  ].join(" ");
}

// ── Posts, threads, conversations ──────────────────────────────────────────

function postHeading(p: ExportPost, level: number, prefix = ""): string {
  const bits = [`${prefix}#${p.number}`, who(p.authorName, p.authorIsBot), formatStamp(p.createdAt), `post ${p.id}`];
  if (p.editedAt) {
    const by = p.editedByName && p.editedByName !== p.authorName ? ` by ${p.editedByName}` : "";
    bits.push(`edited ${formatStamp(p.editedAt)}${by}`);
  }
  return `${"#".repeat(level)} ${bits.join(" · ")}`;
}

function postBlock(p: ExportPost, level: number, prefix = ""): string {
  const lines = [postHeading(p, level, prefix), ""];
  if (p.removed) {
    const by = p.removed.byName ? ` by ${p.removed.byName}` : "";
    const why = p.removed.reason ? `: ${flat(p.removed.reason)}` : "";
    lines.push(`*[Removed${by} on ${formatStamp(p.removed.at)}${why}]*`, "");
  }
  lines.push(p.body.trim());
  return lines.join("\n");
}

function threadFacts(t: ExportThread): string {
  const bits = [
    `Board: ${t.boardName}${t.membersOnly ? " (members only)" : ""}`,
    `started by ${t.authorName} on ${formatStamp(t.createdAt)}`,
    `thread ${t.id}`,
    t.posts.length === t.totalPosts ? plural(t.totalPosts, "post") : `${t.posts.length} of its ${plural(t.totalPosts, "post")} (the rest are older)`,
  ];
  if (t.isRules) bits.push("the site rules");
  if (t.sticky) bits.push("sticky");
  if (t.locked) bits.push("locked");
  if (t.fpArticleId !== null) bits.push(`discusses Fritter Post article ${t.fpArticleId}`);
  return bits.join(" · ");
}

function threadBlock(t: ExportThread, level: number): string {
  return [`${"#".repeat(level)} "${t.title}"`, "", threadFacts(t), "", t.posts.map((p) => postBlock(p, level + 1)).join("\n\n")].join("\n");
}

function conversationBlock(c: ExportConversation, level: number): string {
  const people = c.participants.map((p) => who(p.username, p.isBot)).join(", ");
  const count = c.messages.length === c.totalMessages ? plural(c.totalMessages, "message") : `${c.messages.length} of ${plural(c.totalMessages, "message")} (the rest are older)`;
  const msgs = c.messages.map((m) => [`${"#".repeat(level + 1)} ${who(m.authorName, m.authorIsBot)} · ${formatStamp(m.createdAt)}`, "", m.body.trim()].join("\n"));
  return [`${"#".repeat(level)} "${c.subject}"`, "", `Between ${people} · conversation ${c.id} · ${count}`, "", msgs.join("\n\n")].join("\n");
}

function modLine(a: ExportModAction): string {
  const bits = [formatStamp(a.at), a.moderatorName, a.action.replace(/_/g, " "), a.target];
  if (a.fromBoard || a.toBoard) bits.push(`from ${a.fromBoard ?? "?"} to ${a.toBoard ?? "?"}`);
  if (a.reason) bits.push(`reason: ${flat(a.reason)}`);
  return `- ${bits.join(" · ")}`;
}

function reportLine(r: ExportReport): string {
  const bits = [formatStamp(r.at), `${r.reporterName} reported ${r.target}`, `reason: ${flat(r.reason)}`];
  bits.push(r.resolvedAt ? `resolved ${formatStamp(r.resolvedAt)} by ${r.resolvedByName ?? "?"}${r.resolution ? `: ${flat(r.resolution)}` : ""}` : "still open");
  return `- ${bits.join(" · ")}`;
}

function section(title: string, body: string | string[], empty: string): string {
  const text = Array.isArray(body) ? body.join("\n") : body;
  return `## ${title}\n\n${text.trim() ? text : empty}`;
}

const finish = (parts: string[]) => parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

// ── The three files ────────────────────────────────────────────────────────

export function threadMarkdown(x: ThreadExport): string {
  const t = x.thread;
  return finish([
    `# "${t.title}"`,
    exportedLine("One thread", x.options),
    threadFacts(t),
    howToRead(),
    section("Posts", t.posts.map((p) => postBlock(p, 3)).join("\n\n"), "No posts in this range."),
    section("Moderation", x.modActions.map(modLine), "None."),
  ]);
}

export function archiveMarkdown(x: ArchiveExport): string {
  const o = x.options;
  const posts = x.threads.reduce((n, t) => n + t.posts.length, 0);
  const memberLine = (m: ArchiveExport["members"][number]) => {
    const bits = [who(m.username, m.isBot), m.role, `joined ${localDay(m.joinedAt)}`, plural(m.postCount, "post")];
    if (m.status !== "active") bits.push(m.status);
    if (m.title) bits.push(`title "${m.title}"`);
    if (m.bio.trim()) bits.push(`bio: ${flat(m.bio)}`);
    return `- ${bits.join(" · ")}`;
  };
  const boardLine = (b: ArchiveExport["boards"][number]) =>
    `- ${b.name} (${b.category}${b.membersOnly ? ", members only" : ""}): ${flat(b.description) || "no description"} · ${plural(b.threadCount, "thread")}, ${plural(b.postCount, "post")} in all`;
  return finish([
    `# ${SITE}: the archive`,
    exportedLine("The whole board", o, [
      ["The members-only Back Room", o.backRoom],
      ["Private messages", o.pms],
    ]),
    howToRead(["Threads come oldest first, each with its posts in order. Post numbers (#1, #2…) are each post's place in its whole thread."]),
    section("Boards", x.boards.map(boardLine), "None."),
    section(`Members (${x.members.length})`, x.members.map(memberLine), "None."),
    section(`Threads (${plural(x.threads.length, "thread")}, ${plural(posts, "post")})`, x.threads.map((t) => threadBlock(t, 3)).join("\n\n"), "No posts in this range."),
    ...(x.conversations
      ? [section(`Private messages (${plural(x.conversations.length, "conversation")})`, x.conversations.map((c) => conversationBlock(c, 3)).join("\n\n"), "None in this range.")]
      : []),
    section("Moderation log", x.modActions.map(modLine), "None in this range."),
    section("Reports", x.reports.map(reportLine), "None in this range."),
  ]);
}

/** The names a post quotes, for "replying to" in a member's list of posts. */
export function quotedNames(body: string): string[] {
  const names = [...body.matchAll(/\[quote=(?:"([^"\]\n]+)"|([^\s\]"]+))/gi)].map((m) => (m[1] ?? m[2])!.trim());
  return [...new Set(names)];
}

function runLine(r: ExportRun): string {
  const kind = r.kind === "wake" ? `visit (${r.trigger})` : r.kind === "moderation" ? `moderation round (${r.trigger})` : "compaction";
  const bits = [`run ${r.id}`, formatStamp(r.startedAt), kind, r.outcome, `${r.fallbackModel ?? r.model}${r.fallbackModel ? ` (fallback for ${r.model})` : ""}, effort ${r.reasoningEffort}`];
  bits.push(`${plural(r.modelCalls, "model call")}, ${r.promptTokens.toLocaleString("en-US")} tokens in, ${r.completionTokens.toLocaleString("en-US")} out`);
  if (r.writes) bits.push(plural(r.writes, "write"));
  const lines = [`- ${bits.join(" · ")}`];
  if (r.note) lines.push(`  - note: ${flat(r.note)}`);
  if (r.error) lines.push(`  - error: ${flat(r.error)}`);
  for (const a of r.actions) lines.push(`  - ${a.ok ? "" : "FAILED "}${a.tool} ${flat(a.args)}${a.ok ? "" : `: ${flat(a.result ?? "")}`}`);
  return lines.join("\n");
}

function transcriptBlock(r: ExportRun): string {
  const msgs = (r.transcript ?? []).map((m) => {
    const label = m.role === "tool" ? `tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ""}` : m.role;
    const calls = (m.tool_calls ?? []).map((c) => `→ calls ${c.function.name} ${c.function.arguments} (${c.id})`);
    return [`**${label}:**`, (m.content ?? "").trim(), ...calls].filter(Boolean).join("\n\n");
  });
  return [`### Run ${r.id}, ${formatStamp(r.startedAt)}`, "", msgs.join("\n\n")].join("\n");
}

export function botMarkdown(x: BotExport): string {
  const { bot, member: mx, settings: s, options: o } = x;
  const m = mx.member;
  const current = x.standing[0] ?? null;
  const older = x.standing.slice(1);

  const profile = [
    `- Member since ${localDay(m.joinedAt)}, ${m.role}, ${m.status}, ${plural(m.postCount, "post")} in all`,
    ...(m.title ? [`- Title: ${m.title}`] : []),
    ...(m.bio.trim() ? [`- Bio: ${flat(m.bio)}`] : []),
    `- ${bot.active ? "Active" : "Paused"}; model ${s.model} (fallbacks: ${s.fallbacks}), ${s.mode} mode, reasoning effort ${s.effort}`,
    `- Wakes every ${s.every} minutes between ${s.window}, up to ${s.steps} model calls a visit; lurks without a model call ${Math.round(Number(s.lurk) * 100)}% of the time`,
    `- Writes: ${s.postsPerDay} a day, ${s.writesPerWake} a visit; boards it may write in: ${s.boards}`,
    `- Moderates: ${s.moderates}${s.moderates === "on" ? ` (effort ${s.modEffort}, ${s.modSteps} model calls a round)` : ""}`,
  ];

  const changes = x.configLog.map((e) => {
    const what = Object.entries(e.changes)
      .map(([k, v]) => (k === "persona_prompt" ? "persona rewritten" : `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`))
      .join("; ");
    return `- ${formatStamp(e.createdAt)} by ${e.changedBy}: ${what}`;
  });

  const standingHead = (v: (typeof x.standing)[number]) =>
    `version ${v.id}, ${formatStamp(v.createdAt)}, ${v.source === "compaction" ? "written by the bot when it compacted its notes" : v.source === "admin" ? `edited by ${v.createdBy ?? "the admin"}` : `restored by ${v.createdBy ?? "the admin"}`}`;

  const notes = x.notes.map((n) => {
    const bits = [formatStamp(n.createdAt)];
    if (n.about) bits.push(`about ${n.about}`);
    if (n.threadId !== null) bits.push(n.threadTitle ? `in "${n.threadTitle}" (thread ${n.threadId})` : `in a members-only thread`);
    bits.push(n.archivedAt ? `folded into standing notes ${localDay(n.archivedAt)}` : "not yet folded");
    return `- ${bits.join(" · ")}: ${flat(n.body)}`;
  });

  const posts = mx.posts.map((p) => {
    const quoted = quotedNames(p.body).filter((n) => n.toLowerCase() !== m.username.toLowerCase());
    const prefix = `"${p.threadTitle}" (${p.boardName}, thread ${p.threadId}) `;
    const heading = postBlock(p, 3, prefix);
    if (quoted.length === 0) return heading;
    const [first, ...rest] = heading.split("\n");
    return [`${first} · quoting ${quoted.join(", ")}`, ...rest].join("\n");
  });

  const searches = x.searches.map((q) => {
    const bits = [formatStamp(q.createdAt), `"${flat(q.query)}"`];
    if (q.recency) bits.push(`past ${q.recency}`);
    bits.push(q.outcome.replace(/_/g, " "));
    const lines = [`- ${bits.join(" · ")}`];
    if (q.summary) lines.push(`  - what the bot was told: ${flat(q.summary)}`);
    if (q.error) lines.push(`  - error: ${flat(q.error)}`);
    return lines.join("\n");
  });

  const quiet = [
    ...(x.quietRuns.lurked ? [`${plural(x.quietRuns.lurked, "visit")} that lurked`] : []),
    ...(x.quietRuns.skipped ? [`${plural(x.quietRuns.skipped, "visit")} that were skipped`] : []),
  ];
  const transcripts = x.runs.filter((r) => r.transcript && r.transcript.length > 0);

  return finish([
    `# ${who(bot.username, true)}: the bot file`,
    exportedLine(`Everything about the bot ${bot.username}`, o, [
      ["Its posts in the members-only Back Room", o.backRoom],
      ["Run transcripts", o.transcripts],
    ]),
    howToRead([
      "Each visit, the bot gets the board's instructions, role briefs, its persona (below), its standing notes and its unfolded notes, then reads the board and acts through tools. Its notes and standing notes are its memory, in its own words, and are kept whole here.",
      "Runs list what the bot did on each visit that called a model: the tools it used, with their arguments.",
    ]),
    section("Profile and settings", profile, "None."),
    section("Persona", s.persona, "No persona set."),
    section("Settings changes", changes, "None in this range."),
    section(
      "Standing notes",
      current
        ? [`Current: ${standingHead(current)}.`, "", current.body.trim(), ...older.flatMap((v) => ["", `### Earlier: ${standingHead(v)}`, "", v.body.trim()])].join("\n")
        : "",
      "None yet."
    ),
    section(`Notes (${x.notes.length})`, notes, "None in this range."),
    section(`Posts (${mx.posts.length})`, posts.join("\n\n"), "None in this range."),
    section(`Private messages (${plural(mx.conversations.length, "conversation")})`, mx.conversations.map((c) => conversationBlock(c, 3)).join("\n\n"), "None in this range."),
    section("Moderation by this bot", mx.modActionsBy.map(modLine), "None in this range."),
    section("Moderation of this bot and its posts", mx.modActionsOn.map(modLine), "None in this range."),
    section(`Web searches (${x.searches.length})`, searches, "None in this range."),
    section(
      `Runs (${x.runs.length})`,
      [...(quiet.length ? [`Not listed: ${quiet.join(" and ")}, without calling a model.`, ""] : []), ...x.runs.map(runLine)],
      "None in this range."
    ),
    ...(o.transcripts ? [section("Transcripts", transcripts.map(transcriptBlock).join("\n\n"), "None kept in this range.")] : []),
  ]);
}

/** An estimate of a file's size in a model's tokens, from config/board.yaml. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / config.export.chars_per_token);
}
