import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { createInvite, listInvites, revokeInvite } from "../forum/accounts.js";
import { notFound } from "../forum/errors.js";
import { isAdmin } from "../forum/permissions.js";
import { AdminPage } from "../views/members.js";
import { readForm, render } from "./util.js";

export function registerAdminRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url, env } = s;
  const inviteUrl = (code: string) => `${env.origin}${url(`/register?code=${encodeURIComponent(code)}`)}`;

  // Admin pages are invisible to everyone else.
  app.use("/admin/*", async (c, next) => {
    if (!isAdmin(c.get("viewer"))) throw notFound();
    await next();
  });
  app.use("/admin", async (c, next) => {
    if (!isAdmin(c.get("viewer"))) throw notFound();
    await next();
  });

  app.get("/admin", async (c) => {
    const invites = await listInvites(forum, c.get("viewer"));
    return render(
      c,
      <AdminPage ctx={c.get("page")} invites={invites} newCode={c.req.query("new") ?? null} inviteUrl={inviteUrl} />
    );
  });

  app.post("/admin/invites", async (c) => {
    const f = await readForm(c);
    const expiry = f("expiry");
    const days = expiry === "never" ? null : Number(expiry) > 0 ? Number(expiry) : null;
    const code = await createInvite(forum, c.get("viewer"), f("note"), days);
    return c.redirect(url(`/admin?new=${encodeURIComponent(code)}`), 303);
  });

  app.post("/admin/invites/revoke", async (c) => {
    const f = await readForm(c);
    await revokeInvite(forum, c.get("viewer"), f("code"));
    return c.redirect(url("/admin"), 303);
  });
}
