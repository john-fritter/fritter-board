import "./dotenv.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./config.js";
import { getPool } from "./db/index.js";

function main() {
  const env = loadEnv();
  const pool = getPool();
  const app = createApp({ pool, env });
  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`Fritter Board listening on :${info.port} (public URL ${env.origin}${env.basePath || "/"})`);
  });

  const shutdown = () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
