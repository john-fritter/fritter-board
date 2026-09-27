import { config } from "../config.js";
import { articleDek, articleTitle, formatEditionDate } from "../fp/articles.js";
import type { ThreadArticle } from "../forum/articles.js";
import { Crumbs } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

const n = (x: number) => x.toLocaleString("en-US");

/**
 * The compact card at the top of an article's thread: headline, dek, date and
 * a link to the piece in the paper. Read live from Fritter Post; the board
 * never keeps a copy.
 */
export function ArticleCard(props: { article: ThreadArticle; href: string | null }) {
  const { article, href } = props;
  if (article.state !== "ok") {
    return (
      <section class="fp-card">
        <p class="fp-kicker">The Fritter Post</p>
        <p class="meta">
          {article.state === "gone"
            ? "This article is no longer in the paper."
            : "The article couldn't be loaded just now."}
          {article.state === "unavailable" && href && (
            <>
              {" "}
              <a href={href}>Open it in the paper</a>
            </>
          )}
        </p>
      </section>
    );
  }
  const a = article.article;
  const title = articleTitle(a);
  const dek = articleDek(a, config.fritter_post.dek_max_chars);
  return (
    <section class="fp-card">
      <p class="fp-kicker">The Fritter Post · {formatEditionDate(a.publishedOn)}</p>
      <h2 class={a.headline?.trim() ? "fp-headline" : "fp-headline fp-line"}>
        {href ? <a href={href}>{title}</a> : title}
      </h2>
      {dek && <p class="fp-dek">{dek}</p>}
      <p class="meta">
        {a.sectionTitle && <>Part of {a.sectionTitle} · </>}
        {a.sourceCount === 1 ? "1 source" : `${n(a.sourceCount)} sources`}
        {href && (
          <>
            {" · "}
            <a href={href}>Read it in the paper</a>
          </>
        )}
      </p>
    </section>
  );
}

/** An article nobody here has discussed yet (or whose thread the viewer can't see). */
export function ArticlePage(props: { ctx: PageCtx; article: ThreadArticle & { state: "ok" }; href: string | null }) {
  const { ctx } = props;
  return (
    <Layout ctx={ctx} title={articleTitle(props.article.article)}>
      <Crumbs ctx={ctx} trail={[{ label: "Fritter Post article" }]} />
      <ArticleCard article={props.article} href={props.href} />
      {ctx.viewer === null && (
        // Worded so it's true whether or not a members-only thread exists.
        <p class="notice">
          <a href={ctx.url(`/login?next=${encodeURIComponent(ctx.here)}`)}>Log in</a> to start or join the
          discussion.
        </p>
      )}
    </Layout>
  );
}
