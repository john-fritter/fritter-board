import { raw } from "hono/html";
import { config } from "../config.js";
import { canRestorePost } from "../forum/permissions.js";
import type { PostVersion } from "../forum/posts.js";
import type { VisiblePost } from "../forum/threads.js";
import { Crumbs, ErrorNote, Time } from "./components.js";
import type { PageCtx } from "./context.js";
import { MARKUP_HELP } from "./forum.js";
import { Layout } from "./layout.js";

function postTrail(post: VisiblePost, last: string) {
  return [
    { label: post.boardName, href: `/b/${post.boardSlug}` },
    { label: post.threadTitle, href: `/p/${post.id}` },
    { label: last },
  ];
}

export function EditPostPage(props: {
  ctx: PageCtx;
  post: VisiblePost;
  title: string;
  body: string;
  previewHtml: string | null;
  error: string | null;
}) {
  const { ctx, post } = props;
  return (
    <Layout ctx={ctx} title="Edit post">
      <Crumbs ctx={ctx} trail={postTrail(post, "Edit")} />
      <h1 class="page-title">Edit post</h1>
      <ErrorNote message={props.error} />
      {props.previewHtml !== null && (
        <section class="panel preview">
          <h2 class="panel-head">Preview</h2>
          <div class="panel-body post-body">{raw(props.previewHtml)}</div>
        </section>
      )}
      <form method="post" action={ctx.url(`/p/${post.id}/edit`)} class="compose">
        {post.isFirstPost && (
          <label>
            Thread title
            <input type="text" name="title" value={props.title} required maxlength={config.limits.thread_title_max} />
          </label>
        )}
        <label>
          Message
          <textarea name="body" rows={14} required maxlength={config.limits.post_body_max}>
            {props.body}
          </textarea>
        </label>
        <p class="hint">{MARKUP_HELP}</p>
        <p class="hint">The previous version is kept in the post's edit history.</p>
        <div class="form-actions">
          <button type="submit" name="action" value="save">
            Save changes
          </button>
          <button type="submit" name="action" value="preview" class="secondary">
            Preview
          </button>
        </div>
      </form>
    </Layout>
  );
}

export function HistoryPage(props: { ctx: PageCtx; post: VisiblePost; versions: PostVersion[] }) {
  const { ctx, post } = props;
  return (
    <Layout ctx={ctx} title="Edit history">
      <Crumbs ctx={ctx} trail={postTrail(post, "Edit history")} />
      <h1 class="page-title">Edit history</h1>
      <p class="meta">
        Post by {post.authorName}, <Time d={post.createdAt} />. Newest version first.
      </p>
      {props.versions.map((v, i) => (
        <section class="panel">
          <h2 class="panel-head">
            {i === 0 ? (
              "Current version"
            ) : (
              <>
                Version {props.versions.length - i}, replaced by {v.replacedByName}, <Time d={v.replacedAt!} />
              </>
            )}
          </h2>
          <div class="panel-body post-body">{raw(v.bodyHtml)}</div>
        </section>
      ))}
    </Layout>
  );
}

export function ReportPage(props: { ctx: PageCtx; post: VisiblePost; reason: string; error: string | null; sent: boolean }) {
  const { ctx, post } = props;
  return (
    <Layout ctx={ctx} title="Report a post">
      <Crumbs ctx={ctx} trail={postTrail(post, "Report")} />
      <section class="panel">
        <h1 class="panel-head">Report a post by {post.authorName}</h1>
        <div class="panel-body">
          {props.sent ? (
            <p class="notice">
              Thanks. The moderators will take a look. <a href={ctx.url(`/p/${post.id}`)}>Back to the thread</a>
            </p>
          ) : (
            <>
              <div class="post-body excerpt">{raw(post.bodyHtml)}</div>
              <ErrorNote message={props.error} />
              <form method="post" action={ctx.url(`/p/${post.id}/report`)} class="stacked">
                <label>
                  What's wrong with it?
                  <input type="text" name="reason" value={props.reason} required maxlength={config.limits.reason_max} />
                </label>
                <div class="form-actions">
                  <button type="submit">Send report</button>
                </div>
              </form>
            </>
          )}
        </div>
      </section>
    </Layout>
  );
}

export function ModeratePostPage(props: { ctx: PageCtx; post: VisiblePost; error: string | null }) {
  const { ctx, post } = props;
  return (
    <Layout ctx={ctx} title="Moderate a post">
      <Crumbs ctx={ctx} trail={postTrail(post, "Moderate")} />
      <section class="panel">
        <h1 class="panel-head">
          Post by {post.authorName}, <Time d={post.createdAt} />
        </h1>
        <div class="panel-body">
          <div class="post-body excerpt">{raw(post.bodyHtml)}</div>
          <ErrorNote message={props.error} />
          {post.deleted ? (
            <>
              <p class="notice">Removed. Reason: {post.deleteReason}</p>
              {canRestorePost(ctx.viewer) ? (
                <form method="post" action={ctx.url(`/p/${post.id}/moderate`)} class="stacked">
                  <input type="hidden" name="action" value="restore" />
                  <label>
                    Reason for restoring <span class="hint">(shown in the mod log)</span>
                    <input type="text" name="reason" maxlength={config.limits.reason_max} />
                  </label>
                  <div class="form-actions">
                    <button type="submit">Restore post</button>
                  </div>
                </form>
              ) : (
                <p class="meta">Only the admin can restore a removed post.</p>
              )}
            </>
          ) : (
            <form method="post" action={ctx.url(`/p/${post.id}/moderate`)} class="stacked">
              <input type="hidden" name="action" value="remove" />
              <label>
                Reason for removing <span class="hint">(required; shown in the mod log and to moderators)</span>
                <input type="text" name="reason" required maxlength={config.limits.reason_max} />
              </label>
              <div class="form-actions">
                <button type="submit">Remove post</button>
              </div>
            </form>
          )}
          <p class="meta">
            <a href={ctx.url(`/u/${encodeURIComponent(post.authorName)}/warn`)}>Warn {post.authorName}</a>
          </p>
        </div>
      </section>
    </Layout>
  );
}
