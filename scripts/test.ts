/**
 * Test runner. Discovers every tests/*.test.ts(x) file and runs each in its
 * own tsx child process, so one failing suite can't take the others' output
 * with it.
 *
 * Usage: npm test
 *
 * Test files are plain node:assert scripts: they throw on failure and print a
 * "… tests passed" line on success. Suites that need Postgres read
 * TEST_DATABASE_URL and skip themselves when it isn't set.
 */

import { spawn } from "child_process";
import { readdir } from "fs/promises";
import path from "path";

const TESTS_DIR = path.join(import.meta.dirname, "..", "tests");
const TSX_BIN = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

function runFile(filepath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [filepath], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const files = (await readdir(TESTS_DIR)).filter((f) => /\.test\.tsx?$/.test(f)).sort();
  if (files.length === 0) {
    console.error("No test files found in tests/");
    process.exit(1);
  }

  const failed: string[] = [];
  for (const file of files) {
    console.log(`\n── ${file}`);
    const code = await runFile(path.join(TESTS_DIR, file));
    if (code !== 0) failed.push(file);
  }

  console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
