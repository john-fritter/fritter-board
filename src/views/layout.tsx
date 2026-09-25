import type { Child } from "hono/jsx";
import { config } from "../config.js";
import { isAdmin } from "../forum/permissions.js";
import { Avatar } from "./components.js";
import type { PageCtx } from "./context.js";

export function Layout(props: { ctx: PageCtx; title?: string; children?: Child }) {
  const { ctx } = props;
  const v = ctx.viewer;
  const title = props.title ? `${props.title} · ${config.site.name}` : config.site.name;
  return (
    <html lang="en" data-theme={ctx.theme ?? undefined}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{title}</title>
        <link rel="stylesheet" href={ctx.cssHref} />
      </head>
      <body>
        <div class="wrap">
          <header class="masthead">
            <div class="brand">
              <a class="site-name" href={ctx.url("/")}>
                {config.site.name}
              </a>
              <span class="tagline">{config.site.tagline}</span>
            </div>
            <nav class="usernav" aria-label="Account">
              {v ? (
                <>
                  <span class="whoami">
                    <Avatar username={v.username} size="small" />
                    <a href={ctx.url(`/u/${encodeURIComponent(v.username)}`)}>{v.username}</a>
                  </span>
                  <a href={ctx.url("/members")}>Members</a>
                  <a href={ctx.url("/settings")}>Settings</a>
                  {isAdmin(v) && <a href={ctx.url("/admin")}>Admin</a>}
                  <form method="post" action={ctx.url("/logout")} class="inline-form">
                    <button type="submit" class="linkish">
                      Log out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <a href={ctx.url("/members")}>Members</a>
                  <a href={ctx.url(`/login?next=${encodeURIComponent(ctx.here)}`)}>Log in</a>
                </>
              )}
            </nav>
          </header>
          <main>{props.children}</main>
          <footer class="footer">
            <form method="post" action={ctx.url("/theme")} class="theme-form">
              <input type="hidden" name="next" value={ctx.here} />
              <span>Theme:</span>
              <button type="submit" name="theme" value="light" class="linkish" aria-pressed={ctx.theme === "light" ? "true" : "false"}>
                Light
              </button>
              <button type="submit" name="theme" value="dark" class="linkish" aria-pressed={ctx.theme === "dark" ? "true" : "false"}>
                Dark
              </button>
              <button type="submit" name="theme" value="auto" class="linkish" aria-pressed={ctx.theme === null ? "true" : "false"}>
                Auto
              </button>
            </form>
            <p>
              {config.site.name} · a companion to <a href="https://post.fritter.lol">The Fritter Post</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
