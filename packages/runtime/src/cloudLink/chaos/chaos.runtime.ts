// Test-only: one runtime process of the chaos harness (chaos.integration.test.ts), the real runtime on the real Claude
// Agent adapter and SDK with the stand-in claude (scripts/smoke-claude.mjs, no model, no network). Its state lives in
// CHAOS_BASE, so a restart after kill -9 opens the same database, journal and link identity. As This Mac
// (CHAOS_ROLE=mac) it enrolls with CHAOS_CLOUD_URL, when set, on its first start only (else it signs in as the app does); as a Cloud computer's runtime the harness
// wrote its link dir (CAVEMAN_CLOUD_LINK_DIR) and checkout (CAVEMAN_WORKSPACE_ROOT) as the computers service does.
// Like the app's server it settles what a crash left open before it serves (serverRuntimeStartup's recovery). Writes
// {url, token, stateDir, pid} to CHAOS_OUT once it serves, and runs until killed.
//
// CHAOS_CLOCK_FILE: the process's wall clock (Date.now, new Date()) runs as many milliseconds ahead of the machine's as
// the file says, as a guest's does once its agent stepped it after a memory restore; the monotonic clock and timers are
// left alone. Read every 50 ms, and at once whenever the machine's clock moved over a second since the last reading (the
// process was stopped), so a timer that runs first after SIGCONT already sees the new offset.
//
// CHAOS_HOLD_SEND, CHAOS_HOLD_FILE: a send whose text holds CHAOS_HOLD_SEND, once past every check of the runtime's
// turn.submit, waits before T3 takes it in until the file CHAOS_HOLD_FILE exists, as on a computer too busy to take it in
// at once (a chaos run at load 110). It writes CHAOS_HOLD_FILE.held as it starts to wait.
import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { makeConfig, startRuntime } from "../../session-protocol/testHarness.ts";
import { enroll, readIdentity } from "../identity.ts";
import { linkDirOf } from "../index.ts";

const base = process.env.CHAOS_BASE!;
const out = process.env.CHAOS_OUT!;

const clockFile = process.env.CHAOS_CLOCK_FILE;
if (clockFile) {
  const RealDate = Date;
  const machineNow = RealDate.now.bind(RealDate);
  let offset = 0;
  let lastRead = machineNow();
  const read = () => {
    lastRead = machineNow();
    try {
      offset = Number(fs.readFileSync(clockFile, "utf8")) || 0;
    } catch {
      offset = 0;
    }
  };
  read();
  setInterval(read, 50).unref();
  const now = () => {
    if (machineNow() - lastRead > 1_000) read();
    return machineNow() + offset;
  };
  RealDate.now = now;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget) as object,
  });
}

/** The test config, with every path under its fresh temp dir moved under CHAOS_BASE (the same on every start). */
async function stableConfig() {
  const fresh = await makeConfig();
  const from = fresh.baseDir;
  const moved = Object.fromEntries(
    Object.entries(fresh).map(([key, value]) => [key, typeof value === "string" && value.startsWith(from) ? path.join(base, path.relative(from, value)) : value]),
  ) as typeof fresh;
  for (const dir of [moved.stateDir, path.join(moved.stateDir, "logs", "provider"), path.join(moved.stateDir, "logs", "terminals"), moved.attachmentsDir, moved.worktreesDir, moved.providerStatusCacheDir])
    fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
  return { ...moved, baseDir: base };
}

const config = await stableConfig();
if (process.env.CHAOS_ROLE === "mac" && process.env.CHAOS_CLOUD_URL && readIdentity(linkDirOf(config.stateDir)) === undefined) {
  await enroll({ dir: linkDirOf(config.stateDir), cloudUrl: process.env.CHAOS_CLOUD_URL!, bearer: process.env.CHAOS_BEARER!, name: process.env.CHAOS_NAME ?? "Chaos Mac" });
}
/** The route's T3, holding a send whose text has CHAOS_HOLD_SEND until CHAOS_HOLD_FILE exists (above). */
const holding = (marker: string, file: string) =>
  Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const real = yield* Orchestrator.OrchestratorV2;
      const released = async () => {
        fs.writeFileSync(`${file}.held`, "");
        while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 20));
      };
      return Orchestrator.OrchestratorV2.of({
        ...real,
        dispatch: (command) => (command.type === "message.dispatch" && command.text.includes(marker) ? Effect.promise(released).pipe(Effect.andThen(real.dispatch(command))) : real.dispatch(command)),
      });
    }),
  );
const hold = process.env.CHAOS_HOLD_SEND && process.env.CHAOS_HOLD_FILE ? holding(process.env.CHAOS_HOLD_SEND, process.env.CHAOS_HOLD_FILE) : undefined;
const runtime = await startRuntime(config, "fake-claude", undefined, { recoverOnStartup: true, ...(hold ? { provide: hold } : {}) });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(`${out}.tmp`, JSON.stringify({ url: runtime.url, port: runtime.port, token: runtime.token(), stateDir: config.stateDir, dbPath: config.dbPath, pid: process.pid }));
fs.renameSync(`${out}.tmp`, out);
// A clean stop, as `systemctl stop caveman-runtime` makes one before a Cloud computer goes down: the runtime closes
// (its journal's crash marker goes with it) and the process ends.
process.once("SIGTERM", () => void runtime.close().then(() => process.exit(0), () => process.exit(1)));
// Never outlive the harness: a test runner that died (or was stopped) takes its runtimes with it.
const parent = Number(process.env.CHAOS_PARENT);
setInterval(() => {
  try {
    if (parent > 0) process.kill(parent, 0);
  } catch {
    process.exit(1);
  }
}, 2_000);
