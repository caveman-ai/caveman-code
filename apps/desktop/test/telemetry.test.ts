import type { TurnFact } from "@caveman-app/session-protocol";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudTelemetryUrl, crashReason, envOff, runtimeConfigApi, Telemetry, TELEMETRY_URL, token, type AskTurns } from "../src/telemetry.ts";

const setup = (env = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
  const sent: Array<Record<string, unknown>> = [];
  const posts: number[] = [];
  const make = () =>
    new Telemetry({
      file,
      version: "0.1.0",
      env,
      send: async (_url, body) => {
        const events = JSON.parse(body);
        posts.push(events.length);
        sent.push(...events);
      },
    });
  return { file, sent, posts, make };
};
/** A launch whose onboarding screen has shown the disclosure, with that step's own event dropped. */
const disclosed = (t: Telemetry, sent: unknown[]) => (t.step("welcome_shown"), sent.splice(0), t);

describe("desktop telemetry", () => {
  it("holds everything until the onboarding screen has shown the disclosure, then sends it in order", () => {
    const { sent, posts, make } = setup();
    const t = make();
    t.step("first_launch");
    t.step("runtime_ready");
    t.crash("renderer_gone", "crashed");
    expect(sent).toHaveLength(0);
    t.step("welcome_shown");
    expect(sent.map((e) => e.subcommand)).toEqual(["first_launch", "runtime_ready", "renderer_gone", "welcome_shown"]);
    t.step("first_workspace");
    expect(sent).toHaveLength(5);
    // The next launch remembers the disclosure; more than the receiver's batch of 20 goes in two posts.
    const later = setup();
    const before = later.make();
    for (let i = 0; i < 20; i++) before.crash("runtime_exit", "SIGKILL");
    before.step("welcome_shown");
    expect([later.sent.length, later.posts]).toEqual([21, [20, 1]]);
    later.make().crash("main_exception", "Error");
    expect(later.sent).toHaveLength(22);
    // Off before the disclosure drops what was held.
    const off = setup();
    const quiet = off.make();
    quiet.step("first_launch");
    quiet.setEnabled(false);
    quiet.setEnabled(true);
    quiet.step("welcome_shown");
    expect(off.sent.map((e) => e.subcommand)).toEqual(["welcome_shown"]);
    expect(posts).toEqual([4, 1]);
  });

  it("sends each onboarding step once per install, in the CLI's cli/v1 envelope, and nothing else", () => {
    const { sent, make } = setup();
    const first = disclosed(make(), sent);
    expect(first.firstLaunch).toBe(true);
    first.step("first_launch");
    first.step("first_launch");
    first.step("not_a_step");
    const again = make();
    expect(again.firstLaunch).toBe(false);
    again.step("first_launch");
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(["anonymous_id", "arch", "cli_version", "command", "event", "node_major", "os", "schema", "subcommand", "ts"]);
    expect(sent[0]).toMatchObject({ schema: "cli/v1", event: "onboarding_step", command: "onboarding", subcommand: "first_launch", cli_version: "0.1.0" });
    expect(sent[0]!.anonymous_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("counts the onboarding funnel from sign-in to a plan unlocked, each step once, and only after the disclosure", () => {
    const { sent, make } = setup();
    const t = make();
    const later = ["signed_in", "setup_shown", "project_ready", "tour_done", "unlock_shown", "unlock_started", "unlocked"];
    // A step before the disclosure screen is held, then goes with it.
    t.step("signed_in");
    expect(sent).toHaveLength(0);
    t.step("welcome_shown");
    for (const name of later) {
      t.step(name);
      t.step(name);
    }
    expect(sent.map((e) => e.subcommand)).toEqual(["signed_in", "welcome_shown", ...later.slice(1)]);
    expect(sent.every((e) => e.event === "onboarding_step" && e.command === "onboarding")).toBe(true);
    expect(later.every((name) => t.sent(name as never))).toBe(true);
  });

  it("counts the first run's offers and a replayed tour, each once, and holds them until the disclosure like every step", () => {
    const { sent, make } = setup();
    const t = make();
    const offers = [
      "offer_window_shown",
      "offer_window_unlock",
      "offer_lid_shown",
      "offer_lid_unlock",
      "offer_chief_shown",
      "offer_chief_unlock",
      "offer_gift_shown",
      "offer_gift_open",
      "tour_replayed",
    ];
    t.step("offer_window_shown");
    t.step("offer_gift_unlock"); // not a step: dropped
    expect(sent).toHaveLength(0);
    t.step("welcome_shown");
    for (const name of offers) {
      t.step(name);
      t.step(name);
    }
    expect(sent.map((e) => e.subcommand)).toEqual(["offer_window_shown", "welcome_shown", ...offers.slice(1)]);
    expect(sent.every((e) => e.event === "onboarding_step" && e.command === "onboarding")).toBe(true);
  });

  it("reduces a crash reason to a token, caps crashes per launch, and refuses unknown kinds", () => {
    const { sent, make } = setup();
    const t = disclosed(make(), sent);
    t.crash("renderer_exception", "TypeError");
    t.crash("renderer_exception", "Cannot read properties of undefined (reading 'x') at /Users/me/secret.ts");
    t.crash("nope" as never, "x");
    expect(sent.map((e) => e.error_class)).toEqual(["TypeError", "other"]);
    expect(sent[0]).toMatchObject({ event: "app_crash", command: "desktop", subcommand: "renderer_exception", exit_class: "error" });
    for (let i = 0; i < 40; i++) t.crash("runtime_exit", "SIGKILL");
    expect(sent).toHaveLength(20);
  });

  it("sends nothing when off, forgets the id on off, and honours DO_NOT_TRACK and CAVEMAN_TELEMETRY", () => {
    const { file, sent, make } = setup();
    const t = disclosed(make(), sent);
    t.setEnabled(false);
    expect(JSON.parse(readFileSync(file, "utf8")).anonymousId).toBeUndefined();
    t.step("first_launch");
    t.crash("main_exception", "Error");
    expect(sent).toHaveLength(0);
    t.setEnabled(true);
    t.crash("main_exception", "Error");
    expect(sent).toHaveLength(1);

    const dnt = setup({ DO_NOT_TRACK: "1" });
    disclosed(dnt.make(), dnt.sent).crash("main_exception", "Error");
    expect(dnt.sent).toHaveLength(0);
    expect(dnt.make().choice).toEqual({ enabled: true, envOff: true, dryRun: false, turnsDisclosed: false, reportsDisclosed: false });
    const devFile = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
    const dry: unknown[] = [];
    const dev = new Telemetry({ file: devFile, version: "0.0.0", env: {}, dryRun: true, send: async (_u, body) => void dry.push(body) });
    dev.step("welcome_shown");
    dev.step("first_launch");
    expect([dry.length, dev.choice.dryRun]).toEqual([0, true]);
    expect([envOff({ CAVEMAN_TELEMETRY: "0" }), envOff({ CAVEMAN_TELEMETRY: "on" }), envOff({ DO_NOT_TRACK: "0" }), envOff({})]).toEqual([true, false, false, false]);
    expect([token("0.1.0"), token(""), token(42)]).toEqual(["0.1.0", "other", "other"]);
    expect(["SIGSEGV", "crashed", "exit_0", "exit_255", "exit_256", "exit_01", "MyAppError", "TypeError"].map(crashReason)).toEqual([
      "SIGSEGV", "crashed", "exit_0", "exit_255", "other", "other", "other", "TypeError",
    ]);
  });
});

/**
 * A company's own Cloud as the desktop sees it: its /runtime-config.js (the web's browser config) names `api`, and
 * that host answers `status` to POST /telemetry/cli. Every request is recorded.
 */
const companyCloud = (api: string | undefined, status = 202) => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url === "https://app.customer.example/runtime-config.js") {
      return new Response(`globalThis.__CAVE_RUNTIME_CONFIG__=Object.freeze(${JSON.stringify({ apiURL: api ?? "", gatewayURL: "https://gateway.customer.example", posthogKey: "", posthogHost: "https://eu.i.posthog.com" })});\n`, { status: 200 });
    }
    if (api !== undefined && url === `${api}/telemetry/cli`) return new Response(null, { status });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
};

const onCloud = (cloud: string | undefined, fetchImpl: typeof fetch, env: Record<string, string> = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
  const sent: Array<{ url: string; events: Array<Record<string, unknown>> }> = [];
  let reads = 0;
  let current = cloud;
  const make = (read: () => Promise<string | undefined> = async () => (reads++, current)) =>
    new Telemetry({ file, version: "0.1.0", env, fetch: fetchImpl, cloud: read, send: async (url, body) => void sent.push({ url, events: JSON.parse(body) }) });
  return { file, sent, make, reads: () => reads, use: (next: string | undefined) => (current = next) };
};

describe("desktop telemetry follows the Cloud the app uses", () => {
  it("sends to Caveman's receiver on the hosted Cloud, as before", async () => {
    for (const cloud of [undefined, "https://app.caveman.so"]) {
      const { fetchImpl, requests } = companyCloud(undefined);
      const t = onCloud(cloud, fetchImpl);
      const telemetry = t.make();
      telemetry.step("welcome_shown");
      await telemetry.idle();
      expect(t.sent.map((p) => p.url)).toEqual([TELEMETRY_URL]);
      // No lookup: the hosted Cloud's receiver is known.
      expect(requests).toEqual([]);
    }
  });

  it("sends to a company Cloud's own receiver, on the API host its runtime config names, and never to caveman.so", async () => {
    const cloud = companyCloud("https://api.customer.example");
    const t = onCloud("https://app.customer.example", cloud.fetchImpl);
    const telemetry = t.make();
    telemetry.step("first_launch");
    telemetry.step("welcome_shown");
    telemetry.crash("renderer_gone", "crashed");
    await telemetry.idle();
    expect(t.sent.flatMap((p) => p.events.map((e) => [p.url, e.subcommand]))).toEqual([
      ["https://api.customer.example/telemetry/cli", "first_launch"],
      ["https://api.customer.example/telemetry/cli", "welcome_shown"],
      ["https://api.customer.example/telemetry/cli", "renderer_gone"],
    ]);
    // One lookup per launch: the runtime config, then an empty batch that carries nothing.
    expect(cloud.requests).toEqual([
      { url: "https://app.customer.example/runtime-config.js", method: "GET" },
      { url: "https://api.customer.example/telemetry/cli", method: "POST", body: "[]" },
    ]);
    expect(JSON.stringify([t.sent, cloud.requests])).not.toContain("caveman.so");
    // The Cloud read is kept, for a send while the runtime cannot say.
    expect(JSON.parse(readFileSync(t.file, "utf8")).cloud).toBe("https://app.customer.example");
    const later = t.make(async () => Promise.reject(new Error("runtime down")));
    later.crash("runtime_exit", "SIGKILL");
    await later.idle();
    expect(t.sent.at(-1)).toMatchObject({ url: "https://api.customer.example/telemetry/cli", events: [{ subcommand: "runtime_exit" }] });
  });

  it("sends nothing on a company Cloud that serves no receiver, names none, or names Caveman's", async () => {
    for (const [api, status] of [
      ["https://app.customer.example", 404],
      ["https://api.customer.example", 405],
      [undefined, 202],
      ["https://api.caveman.so", 202],
    ] as const) {
      const cloud = companyCloud(api, status);
      const t = onCloud("https://app.customer.example", cloud.fetchImpl);
      const telemetry = t.make();
      telemetry.step("welcome_shown");
      telemetry.crash("main_exception", "Error");
      await telemetry.idle();
      expect(t.sent).toEqual([]);
      // Only the lookup went out, and nothing in it is an event.
      expect(cloud.requests.every((r) => r.url !== TELEMETRY_URL && (r.body === undefined || r.body === "[]"))).toBe(true);
      expect(cloud.requests.some((r) => r.url.startsWith("https://api.caveman.so"))).toBe(false);
    }
    // An unreachable Cloud, and a Cloud URL that is not one, take nothing either.
    const down = onCloud("https://app.customer.example", (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch);
    const offline = down.make();
    offline.step("welcome_shown");
    await offline.idle();
    const bogus = onCloud("ftp://app.customer.example", companyCloud(undefined).fetchImpl);
    const odd = bogus.make();
    odd.step("welcome_shown");
    await odd.idle();
    expect([down.sent, bogus.sent]).toEqual([[], []]);
  });

  it("follows a change of Cloud, and CAVEMAN_CLOUD_URL wins over what Settings says", async () => {
    const cloud = companyCloud("https://api.customer.example");
    const t = onCloud(undefined, cloud.fetchImpl);
    const telemetry = t.make();
    telemetry.step("welcome_shown");
    await telemetry.idle();
    t.use("https://app.customer.example");
    telemetry.step("first_launch");
    await telemetry.idle();
    expect(t.sent.map((p) => p.url)).toEqual([TELEMETRY_URL, "https://api.customer.example/telemetry/cli"]);

    const pinned = onCloud("https://app.caveman.so", cloud.fetchImpl, { CAVEMAN_CLOUD_URL: "https://app.customer.example" });
    const managed = pinned.make();
    managed.step("welcome_shown");
    await managed.idle();
    expect(pinned.sent.map((p) => p.url)).toEqual(["https://api.customer.example/telemetry/cli"]);
    expect(pinned.reads()).toBe(0);
    // Pinned to a value that is not a Cloud URL: nothing goes anywhere.
    const broken = onCloud(undefined, cloud.fetchImpl, { CAVEMAN_CLOUD_URL: "app.customer.example" });
    const none = broken.make();
    none.step("welcome_shown");
    await none.idle();
    expect(broken.sent).toEqual([]);
  });

  it("reads the API host from a Cloud's runtime config, and refuses a redirect", async () => {
    expect(runtimeConfigApi('globalThis.__CAVE_RUNTIME_CONFIG__=Object.freeze({"apiURL":"https://api.customer.example","gatewayURL":""});\n')).toBe("https://api.customer.example");
    expect([runtimeConfigApi('globalThis.__CAVE_RUNTIME_CONFIG__=Object.freeze({"apiURL":""});'), runtimeConfigApi("<html>"), runtimeConfigApi("Object.freeze({oops)")]).toEqual([undefined, undefined, undefined]);
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => (redirects.push(init?.redirect), new Response("", { status: 500 }))) as unknown as typeof fetch;
    expect(await cloudTelemetryUrl("https://app.customer.example", fetchImpl)).toBeUndefined();
    expect(redirects).toEqual(["error"]);
  });
});

/** A runtime's telemetry.turns: hands out what waits past the last ack, and records every ask. */
const fakeRuntime = (count: number) => {
  let waiting: Array<TurnFact> = Array.from({ length: count }, (_, i) => turnFact(i + 1));
  const asks: Array<{ since: string; ack?: number }> = [];
  const ask: AskTurns = async (params) => {
    asks.push(params);
    if (params.ack !== undefined) waiting = waiting.filter((fact) => fact.seq > params.ack!);
    return { facts: waiting };
  };
  return { asks, ask, add: (seq: number) => waiting.push(turnFact(seq)) };
};

const turnFact = (seq: number): TurnFact => ({
  seq,
  id: seq.toString(16).padStart(32, "0"),
  session: "f".repeat(32),
  started_at: `2026-11-07T04:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  index: seq,
  engine: "claude-agent",
  model: "claude-opus-5-5",
  effort: "max",
  mode: "default",
  origin: "person",
  queued: false,
  prompt_chars: 64,
  images: 0,
  files: 0,
  status: "failed",
  moved: false,
  failure_class: "provider_error",
  retries: 1,
  rate_limited: false,
  duration_ms: 1_000,
  wait_ms: 0,
  tool_ms: 0,
  requests: 1,
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  compactions: 0,
  compactions_failed: 0,
  tools: 0,
  tools_failed: 0,
  tools_declined: 0,
  tool_command: 0,
  tool_read: 0,
  tool_edit: 0,
  tool_search: 0,
  tool_web: 0,
  tool_mcp: 0,
  tool_browser: 0,
  tool_other: 0,
  subagents: 0,
  subagents_failed: 0,
  approvals: 0,
  approvals_denied: 0,
  questions: 0,
  steers: 0,
  todos: 0,
  todos_done: 0,
  files_changed: 0,
  lines_added: 0,
  lines_removed: 0,
  next: "followup",
  next_same_prompt: true,
  undone: false,
  kept: false,
  restored: false,
});

describe("desktop turn stats", () => {
  it("asks nothing before a disclosure naming them, while off, or when the environment says so", async () => {
    const runtime = fakeRuntime(1);
    const { make } = setup();
    const t = make();
    await t.turns(runtime.ask);
    t.setEnabled(false);
    t.step("welcome_shown");
    await t.turns(runtime.ask);
    expect(t.choice.turnsDisclosed).toBe(false);
    const envOffInstall = setup({ DO_NOT_TRACK: "1" }).make();
    envOffInstall.step("welcome_shown");
    await envOffInstall.turns(runtime.ask);
    const dev = new Telemetry({ file: join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json"), version: "0.1.0", env: {}, dryRun: true, send: async () => undefined });
    dev.step("welcome_shown");
    await dev.turns(runtime.ask);
    expect(runtime.asks).toEqual([]);
  });

  it("sends each fact as code_turn from the disclosure on, 20 a post, and acknowledges what was posted", async () => {
    const runtime = fakeRuntime(25);
    const { sent, posts, make } = setup();
    const t = disclosed(make(), sent);
    expect(t.choice.turnsDisclosed).toBe(true);
    await t.turns(runtime.ask);
    expect(posts.slice(-2)).toEqual([20, 5]);
    const since = runtime.asks[0]!.since;
    expect(Date.parse(since)).toBeGreaterThan(Date.now() - 60_000);
    expect(runtime.asks).toEqual([{ since }]);
    const first = sent[0]!;
    expect(first).toMatchObject({ schema: "cli/v1", event: "code_turn", command: "code", subcommand: "turn", cli_version: "0.1.0", ts: "2026-11-07T04:00:01.000Z" });
    expect(first.turn).toMatchObject({ id: turnFact(1).id, model: "claude-opus-5-5", effort: "max", failure_class: "provider_error" });
    expect(first.turn).not.toHaveProperty("seq");
    expect(typeof first.anonymous_id).toBe("string");
    // The next round acknowledges all 25: nothing is sent twice.
    await t.turns(runtime.ask);
    expect(runtime.asks[1]).toEqual({ since, ack: 25 });
    expect(sent).toHaveLength(25);
    // The choice survives a relaunch.
    const relaunched = make();
    runtime.add(26);
    await relaunched.turns(runtime.ask);
    expect(runtime.asks[2]).toEqual({ since });
    expect(sent).toHaveLength(26);
  });

  it("a failed post is sent again: only what went is acknowledged", async () => {
    const runtime = fakeRuntime(30);
    const file = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
    let fail = 1; // the second post fails once
    const bodies: number[] = [];
    const t = new Telemetry({
      file,
      version: "0.1.0",
      env: {},
      send: async (_url, body) => {
        const events = JSON.parse(body) as Array<{ event: string }>;
        if (events[0]?.event === "code_turn" && bodies.length === 1 && fail-- > 0) throw new TypeError("fetch failed");
        if (events[0]?.event === "code_turn") bodies.push(events.length);
      },
    });
    t.step("welcome_shown");
    await t.turns(runtime.ask);
    expect(bodies).toEqual([20]);
    await t.turns(runtime.ask);
    expect(runtime.asks[1]!.ack).toBe(20);
    expect(bodies).toEqual([20, 10]);
  });

  it("off forgets when turn stats began; on again counts from then, and an older install's notice starts them", async () => {
    const { sent, make } = setup();
    const t = disclosed(make(), sent);
    const before = t.choice;
    t.setEnabled(false);
    expect(t.choice.turnsDisclosed).toBe(false);
    t.setEnabled(true);
    expect([before.turnsDisclosed, t.choice.turnsDisclosed]).toEqual([true, true]);
    const runtime = fakeRuntime(1);
    await t.turns(runtime.ask);
    expect(Date.parse(runtime.asks[0]!.since)).toBeGreaterThan(Date.now() - 60_000);

    // An install from before turn stats: disclosed, with no turnsSince, until the notice shows.
    const older = setup();
    writeFileSync(older.file, JSON.stringify({ enabled: true, anonymousId: "00000000-0000-4000-8000-000000000000", steps: ["welcome_shown"], disclosed: true }));
    const upgraded = older.make();
    const asked = fakeRuntime(1);
    await upgraded.turns(asked.ask);
    expect([upgraded.choice.turnsDisclosed, asked.asks.length]).toEqual([false, 0]);
    upgraded.disclosed();
    await upgraded.turns(asked.ask);
    expect([upgraded.choice.turnsDisclosed, asked.asks.length, older.sent.length]).toEqual([true, 1, 1]);
  });

  it("a company Cloud that takes none gets none, and they are not asked for again", async () => {
    const cloud = companyCloud(undefined);
    const t = onCloud("https://app.customer.example", cloud.fetchImpl);
    const telemetry = t.make();
    telemetry.step("welcome_shown");
    await telemetry.idle();
    const runtime = fakeRuntime(3);
    await telemetry.turns(runtime.ask);
    await telemetry.turns(runtime.ask);
    expect(t.sent).toEqual([]);
    expect(runtime.asks[1]!.ack).toBe(3);
  });

  it("turns from a launch under DO_NOT_TRACK are never sent: the next launch counts from itself, with no notice again", async () => {
    const { file, sent, make } = setup();
    const t = disclosed(make(), sent);
    const firstSince = JSON.parse(readFileSync(file, "utf8")).turnsSince as string;
    // A week under DO_NOT_TRACK: nothing asked, and the count's start is dropped.
    const quiet = new Telemetry({ file, version: "0.1.0", env: { DO_NOT_TRACK: "1" }, send: async () => undefined });
    const runtime = fakeRuntime(2);
    await quiet.turns(runtime.ask);
    expect(runtime.asks).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).turnsSince).toBeUndefined();
    // Back without it: a new start, after the old one, and the line still counts as shown.
    await new Promise((r) => setTimeout(r, 5));
    const back = make();
    expect(back.choice.turnsDisclosed).toBe(true);
    await back.turns(runtime.ask);
    expect(Date.parse(runtime.asks[0]!.since)).toBeGreaterThan(Date.parse(firstSince));
    void t;
  });

  it("turned off while a round is posting: nothing more goes", async () => {
    const runtime = fakeRuntime(45);
    const file = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
    const posted: number[] = [];
    let t!: Telemetry;
    t = new Telemetry({
      file,
      version: "0.1.0",
      env: {},
      send: async (_url, body) => {
        const events = JSON.parse(body) as Array<{ event: string }>;
        if (events[0]?.event !== "code_turn") return;
        posted.push(events.length);
        t.setEnabled(false);
      },
    });
    t.step("welcome_shown");
    await t.turns(runtime.ask);
    expect(posted).toEqual([20]);
  });
});

describe("the receiver's answer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a proxy's 5xx or 429 means the post did not arrive, so turn stats post it again; the receiver's 202 is final", async () => {
    const answers: number[] = [];
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(null, { status: answers.shift() ?? 202 });
    });
    const t = new Telemetry({ file: join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json"), version: "0.1.0", env: {}, url: "https://receiver.test/telemetry/cli" });
    t.step("welcome_shown");
    await t.idle();
    bodies.splice(0);
    answers.push(503, 202);
    const runtime = fakeRuntime(1);
    await t.turns(runtime.ask);
    await t.turns(runtime.ask);
    await t.turns(runtime.ask);
    // The 503'd post was not acknowledged, so it went again; the 202'd one was, so it did not go a third time.
    expect(bodies).toHaveLength(2);
    expect(runtime.asks.map((a) => a.ack)).toEqual([undefined, undefined, 1]);
  });
});


describe("the crash report gate (src/crashReports.ts)", () => {
  const COMPANY = "https://cloud.example.com";
  const gated = (env = {}, cloud?: () => Promise<string | undefined>) => {
    const file = join(mkdtempSync(join(tmpdir(), "caveman-telemetry-")), "telemetry.json");
    return { file, make: () => new Telemetry({ file, version: "0.1.0", env, send: async () => undefined, ...(cloud ? { cloud } : {}) }) };
  };

  it("holds reports until a line naming them has shown, then sends them on Caveman's Cloud", async () => {
    const { make } = gated();
    const t = make();
    const changes = vi.fn();
    t.onChange(changes);
    expect(await t.crashGate()).toBe("hold");
    t.step("welcome_shown");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(t.choice.reportsDisclosed).toBe(true);
    expect(await t.crashGate()).toBe("send");
    // Remembered by the next launch.
    expect(await make().crashGate()).toBe("send");
  });

  it("an install that saw the older line holds them until the notice or Settings names them", async () => {
    const { file, make } = gated();
    writeFileSync(file, JSON.stringify({ enabled: true, anonymousId: "6f1c2b8e-4c1a-4f7e-9d2a-0b1c2d3e4f50", steps: ["welcome_shown"], disclosed: true, turnsShown: true, turnsSince: "2026-11-08T00:00:00.000Z" }));
    const t = make();
    expect(t.choice).toMatchObject({ turnsDisclosed: true, reportsDisclosed: false });
    expect(await t.crashGate()).toBe("hold");
    t.disclosed();
    expect(t.choice.reportsDisclosed).toBe(true);
    // Turn stats keep counting from when they began.
    expect(JSON.parse(readFileSync(file, "utf8")).turnsSince).toBe("2026-11-08T00:00:00.000Z");
    expect(await t.crashGate()).toBe("send");
  });

  it("drops them when off, under DO_NOT_TRACK or CAVEMAN_TELEMETRY=0, and says they cannot go at all", async () => {
    for (const env of [{ DO_NOT_TRACK: "1" }, { CAVEMAN_TELEMETRY: "0" }]) {
      const t = gated(env).make();
      t.step("welcome_shown");
      expect([await t.crashGate(), t.crashReportsPossible]).toEqual(["drop", false]);
    }
    const t = gated().make();
    t.step("welcome_shown");
    t.setEnabled(false);
    expect([await t.crashGate(), t.crashReportsPossible, t.anonymousId]).toEqual(["drop", false, undefined]);
    // On again from Settings: the line beside the switch names them.
    t.setEnabled(true);
    expect(await t.crashGate()).toBe("send");
  });

  it("never sends one while the app uses a company's own Cloud, pinned or chosen", async () => {
    const pinned = gated({ CAVEMAN_CLOUD_URL: COMPANY }).make();
    pinned.step("welcome_shown");
    expect([await pinned.crashGate(), pinned.crashReportsPossible]).toEqual(["drop", false]);

    let cloud: string | undefined = COMPANY;
    const { make } = gated({}, async () => cloud);
    const t = make();
    t.step("welcome_shown");
    expect(t.crashReportsPossible).toBe(true);
    expect(await t.crashGate(0)).toBe("drop");
    // Remembered for the next launch, which then does not load the reporter at all.
    expect(make().crashReportsPossible).toBe(false);
    // Back on the hosted Cloud: the next read after the cached one says so.
    cloud = undefined;
    expect(await t.crashGate(1)).toBe("drop");
    expect(await t.crashGate(60_000)).toBe("send");
  });

  it("a runtime that cannot say uses the Cloud read last", async () => {
    const { file, make } = gated({}, () => Promise.reject(new Error("no runtime yet")));
    writeFileSync(file, JSON.stringify({ enabled: true, anonymousId: "6f1c2b8e-4c1a-4f7e-9d2a-0b1c2d3e4f50", steps: ["welcome_shown"], disclosed: true, turnsShown: true, reportsShown: true, cloud: COMPANY }));
    expect(await make().crashGate()).toBe("drop");
  });
});
