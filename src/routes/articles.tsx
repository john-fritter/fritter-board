import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { config } from "../config.js";
import { articleDiscussion } from "../forum/articles.js";
import { getBoard } from "../forum/boards.js";
import { ForumError } from "../forum/errors.js";
import { canPost } from "../forum/permissions.js";
import { createThread } from "../forum/threads.js";
import { articleTitle, clip } from "../fp/articles.js";
import { ArticleCard, ArticlePage } from "../views/articles.js";
import { ComposePage } from "../views/forum.js";
import { formError, parseId, readForm, render } from "./util.js";

/**
 * "Discuss on the board": where every Fritter Post article page links. It opens
 * the article's thread, or offers to start one. Threads start in the board
 * named by fritter_post.discussion_board; moderators can move them after.
 */
export function registerArticleRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;
  const discussionBoard = config.fritter_post.discussion_board;

  app.get("/article/:id", async (c) => {
    const viewer = c.get("viewer");
    const articleId = parseId(c.req.param("id"));
    const { article, threadId } = await articleDiscussion(forum, viewer, articleId);
    if (threadId !== null) return c.redirect(url(`/t/${threadId}`), 302);

    const found = { state: "ok" as const, article };
    const href = s.articleHref(articleId);
    if (!canPost(viewer)) return render(c, <ArticlePage ctx={c.get("page")} article={found} href={href} />);

    const board = await getBoard(forum, viewer, discussionBoard);
    const title = clip(articleTitle(article), config.limits.thread_title_max);
    return render(
      c,
      <ComposePage
        ctx={c.get("page")}
        mode="article"
        board={board}
        article={{ id: articleId, card: <ArticleCard article={found} href={href} /> }}
        title={title}
        body=""
        previewHtml={null}
        error={null}
      />
    );
  });

  app.post("/article/:id", async (c) => {
    const viewer = c.get("viewer");
    const articleId = parseId(c.req.param("id"));
    const { article, threadId } = await articleDiscussion(forum, viewer, articleId);
    if (threadId !== null) return c.redirect(url(`/t/${threadId}`), 303);
    if (!canPost(viewer)) return c.redirect(url(`/article/${articleId}`), 303);

    const board = await getBoard(forum, viewer, discussionBoard);
    const f = await readForm(c);
    const title = f("title");
    const body = f("body");
    const card = <ArticleCard article={{ state: "ok", article }} href={s.articleHref(articleId)} />;
    const page = (previewHtml: string | null, error: string | null) => (
      <ComposePage
        ctx={c.get("page")}
        mode="article"
        board={board}
        article={{ id: articleId, card }}
        title={title}
        body={body}
        previewHtml={previewHtml}
        error={error}
      />
    );
    if (f("action") === "preview") return render(c, page(forum.renderMarkup(body), null));
    try {
      const created = await createThread(forum, viewer, board.id, title, body, { fpArticleId: articleId });
      return c.redirect(url(`/t/${created.threadId}`), 303);
    } catch (err) {
      // Someone else started it a moment ago: join theirs.
      if (err instanceof ForumError && err.status === 409) {
        const again = await articleDiscussion(forum, viewer, articleId);
        if (again.threadId !== null) return c.redirect(url(`/t/${again.threadId}`), 303);
      }
      const { message, status } = formError(err);
      return render(c, page(null, message), status);
    }
  });
}
