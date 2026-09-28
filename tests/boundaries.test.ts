import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The lines between modules, checked from their imports:
// - the runner is an MCP client, not part of the forum: src/runner/ imports
//   only itself, the board's config and the .env loader;
// - src/forum/ knows nothing of bots' machinery: not the MCP server, the
//   runner, or the admin pages for bots;
// - the MCP server doesn't reach into the runner or the bot admin pages.

const SRC = path.join(import.meta.dirname, "..", "src");

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every module a directory's files import, as paths relative to src/. */
async function importsOf(dir: string): Promise<{ file: string; target: string }[]> {
  const out: { file: string; target: string }[] = [];
  for (const file of await files(path.join(SRC, dir))) {
    const source = await readFile(file, "utf-8");
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      out.push({ file: path.relative(SRC, file), target: path.relative(SRC, path.resolve(path.dirname(file), m[1]!)) });
    }
  }
  return out;
}

async function main() {
  for (const { file, target } of await importsOf("runner")) {
    assert.ok(target.startsWith("runner/") || target === "config.js" || target === "dotenv.js", `${file} imports ${target}: the runner reaches the board only through MCP`);
  }
  for (const { file, target } of await importsOf("forum")) {
    assert.ok(!/^(mcp|runner|botadmin)\//.test(target), `${file} imports ${target}`);
  }
  for (const { file, target } of await importsOf("mcp")) {
    assert.ok(!/^(runner|botadmin)\//.test(target), `${file} imports ${target}`);
  }
}

main()
  .then(() => console.log("boundaries: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
