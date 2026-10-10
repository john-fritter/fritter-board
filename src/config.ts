import { readFileSync } from "fs";
import path from "path";
import YAML from "yaml";
import { z } from "zod";

const BoardConfigSchema = z.object({
  site: z.object({ name: z.string(), tagline: z.string(), timezone: z.string() }),
  pagination: z.object({
    threads_per_page: z.number().int().positive(),
    posts_per_page: z.number().int().positive(),
    profile_recent_posts: z.number().int().positive(),
    members_per_page: z.number().int().positive(),
    search_results_per_page: z.number().int().positive(),
    inbox_per_page: z.number().int().positive(),
    mod_log_per_page: z.number().int().positive(),
    bot_runs_per_page: z.number().int().positive(),
    bot_notes_per_page: z.number().int().positive(),
    bot_log_per_page: z.number().int().positive(),
    bot_page_recent: z.number().int().positive(),
    rss_items: z.number().int().positive(),
  }),
  sessions: z.object({
    lifetime_days: z.number().positive(),
    touch_interval_seconds: z.number().int().nonnegative(),
  }),
  online: z.object({ window_minutes: z.number().positive() }),
  login: z.object({
    max_failures: z.number().int().positive(),
    window_minutes: z.number().positive(),
  }),
  invites: z.object({ default_expiry_days: z.number().positive() }),
  limits: z.object({
    username_min: z.number().int().positive(),
    username_max: z.number().int().positive(),
    password_min: z.number().int().positive(),
    title_max: z.number().int().positive(),
    bio_max: z.number().int().positive(),
    thread_title_max: z.number().int().positive(),
    post_body_max: z.number().int().positive(),
    reason_max: z.number().int().positive(),
    bot_title_change_days: z.number().positive(),
    multiquote_max: z.number().int().positive(),
    multiquote_hours: z.number().positive(),
  }),
  moderation: z.object({
    hot_thread_posts: z.number().int().positive(),
    hot_thread_posters: z.number().int().positive(),
    hot_thread_window_minutes: z.number().positive(),
  }),
  fritter_post: z.object({
    discussion_board: z.string().min(1),
    dek_max_chars: z.number().int().positive(),
  }),
  mcp: z.object({
    writes_per_hour: z.number().int().nonnegative(),
    writes_per_day: z.number().int().nonnegative(),
    inbox_items: z.number().int().positive(),
    inbox_pm_messages: z.number().int().positive(),
    inbox_pm_chars: z.number().int().positive(),
    read_thread_posts: z.number().int().positive(),
    excerpt_chars: z.number().int().positive(),
    mod_history_items: z.number().int().positive(),
  }),
  export: z.object({
    chars_per_token: z.number().positive(),
    context_tokens: z.number().int().positive(),
  }),
  runner: z.object({
    nanogpt_base_url: z.string().url(),
    tick_seconds: z.number().positive(),
    model_timeout_seconds: z.number().positive(),
    wake_timeout_seconds: z.number().positive(),
    max_output_tokens: z.number().int().positive(),
    retry_wait_seconds: z.number().nonnegative(),
    wake_retries: z.number().int().nonnegative(),
    wake_retry_min_minutes: z.number().positive(),
    wake_retry_max_minutes: z.number().positive(),
    early_wake_for: z.array(z.string().min(1)),
    early_wake_poll_minutes: z.number().positive(),
    early_wake_delay_min_minutes: z.number().nonnegative(),
    early_wake_delay_max_minutes: z.number().nonnegative(),
    early_wakes_per_day: z.number().int().nonnegative(),
    extra_steps_per_pm: z.number().int().nonnegative(),
    extra_steps_per_mention: z.number().int().nonnegative(),
    steps_per_wake_max: z.number().int().nonnegative(),
    extra_writes_per_item: z.number().int().nonnegative(),
    writes_per_wake_max: z.number().int().nonnegative(),
    window_open_spread_minutes: z.number().nonnegative(),
    single_shot_threads: z.number().int().positive(),
    transcript_retention_days: z.number().positive(),
    action_log_chars: z.number().int().positive(),
    note_max_chars: z.number().int().positive(),
    notes_per_wake: z.number().int().nonnegative(),
    recent_notes_days: z.number().positive(),
    recent_notes_max: z.number().int().nonnegative(),
    notes_per_person: z.number().int().nonnegative(),
    noted_people_per_read: z.number().int().nonnegative(),
    recall_results: z.number().int().positive(),
    standing_max_chars: z.number().int().positive(),
    compaction_every_days: z.number().positive(),
    compaction_max_notes: z.number().int().positive(),
    compaction_max_chars: z.number().int().positive(),
    compaction_retry_hours: z.number().nonnegative(),
    summary_min_posts: z.number().int().positive(),
    summary_tail_posts: z.number().int().positive(),
    summary_max_chars: z.number().int().positive(),
    summary_batch_chars: z.number().int().positive(),
    summary_max_age_days: z.number().positive(),
    summary_model: z.string().min(1),
    summary_reasoning_effort: z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh"]),
    summary_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    model_calls_per_day: z.number().int().nonnegative(),
    moderation_patrol_minutes: z.number().positive(),
    moderation_early_per_day: z.number().int().nonnegative(),
    moderation_min_gap_minutes: z.number().nonnegative(),
    moderation_actions_per_cycle: z.number().int().positive(),
    moderation_posts_per_cycle: z.number().int().nonnegative(),
    moderation_calls_per_day: z.number().int().nonnegative(),
    web_search_services: z.array(z.enum(["langsearch", "exa", "linkup"])).min(1),
    web_search_keys: z.object({
      langsearch: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      exa: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      linkup: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    }),
    web_search_results: z.number().int().positive(),
    web_search_page_chars: z.number().int().positive(),
    web_search_timeout_seconds: z.number().positive(),
    web_search_models: z
      .array(z.object({ model: z.string().min(1), effort: z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh"]) }))
      .min(1),
    web_search_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    web_search_summary_chars: z.number().int().positive(),
    web_searches_per_wake: z.number().int().nonnegative(),
    web_searches_per_bot_per_day: z.number().int().nonnegative(),
    web_searches_per_day: z.number().int().nonnegative(),
    search_probe_parallel_calls: z.number().int().positive(),
  }),
});

export type BoardConfig = z.infer<typeof BoardConfigSchema>;

const CONFIG_PATH = path.join(import.meta.dirname, "..", "config", "board.yaml");

export const config: BoardConfig = BoardConfigSchema.parse(
  YAML.parse(readFileSync(CONFIG_PATH, "utf-8"))
);

export interface Env {
  /** Origin the board is served from, e.g. "https://fritter.lol". */
  origin: string;
  /** Path prefix for every link: "" for a subdomain, "/board" for a subpath. */
  basePath: string;
  secureCookies: boolean;
  port: number;
  /** Fritter Post's public URL, for links to articles; null when not configured. */
  fpPublicUrl: string | null;
}

/** Derives origin, base path and cookie security from one PUBLIC_URL. */
export function parsePublicUrl(publicUrl: string, port: number, fpPublicUrl: string | null = null): Env {
  const url = new URL(publicUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  return {
    origin: url.origin,
    basePath,
    secureCookies: url.protocol === "https:",
    port,
    fpPublicUrl: fpPublicUrl?.trim().replace(/\/+$/, "") || null,
  };
}

export function loadEnv(): Env {
  const port = Number(process.env["PORT"] ?? "3100");
  const publicUrl = process.env["PUBLIC_URL"] ?? `http://localhost:${port}`;
  return parsePublicUrl(publicUrl, port, process.env["FP_PUBLIC_URL"] ?? null);
}
