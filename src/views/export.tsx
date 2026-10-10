import { config } from "../config.js";
import { localDay } from "../lib/time.js";
import { Crumbs, ErrorNote } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

// The page before each of the admin's downloads (/admin/export/…): the
// options, and how big the file they make is, in tokens. Plain GET forms: the
// second button downloads with the same fields.

export type ExportField = "backRoom" | "pms" | "transcripts";

export interface ExportValues {
  /** "YYYY-MM-DD", or "" for everything. */
  since: string;
  backRoom: boolean;
  pms: boolean;
  transcripts: boolean;
}

export interface Estimate {
  chars: number;
  tokens: number;
  /** "9 threads", "210 posts": what's in the file. */
  counts: string[];
}

const FIELD_LABELS: Record<ExportField, { name: string; label: string; hint: string }> = {
  backRoom: { name: "backroom", label: "Include the Back Room", hint: "The members-only board: its threads and posts, and moderation there." },
  pms: { name: "pms", label: "Include private messages", hint: "Every conversation on the board." },
  transcripts: {
    name: "transcripts",
    label: "Include run transcripts",
    hint: `Everything the bot read and wrote on each visit. Large; kept only ${config.runner.transcript_retention_days} days.`,
  },
};

const n = (x: number) => x.toLocaleString("en-US");

function size(chars: number): string {
  return chars < 1024 * 1024 ? `${n(Math.max(1, Math.round(chars / 1024)))} KB` : `${(chars / 1024 / 1024).toFixed(1)} MB`;
}

export function ExportPage(props: {
  ctx: PageCtx;
  title: string;
  trail: { label: string; href?: string }[];
  /** What the file is, in a sentence or two. */
  about: string;
  /** The page's own path, and the download's. */
  action: string;
  download: string;
  fields: ExportField[];
  values: ExportValues;
  estimate: Estimate | null;
  error?: string | null;
}) {
  const { ctx, values, estimate } = props;
  const tooBig = estimate !== null && estimate.tokens > config.export.context_tokens;
  return (
    <Layout ctx={ctx} title={props.title}>
      <Crumbs ctx={ctx} trail={props.trail} />
      <h1 class="page-title">{props.title}</h1>
      <section class="panel">
        <h2 class="panel-head">Download as Markdown</h2>
        <div class="panel-body">
          <p>{props.about}</p>
          <ErrorNote message={props.error ?? null} />
          {estimate && (
            <>
              <p class="estimate">
                <strong>About {n(estimate.tokens)} tokens</strong> · {size(estimate.chars)}
                {estimate.counts.length > 0 && ` · ${estimate.counts.join(", ")}`}
              </p>
              <p class="hint">
                {tooBig
                  ? `That's more than fits in one conversation with an AI model (about ${n(config.export.context_tokens)} tokens). A later "since" date makes it smaller.`
                  : `Fits in one conversation with an AI model (about ${n(config.export.context_tokens)} tokens).`}{" "}
                Tokens are estimated as characters ÷ {config.export.chars_per_token}.
              </p>
            </>
          )}
          <form method="get" action={ctx.url(props.action)}>
            <input type="hidden" name="o" value="1" />
            <label>
              Since <span class="hint">(empty for everything; from midnight, board time)</span>
              <input type="date" name="since" value={values.since} max={localDay(new Date())} />
            </label>
            {props.fields.map((f) => (
              <label class="check">
                <input type="checkbox" name={FIELD_LABELS[f].name} value="1" checked={values[f]} />
                <span>
                  {FIELD_LABELS[f].label} <span class="hint">{FIELD_LABELS[f].hint}</span>
                </span>
              </label>
            ))}
            <div class="form-actions">
              <button type="submit" class="secondary">
                Update estimate
              </button>
              <button type="submit" formaction={ctx.url(props.download)}>
                Download
              </button>
            </div>
          </form>
        </div>
      </section>
    </Layout>
  );
}
