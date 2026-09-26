import "./dotenv.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./config.js";
import { getPool } from "./db/index.js";
import { createFpPool } from "./fp/articles.js";

function main() {
  const env = loadEnv();
  const pool = getPool();
  // Fritter Post's published articles. Without it the board runs, minus the paper.
  const fpUrl = process.env["FP_DATABASE_URL"];
  const fp = fpUrl ? createFpPool(fpUrl) : null;
  const app = createApp({ pool, env, fp });
  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`Fritter Board listening on :${info.port} (public URL ${env.origin}${env.basePath || "/"})`);
  });

  const shutdown = () => {
    server.close(() => {
      Promise.all([pool.end(), fp?.end()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
