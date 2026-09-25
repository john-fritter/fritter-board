import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Services } from "../app.js";
import { createSession, destroySession } from "../auth/sessions.js";
import { login, register } from "../forum/accounts.js";
import { invalid } from "../forum/errors.js";
import { changePassword, getProfile, updateProfile } from "../forum/users.js";
import { LoginPage, RegisterPage, SettingsPage } from "../views/members.js";
import { formError, readForm, render, safeNext, SESSION_COOKIE, setSessionCookie, THEME_COOKIE } from "./util.js";

const THEME_COOKIE_DAYS = 365;

export function registerAccountRoutes(app: Hono<AppEnv>, s: Services): void {
  const { forum, url, env } = s;

  app.get("/login", (c) => {
    if (c.get("viewer")) return c.redirect(url("/"), 303);
    return render(c, <LoginPage ctx={c.get("page")} next={safeNext(c.req.query("next"))} username="" error={null} />);
  });

  app.post("/login", async (c) => {
    const f = await readForm(c);
    const next = safeNext(f("next"));
    try {
      const userId = await login(forum, s.limiter, f("username"), f("password"));
      setSessionCookie(c, env, await createSession(forum.pool, userId));
      return c.redirect(url(next), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, <LoginPage ctx={c.get("page")} next={next} username={f("username")} error={message} />, status);
    }
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await destroySession(forum.pool, token);
    deleteCookie(c, SESSION_COOKIE, { path: env.basePath || "/" });
    return c.redirect(url("/"), 303);
  });

  app.get("/register", (c) => {
    if (c.get("viewer")) return c.redirect(url("/"), 303);
    return render(c, <RegisterPage ctx={c.get("page")} code={c.req.query("code") ?? ""} username="" error={null} />);
  });

  app.post("/register", async (c) => {
    const f = await readForm(c);
    try {
      if (f("password") !== f("password2")) throw invalid("The two passwords don't match.");
      const userId = await register(forum, f("code"), f("username"), f("password"));
      setSessionCookie(c, env, await createSession(forum.pool, userId));
      return c.redirect(url("/"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      return render(c, <RegisterPage ctx={c.get("page")} code={f("code")} username={f("username")} error={message} />, status);
    }
  });

  app.get("/settings", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return c.redirect(url(`/login?next=${encodeURIComponent("/settings")}`), 303);
    const profile = await getProfile(forum, viewer.username);
    const saved = c.req.query("saved");
    return render(
      c,
      <SettingsPage
        ctx={c.get("page")}
        profile={profile}
        profileMessage={saved === "profile" ? "Profile saved." : null}
        profileError={null}
        passwordMessage={saved === "password" ? "Password changed. Your other sessions were logged out." : null}
        passwordError={null}
      />
    );
  });

  app.post("/settings/profile", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return c.redirect(url("/login"), 303);
    const f = await readForm(c);
    try {
      await updateProfile(forum, viewer, { title: f("title"), bio: f("bio") });
      return c.redirect(url("/settings?saved=profile"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      const profile = await getProfile(forum, viewer.username);
      const draft = { ...profile, customTitle: f("title"), bio: f("bio") };
      return render(
        c,
        <SettingsPage ctx={c.get("page")} profile={draft} profileMessage={null} profileError={message} passwordMessage={null} passwordError={null} />,
        status
      );
    }
  });

  app.post("/settings/password", async (c) => {
    const viewer = c.get("viewer");
    const token = c.get("sessionToken");
    if (!viewer || !token) return c.redirect(url("/login"), 303);
    const f = await readForm(c);
    try {
      if (f("password") !== f("password2")) throw invalid("The two new passwords don't match.");
      await changePassword(forum, viewer, f("current"), f("password"), token);
      return c.redirect(url("/settings?saved=password"), 303);
    } catch (err) {
      const { message, status } = formError(err);
      const profile = await getProfile(forum, viewer.username);
      return render(
        c,
        <SettingsPage ctx={c.get("page")} profile={profile} profileMessage={null} profileError={null} passwordMessage={null} passwordError={message} />,
        status
      );
    }
  });

  app.post("/theme", async (c) => {
    const f = await readForm(c);
    const theme = f("theme");
    if (theme === "light" || theme === "dark") {
      setCookie(c, THEME_COOKIE, theme, {
        path: env.basePath || "/",
        sameSite: "Lax",
        secure: env.secureCookies,
        maxAge: THEME_COOKIE_DAYS * 24 * 60 * 60,
      });
    } else {
      deleteCookie(c, THEME_COOKIE, { path: env.basePath || "/" });
    }
    return c.redirect(url(safeNext(f("next"))), 303);
  });
}
