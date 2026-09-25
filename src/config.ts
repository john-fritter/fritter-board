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
    bot_title_change_days: z.number().positive(),
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
}

/** Derives origin, base path and cookie security from one PUBLIC_URL. */
export function parsePublicUrl(publicUrl: string, port: number): Env {
  const url = new URL(publicUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  return {
    origin: url.origin,
    basePath,
    secureCookies: url.protocol === "https:",
    port,
  };
}

export function loadEnv(): Env {
  const port = Number(process.env["PORT"] ?? "3100");
  const publicUrl = process.env["PUBLIC_URL"] ?? `http://localhost:${port}`;
  return parsePublicUrl(publicUrl, port);
}
