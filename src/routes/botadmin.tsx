import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import {
  archiveNote,
  controlBot,
  CONTROLS,
  getBot,
  getRun,
  listBots,
  listChanges,
  listNotes,
  listRuns,
  listStanding,
  noteFilter,
  restoreStanding,
  saveStanding,
  undoChange,
  updateSettings,
  type BotAdminCtx,
  type Control,
} from "../botadmin/bots.js";
import { invalid } from "../forum/errors.js";
import type { SettingsInput } from "../runner/settings.js";
import { BotPage, BotsPage, ChangesPage, NotesPage, RunPage, RunsPage, StandingPage, type BotPageProps } from "../views/botadmin.js";
import type { AppContext } from "../app.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { formError, parseId, readForm, render } from "./util.js";

// /admin/bots: the admin's pages for bots (src/botadmin/). The /admin guard in
// routes/admin.tsx already hides them from everyone else, and every function
// they call checks again.

const SAVED: Record<string, string> = {
  settings: "Settings saved.",
  unchanged: "Nothing had changed.",
  standing: "Standing notes saved as a new version.",
  pause: "Paused: it won't be woken until resumed.",
  resume: "Resumed: its first wake comes within its interval.",
  wake: "It wakes at the runner's next tick.",
  compact: "Its notes are folded into its standing notes at the runner's next tick.",
};

const SETTINGS_FIELDS: (keyof SettingsInput)[] = [
  "model",
  "mode",
  "effort",
  "persona",
  "every",
  "window",
  "steps",
  "postsPerDay",
  "writesPerWake",
  "lurk",
  "boards",
  "keyEnv",
  "tokenEnv",
];

export function registerBotAdminRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;
  const ctx: BotAdminCtx = { pool: forum.pool };
  const botUrl = (name: string, rest = "") => url(`/admin/bots/${encodeURIComponent(name)}${rest}`);

  /** A bot's page, with whatever went wrong on one of its forms. */
  async function botPage(c: AppContext, name: string, extra: Partial<BotPageProps> = {}, status: ContentfulStatusCode = 200) {
    const data = await getBot(ctx, c.get("viewer"), name);
    const saved = c.req.query("saved");
    return render(
      c,
      <BotPage
        ctx={c.get("page")}
        row={data.row}
        standing={data.standing}
        runs={data.runs}
        notes={data.notes}
        log={data.log}
        settings={data.settings}
        saved={saved ? (SAVED[saved] ?? null) : null}
        {...extra}
      />,
      status
    );
  }

  app.get("/admin/bots", async (c) => {
    const { bots, unconfigured } = await listBots(ctx, c.get("viewer"));
    return render(c, <BotsPage ctx={c.get("page")} bots={bots} unconfigured={unconfigured} />);
  });

  app.get("/admin/bots/:name", (c) => botPage(c, c.req.param("name")));

  app.post("/admin/bots/:name/settings", async (c) => {
    const name = c.req.param("name");
    const f = await readForm(c);
    const input: SettingsInput = {};
    for (const field of SETTINGS_FIELDS) input[field] = f(field);
    try {
      const changes = await updateSettings(ctx, c.get("viewer"), name, input);
      return c.redirect(`${botUrl(name)}?saved=${Object.keys(changes).length ? "settings" : "unchanged"}`, 303);
    } catch (err) {
      const { message, status } = formError(err);
      const data = await getBot(ctx, c.get("viewer"), name);
      return botPage(c, name, { settingsError: message, settings: { ...data.settings, ...input } as Required<SettingsInput> }, status);
    }
  });

  app.post("/admin/bots/:name/control", async (c) => {
    const name = c.req.param("name");
    const action = (await readForm(c))("action") as Control;
    try {
      if (!CONTROLS.includes(action)) throw invalid("Unknown action.");
      await controlBot(ctx, c.get("viewer"), name, action);
      return c.redirect(`${botUrl(name)}?saved=${action}`, 303);
    } catch (err) {
      const { message, status } = formError(err);
      return botPage(c, name, { controlError: message }, status);
    }
  });

  app.get("/admin/bots/:name/standing", async (c) => {
    const { bot, versions } = await listStanding(ctx, c.get("viewer"), c.req.param("name"));
    return render(c, <StandingPage ctx={c.get("page")} bot={bot} versions={versions} />);
  });

  app.post("/admin/bots/:name/standing", async (c) => {
    const name = c.req.param("name");
    const body = (await readForm(c))("body");
    try {
      await saveStanding(ctx, c.get("viewer"), name, body);
      return c.redirect(`${botUrl(name)}?saved=standing`, 303);
    } catch (err) {
      const { message, status } = formError(err);
      return botPage(c, name, { standingError: message, standingText: body }, status);
    }
  });

  app.post("/admin/bots/:name/standing/:id/restore", async (c) => {
    const name = c.req.param("name");
    try {
      await restoreStanding(ctx, c.get("viewer"), name, parseId(c.req.param("id")));
      return c.redirect(botUrl(name, "/standing"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      const { bot, versions } = await listStanding(ctx, c.get("viewer"), name);
      return render(c, <StandingPage ctx={c.get("page")} bot={bot} versions={versions} error={message} />, status);
    }
  });

  app.get("/admin/bots/:name/runs", async (c) => {
    const { bot, runs, page } = await listRuns(ctx, c.get("viewer"), c.req.param("name"), c.req.query("page"));
    return render(c, <RunsPage ctx={c.get("page")} bot={bot} runs={runs} page={page} />);
  });

  app.get("/admin/bots/:name/runs/:id", async (c) => {
    const { bot, run } = await getRun(ctx, c.get("viewer"), c.req.param("name"), parseId(c.req.param("id")));
    return render(c, <RunPage ctx={c.get("page")} bot={bot} run={run} />);
  });

  app.get("/admin/bots/:name/notes", async (c) => {
    const filter = noteFilter(c.req.query("about"), c.req.query("folded"));
    const { bot, notes, total, page } = await listNotes(ctx, c.get("viewer"), c.req.param("name"), filter, c.req.query("page"));
    return render(c, <NotesPage ctx={c.get("page")} bot={bot} notes={notes} total={total} page={page} filter={filter} />);
  });

  app.post("/admin/bots/:name/notes/:id/archive", async (c) => {
    const name = c.req.param("name");
    await archiveNote(ctx, c.get("viewer"), name, parseId(c.req.param("id")));
    return c.redirect(botUrl(name, "/notes"), 303);
  });

  app.get("/admin/bots/:name/changes", async (c) => {
    const { bot, entries, page } = await listChanges(ctx, c.get("viewer"), c.req.param("name"), c.req.query("page"));
    return render(c, <ChangesPage ctx={c.get("page")} bot={bot} entries={entries} page={page} />);
  });

  app.post("/admin/bots/:name/changes/:id/undo", async (c) => {
    const name = c.req.param("name");
    try {
      await undoChange(ctx, c.get("viewer"), name, parseId(c.req.param("id")));
      return c.redirect(botUrl(name, "/changes"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      const { bot, entries, page } = await listChanges(ctx, c.get("viewer"), name, undefined);
      return render(c, <ChangesPage ctx={c.get("page")} bot={bot} entries={entries} page={page} error={message} />, status);
    }
  });
}
