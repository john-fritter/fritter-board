import type { Hono } from "hono";
import type { AppEnv, Services } from "../app.js";
import { getProfile, listMembers, recentPosts } from "../forum/users.js";
import { MembersPage, ProfilePage } from "../views/members.js";
import { render } from "./util.js";

export function registerMemberRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum } = s;

  app.get("/members", async (c) => {
    const { members, page } = await listMembers(forum, c.req.query("page"));
    return render(c, <MembersPage ctx={c.get("page")} members={members} page={page} />);
  });

  app.get("/u/:username", async (c) => {
    const profile = await getProfile(forum, c.req.param("username"));
    const posts = await recentPosts(forum, c.get("viewer"), profile.author.id);
    return render(c, <ProfilePage ctx={c.get("page")} profile={profile} posts={posts} />);
  });
}
