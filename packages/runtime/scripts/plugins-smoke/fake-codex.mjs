#!/usr/bin/env node
// For scripts/plugins-smoke.ts: a `codex app-server` stand-in. It records every
// frame the runtime sends to $PLUGINS_SMOKE_RECORD/codex.jsonl and answers from
// the recorded `simple` Codex transcript (initialize, thread/start, turn/start
// and the turn's notifications), so the smoke can check the per-thread MCP
// config Codex would have received without a model or a login.
import { appendFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.161.0\n");
  process.exit(0);
}
const log = path.join(process.env.PLUGINS_SMOKE_RECORD ?? ".", "codex.jsonl");
const record = (entry) => appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
record({ argv: process.argv.slice(2) });
const fixture = fileURLToPath(
  new URL("../../src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url),
);
const entries = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
/** The inbound frames the transcript emits after the runtime sends `method`, up to the next request it expects. */
const after = (method) => {
  const at = entries.findIndex((e) => e.type === "expect_outbound" && e.frame?.method === method);
  if (at < 0) return undefined;
  const out = [];
  for (const e of entries.slice(at + 1)) {
    if (e.type === "expect_outbound" && e.frame?.id !== undefined) break;
    if (e.type === "emit_inbound") out.push(e.frame);
  }
  return out;
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  record({ stdin: frame });
  if (frame.id === undefined || frame.method === undefined) return;
  const frames = after(frame.method);
  if (frames === undefined) {
    // Probes this stand-in does not model (account, rate limits, models): an empty answer.
    send({ id: frame.id, result: frame.method === "model/list" ? { data: [], nextCursor: null } : {} });
    return;
  }
  for (const out of frames) send("id" in out && "result" in out ? { ...out, id: frame.id } : out);
});
