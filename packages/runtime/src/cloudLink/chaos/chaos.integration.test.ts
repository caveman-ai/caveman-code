// The chaos harness (DESIGN S11): three real runtimes (This Mac and two Cloud computers, each its own process on the
// stand-in claude, no model, no network), the test Cloud and four devices running the web app's real sync state (the
// desktop on the Mac, two web tabs, a phone with WebRTC's direct path to the Mac), put through seeded faults: sockets
// cut, kill -9 mid-turn and a restart on the same state dir, a Cloud computer asleep with sends queued for it, a Mac
// asleep without a word and a send from the phone, the lid mid-turn (and coming home), a move to a named computer,
// two devices answering one ask, a send racing a stop on one device and across devices, one request id down both
// paths, a lost WAL tail on the Mac, a page reloaded with calls in its outbox, the phone's direct path dropped, a Cloud
// computer back on an empty disk or on an earlier snapshot of its own. After each run the invariants in scenario.ts
// hold, or the test prints the seed, what broke and the run's last events.
//
// CI runs a fixed set of seeds: three runs that between them put every fault no filed bug blocks. The latency budgets
// are judged in CI's own job (ci.yml "Chaos latency"), where nothing else runs (CHAOS_LATENCY=judge).
// CHAOS_LONG=1 runs seeds for as long as asked: CHAOS_SEEDS=1-50 (or a list), CHAOS_MINUTES=30 (stops after),
// CHAOS_STEPS=60 per run. CHAOS_SEEDS alone replays those seeds with the CI fault sets. Every run steers clear of
// product bugs already known (scenario.ts KNOWN, each with its entry there), so it finds new ones; CHAOS_KNOWN=1 walks
// into them.
// CHAOS_RESULTS=<file> appends each run's result and the latency samples as JSON lines. Every run's summary (pass or
// fail, its faults and its counts) goes to stderr, which vitest's default reporter shows for a passing test too (it
// hides a passing test's console output), and is the test's annotation (shown by --reporter=verbose).
// Debugging: CHAOS_FAULTS=lid,kill9_mac replaces a seed's faults; CHAOS_TRACE=1 writes the run's events to a file on a
// pass too (a failure always does, and prints where).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";

import { until as eventually } from "../../session-protocol/testHarness.ts";
import { ALL_FAULTS, chaos, ChaosRun, type Fault, type RunResult, type Sent } from "./scenario.ts";
import { measureLatency, type LatencyReport } from "./latency.ts";
import { dispatchLog, journalOf, logErrors, sleep, Trace, World, type Hub } from "./world.ts";

const LONG = process.env.CHAOS_LONG === "1";
const seedsFrom = (raw: string | undefined) =>
  raw
    ?.split(",")
    .flatMap((part) => {
      const [a, b] = part.split("-").map(Number);
      return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, i) => a! + i);
    })
    .filter((n) => Number.isFinite(n));
/** The CI set: between them every fault happens at least once. */
const CI_RUNS: ReadonlyArray<{ seed: number; faults: ReadonlyArray<Fault> }> = [
  { seed: 1, faults: ["kill9_mac", "drop_sockets", "reload_outbox", "move_named", "drop_runtime_relay", "drop_direct", "drop_phone_relay"] },
  { seed: 2, faults: ["box_asleep_queued", "lid", "lost_wal_tail", "kill9_box", "mac_asleep_send"] },
  { seed: 3, faults: ["box_empty_disk", "box_older_disk", "kill9_box", "box_empty_disk"] },
];

const trace = new Trace();
let world: World;
const results: Array<RunResult> = [];

// SIGSTOP and SIGCONT stand for a computer's sleep; Windows has neither (the runtime suite runs on Linux and macOS).
const POSIX = process.platform !== "win32";

beforeAll(async () => {
  if (!POSIX) return;
  world = new World({ trace });
  await world.start();
  await world.addDevices([
    { name: "desktop", kind: "desktop", home: "mac" },
    { name: "web-1", kind: "web", home: null },
    { name: "web-2", kind: "web", home: "box-a" },
    { name: "phone", kind: "phone", home: null, direct: true },
  ]);
}, 400_000);

/** Sends pending and not in their outbox when their page reloaded, and how many of them never ran (scenario.ts reload). */
const unsaved = (r: RunResult) => (r.counts.reload_unsaved_send ? ` reload: ${r.counts.reload_unsaved_send} pending send(s) not in the outbox, ${r.counts["reload_unsaved_send:lost"] ?? 0} lost` : "");
/** One run in a line: its seed, pass or fail, its time, Cloud's copy catch-up, its faults and what it counted. */
const summary = (r: RunResult) =>
  `chaos seed ${r.seed} ${r.violations.length === 0 ? "pass" : `FAIL(${r.violations.length})`} ${Math.round(r.ms / 1000)} s copy ${r.copyCatchUpMs} ms [${r.faults.join(" ")}]${unsaved(r)} counts ${JSON.stringify(r.counts)}`;
/** To stderr: vitest's default reporter hides a passing test's console output, never what it writes there. */
const say = (text: string) => void process.stderr.write(`${text}\n`);

afterAll(async () => {
  if (results.length > 0) say(`chaos: ${results.map(summary).join("\n       ")}`);
  await world?.close();
}, 60_000);

function report(result: RunResult): string {
  const file = path.join(os.tmpdir(), `chaos-trace-seed-${result.seed}-${Date.now()}.log`);
  fs.writeFileSync(file, `${trace.lines.join("\n")}\n`);
  return [
    `chaos seed ${result.seed} failed (replay: CHAOS_SEEDS=${result.seed}${LONG ? " CHAOS_LONG=1" : ""}; the whole run's events: ${file}):`,
    ...result.violations.map((v) => `  - ${v}`),
    `faults: ${result.faults.join(", ")}`,
    `counts: ${JSON.stringify(result.counts)}`,
    "last events:",
    trace.tail(150),
    ...world.runtimes.map((r) => `${r.name} log (errors):\n${logErrors(r)}`),
  ].join("\n");
}

/**
 * A run's result kept for the summary (and CHAOS_RESULTS), said at once and annotated on its test, its trace printed on
 * a failure (or written, CHAOS_TRACE=1).
 */
async function record(result: RunResult, context: TestContext): Promise<void> {
  results.push(result);
  say(summary(result));
  await context.annotate(summary(result));
  if (process.env.CHAOS_RESULTS) fs.appendFileSync(process.env.CHAOS_RESULTS, `${JSON.stringify(result)}\n`);
  if (result.violations.length > 0) console.error(report(result));
  else if (process.env.CHAOS_TRACE === "1") fs.writeFileSync(path.join(os.tmpdir(), `chaos-trace-seed-${result.seed}-${Date.now()}.log`), `${trace.lines.join("\n")}\n`);
}

async function runSeed(context: TestContext, seed: number, faults: ReadonlyArray<Fault>, steps: number, pool?: ReadonlyArray<Fault>) {
  const avoidKnown = process.env.CHAOS_KNOWN !== "1";
  const result = await chaos(world, { seed, steps, faults, avoidKnown, ...(pool ? { pool, faultRate: 0.12 } : {}) });
  await record(result, context);
  expect(result.violations, `seed ${seed}`).toEqual([]);
}

if (LONG) {
  const seeds = seedsFrom(process.env.CHAOS_SEEDS) ?? Array.from({ length: 1000 }, (_, i) => i + 100);
  const until = Date.now() + Number(process.env.CHAOS_MINUTES ?? 30) * 60_000;
  const steps = Number(process.env.CHAOS_STEPS ?? 60);
  for (const seed of seeds) {
    test.skipIf(!POSIX || Date.now() > until)(`chaos seed ${seed}`, async (context) => {
      if (Date.now() > until) return context.skip();
      await runSeed(context, seed, [], steps, ALL_FAULTS);
    }, 900_000);
  }
} else {
  const only = seedsFrom(process.env.CHAOS_SEEDS);
  for (const run of CI_RUNS.filter((r) => !only || only.includes(r.seed))) {
    const faults = process.env.CHAOS_FAULTS !== undefined ? (process.env.CHAOS_FAULTS.split(",").filter(Boolean) as Array<Fault>) : run.faults;
    test.skipIf(!POSIX)(`chaos seed ${run.seed}: ${run.faults.join(", ")}`, (context) => runSeed(context, run.seed, faults, Number(process.env.CHAOS_STEPS ?? 24)), 300_000);
  }

  // reload_outbox reloads the page 0-14 ms after its send, so whether the send is still unanswered then is up to how
  // fast its runtime answers (seed 1 failed whenever box-b was the slower). Here box-b sleeps across the reload and
  // web-2's page dies with two sends to it unanswered. The first is out and waits in box-b's socket (seed 1's case): it
  // runs as box-b wakes, and the new page's resend of it must not run it again. The second is lost on its way, so only
  // the new page's outbox can run it. Each runs once, nothing waits for an answer on the page that died, and that page
  // opens nothing more.
  test.skipIf(!POSIX)("a page that reloads with sends unanswered: each runs once (from its outbox if it was lost), and nothing waits on the page that died", async (context) => {
    const started = Date.now();
    const run = new ChaosRun(world, { seed: 101, steps: 0, avoidKnown: process.env.CHAOS_KNOWN !== "1" });
    trace.note("---- seed 101: a page that reloads with sends unanswered");
    const device = world.device("web-2");
    const page = device.page;
    let sends: Array<Sent> = [];
    const ran: Record<string, number> = {};
    let deadHub: Hub | undefined;
    try {
      await run.setup();
      const chat = run.chats.find((c) => c.createdOn === "box-b")!;
      // Its views are live, so a send goes out at once on the page's open connection to box-b.
      await eventually(() => [...device.views.values()].every((v) => v.state.kind === "live"), 30_000);
      const relayed = (sent: Sent, lost: boolean) =>
        world.relay.frames().some((f) => f.device === device.name && f.page === page && f.lost === lost && f.head.includes(`"request_id":"${sent.requestId}"`));
      world.boxB.stop();
      try {
        const out = run.send(device, chat, "slow 300: {id} then reload (out, its computer asleep)");
        await eventually(() => relayed(out, false), 10_000);
        world.relay.lose(device.name, page, world.boxB.runtimeId);
        const lost = run.send(device, chat, "slow 300: {id} then reload (lost on its way)");
        await eventually(() => relayed(lost, true), 10_000);
        sends = [out, lost];
        deadHub = device.hub;
        await run.reload(device);
      } finally {
        world.boxB.wake();
      }
      expect(
        sends.map((s) => s.inOutboxAtReload),
        "the page dies with both sends in its outbox",
      ).toEqual([true, true]);
      // The dead page's objects live on in this process: a call they still make opens no connection.
      void deadHub!
        .clientFor(chat.sessionId)
        .call("workspace.get", { workspace_id: chat.workspaceId })
        .catch(() => undefined);
      await run.check(await run.quiesce());
      const { events } = await journalOf(world.ownerOf(chat.sessionId) ?? world.boxB, chat.sessionId);
      for (const s of sends) ran[s.id] = events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === s.text).length;
      expect(
        world.relay.streams().filter((s) => s.device === device.name && s.page === page),
        "the page that died has no stream open",
      ).toEqual([]);
    } finally {
      deadHub?.stop();
      await run.teardown().catch(() => undefined);
    }
    const result = run.result(started);
    await record(result, context);
    expect(result.violations).toEqual([]);
    expect(ran, "each send ran once").toEqual(Object.fromEntries(sends.map((s) => [s.id, 1])));
  }, 300_000);

  // web-2's socket to box-b is cut, and the page sends twice to box-b's chat at once: the first waits for the socket (it
  // is not on the wire), the second in ChatSender behind it. The page reloads 60 ms later. Both must run once, in the
  // order sent: a send is in the device's outbox from the moment it is made, wherever it waits. Run out of order, the
  // test prints the chat's journal and its runtime's dispatch log (dispatchLog).
  test.skipIf(!POSIX)("two sends made back to back while the page's socket to the chat's computer is down survive a reload: each runs once, in the order sent", async (context) => {
    const started = Date.now();
    const avoidKnown = process.env.CHAOS_KNOWN !== "1";
    const run = new ChaosRun(world, { seed: 301, steps: 0, avoidKnown });
    trace.note("---- seed 301: two sends behind a cut socket, then a reload");
    const device = world.device("web-2");
    const page = device.page;
    let sends: Array<Sent> = [];
    let order: Array<string> = [];
    try {
      await run.setup();
      const chat = run.chats.find((c) => c.createdOn === "box-b")!;
      await eventually(() => [...device.views.values()].every((v) => v.state.kind === "live"), 30_000);
      const view = device.views.get(chat.sessionId)!;
      const seen = view.states.length;
      world.relay.dropDevice(device.name, world.boxB.runtimeId);
      // The page's client has seen its socket go (the view says so as it does): it opens the next one only after its
      // back-off, a quarter of a second at least.
      const cut = Date.now() + 10_000;
      while (!view.states.slice(seen).includes("reconnecting")) {
        if (Date.now() > cut) throw new Error(`${device.name}'s view of ${chat.title} never saw its socket go (states ${view.states.slice(seen).join(",")})`);
        await new Promise((r) => setImmediate(r));
      }
      sends = [run.send(device, chat, "slow 300: {id} then reload (first, its socket cut)"), run.send(device, chat, "slow 300: {id} then reload (second, behind it)")];
      await sleep(60);
      expect(
        world.relay.frames().filter((f) => f.device === device.name && f.page === page && sends.some((s) => f.head.includes(`"request_id":"${s.requestId}"`))),
        "neither send is on the wire when the page reloads",
      ).toEqual([]);
      await run.reload(device);
      await run.check(await run.quiesce());
      const owner = world.ownerOf(chat.sessionId) ?? world.boxB;
      const { events } = await journalOf(owner, chat.sessionId);
      const said = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : []));
      order = said.flatMap((text) => sends.filter((s) => s.text === text).map((s) => s.id));
      // Out of order: what the chat's journal shows, and how its runtime created, queued and started the runs.
      if (order.join() !== sends.map((s) => s.id).join()) {
        const journal = events.map((e) => `  ${e.cursor} ${e.type}${e.turn_id ? ` turn ${e.turn_id.slice(-8)}` : ""}${e.type === "message.done" ? ` ${e.payload.role} "${e.payload.text}"${e.payload.delivery ? ` (${e.payload.delivery})` : ""}` : ""}`);
        const dump = [`seed 301 ran ${order.join(" ")} for ${sends.map((s) => s.id).join(" ")}; ${chat.title}'s journal on ${owner.name}:`, ...journal, `${owner.name}'s dispatch log:`, dispatchLog(owner, events.flatMap((e) => (e.type === "message.done" && e.turn_id && sends.some((s) => s.text === e.payload.text) ? [e.turn_id] : [])))].join("\n");
        say(dump);
        for (const line of dump.split("\n")) trace.note(line);
      }
    } finally {
      await run.teardown().catch(() => undefined);
    }
    const result = run.result(started);
    await record(result, context);
    expect(result.violations).toEqual([]);
    expect(order, "each ran once, in the order sent").toEqual(sends.map((s) => s.id));
  }, 300_000);
}

/**
 * The absolute budgets need the machine to themselves: other work on it slows the Mac's sealed paths (their frames are
 * encrypted per device) more than the loopback send they are measured against, so on a shared machine they breach
 * though the code did not change (p50 48-61 ms at load 2.2-2.9 per core, from other tests and sessions). They are
 * judged in CI's own latency job (CHAOS_LATENCY=judge: this test alone on its runner, where the harness itself puts a
 * 4-vCPU runner near 2.5 per core) up to load 3 per core. The runtime shards on CI skip it. Anywhere else they are
 * judged only on a machine that is mostly its own (load per core at most 1.5), and printed otherwise.
 */
const JUDGE = process.env.CHAOS_LATENCY === "judge";
const MAX_LOAD = Number(process.env.CHAOS_MAX_LOAD ?? (JUDGE ? 3 : 1.5));
const load = () => os.loadavg()[0]! / os.cpus().length;

test.skipIf(!POSIX)("hop overhead on localhost stays inside the S14 budgets (network excluded)", async (context) => {
  if (process.env.CI && !JUDGE) return context.skip("judged in CI's own latency job (ci.yml), with nothing else on its runner");
  const before = load();
  const latency: LatencyReport = await measureLatency(world);
  const after = load();
  say(`chaos latency (ms; load per core ${before.toFixed(2)} -> ${after.toFixed(2)}):\n${latency.lines.join("\n")}`);
  if (process.env.CHAOS_RESULTS) fs.appendFileSync(process.env.CHAOS_RESULTS, `${JSON.stringify({ latency: latency.samples, breaches: latency.breaches, load: [before, after] })}\n`);
  for (const breach of latency.breaches) console.error(`latency: ${breach}`);
  if (Math.max(before, after) > MAX_LOAD) return context.skip(`the machine is busy (load per core ${Math.max(before, after).toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`);
  expect(latency.breaches).toEqual([]);
}, 400_000);
