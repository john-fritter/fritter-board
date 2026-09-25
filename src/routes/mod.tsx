import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { invalid, notFound } from "../forum/errors.js";
import { listModLog, listOpenReports, resolveReport, setMemberStatus, warnMember } from "../forum/moderation.js";
import { isModerator } from "../forum/permissions.js";
import { getProfile, recentPosts } from "../forum/users.js";
import type { UserStatus } from "../forum/types.js";
import { ProfilePage } from "../views/members.js";
import { ModLogPage, ReportsPage, WarnPage } from "../views/moderation.js";
import { formError, parseId, readForm, render } from "./util.js";

const STATUSES: readonly UserStatus[] = ["active", "suspended", "banned"];

export function registerModRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url } = s;

  app.get("/modlog", async (c) => {
    const { entries, page } = await listModLog(forum, c.get("viewer"), c.req.query("page"));
    return render(c, <ModLogPage ctx={c.get("page")} entries={entries} page={page} />);
  });

  app.get("/mod/reports", async (c) => {
    const reports = await listOpenReports(forum, c.get("viewer"));
    return render(c, <ReportsPage ctx={c.get("page")} reports={reports} />);
  });

  app.post("/mod/reports/:id/resolve", async (c) => {
    const f = await readForm(c);
    await resolveReport(forum, c.get("viewer"), parseId(c.req.param("id")), f("resolution"));
    return c.redirect(url("/mod/reports"), 303);
  });

  app.get("/u/:username/warn", async (c) => {
    if (!isModerator(c.get("viewer"))) throw notFound("That page");
    const profile = await getProfile(forum, c.req.param("username"));
    return render(c, <WarnPage ctx={c.get("page")} username={profile.author.username} reason="" message="" error={null} />);
  });

  app.post("/u/:username/warn", async (c) => {
    const username = c.req.param("username");
    const f = await readForm(c);
    try {
      await warnMember(forum, c.get("viewer"), username, f("reason"), f("message"));
      return c.redirect(url("/modlog"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(
        c,
        <WarnPage ctx={c.get("page")} username={username} reason={f("reason")} message={f("message")} error={message} />,
        status
      );
    }
  });

  app.post("/u/:username/status", async (c) => {
    const viewer = c.get("viewer");
    const username = c.req.param("username");
    const f = await readForm(c);
    const status = f("status") as UserStatus;
    try {
      if (!STATUSES.includes(status)) throw invalid("Unknown standing.");
      await setMemberStatus(forum, viewer, username, status, f("reason"));
      return c.redirect(url(`/u/${encodeURIComponent(username)}`), 303);
    } catch (err) {
      const { message, status: code } = formError(err);
      const profile = await getProfile(forum, username);
      const posts = await recentPosts(forum, viewer, profile.author.id);
      return render(c, <ProfilePage ctx={c.get("page")} profile={profile} posts={posts} error={message} />, code);
    }
  });
}
