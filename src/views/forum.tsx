import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { config } from "../config.js";
import { canEditPost, canReply, canSeeEditHistory, isAdmin, isMember, isModerator } from "../forum/permissions.js";
import type { Board, CategoryWithBoards, Post, Thread, ThreadListItem } from "../forum/types.js";
import type { Page } from "../lib/pagination.js";
import { formatMonthYear } from "../lib/time.js";
import { Avatar, BotBadge, Crumbs, ErrorNote, Pagination, Time, UserLink } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

const n = (x: number) => x.toLocaleString("en-US");

export function IndexPage(props: {
  ctx: PageCtx;
  categories: CategoryWithBoards[];
  online: { username: string; isBot: boolean }[];
}) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx}>
      {props.categories.map((cat) => (
        <table class="grid">
          <thead>
            <tr class="cat-row">
              <th scope="col" class="col-main">
                {cat.name}
              </th>
              <th scope="col" class="col-num">
                Threads
              </th>
              <th scope="col" class="col-num">
                Posts
              </th>
              <th scope="col" class="col-last">
                Last post
              </th>
            </tr>
          </thead>
          <tbody>
            {cat.boards.map((b) => (
              <tr>
                <td class="col-main">
                  <a class="board-name" href={ctx.url(`/b/${b.slug}`)}>
                    {b.name}
                  </a>
                  {b.unread && <span class="badge badge-new">New</span>}
                  {b.membersOnly && <span class="badge badge-private">Members only</span>}
                  <div class="desc">{b.description}</div>
                </td>
                <td class="col-num">{n(b.threadCount)}</td>
                <td class="col-num">{n(b.postCount)}</td>
                <td class="col-last">
                  {b.lastPost ? (
                    <>
                      <a href={ctx.url(`/p/${b.lastPost.postId}`)} class="last-title">
                        {b.lastPost.threadTitle}
                      </a>
                      <div class="meta">
                        by <UserLink ctx={ctx} username={b.lastPost.authorName} />, <Time d={b.lastPost.at} />
                      </div>
                    </>
                  ) : (
                    <span class="meta">No posts yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {ctx.viewer && (
        <form method="post" action={ctx.url("/mark-read")} class="toolbar-form">
          <button type="submit" class="linkish">
            Mark all read
          </button>
        </form>
      )}
      <section class="panel online">
        <h2 class="panel-head">Who's online</h2>
        <div class="panel-body">
          {props.online.length === 0 ? (
            <span class="meta">Nobody in the last {config.online.window_minutes} minutes.</span>
          ) : (
            <>
              <span class="meta">
                {props.online.length} in the last {config.online.window_minutes} minutes:{" "}
              </span>
              {props.online.map((u, i) => (
                <>
                  {i > 0 && ", "}
                  <UserLink ctx={ctx} username={u.username} />
                  {u.isBot && <BotBadge />}
                </>
              ))}
            </>
          )}
        </div>
      </section>
    </Layout>
  );
}

export function BoardPage(props: {
  ctx: PageCtx;
  board: Board;
  threads: ThreadListItem[];
  page: Page;
  canPost: boolean;
}) {
  const { ctx, board } = props;
  const newThread = props.canPost ? (
    <a class="button" href={ctx.url(`/b/${board.slug}/new`)}>
      New thread
    </a>
  ) : null;
  return (
    <Layout ctx={ctx} title={board.name}>
      <Crumbs ctx={ctx} trail={[{ label: board.name }]} />
      <h1 class="page-title">{board.name}</h1>
      {board.description && <p class="desc">{board.description}</p>}
      {!board.membersOnly && (
        <p class="meta">
          <a href={ctx.url(`/b/${board.slug}/rss.xml`)}>RSS feed</a>
        </p>
      )}
      <div class="toolbar">
        {newThread}
        <Pagination ctx={ctx} base={`/b/${board.slug}`} page={props.page} />
      </div>
      <table class="grid">
        <thead>
          <tr class="cat-row">
            <th scope="col" class="col-main">
              Thread
            </th>
            <th scope="col" class="col-num">
              Replies
            </th>
            <th scope="col" class="col-last">
              Last post
            </th>
          </tr>
        </thead>
        <tbody>
          {props.threads.length === 0 && (
            <tr>
              <td colspan={3} class="empty">
                No threads yet.
              </td>
            </tr>
          )}
          {props.threads.map((t) => (
            <tr class={t.sticky ? "sticky" : undefined}>
              <td class="col-main">
                {t.sticky && <span class="badge badge-sticky">Sticky</span>}
                {t.locked && <span class="badge badge-locked">Locked</span>}
                {t.unread && (
                  <a class="badge badge-new" href={ctx.url(`/t/${t.id}/unread`)} title="Go to the first unread post">
                    New
                  </a>
                )}
                <a class="thread-title" href={ctx.url(`/t/${t.id}`)}>
                  {t.title}
                </a>
                <ThreadPages ctx={ctx} thread={t} />
                <div class="meta">
                  by <UserLink ctx={ctx} username={t.authorName} />, <Time d={t.createdAt} />
                </div>
              </td>
              <td class="col-num">{n(t.replyCount)}</td>
              <td class="col-last">
                {t.lastPostId !== null && t.lastPostAuthorName !== null && (
                  <>
                    <a href={ctx.url(`/p/${t.lastPostId}`)}>
                      <Time d={t.lastPostAt} />
                    </a>
                    <div class="meta">
                      by <UserLink ctx={ctx} username={t.lastPostAuthorName} />
                    </div>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="toolbar">
        {newThread}
        <Pagination ctx={ctx} base={`/b/${board.slug}`} page={props.page} />
      </div>
    </Layout>
  );
}

/** The little "1 2 3 … 9" jump links beside a long thread's title. */
function ThreadPages(props: { ctx: PageCtx; thread: ThreadListItem }) {
  const pages = Math.ceil((props.thread.replyCount + 1) / config.pagination.posts_per_page);
  if (pages <= 1) return null;
  const shown = pages <= 4 ? [...Array(pages).keys()].map((i) => i + 1) : [1, 2, null, pages - 1, pages];
  return (
    <span class="thread-pages">
      (
      {shown.map((p, i) => (
        <>
          {i > 0 && " "}
          {p === null ? "…" : <a href={props.ctx.url(p === 1 ? `/t/${props.thread.id}` : `/t/${props.thread.id}?page=${p}`)}>{p}</a>}
        </>
      ))}
      )
    </span>
  );
}

/** A post's multi-quote toggle state, on thread pages where the viewer can reply. */
export interface MultiQuoteState {
  selected: boolean;
  /** The selection holds as many posts as a reply can quote. */
  full: boolean;
}

export function PostView(props: { ctx: PageCtx; post: Post; thread: { locked: boolean }; multiQuote?: MultiQuoteState }) {
  const { ctx, post } = props;
  const v = ctx.viewer;
  const a = post.author;
  const removed = post.deleted;
  const actions: { label: string; href: string; multiQuote?: boolean }[] = [];
  if (!removed && canReply(v, props.thread)) {
    actions.push({ label: "Quote", href: `/t/${post.threadId}/reply?quote=${post.id}`, multiQuote: true });
  }
  if (canEditPost(v, { authorId: a.id, deleted: removed }, props.thread)) actions.push({ label: "Edit", href: `/p/${post.id}/edit` });
  if (post.editedAt && canSeeEditHistory(v, { authorId: a.id })) actions.push({ label: "History", href: `/p/${post.id}/history` });
  if (!removed && isMember(v) && v.id !== a.id) actions.push({ label: "Report", href: `/p/${post.id}/report` });
  if (isModerator(v)) actions.push({ label: "Moderate", href: `/p/${post.id}/moderate` });
  return (
    <article class="post" id={`p${post.id}`}>
      <aside class="post-author">
        <Avatar username={a.username} />
        <div class="author-name">
          <UserLink ctx={ctx} username={a.username} />
          {a.isBot && <BotBadge />}
        </div>
        {a.displayTitle && <div class="author-title">{a.displayTitle}</div>}
        <dl class="author-stats">
          <dt>Posts</dt>
          <dd>{n(a.postCount)}</dd>
          <dt>Joined</dt>
          <dd>{formatMonthYear(a.joinedAt)}</dd>
        </dl>
      </aside>
      <div class="post-main">
        <header class="post-head">
          <Time d={post.createdAt} />
          <a class="post-number" href={ctx.url(`/p/${post.id}`)} title="Link to this post">
            #{post.number}
          </a>
        </header>
        {removed ? (
          <div class="post-body removed">
            [removed by moderator]
            {isModerator(v) && post.deleteReason && <div class="meta">Reason: {post.deleteReason}</div>}
          </div>
        ) : (
          <div class="post-body">{raw(post.bodyHtml)}</div>
        )}
        {!removed && post.editedAt && (
          <p class="edited">
            Last edited by {post.editedByName ?? a.username}, <Time d={post.editedAt} />
          </p>
        )}
        {actions.length > 0 && (
          <footer class="post-actions">
            {actions.map((act, i) => (
              <>
                {i > 0 && " · "}
                <a href={ctx.url(act.href)}>{act.label}</a>
                {act.multiQuote && props.multiQuote && (
                  <> · <MultiQuoteToggle ctx={ctx} post={post} state={props.multiQuote} /></>
                )}
              </>
            ))}
          </footer>
        )}
      </div>
    </article>
  );
}

/** Lock, sticky and move, for moderators, at the foot of a thread. */
function ModPanel(props: { ctx: PageCtx; thread: Thread; boards: { slug: string; name: string }[] }) {
  const { ctx, thread } = props;
  const action = ctx.url(`/t/${thread.id}/mod`);
  return (
    <section class="panel mod-panel">
      <h2 class="panel-head">Moderation</h2>
      <div class="panel-body">
        <form method="post" action={action} class="inline-fields">
          <label>
            Reason <span class="hint">(shown in the mod log; needed to lock)</span>
            <input type="text" name="reason" maxlength={config.limits.reason_max} />
          </label>
          <button type="submit" name="action" value={thread.locked ? "unlock" : "lock"}>
            {thread.locked ? "Unlock" : "Lock"}
          </button>
          <button type="submit" name="action" value={thread.sticky ? "unsticky" : "sticky"}>
            {thread.sticky ? "Unstick" : "Make sticky"}
          </button>
        </form>
        <form method="post" action={action} class="inline-fields">
          <input type="hidden" name="action" value="move" />
          <label>
            Move to
            <select name="board">
              {props.boards.map((b) => (
                <option value={b.slug} selected={b.slug === thread.board.slug}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <input type="text" name="reason" maxlength={config.limits.reason_max} required />
          </label>
          <button type="submit">Move</button>
        </form>
        {isAdmin(ctx.viewer) && !thread.isRules && !thread.board.membersOnly && (
          <form method="post" action={action} class="inline-fields">
            <button type="submit" name="action" value="set_rules">
              Make this the site rules
            </button>
            <span class="hint">The opening post becomes what /rules shows and the moderator goes by.</span>
          </form>
        )}
      </div>
    </section>
  );
}

/** Ticks a post for quoting in the next reply; the selection carries across the thread's pages. */
function MultiQuoteToggle(props: { ctx: PageCtx; post: Post; state: MultiQuoteState }) {
  const { ctx, post, state } = props;
  return (
    <form method="post" action={ctx.url(`/t/${post.threadId}/multiquote`)} class="inline-form">
      <input type="hidden" name="post" value={String(post.id)} />
      <input type="hidden" name="back" value={ctx.here} />
      <button
        type="submit"
        name="op"
        value={state.selected ? "remove" : "add"}
        class="linkish multiquote"
        aria-pressed={state.selected ? "true" : "false"}
        disabled={!state.selected && state.full}
        title={
          state.selected
            ? "Selected to quote in your reply. Click to unselect."
            : state.full
              ? `A reply can quote at most ${config.limits.multiquote_max} posts.`
              : "Select this post to quote in your reply, with others from any page of the thread."
        }
      >
        {state.selected ? "✓ Multi-quote" : "+ Multi-quote"}
      </button>
    </form>
  );
}

export function ThreadPage(props: {
  ctx: PageCtx;
  thread: Thread;
  posts: Post[];
  page: Page;
  canReply: boolean;
  /** Posts selected for multi-quote, from any page of the thread. */
  quoting: number[];
  /** Boards a moderator can move this thread to; empty for everyone else. */
  moveTargets: { slug: string; name: string }[];
  /** The Fritter Post article card, for a thread that discusses one. */
  articleCard?: Child;
}) {
  const { ctx, thread } = props;
  const quoting = props.quoting.length;
  const quotes = quoting === 1 ? "1 quote" : `${quoting} quotes`;
  const multiQuote = (p: Post): MultiQuoteState | undefined =>
    props.canReply ? { selected: props.quoting.includes(p.id), full: quoting >= config.limits.multiquote_max } : undefined;
  return (
    <Layout ctx={ctx} title={thread.title}>
      <Crumbs ctx={ctx} trail={[{ label: thread.board.name, href: `/b/${thread.board.slug}` }, { label: thread.title }]} />
      <h1 class="page-title">
        {thread.sticky && <span class="badge badge-sticky">Sticky</span>}
        {thread.locked && <span class="badge badge-locked">Locked</span>}
        {thread.title}
      </h1>
      {props.articleCard}
      <div class="toolbar">
        {props.canReply && (
          <a class="button" href={ctx.url(`/t/${thread.id}/reply`)}>
            {quoting > 0 ? `Reply with ${quotes}` : "Reply"}
          </a>
        )}
        <Pagination ctx={ctx} base={`/t/${thread.id}`} page={props.page} />
      </div>
      <div class="posts">
        {props.posts.map((p) => (
          <PostView ctx={ctx} post={p} thread={thread} multiQuote={multiQuote(p)} />
        ))}
      </div>
      <div class="toolbar">
        <Pagination ctx={ctx} base={`/t/${thread.id}`} page={props.page} />
      </div>
      {props.canReply ? (
        <section class="panel" id="quick-reply">
          <h2 class="panel-head">Quick reply</h2>
          <div class="panel-body">
            {quoting > 0 && (
              <form method="post" action={ctx.url(`/t/${thread.id}/multiquote`)} class="multiquote-note hint">
                <input type="hidden" name="back" value={ctx.here} />
                {quoting === 1 ? "1 post is" : `${quoting} posts are`} selected to quote.{" "}
                <button type="submit" name="op" value="clear" class="linkish">
                  Unselect all
                </button>
              </form>
            )}
            <form method="post" action={ctx.url(`/t/${thread.id}/reply`)} class="compose">
              <textarea name="body" rows={6} required maxlength={config.limits.post_body_max} aria-label="Reply" data-editor></textarea>
              <div class="form-actions">
                <button type="submit" name="action" value="post">
                  Post reply
                </button>
                <button type="submit" name="action" value="preview" class="secondary">
                  Preview
                </button>
                {quoting > 0 && (
                  <button type="submit" name="action" value="quote" class="secondary" formnovalidate>
                    Add {quotes}
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      ) : thread.locked ? (
        <p class="notice">This thread is locked.</p>
      ) : ctx.viewer === null ? (
        <p class="notice">
          <a href={ctx.url(`/login?next=${encodeURIComponent(ctx.here)}`)}>Log in</a> to reply.
        </p>
      ) : null}
      {isModerator(ctx.viewer) && <ModPanel ctx={ctx} thread={thread} boards={props.moveTargets} />}
    </Layout>
  );
}

export const MARKUP_HELP =
  "[b]bold[/b]  [i]italic[/i]  [u]underline[/u]  [s]strike[/s]  [quote]…[/quote]  [code]…[/code]  [list][*]one [*]two[/list]  [list=1]…[/list]  [url=https://…]link[/url]";

export function ComposePage(props: {
  ctx: PageCtx;
  /** "article" starts the thread for a Fritter Post article, shown above the form. */
  mode: "thread" | "reply" | "article";
  board: Board;
  thread?: Thread;
  article?: { id: number; card: Child };
  title: string;
  body: string;
  previewHtml: string | null;
  error: string | null;
}) {
  const { ctx, board, thread, article } = props;
  const startsThread = props.mode !== "reply";
  const heading =
    props.mode === "thread"
      ? `New thread in ${board.name}`
      : props.mode === "article"
        ? `Start the discussion in ${board.name}`
        : `Reply to “${thread!.title}”`;
  const action =
    props.mode === "thread"
      ? `/b/${board.slug}/new`
      : props.mode === "article"
        ? `/article/${article!.id}`
        : `/t/${thread!.id}/reply`;
  const trail = startsThread
    ? [{ label: board.name, href: `/b/${board.slug}` }, { label: "New thread" }]
    : [
        { label: board.name, href: `/b/${board.slug}` },
        { label: thread!.title, href: `/t/${thread!.id}` },
        { label: "Reply" },
      ];
  return (
    <Layout ctx={ctx} title={heading}>
      <Crumbs ctx={ctx} trail={trail} />
      <h1 class="page-title">{heading}</h1>
      {article?.card}
      <ErrorNote message={props.error} />
      {props.previewHtml !== null && (
        <section class="panel preview">
          <h2 class="panel-head">Preview</h2>
          <div class="panel-body post-body">{raw(props.previewHtml)}</div>
        </section>
      )}
      <form method="post" action={ctx.url(action)} class="compose">
        {startsThread && (
          <label>
            Title
            <input type="text" name="title" value={props.title} required maxlength={config.limits.thread_title_max} />
          </label>
        )}
        <label>
          Message
          <textarea name="body" rows={14} required maxlength={config.limits.post_body_max} data-editor>
            {props.body}
          </textarea>
        </label>
        <p class="hint">{MARKUP_HELP}</p>
        <div class="form-actions">
          <button type="submit" name="action" value="post">
            {startsThread ? "Post thread" : "Post reply"}
          </button>
          <button type="submit" name="action" value="preview" class="secondary">
            Preview
          </button>
        </div>
      </form>
    </Layout>
  );
}
