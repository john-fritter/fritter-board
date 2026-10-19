import type { Hono } from "hono";
import type { AppContext, AppEnv, Services } from "../app.js";
import { exportBot, type BotExportOptions } from "../botadmin/export.js";
import { archiveMarkdown, botMarkdown, estimateTokens, threadMarkdown } from "../export/markdown.js";
import { invalid } from "../forum/errors.js";
import { exportArchive, exportThread } from "../forum/export.js";
import { localDay, startOfLocalDay } from "../lib/time.js";
import { ExportPage, type ExportField, type ExportValues } from "../views/export.js";
import { formError, parseId, render } from "./util.js";

// /admin/export: the admin's Markdown downloads, a thread, the archive and a
// bot's file, each with a page first that shows its size in tokens. The
// /admin guard in routes/admin.tsx hides them from everyone else, and the
// functions that gather the data check again (src/forum/export.ts,
// src/botadmin/export.ts). Downloads are GETs: they change nothing.

const DEFAULTS: ExportValues = { since: "", backRoom: true, pms: false, transcripts: false };

/** The form's fields; until it has been submitted (no `o`), the defaults. */
function readValues(c: AppContext): ExportValues {
  const q = (k: string) => c.req.query(k) ?? "";
  const since = q("since").trim();
  if (q("o") !== "1") return { ...DEFAULTS, since };
  return { since, backRoom: q("backroom") === "1", pms: q("pms") === "1", transcripts: q("transcripts") === "1" };
}

function toOptions(v: ExportValues): BotExportOptions {
  let since: Date | null = null;
  if (v.since) {
    since = startOfLocalDay(v.since);
    if (!since) throw invalid(`"${v.since}" isn't a date: pick one, or leave "since" empty for everything.`);
  }
  return { since, backRoom: v.backRoom, pms: v.pms, transcripts: v.transcripts };
}

/** A name for the file: letters, digits and dashes only. */
export function fileSlug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, max)
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

const sinceSuffix = (v: ExportValues) => (v.since ? `-since-${v.since}` : "");
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

interface Built {
  markdown: string;
  filename: string;
  counts: string[];
  /** For the page: its title, crumbs and the sentence on what the file is. */
  title: string;
  trail: { label: string; href?: string }[];
  about: string;
}

interface ExportRoute {
  path: string;
  fields: ExportField[];
  build: (c: AppContext, opts: BotExportOptions, values: ExportValues) => Promise<Built>;
}

export function registerExportRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum } = s;

  function route(r: ExportRoute): void {
    // The page: the options, and the estimate for them.
    app.get(r.path, async (c) => {
      const values = readValues(c);
      const pathNow = c.req.path.slice(s.env.basePath.length);
      let built: Built;
      try {
        built = await r.build(c, toOptions(values), values);
      } catch (err) {
        const { message, status } = formError(err);
        // Built again without the bad date, for the page's title and crumbs.
        const fallback = await r.build(c, toOptions({ ...values, since: "" }), values);
        return render(
          c,
          <ExportPage
            ctx={c.get("page")}
            title={fallback.title}
            trail={fallback.trail}
            about={fallback.about}
            action={pathNow}
            download={`${pathNow}/download`}
            fields={r.fields}
            values={values}
            estimate={null}
            error={message}
          />,
          status
        );
      }
      return render(
        c,
        <ExportPage
          ctx={c.get("page")}
          title={built.title}
          trail={built.trail}
          about={built.about}
          action={pathNow}
          download={`${pathNow}/download`}
          fields={r.fields}
          values={values}
          estimate={{ chars: built.markdown.length, tokens: estimateTokens(built.markdown), counts: built.counts }}
        />
      );
    });

    // The file itself.
    app.get(`${r.path}/download`, async (c) => {
      const values = readValues(c);
      const built = await r.build(c, toOptions(values), values);
      return c.body(built.markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${built.filename}"`,
        "Cache-Control": "no-store",
      });
    });
  }

  const today = () => localDay(new Date());

  route({
    path: "/admin/export/thread/:id",
    fields: [],
    build: async (c, opts, values) => {
      const x = await exportThread(forum, c.get("viewer"), parseId(c.req.param("id")), opts);
      const t = x.thread;
      return {
        markdown: threadMarkdown(x),
        filename: `fritter-board-thread-${t.id}-${fileSlug(t.title)}${sinceSuffix(values)}.md`,
        counts: [count(t.posts.length, "post"), count(x.modActions.length, "mod action")],
        title: `Download “${t.title}”`,
        trail: [{ label: t.boardName, href: `/b/${t.boardSlug}` }, { label: t.title, href: `/t/${t.id}` }, { label: "Download" }],
        about: "The thread as one Markdown file, every post in order with who wrote it and when, removed posts included, and the thread's moderation. Made to be read by a person, or handed to an AI model to analyze.",
      };
    },
  });

  route({
    path: "/admin/export/archive",
    fields: ["backRoom", "pms"],
    build: async (c, opts, values) => {
      const x = await exportArchive(forum, c.get("viewer"), opts);
      const posts = x.threads.reduce((n, t) => n + t.posts.length, 0);
      const counts = [count(x.threads.length, "thread"), count(posts, "post"), count(x.members.length, "member")];
      if (x.conversations) {
        counts.push(count(x.conversations.length, "conversation"), count(x.conversations.reduce((n, cv) => n + cv.messages.length, 0), "message"));
      }
      counts.push(count(x.modActions.length, "mod action"));
      return {
        markdown: archiveMarkdown(x),
        filename: `fritter-board-archive-${today()}${sinceSuffix(values)}.md`,
        counts,
        title: "Download the archive",
        trail: [{ label: "Admin", href: "/admin" }, { label: "Download the archive" }],
        about: "The whole board as one Markdown file: boards and members, every thread with its posts, the moderation log and reports, and private messages if you include them. Made to be read by a person, or handed to an AI model to analyze forum behavior.",
      };
    },
  });

  route({
    path: "/admin/export/bot/:name",
    fields: ["backRoom", "transcripts"],
    build: async (c, opts, values) => {
      const x = await exportBot(forum, c.get("viewer"), c.req.param("name") ?? "", opts);
      const name = x.bot.username;
      const counts = [
        count(x.member.posts.length, "post"),
        count(x.member.conversations.length, "PM conversation"),
        count(x.notes.length, "note"),
        count(x.runs.length, "run"),
        count(x.searches.length, "web search", "web searches"),
      ];
      if (opts.transcripts) counts.push(count(x.runs.filter((r) => r.transcript?.length).length, "transcript"));
      return {
        markdown: botMarkdown(x),
        filename: `fritter-board-bot-${fileSlug(name)}-${today()}${sinceSuffix(values)}.md`,
        counts,
        title: `Download ${name}'s file`,
        trail: [
          { label: "Admin", href: "/admin" },
          { label: "Bots", href: "/admin/bots" },
          { label: name, href: `/admin/bots/${encodeURIComponent(name)}` },
          { label: "Download" },
        ],
        about: `Everything about ${name} as one Markdown file: its settings and persona, its memory (standing notes and every note), its posts, its private messages, its moderation and web searches, and what it did on each visit. Made to be read by a person, or handed to an AI model to analyze how the bot behaves.`,
      };
    },
  });
}
