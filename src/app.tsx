import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Pool } from "pg";
import { LoginLimiter } from "./auth/login-limiter.js";
import { viewerForSession } from "./auth/sessions.js";
import { config, type Env } from "./config.js";
import type { ForumContext } from "./forum/context.js";
import { openReportCount } from "./forum/moderation.js";
import { isModerator } from "./forum/permissions.js";
import { unreadConversationCount } from "./forum/pms.js";
import { ForumError } from "./forum/errors.js";
import type { Viewer } from "./forum/types.js";
import { renderBBCode } from "./markup/bbcode.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerArticleRoutes } from "./routes/articles.js";
import { registerForumRoutes } from "./routes/forum.js";
import { registerMemberRoutes } from "./routes/members.js";
import { registerModRoutes } from "./routes/mod.js";
import { registerPmRoutes } from "./routes/pms.js";
import { registerPostRoutes } from "./routes/posts.js";
import { render, SESSION_COOKIE, THEME_COOKIE } from "./routes/util.js";
import type { PageCtx, Theme } from "./views/context.js";
import { ErrorPage } from "./views/members.js";

export interface AppDeps {
  pool: Pool;
  env: Env;
  limiter?: LoginLimiter;
  /** Fritter Post's published articles, read-only; omit to run without the paper. */
  fp?: Pool | null;
}

export interface AppEnv {
  Variables: {
    viewer: Viewer | null;
    sessionToken: string | null;
    page: PageCtx;
  };
}

/** Shared by every route module. */
export interface Services {
  forum: ForumContext;
  env: Env;
  limiter: LoginLimiter;
  url: (p: string) => string;
  /** A Fritter Post article's permanent page, or null when FP_PUBLIC_URL isn't set. */
  articleHref: (articleId: number) => string | null;
}

export type AppContext = Context<AppEnv>;

const CSS_PATH = path.join(import.meta.dirname, "static", "style.css");

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { env } = deps;
  const url = (p: string) => `${env.basePath}${p}`;
  const services: Services = {
    env,
    url,
    forum: {
      pool: deps.pool,
      renderMarkup: (body) => renderBBCode(body, { postUrl: (id) => url(`/p/${id}`) }),
      fp: deps.fp ?? null,
    },
    articleHref: (id) => (env.fpPublicUrl ? `${env.fpPublicUrl}/article/${id}` : null),
    limiter:
      deps.limiter ??
      new LoginLimiter(config.login.max_failures, config.login.window_minutes * 60_000),
  };

  const css = readFileSync(CSS_PATH, "utf-8");
  const cssVersion = createHash("sha256").update(css).digest("hex").slice(0, 12);
  const cssHref = url(`/static/style.css?v=${cssVersion}`);

  // Non-strict so "/board" and "/board/" (and any trailing slash) route the same.
  const root = new Hono<AppEnv>({ strict: false });
  const app = env.basePath ? root.basePath(env.basePath) : root;

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "same-origin",
    })
  );
  // Rejects cross-site form posts by their Origin header.
  app.use(csrf({ origin: env.origin }));

  app.use(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? null;
    const viewer = token ? await viewerForSession(deps.pool, token) : null;
    const themeCookie = getCookie(c, THEME_COOKIE);
    const theme: Theme | null = themeCookie === "light" || themeCookie === "dark" ? themeCookie : null;
    const u = new URL(c.req.url);
    let here = u.pathname;
    if (env.basePath && here.startsWith(env.basePath)) here = here.slice(env.basePath.length) || "/";
    c.set("viewer", viewer);
    c.set("sessionToken", viewer ? token : null);
    const [unreadPms, openReports] = viewer
      ? await Promise.all([
          unreadConversationCount(services.forum, viewer),
          isModerator(viewer) ? openReportCount(services.forum) : Promise.resolve(null),
        ])
      : [0, null];
    c.set("page", { viewer, url, theme, cssHref, here: here + u.search, unreadPms, openReports });
    await next();
  });

  app.get("/static/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(css);
  });

  registerForumRoutes(app, services);
  registerArticleRoutes(app, services);
  registerPostRoutes(app, services);
  registerPmRoutes(app, services);
  registerModRoutes(app, services);
  registerAccountRoutes(app, services);
  registerMemberRoutes(app, services);
  registerAdminRoutes(app, services);

  app.notFound((c) =>
    render(c, <ErrorPage ctx={c.get("page")} status={404} message="That page doesn't exist." />, 404)
  );

  app.onError((err, c) => {
    // Middleware refusals (e.g. a cross-site form post) carry their own response.
    if (err instanceof HTTPException) return err.getResponse();
    const page = c.get("page");
    if (err instanceof ForumError) {
      return render(c, <ErrorPage ctx={page} status={err.status} message={err.message} />, err.status);
    }
    console.error(err);
    if (!page) return c.text("Internal error", 500);
    return render(c, <ErrorPage ctx={page} status={500} message="The board hit an error. Try again in a moment." />, 500);
  });

  return app;
}
