import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { getBoard, listIndex, listThreads } from "../forum/boards.js";
import { canPost, canReply } from "../forum/permissions.js";
import { createThread, getPost, getThread, listPosts, locatePost, reply } from "../forum/threads.js";
import { whoIsOnline } from "../forum/users.js";
import { quoteFor } from "../markup/bbcode.js";
import { BoardPage, ComposePage, IndexPage, ThreadPage } from "../views/forum.js";
import { formError, parseId, readForm, render } from "./util.js";

export function registerForumRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;
  const loginFirst = (here: string) => url(`/login?next=${encodeURIComponent(here)}`);

  app.get("/", async (c) => {
    const viewer = c.get("viewer");
    const [categories, online] = await Promise.all([listIndex(forum, viewer), whoIsOnline(forum)]);
    return render(c, <IndexPage ctx={c.get("page")} categories={categories} online={online} />);
  });

  app.get("/b/:slug", async (c) => {
    const viewer = c.get("viewer");
    const board = await getBoard(forum, viewer, c.req.param("slug"));
    const { threads, page } = await listThreads(forum, board, c.req.query("page"));
    return render(
      c,
      <BoardPage ctx={c.get("page")} board={board} threads={threads} page={page} canPost={canPost(viewer)} />
    );
  });

  app.get("/b/:slug/new", async (c) => {
    const viewer = c.get("viewer");
    const board = await getBoard(forum, viewer, c.req.param("slug"));
    if (!canPost(viewer)) return c.redirect(loginFirst(c.get("page").here), 303);
    return render(
      c,
      <ComposePage ctx={c.get("page")} mode="thread" board={board} title="" body="" previewHtml={null} error={null} />
    );
  });

  app.post("/b/:slug/new", async (c) => {
    const viewer = c.get("viewer");
    const board = await getBoard(forum, viewer, c.req.param("slug"));
    const f = await readForm(c);
    const title = f("title");
    const body = f("body");
    const page = (previewHtml: string | null, error: string | null) => (
      <ComposePage ctx={c.get("page")} mode="thread" board={board} title={title} body={body} previewHtml={previewHtml} error={error} />
    );
    if (f("action") === "preview") return render(c, page(forum.renderMarkup(body), null));
    try {
      const { threadId } = await createThread(forum, viewer, board.id, title, body);
      return c.redirect(url(`/t/${threadId}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, page(null, message), status);
    }
  });

  app.get("/t/:id", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    const { posts, page } = await listPosts(forum, thread, c.req.query("page"));
    return render(
      c,
      <ThreadPage ctx={c.get("page")} thread={thread} posts={posts} page={page} canReply={canReply(viewer, thread)} />
    );
  });

  app.get("/t/:id/reply", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    if (!canReply(viewer, thread)) {
      if (viewer === null) return c.redirect(loginFirst(c.get("page").here), 303);
      return c.redirect(url(`/t/${thread.id}`), 303);
    }
    let body = "";
    const quoteId = c.req.query("quote");
    if (quoteId) {
      const quoted = await getPost(forum, viewer, parseId(quoteId));
      if (quoted.threadId === thread.id && !quoted.deleted) body = quoteFor(quoted.authorName, quoted.id, quoted.body);
    }
    return render(
      c,
      <ComposePage ctx={c.get("page")} mode="reply" board={thread.board} thread={thread} title="" body={body} previewHtml={null} error={null} />
    );
  });

  app.post("/t/:id/reply", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    const body = f("body");
    const page = (previewHtml: string | null, error: string | null) => (
      <ComposePage ctx={c.get("page")} mode="reply" board={thread.board} thread={thread} title="" body={body} previewHtml={previewHtml} error={error} />
    );
    if (f("action") === "preview") return render(c, page(forum.renderMarkup(body), null));
    try {
      const { postId } = await reply(forum, viewer, thread.id, body);
      return c.redirect(url(`/p/${postId}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, page(null, message), status);
    }
  });

  app.get("/p/:id", async (c) => {
    const postId = parseId(c.req.param("id"));
    const { threadId, page } = await locatePost(forum, c.get("viewer"), postId);
    const query = page > 1 ? `?page=${page}` : "";
    return c.redirect(url(`/t/${threadId}${query}#p${postId}`), 302);
  });
}
