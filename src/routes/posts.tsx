import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { invalid, notFound } from "../forum/errors.js";
import { removePost, reportPost, restorePost } from "../forum/moderation.js";
import { canEditPost, isModerator } from "../forum/permissions.js";
import { editPost, postHistory } from "../forum/posts.js";
import { getPost } from "../forum/threads.js";
import { EditPostPage, HistoryPage, ModeratePostPage, ReportPage } from "../views/posts.js";
import { formError, parseId, readForm, render } from "./util.js";

export function registerPostRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;

  app.get("/p/:id/edit", async (c) => {
    const viewer = c.get("viewer");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    if (!canEditPost(viewer, post, { locked: post.threadLocked })) return c.redirect(url(`/p/${post.id}`), 303);
    return render(
      c,
      <EditPostPage ctx={c.get("page")} post={post} title={post.threadTitle} body={post.body} previewHtml={null} error={null} />
    );
  });

  app.post("/p/:id/edit", async (c) => {
    const viewer = c.get("viewer");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    const title = post.isFirstPost ? f("title") : undefined;
    const page = (previewHtml: string | null, error: string | null) => (
      <EditPostPage ctx={c.get("page")} post={post} title={title ?? ""} body={f("body")} previewHtml={previewHtml} error={error} />
    );
    if (f("action") === "preview") return render(c, page(forum.renderMarkup(f("body")), null));
    try {
      await editPost(forum, viewer, post.id, f("body"), title);
      return c.redirect(url(`/p/${post.id}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, page(null, message), status);
    }
  });

  app.get("/p/:id/history", async (c) => {
    const { post, versions } = await postHistory(forum, c.get("viewer"), parseId(c.req.param("id")));
    return render(c, <HistoryPage ctx={c.get("page")} post={post} versions={versions} />);
  });

  app.get("/p/:id/report", async (c) => {
    const viewer = c.get("viewer");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    if (!viewer) return c.redirect(url(`/login?next=${encodeURIComponent(c.get("page").here)}`), 303);
    return render(c, <ReportPage ctx={c.get("page")} post={post} reason="" error={null} sent={c.req.query("sent") === "1"} />);
  });

  app.post("/p/:id/report", async (c) => {
    const viewer = c.get("viewer");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    try {
      await reportPost(forum, viewer, post.id, f("reason"));
      return c.redirect(url(`/p/${post.id}/report?sent=1`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, <ReportPage ctx={c.get("page")} post={post} reason={f("reason")} error={message} sent={false} />, status);
    }
  });

  app.get("/p/:id/moderate", async (c) => {
    const viewer = c.get("viewer");
    if (!isModerator(viewer)) throw notFound("That page");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    return render(c, <ModeratePostPage ctx={c.get("page")} post={post} error={null} />);
  });

  app.post("/p/:id/moderate", async (c) => {
    const viewer = c.get("viewer");
    const post = await getPost(forum, viewer, parseId(c.req.param("id")));
    const f = await readForm(c);
    try {
      if (f("action") === "remove") await removePost(forum, viewer, post.id, f("reason"));
      else if (f("action") === "restore") await restorePost(forum, viewer, post.id, f("reason"));
      else throw invalid("Unknown moderation action.");
      return c.redirect(url(`/p/${post.id}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, <ModeratePostPage ctx={c.get("page")} post={post} error={message} />, status);
    }
  });
}
