/**
 * Creates the first administrator — the one account that can't come from an
 * invite. Prompts for the password so it never lands in shell history.
 *
 * Usage: npm run create-admin -- <username>
 */

import "../src/dotenv.js";
import { createInterface } from "readline/promises";
import { getPool } from "../src/db/index.js";
import { insertUser } from "../src/forum/accounts.js";

async function readPassword(prompt: string): Promise<string> {
  if (process.env["ADMIN_PASSWORD"]) return process.env["ADMIN_PASSWORD"];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mute echo while the password is typed.
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  const pending = rl.question(prompt);
  muted = true;
  const answer = await pending;
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: npm run create-admin -- <username>");
    process.exit(1);
  }
  const password = await readPassword(`Password for ${username}: `);
  const pool = getPool();
  try {
    const id = await insertUser(pool, { username, password, role: "admin" });
    console.log(`Created admin ${username} (id ${id}).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
