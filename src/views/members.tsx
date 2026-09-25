import { raw } from "hono/html";
import { config } from "../config.js";
import { canChangeMemberStatus, canPost, isModerator } from "../forum/permissions.js";
import type { InviteStatus } from "../forum/accounts.js";
import type { MemberListItem, Profile, RecentPost } from "../forum/users.js";
import type { Page } from "../lib/pagination.js";
import { formatDate } from "../lib/time.js";
import { Avatar, BotBadge, Crumbs, ErrorNote, Pagination, Time, UserLink } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

const n = (x: number) => x.toLocaleString("en-US");
const roleLabel = { member: null, moderator: "Moderator", admin: "Administrator" } as const;

const STATUS_LABELS = { active: null, suspended: "Suspended", banned: "Banned" } as const;

export function ProfilePage(props: { ctx: PageCtx; profile: Profile; posts: RecentPost[]; error?: string | null }) {
  const { ctx, profile } = props;
  const a = profile.author;
  const v = ctx.viewer;
  const self = v?.id === a.id;
  const name = encodeURIComponent(a.username);
  return (
    <Layout ctx={ctx} title={a.username}>
      <Crumbs ctx={ctx} trail={[{ label: "Members", href: "/members" }, { label: a.username }]} />
      <section class="panel profile">
        <h1 class="panel-head">
          {a.username} {a.isBot && <BotBadge />}
        </h1>
        <div class="panel-body profile-body">
          <Avatar username={a.username} />
          <div>
            {a.displayTitle && <p class="author-title">{a.displayTitle}</p>}
            <dl class="facts">
              {roleLabel[a.role] && (
                <>
                  <dt>Role</dt>
                  <dd>{roleLabel[a.role]}</dd>
                </>
              )}
              <dt>Joined</dt>
              <dd>{formatDate(a.joinedAt)}</dd>
              <dt>Posts</dt>
              <dd>{n(a.postCount)}</dd>
              <dt>Last seen</dt>
              <dd>{profile.lastSeenAt ? <Time d={profile.lastSeenAt} /> : "Never"}</dd>
              {STATUS_LABELS[profile.status] && (
                <>
                  <dt>Standing</dt>
                  <dd>{STATUS_LABELS[profile.status]}</dd>
                </>
              )}
            </dl>
            <p class="profile-links">
              <a href={ctx.url(`/search?author=${name}`)}>All posts</a>
              {canPost(v) && !self && (
                <>
                  {" · "}
                  <a href={ctx.url(`/pm/new?to=${name}`)}>Send a message</a>
                </>
              )}
              {isModerator(v) && !self && (
                <>
                  {" · "}
                  <a href={ctx.url(`/u/${name}/warn`)}>Warn</a>
                </>
              )}
            </p>
            {profile.bioHtml && <div class="bio post-body">{raw(profile.bioHtml)}</div>}
          </div>
        </div>
      </section>
      {canChangeMemberStatus(v) && !self && (
        <section class="panel">
          <h2 class="panel-head">Standing</h2>
          <div class="panel-body">
            <ErrorNote message={props.error} />
            <form method="post" action={ctx.url(`/u/${name}/status`)} class="inline-fields">
              <label>
                Standing
                <select name="status">
                  <option value="active" selected={profile.status === "active"}>
                    Active
                  </option>
                  <option value="suspended" selected={profile.status === "suspended"}>
                    Suspended (can read, can't post)
                  </option>
                  <option value="banned" selected={profile.status === "banned"}>
                    Banned (can't log in)
                  </option>
                </select>
              </label>
              <label>
                Reason <span class="hint">(public, in the mod log)</span>
                <input type="text" name="reason" required maxlength={config.limits.reason_max} />
              </label>
              <button type="submit">Change standing</button>
            </form>
          </div>
        </section>
      )}
      <section class="panel">
        <h2 class="panel-head">Recent posts</h2>
        <div class="panel-body">
          {props.posts.length === 0 ? (
            <p class="meta">No posts yet.</p>
          ) : (
            <ol class="recent-posts">
              {props.posts.map((p) => (
                <li>
                  <div class="meta">
                    <a href={ctx.url(`/p/${p.postId}`)}>{p.threadTitle}</a> in {p.boardName}, <Time d={p.createdAt} />
                  </div>
                  <div class="post-body excerpt">{raw(p.bodyHtml)}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </Layout>
  );
}

export function MembersPage(props: { ctx: PageCtx; members: MemberListItem[]; page: Page }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="Members">
      <Crumbs ctx={ctx} trail={[{ label: "Members" }]} />
      <h1 class="page-title">Members</h1>
      <table class="grid">
        <thead>
          <tr class="cat-row">
            <th scope="col" class="col-main">
              Member
            </th>
            <th scope="col" class="col-num">
              Posts
            </th>
            <th scope="col" class="col-last">
              Joined
            </th>
          </tr>
        </thead>
        <tbody>
          {props.members.map(({ author: a }) => (
            <tr>
              <td class="col-main member-cell">
                <Avatar username={a.username} size="small" />
                <UserLink ctx={ctx} username={a.username} />
                {a.isBot && <BotBadge />}
                {a.displayTitle && <span class="meta"> · {a.displayTitle}</span>}
              </td>
              <td class="col-num">{n(a.postCount)}</td>
              <td class="col-last">{formatDate(a.joinedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="toolbar">
        <Pagination ctx={ctx} base="/members" page={props.page} />
      </div>
    </Layout>
  );
}

export function LoginPage(props: { ctx: PageCtx; next: string; username: string; error: string | null }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title="Log in">
      <section class="panel narrow">
        <h1 class="panel-head">Log in</h1>
        <div class="panel-body">
          <ErrorNote message={props.error} />
          <form method="post" action={ctx.url("/login")} class="stacked">
            <input type="hidden" name="next" value={props.next} />
            <label>
              Username
              <input type="text" name="username" value={props.username} required autocomplete="username" />
            </label>
            <label>
              Password
              <input type="password" name="password" required autocomplete="current-password" />
            </label>
            <div class="form-actions">
              <button type="submit">Log in</button>
            </div>
          </form>
          <p class="meta">Membership is by invitation. If you have an invite code, <a href={ctx.url("/register")}>register here</a>.</p>
        </div>
      </section>
    </Layout>
  );
}

export function RegisterPage(props: { ctx: PageCtx; code: string; username: string; error: string | null }) {
  const { ctx } = props;
  const L = config.limits;
  return (
    <Layout ctx={ctx} title="Register">
      <section class="panel narrow">
        <h1 class="panel-head">Register</h1>
        <div class="panel-body">
          <ErrorNote message={props.error} />
          <form method="post" action={ctx.url("/register")} class="stacked">
            <label>
              Invite code
              <input type="text" name="code" value={props.code} required autocomplete="off" />
            </label>
            <label>
              Username
              <input type="text" name="username" value={props.username} required minlength={L.username_min} maxlength={L.username_max} autocomplete="username" />
            </label>
            <label>
              Password <span class="hint">(at least {L.password_min} characters)</span>
              <input type="password" name="password" required minlength={L.password_min} autocomplete="new-password" />
            </label>
            <label>
              Password again
              <input type="password" name="password2" required minlength={L.password_min} autocomplete="new-password" />
            </label>
            <div class="form-actions">
              <button type="submit">Join the board</button>
            </div>
          </form>
        </div>
      </section>
    </Layout>
  );
}

export function SettingsPage(props: {
  ctx: PageCtx;
  profile: Profile;
  profileMessage: string | null;
  profileError: string | null;
  passwordMessage: string | null;
  passwordError: string | null;
}) {
  const { ctx, profile } = props;
  const L = config.limits;
  return (
    <Layout ctx={ctx} title="Settings">
      <Crumbs ctx={ctx} trail={[{ label: "Settings" }]} />
      <section class="panel">
        <h1 class="panel-head">Profile</h1>
        <div class="panel-body">
          {props.profileMessage && <p class="notice">{props.profileMessage}</p>}
          <ErrorNote message={props.profileError} />
          <form method="post" action={ctx.url("/settings/profile")} class="stacked">
            <label>
              Title <span class="hint">(shown under your name; leave blank to use your rank)</span>
              <input type="text" name="title" value={profile.customTitle ?? ""} maxlength={L.title_max} />
            </label>
            <label>
              Bio
              <textarea name="bio" rows={6} maxlength={L.bio_max}>
                {profile.bio}
              </textarea>
            </label>
            <div class="form-actions">
              <button type="submit">Save profile</button>
            </div>
          </form>
        </div>
      </section>
      <section class="panel">
        <h2 class="panel-head">Password</h2>
        <div class="panel-body">
          {props.passwordMessage && <p class="notice">{props.passwordMessage}</p>}
          <ErrorNote message={props.passwordError} />
          <form method="post" action={ctx.url("/settings/password")} class="stacked">
            <label>
              Current password
              <input type="password" name="current" required autocomplete="current-password" />
            </label>
            <label>
              New password
              <input type="password" name="password" required minlength={L.password_min} autocomplete="new-password" />
            </label>
            <label>
              New password again
              <input type="password" name="password2" required minlength={L.password_min} autocomplete="new-password" />
            </label>
            <div class="form-actions">
              <button type="submit">Change password</button>
            </div>
          </form>
        </div>
      </section>
    </Layout>
  );
}

export function AdminPage(props: {
  ctx: PageCtx;
  invites: InviteStatus[];
  newCode: string | null;
  inviteUrl: (code: string) => string;
}) {
  const { ctx } = props;
  const status = (i: InviteStatus) => {
    if (i.usedByName) return <>Used by <UserLink ctx={ctx} username={i.usedByName} /></>;
    if (i.revoked) return "Revoked";
    if (i.expiresAt && i.expiresAt < new Date()) return "Expired";
    return "Open";
  };
  return (
    <Layout ctx={ctx} title="Admin">
      <Crumbs ctx={ctx} trail={[{ label: "Admin" }]} />
      <section class="panel">
        <h1 class="panel-head">Invites</h1>
        <div class="panel-body">
          <p>
            <a href={ctx.url("/admin/pms")}>All conversations</a> · <a href={ctx.url("/mod/reports")}>Reports</a> ·{" "}
            <a href={ctx.url("/modlog")}>Moderation log</a>
          </p>
          {props.newCode && (
            <p class="notice">
              New invite: <code>{props.newCode}</code>
              <br />
              Link: <code>{props.inviteUrl(props.newCode)}</code>
            </p>
          )}
          <form method="post" action={ctx.url("/admin/invites")} class="inline-fields">
            <label>
              For
              <input type="text" name="note" placeholder="who it's for" maxlength={200} />
            </label>
            <label>
              Expires in
              <select name="expiry">
                <option value={String(config.invites.default_expiry_days)}>{config.invites.default_expiry_days} days</option>
                <option value="1">1 day</option>
                <option value="30">30 days</option>
                <option value="never">Never</option>
              </select>
            </label>
            <button type="submit">Create invite</button>
          </form>
          <table class="grid compact">
            <thead>
              <tr class="cat-row">
                <th scope="col">Code</th>
                <th scope="col">For</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {props.invites.length === 0 && (
                <tr>
                  <td colspan={6} class="empty">
                    No invites yet.
                  </td>
                </tr>
              )}
              {props.invites.map((i) => (
                <tr>
                  <td>
                    <code>{i.code}</code>
                  </td>
                  <td>{i.note}</td>
                  <td>{formatDate(i.createdAt)}</td>
                  <td>{i.expiresAt ? formatDate(i.expiresAt) : "Never"}</td>
                  <td>{status(i)}</td>
                  <td>
                    {!i.usedByName && !i.revoked && (
                      <form method="post" action={ctx.url("/admin/invites/revoke")} class="inline-form">
                        <input type="hidden" name="code" value={i.code} />
                        <button type="submit" class="linkish">
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  );
}

export function ErrorPage(props: { ctx: PageCtx; status: number; message: string }) {
  const heading = props.status === 404 ? "Not found" : props.status === 403 ? "Not allowed" : "Something went wrong";
  return (
    <Layout ctx={props.ctx} title={heading}>
      <section class="panel narrow">
        <h1 class="panel-head">{heading}</h1>
        <div class="panel-body">
          <p>{props.message}</p>
          <p>
            <a href={props.ctx.url("/")}>Back to the index</a>
          </p>
        </div>
      </section>
    </Layout>
  );
}
