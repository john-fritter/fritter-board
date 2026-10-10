import type { Child } from "hono/jsx";
import type { BotRow, BriefView, LogEntry, RunDetail, RunRow, StandingVersion, TranscriptMessage, NoteFilter } from "../botadmin/bots.js";
import { BRIEF_TITLES } from "../runner/briefs.js";
import { config } from "../config.js";
import type { Page } from "../lib/pagination.js";
import type { Note, Standing } from "../runner/memory.js";
import { EFFORTS, type SettingsInput } from "../runner/settings.js";
import type { Bot } from "../runner/store.js";
import { Crumbs, ErrorNote, Pagination, Time } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

// The admin pages for bots (/admin/bots). Plain forms, no scripts, like the
// rest of the board; long text folds away in <details>.

const base = (bot: { username: string }) => `/admin/bots/${encodeURIComponent(bot.username)}`;
const n = (x: number) => x.toLocaleString("en-US");

function trail(ctx: PageCtx, bot: Bot | null, here?: string) {
  const t: { label: string; href?: string }[] = [{ label: "Admin", href: "/admin" }, { label: "Bots", href: "/admin/bots" }];
  if (bot) t.push({ label: bot.username, ...(here ? { href: base(bot) } : {}) });
  if (here) t.push({ label: here });
  return <Crumbs ctx={ctx} trail={t} />;
}

function Status(props: { bot: Bot }) {
  const b = props.bot;
  if (!b.active) return <>paused</>;
  if (b.pausedUntil && b.pausedUntil > new Date()) {
    return (
      <>
        resting until <Time d={b.pausedUntil} /> (NanoGPT daily cap)
      </>
    );
  }
  return <>active</>;
}

function Moderation(props: { bot: Bot; calls: number }) {
  const b = props.bot;
  if (!b.moderates) return <>off</>;
  if (!b.modApiKeyRef) return <>on, but no moderation key is named: no rounds</>;
  const now = new Date();
  return (
    <>
      rounds on <code>{b.modApiKeyRef}</code>, {props.calls} of {config.runner.moderation_calls_per_day} calls in 24h
      {b.modPausedUntil && b.modPausedUntil > now ? (
        <>
          ; resting until <Time d={b.modPausedUntil} /> (NanoGPT daily cap)
        </>
      ) : (
        b.active &&
        b.modNextAt && (
          <>
            ; next patrol <Time d={b.modNextAt} />
          </>
        )
      )}
      {b.modEarlyAt && (
        <>
          ; early round <Time d={b.modEarlyAt} /> ({b.modEarlyTrigger})
        </>
      )}
    </>
  );
}

function RunSummary(props: { run: RunRow }) {
  const r = props.run;
  return (
    <>
      {r.kind === "wake" ? r.trigger : r.kind === "compaction" ? "compaction" : `moderation (${r.trigger})`} · <span class={`outcome-${r.outcome}`}>{r.outcome}</span>
      {r.fallbackModel && (
        <>
          {" "}
          on <code>{r.fallbackModel}</code>
        </>
      )}
      {r.modelCalls > 0 && ` · ${r.modelCalls} call(s), ${n(r.promptTokens)} in / ${n(r.completionTokens)} out`}
      {r.summaryCalls > 0 && ` · ${r.summaryCalls} summary call(s)`}
      {r.writes > 0 && ` · ${r.writes} write(s)`}
    </>
  );
}

function RunsTable(props: { ctx: PageCtx; bot: Bot; runs: RunRow[] }) {
  const { ctx, bot } = props;
  return (
    <div class="table-scroll">
      <table class="grid compact">
        <thead>
          <tr class="cat-row">
            <th scope="col">Run</th>
            <th scope="col">Started</th>
            <th scope="col">What happened</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.length === 0 && (
            <tr>
              <td colspan={4} class="empty">
                No runs yet.
              </td>
            </tr>
          )}
          {props.runs.map((r) => (
            <tr>
              <td>
                <a href={ctx.url(`${base(bot)}/runs/${r.id}`)}>#{r.id}</a>
              </td>
              <td class="nowrap">
                <Time d={r.startedAt} />
              </td>
              <td>
                <RunSummary run={r} />
              </td>
              <td>{r.error ?? r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteLine(props: { ctx: PageCtx; bot: Bot; note: Note; archive?: boolean }) {
  const { ctx, bot, note } = props;
  return (
    <li>
      <span class="meta">
        #{note.id} · <Time d={note.createdAt} />
        {note.about && ` · about ${note.about}`}
        {note.threadId && (
          <>
            {" · "}
            <a href={ctx.url(`/t/${note.threadId}`)}>thread {note.threadId}</a>
          </>
        )}
        {note.archivedAt && " · folded"}
      </span>
      <div class="pre-text">{note.body}</div>
      {props.archive && !note.archivedAt && (
        <form method="post" action={ctx.url(`${base(bot)}/notes/${note.id}/archive`)} class="inline-form">
          <button type="submit" class="linkish">
            Archive
          </button>
        </form>
      )}
    </li>
  );
}

// ── The list ───────────────────────────────────────────────────────────────

export function BotsPage(props: { ctx: PageCtx; bots: BotRow[]; unconfigured: string[] }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="Bots">
      {trail(ctx, null)}
      <section class="panel">
        <h1 class="panel-head">Bots</h1>
        <div class="panel-body">
          <div class="table-scroll">
            <table class="grid compact">
              <thead>
                <tr class="cat-row">
                  <th scope="col">Bot</th>
                  <th scope="col">Status</th>
                  <th scope="col">Model</th>
                  <th scope="col">Next wake</th>
                  <th scope="col">Last run</th>
                  <th scope="col" class="col-num">
                    Writes, 24h
                  </th>
                  <th scope="col" class="col-num">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {props.bots.length === 0 && (
                  <tr>
                    <td colspan={7} class="empty">
                      No bot has runner settings yet.
                    </td>
                  </tr>
                )}
                {props.bots.map(({ bot, lastRun, writesToday, notes }) => (
                  <tr>
                    <td>
                      <a href={ctx.url(base(bot))}>{bot.username}</a>
                    </td>
                    <td>
                      <Status bot={bot} />
                    </td>
                    <td>
                      <code>{bot.model}</code> ({bot.mode})
                    </td>
                    <td class="nowrap">{bot.active && bot.nextWakeAt ? <Time d={bot.nextWakeAt} /> : "-"}</td>
                    <td>
                      {lastRun ? (
                        <>
                          <a href={ctx.url(`${base(bot)}/runs/${lastRun.id}`)}>
                            <Time d={lastRun.startedAt} />
                          </a>{" "}
                          <RunSummary run={lastRun} />
                        </>
                      ) : (
                        "never"
                      )}
                    </td>
                    <td class="col-num">
                      {writesToday} / {bot.postsPerDay}
                    </td>
                    <td class="col-num">{notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <a href={ctx.url("/admin/briefs")}>Role briefs</a>: what every bot is told about the board, and the moderator about moderating.
          </p>
          {props.unconfigured.length > 0 && (
            <p class="hint">
              Bot accounts without runner settings: {props.unconfigured.join(", ")}. Give one settings with{" "}
              <code>npm run bot -- config &lt;name&gt; --model … --key-env … --token-env …</code>, which names its secrets.
            </p>
          )}
        </div>
      </section>
    </Layout>
  );
}

// ── One bot ────────────────────────────────────────────────────────────────

export interface BotPageProps {
  ctx: PageCtx;
  row: BotRow;
  standing: Standing | null;
  runs: RunRow[];
  notes: { notes: Note[]; total: number };
  log: LogEntry[];
  settings: Required<SettingsInput>;
  settingsError?: string | null;
  standingText?: string | null;
  standingError?: string | null;
  controlError?: string | null;
  saved?: string | null;
}

function Field(props: { label: string; name: string; value: string; hint?: string }) {
  return (
    <label>
      {props.label}
      {props.hint && <span class="hint"> {props.hint}</span>}
      <input type="text" name={props.name} value={props.value} />
    </label>
  );
}

function SettingsForm(props: { ctx: PageCtx; bot: Bot; s: Required<SettingsInput> }) {
  const { ctx, bot, s } = props;
  return (
    <form method="post" action={ctx.url(`${base(bot)}/settings`)} class="compose">
      <div class="inline-fields">
        <Field label="Model" name="model" value={s.model} />
        <Field label="Fallback models" hint="(in order: a,b; or none)" name="fallbacks" value={s.fallbacks} />
        <label>
          Mode
          <select name="mode">
            <option value="tools" selected={s.mode === "tools"}>
              tools
            </option>
            <option value="single_shot" selected={s.mode === "single_shot"}>
              single_shot
            </option>
          </select>
        </label>
        <label>
          Reasoning effort
          <select name="effort">
            {EFFORTS.map((e) => (
              <option value={e} selected={s.effort === e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="inline-fields">
        <Field label="Wakes every" hint="(minutes, MIN-MAX)" name="every" value={s.every} />
        <Field label="Waking window" hint={`(${config.site.timezone})`} name="window" value={s.window} />
        <Field label="Lurks" hint="(0 to 1)" name="lurk" value={s.lurk} />
      </div>
      <div class="inline-fields">
        <Field label="Model calls a wake" name="steps" value={s.steps} />
        <Field label="Writes a wake" name="writesPerWake" value={s.writesPerWake} />
        <Field label="Writes a day" name="postsPerDay" value={s.postsPerDay} />
      </div>
      <div class="inline-fields">
        <Field label="Writes in" hint="(board slugs, or all)" name="boards" value={s.boards} />
        <Field label="Key variable" name="keyEnv" value={s.keyEnv} />
        <Field label="Token variable" name="tokenEnv" value={s.tokenEnv} />
        <Field label="Model calls a day" hint="(on its key; or default)" name="callsPerDay" value={s.callsPerDay} />
      </div>
      <div class="inline-fields">
        <label>
          Moderation rounds
          <select name="moderates">
            <option value="off" selected={s.moderates === "off"}>
              off
            </option>
            <option value="on" selected={s.moderates === "on"}>
              on
            </option>
          </select>
        </label>
        <Field label="Moderation key variable" name="modKeyEnv" value={s.modKeyEnv} />
        <label>
          Moderation effort
          <select name="modEffort">
            {EFFORTS.map((e) => (
              <option value={e} selected={s.modEffort === e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <Field label="Model calls a round" name="modSteps" value={s.modSteps} />
      </div>
      <p class="hint">
        Moderation rounds need the bot to be a moderator on the board. Mod tools are offered only in rounds, never on ordinary visits.
      </p>
      <label>
        Persona
        <textarea name="persona" rows={18} class="tall">
          {s.persona}
        </textarea>
      </label>
      <div class="form-actions">
        <button type="submit">Save settings</button>
        <a href={ctx.url(`${base(bot)}/changes`)}>Changes, and undo</a>
      </div>
    </form>
  );
}

export function BotPage(props: BotPageProps) {
  const { ctx, row } = props;
  const { bot } = row;
  const control = (name: string, label: string, disabled = false) => (
    <form method="post" action={ctx.url(`${base(bot)}/control`)} class="inline-form">
      <button type="submit" name="action" value={name} class="secondary" disabled={disabled}>
        {label}
      </button>
    </form>
  );
  return (
    <Layout ctx={ctx} title={`${bot.username} · Bots`}>
      {trail(ctx, bot)}
      <h1 class="page-title">{bot.username}</h1>
      {props.saved && (
        <p class="notice" role="status">
          {props.saved}
        </p>
      )}
      <section class="panel">
        <h2 class="panel-head">Now</h2>
        <div class="panel-body">
          <ErrorNote message={props.controlError} />
          <dl class="facts">
            <dt>Status</dt>
            <dd>
              <Status bot={bot} />
            </dd>
            <dt>Next wake</dt>
            <dd>
              {bot.active && bot.nextWakeAt ? <Time d={bot.nextWakeAt} /> : "-"}
              {bot.earlyWakeAt && (
                <>
                  ; early wake <Time d={bot.earlyWakeAt} /> ({bot.earlyWakeTrigger})
                </>
              )}
            </dd>
            <dt>Last run</dt>
            <dd>
              {row.lastRun ? (
                <>
                  <a href={ctx.url(`${base(bot)}/runs/${row.lastRun.id}`)}>
                    <Time d={row.lastRun.startedAt} />
                  </a>{" "}
                  <RunSummary run={row.lastRun} />
                </>
              ) : (
                "never"
              )}
            </dd>
            <dt>Writes, 24h</dt>
            <dd>
              {row.writesToday} of {bot.postsPerDay}
            </dd>
            <dt>Notes</dt>
            <dd>
              {row.notes} not yet folded{bot.compactRequestedAt && "; compaction asked for"}
            </dd>
            <dt>Inbox read to</dt>
            <dd>{bot.inboxCursor ? <Time d={bot.inboxCursor} /> : "-"}</dd>
            <dt>Model calls, 24h</dt>
            <dd>
              {row.callsToday} of {bot.modelCallsPerDay ?? config.runner.model_calls_per_day} on <code>{bot.apiKeyRef}</code>
            </dd>
            <dt>Moderation</dt>
            <dd>
              <Moderation bot={bot} calls={row.modCallsToday} />
            </dd>
          </dl>
          <div class="form-actions">
            {bot.active ? control("pause", "Pause") : control("resume", "Resume")}
            {control("wake", "Wake now", !bot.active)}
            {control("compact", "Compact notes now", !bot.active)}
            {bot.moderates && control("moderate", "Moderate now", !bot.active || !bot.modApiKeyRef)}
            <a class="button secondary" href={ctx.url(`/admin/export/bot/${encodeURIComponent(bot.username)}`)}>
              Download bot file
            </a>
          </div>
          <p class="hint">Wake, compact and moderate happen at the runner's next tick, within {config.runner.tick_seconds} seconds.</p>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel-head">Standing notes</h2>
        <div class="panel-body">
          <p class="meta">
            {props.standing ? (
              <>
                Version {props.standing.id}, <Time d={props.standing.createdAt} />, {props.standing.body.length} of{" "}
                {config.runner.standing_max_chars} characters ·{" "}
              </>
            ) : (
              "None yet · "
            )}
            <a href={ctx.url(`${base(bot)}/standing`)}>Versions</a>
          </p>
          <ErrorNote message={props.standingError} />
          <form method="post" action={ctx.url(`${base(bot)}/standing`)} class="compose">
            <textarea name="body" rows={14} maxlength={config.runner.standing_max_chars} aria-label="Standing notes" class="tall">
              {props.standingText ?? props.standing?.body ?? ""}
            </textarea>
            <div class="form-actions">
              <button type="submit">Save as a new version</button>
            </div>
          </form>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel-head">Recent runs</h2>
        <div class="panel-body">
          <RunsTable ctx={ctx} bot={bot} runs={props.runs} />
          <p>
            <a href={ctx.url(`${base(bot)}/runs`)}>All runs</a>
          </p>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel-head">Recent notes</h2>
        <div class="panel-body">
          {props.notes.notes.length === 0 ? (
            <p class="empty">No notes yet.</p>
          ) : (
            <ul class="recent-posts">
              {props.notes.notes.map((note) => (
                <NoteLine ctx={ctx} bot={bot} note={note} />
              ))}
            </ul>
          )}
          <p>
            <a href={ctx.url(`${base(bot)}/notes`)}>All {props.notes.total} notes</a>
          </p>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel-head">Settings and persona</h2>
        <div class="panel-body">
          <ErrorNote message={props.settingsError} />
          <SettingsForm ctx={ctx} bot={bot} s={props.settings} />
        </div>
      </section>
    </Layout>
  );
}

// ── Runs ───────────────────────────────────────────────────────────────────

export function RunsPage(props: { ctx: PageCtx; bot: Bot; runs: RunRow[]; page: Page }) {
  const { ctx, bot } = props;
  return (
    <Layout ctx={ctx} title={`${bot.username}'s runs · Bots`}>
      {trail(ctx, bot, "Runs")}
      <section class="panel">
        <h1 class="panel-head">{bot.username}'s runs</h1>
        <div class="panel-body">
          <RunsTable ctx={ctx} bot={bot} runs={props.runs} />
          <div class="toolbar">
            <Pagination ctx={ctx} base={`${base(bot)}/runs`} page={props.page} />
          </div>
        </div>
      </section>
    </Layout>
  );
}

function Message(props: { m: TranscriptMessage; open: boolean }) {
  const { m } = props;
  const label = m.role === "tool" ? `tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ""}` : m.role;
  const body: Child[] = [];
  if (m.content) body.push(<div class="pre-text">{m.content}</div>);
  for (const call of m.tool_calls ?? []) {
    body.push(
      <div class="pre-text">
        → {call.function.name}({call.function.arguments})
      </div>
    );
  }
  if (body.length === 0) body.push(<div class="meta">(nothing)</div>);
  return (
    <li>
      <details open={props.open}>
        <summary class="msg-role">
          {label}
          {!props.open && m.content ? ` · ${m.content.length} characters` : ""}
        </summary>
        {body}
      </details>
    </li>
  );
}

export function RunPage(props: { ctx: PageCtx; bot: Bot; run: RunDetail }) {
  const { ctx, bot, run } = props;
  return (
    <Layout ctx={ctx} title={`Run #${run.id} · ${bot.username} · Bots`}>
      {trail(ctx, bot, `Run #${run.id}`)}
      <section class="panel">
        <h1 class="panel-head">
          Run #{run.id}: {run.kind}
        </h1>
        <div class="panel-body">
          <dl class="facts">
            <dt>Started</dt>
            <dd>
              <Time d={run.startedAt} />
              {run.finishedAt && (
                <>
                  , finished <Time d={run.finishedAt} />
                </>
              )}
            </dd>
            <dt>Trigger</dt>
            <dd>{run.trigger}</dd>
            <dt>Outcome</dt>
            <dd class={`outcome-${run.outcome}`}>{run.outcome}</dd>
            <dt>Model</dt>
            <dd>
              <code>{run.model}</code> ({run.mode}, reasoning {run.reasoningEffort})
              {run.fallbackModel && (
                <>
                  ; it failed, and <code>{run.fallbackModel}</code>, a fallback, served the rest of the run
                </>
              )}
            </dd>
            <dt>Model calls</dt>
            <dd>
              {run.modelCalls}: {n(run.promptTokens)} tokens in ({n(run.cachedTokens)} cached), {n(run.completionTokens)} out (
              {n(run.reasoningTokens)} reasoning)
            </dd>
            {run.summaryCalls > 0 && (
              <>
                <dt>Summaries</dt>
                <dd>
                  {run.summaryCalls} call(s): {n(run.summaryPromptTokens)} in, {n(run.summaryCompletionTokens)} out
                </dd>
              </>
            )}
            <dt>Writes</dt>
            <dd>{run.writes}</dd>
            {run.inboxSince && (
              <>
                <dt>Inbox</dt>
                <dd>
                  <Time d={run.inboxSince} /> to {run.inboxUntil ? <Time d={run.inboxUntil} /> : "-"}
                </dd>
              </>
            )}
            {run.note && (
              <>
                <dt>Note</dt>
                <dd>{run.note}</dd>
              </>
            )}
            {run.error && (
              <>
                <dt>Error</dt>
                <dd class="outcome-failed">{run.error}</dd>
              </>
            )}
          </dl>
        </div>
      </section>
      <section class="panel">
        <h2 class="panel-head">Actions</h2>
        <div class="panel-body">
          {run.actions.length === 0 ? (
            <p class="empty">None.</p>
          ) : (
            <div class="table-scroll">
              <table class="grid compact">
                <thead>
                  <tr class="cat-row">
                    <th scope="col">Tool</th>
                    <th scope="col">Arguments</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {run.actions.map((a) => (
                    <tr>
                      <td class={a.ok ? undefined : "outcome-failed"}>
                        {a.tool}
                        {!a.ok && " (refused)"}
                      </td>
                      <td>
                        <code>{a.args}</code>
                      </td>
                      <td>
                        <code>{a.result}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {run.searches.length > 0 && (
        <section class="panel">
          <h2 class="panel-head">Web searches</h2>
          <div class="panel-body">
            <p class="hint">The bot got only the summary; the pages and their links are for you.</p>
            <ul class="recent-posts">
              {run.searches.map((s) => (
                <li>
                  <details>
                    <summary>
                      “{s.query}”{s.recency && ` (last ${s.recency})`} ·{" "}
                      <span class={s.outcome === "ok" ? undefined : "outcome-failed"}>{SEARCH_OUTCOMES[s.outcome] ?? s.outcome}</span>
                      {s.service && ` · ${s.service}`}
                      {s.researchModel && (
                        <>
                          {" "}
                          · <code>{s.researchModel}</code>
                        </>
                      )}
                    </summary>
                    {s.summary && <div class="pre-text">{s.summary}</div>}
                    {s.error && <p class="hint">Along the way: {s.error}</p>}
                    {s.results.length > 0 && (
                      <ol>
                        {s.results.map((h) => (
                          <li>
                            <a href={h.url} rel="noreferrer nofollow">
                              {h.title}
                            </a>{" "}
                            · {h.site}
                            {h.published && ` · ${h.published}`}
                          </li>
                        ))}
                      </ol>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      <section class="panel">
        <h2 class="panel-head">Transcript</h2>
        <div class="panel-body">
          {run.transcript === null ? (
            <p class="empty">
              {run.outcome === "lurked" || run.outcome === "skipped"
                ? "No model was called."
                : `Cleared: transcripts are kept ${config.runner.transcript_retention_days} days.`}
            </p>
          ) : (
            <>
              <p class="hint">
                After the fixed prefix (instructions, persona and tools), recorded as <code>{run.prefixHash ?? "-"}</code>.
              </p>
              <ol class="transcript">
                {run.transcript.map((m, i) => (
                  <Message m={m} open={m.role === "assistant" || (m.role === "user" && i > 0)} />
                ))}
              </ol>
            </>
          )}
        </div>
      </section>
    </Layout>
  );
}

const SEARCH_OUTCOMES: Record<string, string> = {
  ok: "summarized",
  no_results: "nothing found",
  search_failed: "search failed",
  summary_failed: "no usable summary",
  research_capped: "research key capped",
};

// ── Standing ───────────────────────────────────────────────────────────────

export function StandingPage(props: { ctx: PageCtx; bot: Bot; versions: StandingVersion[]; error?: string | null }) {
  const { ctx, bot } = props;
  const who = (v: StandingVersion) =>
    v.source === "compaction" ? (
      <>
        compaction{" "}
        {v.runId && <a href={ctx.url(`${base(bot)}/runs/${v.runId}`)}>run #{v.runId}</a>}
      </>
    ) : (
      `${v.source === "rollback" ? "restored" : "edited"} by ${v.createdBy ?? "?"}`
    );
  return (
    <Layout ctx={ctx} title={`${bot.username}'s standing notes · Bots`}>
      {trail(ctx, bot, "Standing notes")}
      <section class="panel">
        <h1 class="panel-head">{bot.username}'s standing notes</h1>
        <div class="panel-body">
          <ErrorNote message={props.error} />
          {props.versions.length === 0 && <p class="empty">No versions yet.</p>}
          <ul class="recent-posts">
            {props.versions.map((v, i) => (
              <li>
                <details open={i === 0}>
                  <summary>
                    Version {v.id}
                    {i === 0 && " (current)"} · <Time d={v.createdAt} /> · {who(v)} · {v.body.length} characters
                  </summary>
                  <div class="pre-text">{v.body}</div>
                </details>
                {i > 0 && (
                  <form method="post" action={ctx.url(`${base(bot)}/standing/${v.id}/restore`)} class="inline-form">
                    <button type="submit" class="linkish">
                      Restore this version
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </Layout>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────

export function NotesPage(props: { ctx: PageCtx; bot: Bot; notes: Note[]; total: number; page: Page; filter: NoteFilter }) {
  const { ctx, bot, filter } = props;
  const query = [filter.about && `about=${encodeURIComponent(filter.about)}`, filter.folded !== "all" && `folded=${filter.folded}`]
    .filter(Boolean)
    .join("&");
  return (
    <Layout ctx={ctx} title={`${bot.username}'s notes · Bots`}>
      {trail(ctx, bot, "Notes")}
      <section class="panel">
        <h1 class="panel-head">
          {bot.username}'s notes ({props.total})
        </h1>
        <div class="panel-body">
          <form method="get" action={ctx.url(`${base(bot)}/notes`)} class="inline-fields">
            <label>
              About
              <input type="text" name="about" value={filter.about} placeholder="a member's name" />
            </label>
            <label>
              Showing
              <select name="folded">
                <option value="all" selected={filter.folded === "all"}>
                  all notes
                </option>
                <option value="current" selected={filter.folded === "current"}>
                  not yet folded
                </option>
                <option value="folded" selected={filter.folded === "folded"}>
                  folded or archived
                </option>
              </select>
            </label>
            <button type="submit">Show</button>
          </form>
          {props.notes.length === 0 ? (
            <p class="empty">No notes.</p>
          ) : (
            <ul class="recent-posts">
              {props.notes.map((note) => (
                <NoteLine ctx={ctx} bot={bot} note={note} archive />
              ))}
            </ul>
          )}
          <p class="hint">Archiving a note stops it coming with every wake; the bot can still find it with recall.</p>
          <div class="toolbar">
            <Pagination ctx={ctx} base={`${base(bot)}/notes${query ? `?${query}` : ""}`} page={props.page} />
          </div>
        </div>
      </section>
    </Layout>
  );
}

// ── Changes ────────────────────────────────────────────────────────────────

function Value(props: { v: unknown }) {
  const v = props.v;
  if (v === null || v === undefined) return <span class="meta">(none)</span>;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  if (text.length <= 80) return <code>{text}</code>;
  return (
    <details>
      <summary>{text.length} characters</summary>
      <div class="pre-text">{text}</div>
    </details>
  );
}

export function ChangesPage(props: { ctx: PageCtx; bot: Bot; entries: LogEntry[]; page: Page; error?: string | null }) {
  const { ctx, bot } = props;
  return (
    <Layout ctx={ctx} title={`${bot.username}'s changes · Bots`}>
      {trail(ctx, bot, "Changes")}
      <section class="panel">
        <h1 class="panel-head">Changes to {bot.username}'s settings</h1>
        <div class="panel-body">
          <ErrorNote message={props.error} />
          <div class="table-scroll">
            <table class="grid compact">
              <thead>
                <tr class="cat-row">
                  <th scope="col">When</th>
                  <th scope="col">By</th>
                  <th scope="col">Setting</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {props.entries.length === 0 && (
                  <tr>
                    <td colspan={6} class="empty">
                      No changes logged yet.
                    </td>
                  </tr>
                )}
                {props.entries.map((e) =>
                  Object.entries(e.changes).map(([field, c], i) => (
                    <tr>
                      <td class="nowrap">{i === 0 && <Time d={e.createdAt} />}</td>
                      <td>{i === 0 && e.changedBy}</td>
                      <td>
                        <code>{field}</code>
                      </td>
                      <td>
                        <Value v={c.from} />
                      </td>
                      <td>
                        <Value v={c.to} />
                      </td>
                      <td>
                        {i === 0 && (
                          <form method="post" action={ctx.url(`${base(bot)}/changes/${e.id}/undo`)} class="inline-form">
                            <button type="submit" class="linkish">
                              Undo
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p class="hint">Undo sets the settings in that change back to what they were before it, as a new change.</p>
          <div class="toolbar">
            <Pagination ctx={ctx} base={`${base(bot)}/changes`} page={props.page} />
          </div>
        </div>
      </section>
    </Layout>
  );
}

// ── Role briefs ────────────────────────────────────────────────────────────

const BRIEF_ABOUT: Record<BriefView["name"], string> = {
  member: "Every bot, on every visit and round: what the board is and how to be a member of it.",
  moderator_member: "Added on the ordinary visits of a bot that moderates.",
  moderation: "The moderator's brief for moderation rounds, with the site rules.",
};

export function BriefsPage(props: { ctx: PageCtx; briefs: BriefView[]; saved?: string | null; error?: { name: string; message: string; text: string } | null }) {
  const { ctx } = props;
  const t: { label: string; href?: string }[] = [{ label: "Admin", href: "/admin" }, { label: "Bots", href: "/admin/bots" }, { label: "Role briefs" }];
  return (
    <Layout ctx={ctx} title="Role briefs · Bots">
      <Crumbs ctx={ctx} trail={t} />
      <h1 class="page-title">Role briefs</h1>
      <p class="desc">
        A bot's prompt is the board's own instructions, then these briefs, then its persona. Changes apply from each bot's next visit.
      </p>
      {props.saved && (
        <p class="notice" role="status">
          {props.saved}
        </p>
      )}
      {props.briefs.map((b) => {
        const error = props.error?.name === b.name ? props.error : null;
        return (
          <section class="panel" id={b.name}>
            <h2 class="panel-head">{BRIEF_TITLES[b.name]}</h2>
            <div class="panel-body">
              <p class="meta">
                {BRIEF_ABOUT[b.name]}{" "}
                {b.latest ? (
                  <>
                    Version {b.latest.id}, <Time d={b.latest.createdAt} /> by {b.latest.createdBy}.
                  </>
                ) : (
                  <>
                    As shipped (<code>config/briefs/{b.name}.md</code>).
                  </>
                )}
              </p>
              <ErrorNote message={error?.message} />
              <form method="post" action={ctx.url(`/admin/briefs/${b.name}`)} class="compose">
                <textarea name="body" rows={14} aria-label={BRIEF_TITLES[b.name]} class="tall">
                  {error ? error.text : b.current}
                </textarea>
                <div class="form-actions">
                  <button type="submit">Save as a new version</button>
                </div>
              </form>
              {b.latest && b.latest.body !== b.shipped && (
                <form method="post" action={ctx.url(`/admin/briefs/${b.name}/restore`)} class="inline-form">
                  <button type="submit" class="linkish">
                    Go back to the shipped text
                  </button>
                </form>
              )}
              {b.versions.length > 1 && (
                <details>
                  <summary>Earlier versions</summary>
                  <ul class="recent-posts">
                    {b.versions.slice(1).map((v) => (
                      <li>
                        <details>
                          <summary>
                            Version {v.id} · <Time d={v.createdAt} /> · {v.createdBy}
                          </summary>
                          <div class="pre-text">{v.body}</div>
                        </details>
                        <form method="post" action={ctx.url(`/admin/briefs/${b.name}/restore`)} class="inline-form">
                          <input type="hidden" name="version" value={String(v.id)} />
                          <button type="submit" class="linkish">
                            Restore this version
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </section>
        );
      })}
    </Layout>
  );
}
