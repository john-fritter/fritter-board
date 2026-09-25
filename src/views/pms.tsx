import { raw } from "hono/html";
import { config } from "../config.js";
import type { Conversation, InboxItem } from "../forum/pms.js";
import type { Page } from "../lib/pagination.js";
import { Avatar, BotBadge, Crumbs, ErrorNote, Pagination, Time, UserLink } from "./components.js";
import type { PageCtx } from "./context.js";
import { MARKUP_HELP } from "./forum.js";
import { Layout } from "./layout.js";

export function InboxPage(props: {
  ctx: PageCtx;
  items: InboxItem[];
  page: Page;
  /** The admin's view of every conversation. */
  all?: boolean;
}) {
  const { ctx } = props;
  const title = props.all ? "All conversations" : "Messages";
  return (
    <Layout ctx={ctx} title={title}>
      <Crumbs ctx={ctx} trail={props.all ? [{ label: "Admin", href: "/admin" }, { label: title }] : [{ label: title }]} />
      <h1 class="page-title">{title}</h1>
      <div class="toolbar">
        {!props.all && (
          <a class="button" href={ctx.url("/pm/new")}>
            New message
          </a>
        )}
        <Pagination ctx={ctx} base={props.all ? "/admin/pms" : "/pm"} page={props.page} />
      </div>
      <table class="grid">
        <thead>
          <tr class="cat-row">
            <th scope="col" class="col-main">
              Subject
            </th>
            <th scope="col" class="col-last">
              {props.all ? "Between" : "With"}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.items.length === 0 && (
            <tr>
              <td colspan={2} class="empty">
                No messages.
              </td>
            </tr>
          )}
          {props.items.map((c) => (
            <tr class={c.unread ? "unread" : undefined}>
              <td class="col-main">
                {c.unread && <span class="badge badge-new">New</span>}
                <a class="thread-title" href={ctx.url(`/pm/${c.id}`)}>
                  {c.subject}
                </a>
                <div class="meta">
                  Last message <Time d={c.lastMessageAt} />
                </div>
              </td>
              <td class="col-last">
                {c.with.map((name, i) => (
                  <>
                    {i > 0 && ", "}
                    <UserLink ctx={ctx} username={name} />
                  </>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
}

export function ConversationPage(props: { ctx: PageCtx; conv: Conversation }) {
  const { ctx, conv } = props;
  return (
    <Layout ctx={ctx} title={conv.subject}>
      <Crumbs ctx={ctx} trail={[{ label: "Messages", href: "/pm" }, { label: conv.subject }]} />
      <h1 class="page-title">{conv.subject}</h1>
      <p class="meta">
        Between{" "}
        {conv.participants.map((p, i) => (
          <>
            {i > 0 && " and "}
            <UserLink ctx={ctx} username={p.username} />
          </>
        ))}
        .
      </p>
      {conv.readingAsAdmin && <p class="notice">You're reading this conversation as the admin. The participants aren't told.</p>}
      <div class="toolbar">
        <Pagination ctx={ctx} base={`/pm/${conv.id}`} page={conv.page} />
      </div>
      <div class="posts">
        {conv.messages.map((m) => (
          <article class="post" id={`m${m.id}`}>
            <aside class="post-author">
              <Avatar username={m.author.username} />
              <div class="author-name">
                <UserLink ctx={ctx} username={m.author.username} />
                {m.author.isBot && <BotBadge />}
              </div>
              {m.author.displayTitle && <div class="author-title">{m.author.displayTitle}</div>}
            </aside>
            <div class="post-main">
              <header class="post-head">
                <Time d={m.createdAt} />
              </header>
              <div class="post-body">{raw(m.bodyHtml)}</div>
            </div>
          </article>
        ))}
      </div>
      {conv.isParticipant && (
        <section class="panel">
          <h2 class="panel-head">Reply</h2>
          <div class="panel-body">
            <form method="post" action={ctx.url(`/pm/${conv.id}/reply`)} class="compose">
              <textarea name="body" rows={6} required maxlength={config.limits.post_body_max} aria-label="Reply"></textarea>
              <div class="form-actions">
                <button type="submit">Send</button>
              </div>
            </form>
          </div>
        </section>
      )}
    </Layout>
  );
}

export function NewMessagePage(props: {
  ctx: PageCtx;
  to: string;
  subject: string;
  body: string;
  error: string | null;
}) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="New message">
      <Crumbs ctx={ctx} trail={[{ label: "Messages", href: "/pm" }, { label: "New message" }]} />
      <h1 class="page-title">New message</h1>
      <ErrorNote message={props.error} />
      <form method="post" action={ctx.url("/pm/new")} class="compose">
        <label>
          To
          <input type="text" name="to" value={props.to} required maxlength={config.limits.username_max} />
        </label>
        <label>
          Subject
          <input type="text" name="subject" value={props.subject} maxlength={config.limits.thread_title_max} />
        </label>
        <label>
          Message
          <textarea name="body" rows={10} required maxlength={config.limits.post_body_max}>
            {props.body}
          </textarea>
        </label>
        <p class="hint">{MARKUP_HELP}</p>
        <p class="hint">Messages are private between you and the recipient, except that the admin can read all messages.</p>
        <div class="form-actions">
          <button type="submit">Send</button>
        </div>
      </form>
    </Layout>
  );
}
