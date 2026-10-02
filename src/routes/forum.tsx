import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { config } from "../config.js";
import { articleForThread } from "../forum/articles.js";
import { getBoard, listIndex, listThreads, listVisibleBoards } from "../forum/boards.js";
import { invalid } from "../forum/errors.js";
import { boardFeed } from "../forum/feeds.js";
import { isThreadFlagAction, moveThread, setThreadFlag } from "../forum/moderation.js";
import { getRules, setRulesThread } from "../forum/rules.js";
import { canPost, canReply, isModerator } from "../forum/permissions.js";
import { firstUnreadPostId, markAllRead, markThreadRead } from "../forum/reads.js";
import { search } from "../forum/search.js";
import { createThread, getThread, listPosts, locatePost, quotablePosts, reply } from "../forum/threads.js";
import { whoIsOnline } from "../forum/users.js";
import { quotesFor } from "../markup/bbcode.js";
import { ArticleCard } from "../views/articles.js";
import { BoardPage, ComposePage, IndexPage, ThreadPage } from "../views/forum.js";
import { SearchPage } from "../views/search.js";
import { rssXml } from "./rss.js";
import { clearSelection, readSelection, saveSelection } from "./multiquote.js";
import { formError, parseId, readForm, render, safeNext } from "./util.js";

export function registerForumRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url, env } = s;
  const loginFirst = (here: string) => url(`/login?next=${encodeURIComponent(here)}`);

  app.get("/", async (c) => {
    const viewer = c.get("viewer");
    const [categories, online] = await Promise.all([listIndex(forum, viewer), whoIsOnline(forum)]);
    return render(c, <IndexPage ctx={c.get("page")} categories={categories} online={online} />);
  });

  app.get("/b/:slug", async (c) => {
    const viewer = c.get("viewer");
    const board = await getBoard(forum, viewer, c.req.param("slug"));
    const { threads, page } = await listThreads(forum, viewer, board, c.req.query("page"));
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
    const { posts, page } = await listPosts(forum, viewer, thread, c.req.query("page"));
    const lastOnPage = posts[posts.length - 1];
    if (viewer && lastOnPage) await markThreadRead(forum, viewer, thread.id, lastOnPage.id);
    const replies = canReply(viewer, thread);
    const selection = replies ? readSelection(c, thread.id) : [];
    const [moveTargets, article, quoting] = await Promise.all([
      isModerator(viewer) ? listVisibleBoards(forum, viewer) : Promise.resolve([]),
      thread.fpArticleId !== null ? articleForThread(forum, thread.fpArticleId) : Promise.resolve(null),
      selection.length > 0 ? quotablePosts(forum, thread, selection) : Promise.resolve([]),
    ]);
    return render(
      c,
      <ThreadPage
        ctx={c.get("page")}
        thread={thread}
        posts={posts}
        page={page}
        canReply={replies}
        quoting={quoting.map((p) => p.id)}
        moveTargets={moveTargets}
        articleCard={
          article && thread.fpArticleId !== null && (
            <ArticleCard article={article} href={s.articleHref(thread.fpArticleId)} />
          )
        }
      />
    );
  });

  // The "New" badge: jump to the first post the member hasn't read.
  app.get("/t/:id/unread", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    const postId = viewer ? await firstUnreadPostId(forum, viewer, thread.id) : null;
    return c.redirect(url(postId ? `/p/${postId}` : `/t/${thread.id}`), 302);
  });

  app.post("/t/:id/mod", async (c) => {
    const viewer = c.get("viewer");
    const threadId = parseId(c.req.param("id"));
    const f = await readForm(c);
    const action = f("action");
    if (action === "move") await moveThread(forum, viewer, threadId, f("board"), f("reason"));
    else if (action === "set_rules") await setRulesThread(forum, viewer, threadId);
    else if (isThreadFlagAction(action)) await setThreadFlag(forum, viewer, threadId, action, f("reason"));
    else throw invalid("Unknown moderation action.");
    return c.redirect(url(`/t/${threadId}`), 303);
  });

  app.get("/rules", async (c) => {
    const { thread } = await getRules(forum, c.get("viewer"));
    return c.redirect(url(`/t/${thread.id}`), 302);
  });

  app.post("/mark-read", async (c) => {
    const viewer = c.get("viewer");
    if (viewer) await markAllRead(forum, viewer);
    return c.redirect(url("/"), 303);
  });

  app.get("/b/:slug/rss.xml", async (c) => {
    const { board, items } = await boardFeed(forum, c.req.param("slug"));
    c.header("Content-Type", "application/rss+xml; charset=utf-8");
    return c.body(rssXml(s.env.origin, url, board, items));
  });

  app.get("/search", async (c) => {
    const viewer = c.get("viewer");
    const q = c.req.query("q") ?? "";
    const author = c.req.query("author") ?? "";
    const board = c.req.query("board") ?? "";
    const sort = c.req.query("sort") === "relevance" ? "relevance" : "newest";
    const boards = await listVisibleBoards(forum, viewer);
    const searched = q.trim() !== "" || author.trim() !== "";
    const result = await search(
      forum,
      viewer,
      { q, author, boardSlug: board || undefined, sort },
      c.req.query("page")
    );
    return render(
      c,
      <SearchPage
        ctx={c.get("page")}
        q={q}
        author={author}
        board={board}
        sort={sort}
        boards={boards}
        hits={result.hits}
        total={result.total}
        page={result.page}
        searched={searched}
        error={null}
      />
    );
  });

  // Opens the reply form with the multi-quote selection quoted, and the post
  // whose Quote link was followed, all in thread order.
  app.get("/t/:id/reply", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    if (!canReply(viewer, thread)) {
      if (viewer === null) return c.redirect(loginFirst(c.get("page").here), 303);
      return c.redirect(url(`/t/${thread.id}`), 303);
    }
    const selection = readSelection(c, thread.id);
    const quoteParam = c.req.query("quote");
    const quoteId = quoteParam ? parseId(quoteParam) : null;
    const ids = quoteId !== null
      ? [...selection.filter((id) => id !== quoteId).slice(0, config.limits.multiquote_max - 1), quoteId]
      : selection;
    const body = quotesFor(await quotablePosts(forum, thread, ids));
    return render(
      c,
      <ComposePage ctx={c.get("page")} mode="reply" board={thread.board} thread={thread} title="" body={body} previewHtml={null} error={null} />
    );
  });

  app.post("/t/:id/reply", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    const page = (body: string, previewHtml: string | null, error: string | null) => (
      <ComposePage ctx={c.get("page")} mode="reply" board={thread.board} thread={thread} title="" body={body} previewHtml={previewHtml} error={error} />
    );
    const body = f("body");
    if (f("action") === "preview") return render(c, page(body, forum.renderMarkup(body), null));
    // Quick reply's "Add quotes": the full form, the selection quoted above the draft.
    if (f("action") === "quote") {
      if (!canReply(viewer, thread)) return c.redirect(url(`/t/${thread.id}`), 303);
      const quotes = quotesFor(await quotablePosts(forum, thread, readSelection(c, thread.id)));
      return render(c, page(quotes + body, null, null));
    }
    try {
      const { postId } = await reply(forum, viewer, thread.id, body);
      if (readSelection(c, thread.id).length > 0) clearSelection(c, env);
      return c.redirect(url(`/p/${postId}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, page(body, null, message), status);
    }
  });

  // Ticks or unticks a post for multi-quote, or clears the selection, then
  // goes back to where the member was.
  app.post("/t/:id/multiquote", async (c) => {
    const viewer = c.get("viewer");
    const thread = await getThread(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    const back = url(safeNext(f("back")));
    if (!canReply(viewer, thread)) return c.redirect(back, 303);
    const op = f("op");
    if (op === "clear") {
      clearSelection(c, env);
      return c.redirect(`${back}#quick-reply`, 303);
    }
    const postId = /^\d{1,15}$/.test(f("post")) ? Number(f("post")) : null;
    if (postId === null) return c.redirect(back, 303);
    let ids = readSelection(c, thread.id);
    if (op === "remove") ids = ids.filter((id) => id !== postId);
    else if (op === "add" && !ids.includes(postId) && ids.length < config.limits.multiquote_max) {
      if ((await quotablePosts(forum, thread, [postId])).length > 0) ids = [...ids, postId];
    }
    saveSelection(c, env, thread.id, ids);
    return c.redirect(`${back}#p${postId}`, 303);
  });

  app.get("/p/:id", async (c) => {
    const postId = parseId(c.req.param("id"));
    const { threadId, page } = await locatePost(forum, c.get("viewer"), postId);
    const query = page > 1 ? `?page=${page}` : "";
    return c.redirect(url(`/t/${threadId}${query}#p${postId}`), 302);
  });
}
