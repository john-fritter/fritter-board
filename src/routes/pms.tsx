import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { listAllConversations, listInbox, readConversation, replyToConversation, sendNewMessage } from "../forum/pms.js";
import { InboxPage, NewMessagePage, ConversationPage } from "../views/pms.js";
import { formError, parseId, readForm, render } from "./util.js";

export function registerPmRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;

  // Every PM page needs a login; visitors are sent to log in and brought back.
  app.use("/pm/*", async (c, next) => {
    if (!c.get("viewer")) return c.redirect(url(`/login?next=${encodeURIComponent(c.get("page").here)}`), 303);
    await next();
  });
  app.use("/pm", async (c, next) => {
    if (!c.get("viewer")) return c.redirect(url(`/login?next=${encodeURIComponent("/pm")}`), 303);
    await next();
  });

  app.get("/pm", async (c) => {
    const { items, page } = await listInbox(forum, c.get("viewer"), c.req.query("page"));
    return render(c, <InboxPage ctx={c.get("page")} items={items} page={page} />);
  });

  app.get("/pm/new", (c) =>
    render(c, <NewMessagePage ctx={c.get("page")} to={c.req.query("to") ?? ""} subject="" body="" error={null} />)
  );

  app.post("/pm/new", async (c) => {
    const f = await readForm(c);
    try {
      const id = await sendNewMessage(forum, c.get("viewer"), f("to"), f("subject"), f("body"));
      return c.redirect(url(`/pm/${id}`), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(
        c,
        <NewMessagePage ctx={c.get("page")} to={f("to")} subject={f("subject")} body={f("body")} error={message} />,
        status
      );
    }
  });

  app.get("/pm/:id", async (c) => {
    const conv = await readConversation(forum, c.get("viewer"), parseId(c.req.param("id")), c.req.query("page"));
    return render(c, <ConversationPage ctx={c.get("page")} conv={conv} />);
  });

  app.post("/pm/:id/reply", async (c) => {
    const id = parseId(c.req.param("id"));
    const f = await readForm(c);
    const messageId = await replyToConversation(forum, c.get("viewer"), id, f("body"));
    return c.redirect(url(`/pm/${id}#m${messageId}`), 303);
  });

  app.get("/admin/pms", async (c) => {
    const { items, page } = await listAllConversations(forum, c.get("viewer"), c.req.query("page"));
    return render(c, <InboxPage ctx={c.get("page")} items={items} page={page} all />);
  });
}
