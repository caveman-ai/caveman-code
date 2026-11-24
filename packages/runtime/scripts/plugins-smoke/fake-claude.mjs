#!/usr/bin/env node
// For scripts/plugins-smoke.ts: the smoke `claude` stand-in (../smoke-claude.mjs)
// behind a recorder. It appends its argv and every stdin frame to
// $PLUGINS_SMOKE_RECORD/claude.jsonl, so the smoke can check what Claude Agent
// would have received (plugin dirs, MCP servers over stdin) without a model.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const log = path.join(process.env.PLUGINS_SMOKE_RECORD ?? ".", "claude.jsonl");
const record = (entry) => appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
record({ argv: process.argv.slice(2) });
const smoke = fileURLToPath(new URL("../smoke-claude.mjs", import.meta.url));
const child = spawn(process.execPath, [smoke, ...process.argv.slice(2)], { stdio: ["pipe", "inherit", "inherit"] });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) record({ stdin: JSON.parse(line) });
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 1));
