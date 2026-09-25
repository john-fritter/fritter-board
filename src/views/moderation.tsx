import { raw } from "hono/html";
import { config } from "../config.js";
import type { ModAction, ModLogEntry, OpenReport } from "../forum/moderation.js";
import type { Page } from "../lib/pagination.js";
import { Crumbs, ErrorNote, Pagination, Time, UserLink } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

const ACTION_LABELS: Record<ModAction, string> = {
  lock: "Locked",
  unlock: "Unlocked",
  sticky: "Made sticky",
  unsticky: "Unstuck",
  move: "Moved",
  remove_post: "Removed",
  restore_post: "Restored",
  warn: "Warned",
  suspend: "Suspended",
  ban: "Banned",
  reinstate: "Reinstated",
  resolve_report: "Resolved",
};

export function ModLogPage(props: { ctx: PageCtx; entries: ModLogEntry[]; page: Page }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="Moderation log">
      <Crumbs ctx={ctx} trail={[{ label: "Moderation log" }]} />
      <h1 class="page-title">Moderation log</h1>
      <p class="desc">Every moderation action on the board, with the reason given. Nothing is left out.</p>
      <div class="toolbar">
        <Pagination ctx={ctx} base="/modlog" page={props.page} />
      </div>
      <table class="grid compact">
        <thead>
          <tr class="cat-row">
            <th scope="col">When</th>
            <th scope="col">Moderator</th>
            <th scope="col">Action</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.length === 0 && (
            <tr>
              <td colspan={4} class="empty">
                Nothing yet.
              </td>
            </tr>
          )}
          {props.entries.map((e) => (
            <tr>
              <td class="nowrap">
                <Time d={e.at} />
              </td>
              <td>
                <UserLink ctx={ctx} username={e.moderatorName} />
              </td>
              <td>
                {ACTION_LABELS[e.action]}{" "}
                {e.target.path ? <a href={ctx.url(e.target.path)}>{e.target.label}</a> : e.target.label}
                {e.details.fromBoard && e.details.toBoard && (
                  <span class="meta">
                    {" "}
                    from {e.details.fromBoard} to {e.details.toBoard}
                  </span>
                )}
              </td>
              <td>{e.reason || <span class="meta">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
}

export function ReportsPage(props: { ctx: PageCtx; reports: OpenReport[] }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="Reports">
      <Crumbs ctx={ctx} trail={[{ label: "Reports" }]} />
      <h1 class="page-title">Open reports</h1>
      {props.reports.length === 0 && <p class="notice">No open reports.</p>}
      {props.reports.map((r) => (
        <section class="panel">
          <h2 class="panel-head">
            Post by {r.postAuthorName} in “{r.threadTitle}”
          </h2>
          <div class="panel-body">
            <p>
              <UserLink ctx={ctx} username={r.reporterName} /> reported it <Time d={r.createdAt} />: <em>{r.reason}</em>
            </p>
            <div class="post-body excerpt">{raw(r.postBodyHtml)}</div>
            {r.postRemoved && <p class="meta">This post has since been removed.</p>}
            <p>
              <a href={ctx.url(`/p/${r.postId}`)}>View in thread</a> ·{" "}
              <a href={ctx.url(`/p/${r.postId}/moderate`)}>Moderate</a>
            </p>
            <form method="post" action={ctx.url(`/mod/reports/${r.id}/resolve`)} class="inline-fields">
              <label>
                Resolution <span class="hint">(shown in the mod log)</span>
                <input type="text" name="resolution" maxlength={config.limits.reason_max} />
              </label>
              <button type="submit">Resolve</button>
            </form>
          </div>
        </section>
      ))}
    </Layout>
  );
}

export function WarnPage(props: { ctx: PageCtx; username: string; reason: string; message: string; error: string | null }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title={`Warn ${props.username}`}>
      <Crumbs ctx={ctx} trail={[{ label: props.username, href: `/u/${encodeURIComponent(props.username)}` }, { label: "Warn" }]} />
      <section class="panel narrow">
        <h1 class="panel-head">Warn {props.username}</h1>
        <div class="panel-body">
          <ErrorNote message={props.error} />
          <form method="post" action={ctx.url(`/u/${encodeURIComponent(props.username)}/warn`)} class="stacked">
            <label>
              Reason <span class="hint">(public, in the mod log)</span>
              <input type="text" name="reason" value={props.reason} required maxlength={config.limits.reason_max} />
            </label>
            <label>
              Message <span class="hint">(sent privately; the reason is sent if left blank)</span>
              <textarea name="message" rows={6} maxlength={config.limits.post_body_max}>
                {props.message}
              </textarea>
            </label>
            <div class="form-actions">
              <button type="submit">Send warning</button>
            </div>
          </form>
        </div>
      </section>
    </Layout>
  );
}
