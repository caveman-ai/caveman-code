#!/usr/bin/env node
// A stand-in for the `codex` CLI's app-server, for tests and the Settings ->
// Engines walk-through: no OpenAI call, no real Codex, no one's login. It
// answers the handshake, the API-key account calls (login writes auth.json in
// $CODEX_HOME, as Codex does; a key containing "refused" is refused and
// nothing is written; logout deletes it), config/read (openai_base_url is
// FAKE_CODEX_OPENAI_BASE_URL, where the runtime checks the key; unset, the
// provider is not OpenAI, so the runtime checks nothing) and the provider
// probe (one model, no skills). FAKE_CODEX_LOG, when set, gets one JSON line
// per call: the method, CODEX_HOME, and whether the login key is in the
// process environment (it must never be).
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

const home = process.env.CODEX_HOME ?? "";
const auth = join(home, "auth.json");
const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ home, ...entry })}\n`);
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const MODEL = {
  id: "gpt-fake",
  model: "gpt-fake",
  displayName: "GPT Fake",
  description: "The fake app-server's only model.",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
};

const answer = {
  initialize: () => ({ codexHome: home, platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.0.0-fake" }),
  "account/login/start": (params) => {
    log({ method: "account/login/start", key_in_env: Object.values(process.env).some((v) => v?.includes(params.apiKey)) });
    if (params.apiKey.includes("refused")) throw new Error("invalid API key");
    mkdirSync(home, { recursive: true });
    writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: params.apiKey }), { mode: 0o600 });
    return { type: "apiKey" };
  },
  "account/read": () => ({ account: existsSync(auth) ? { type: "apiKey" } : null, requiresOpenaiAuth: true }),
  "account/logout": () => {
    rmSync(auth, { force: true });
    return {};
  },
  "config/read": () => {
    const base = process.env.FAKE_CODEX_OPENAI_BASE_URL;
    return { config: { model_provider: base ? "openai" : "fake-codex", openai_base_url: base ?? null }, origins: {} };
  },
  "skills/list": () => ({ data: [] }),
  "model/list": () => ({ data: [MODEL], nextCursor: null }),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return; // notifications (initialized)
  if (frame.method !== "account/login/start") log({ method: frame.method });
  const handler = answer[frame.method];
  if (!handler) return send({ id: frame.id, error: { code: -32601, message: `fake codex: no ${frame.method}` } });
  try {
    send({ id: frame.id, result: handler(frame.params) });
  } catch (error) {
    send({ id: frame.id, error: { code: -32000, message: error.message } });
  }
});
