// delegate_task's Auto against a fake Caveman Cloud on a local port: the pool, the answer's mapping,
// every fallback, the time box, and outcomes posted once. Never a real Cloud or key.
import * as http from "node:http";

import type { ServerProvider } from "@caveman-app/protocol";
import type { SubagentRunner } from "@caveman-app/session-protocol";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AccountSession } from "../cloudLink/account.ts";
import { askRoute, layer, limitsExhausted, make, onCredits, personPin, pickOrder, planModels, planServing, postOutcome, routeBody, routePool, SubagentAuto, SubagentRouteLink, type RouteLink } from "./subagentAuto.ts";
import { makeRouterKey, setRouterKey } from "./routerKey.ts";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const provider = (instanceId: string, slugs: ReadonlyArray<string>, extra: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-17T00:00:00.000Z",
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...extra,
  }) as unknown as ServerProvider;
const full = (resetsAt?: string) => ({
  checkedAt: "2026-10-17T00:00:00.000Z",
  windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100, ...(resetsAt ? { resetsAt } : {}) }],
});

test("pick order: the lead, then the person (agent type or role pin), then Cloud, then inheritance", () => {
  const base = { leadPinned: false, agentTypeModel: false, pinned: false, defaultModel: "auto" } as const;
  expect(pickOrder({ ...base, leadPinned: true, pinned: true })).toBe("lead");
  expect(pickOrder({ ...base, leadPinned: true, pinned: true, pinAlways: true })).toBe("user");
  expect(pickOrder({ ...base, leadPinned: true, pinAlways: true })).toBe("lead");
  expect(pickOrder({ ...base, agentTypeModel: true })).toBe("user");
  expect(pickOrder({ ...base, pinned: true })).toBe("user");
  expect(pickOrder(base)).toBe("auto");
  expect(pickOrder({ ...base, defaultModel: "auto-by-role" })).toBe("default");
  expect(pickOrder({ ...base, defaultModel: "inherit" })).toBe("default");
});

test("the person's pin: a named role's, then the brief's task kind, then general's; the classifier only when a kind is pinned", async () => {
  let asked = 0;
  const classify = (kind: "frontend_ui" | "backend_fix" | undefined) => async () => {
    asked++;
    return kind;
  };
  const rolePins = { review: "review-pin", general: "general-pin" } as const;
  const taskPins = { frontend_ui: "ui-pin" } as const;
  // A named role's pin decides without the classifier.
  expect(await personPin({ role: "review", rolePins, taskPins, classify: classify("frontend_ui") })).toEqual({ pin: "review-pin", task: undefined });
  expect(asked).toBe(0);
  // No role named: the kind's pin, with the kind it read.
  expect(await personPin({ role: "general", rolePins, taskPins, classify: classify("frontend_ui") })).toEqual({ pin: "ui-pin", task: "frontend_ui" });
  // A kind nobody pinned falls to general's.
  expect(await personPin({ role: "general", rolePins, taskPins, classify: classify("backend_fix") })).toEqual({ pin: "general-pin", task: undefined });
  // A named role with no pin of its own takes the kind's, never general's.
  expect(await personPin({ role: "implementation", rolePins, taskPins, classify: classify("frontend_ui") })).toEqual({ pin: "ui-pin", task: "frontend_ui" });
  expect(await personPin({ role: "implementation", rolePins, taskPins, classify: classify(undefined) })).toEqual({ pin: undefined, task: undefined });
  // No kind pinned: the classifier never runs.
  asked = 0;
  expect(await personPin({ role: "general", rolePins, taskPins: { frontend_ui: null }, classify: classify("frontend_ui") })).toEqual({ pin: "general-pin", task: undefined });
  expect(asked).toBe(0);
});

test("the pool is exactly the ready connected instances x their models, a spent login left out", () => {
  const signedIn = (type?: string) => ({ auth: { status: "authenticated", ...(type ? { type } : {}) } }) as Partial<ServerProvider>;
  const providers = [
    provider("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5[1m]", "caveman-auto"], signedIn("max")),
 // A second Codex login on a compact plan; the first is a key whose weekly window is spent.
    provider("codex", ["gpt-6.1-sol"], { usageLimits: full("2026-10-20T00:00:00.000Z") } as Partial<ServerProvider>),
    provider("codex-account-ab12", ["gpt-6.1-sol", "gpt-6-luna"]),
    // Full but past its reset, and full but running on credits: both still usable.
    provider("cursor", ["composer-2"], { ...signedIn("browser"), usageLimits: full("2026-10-17T11:00:00.000Z") } as Partial<ServerProvider>),
    provider("grok", ["grok-5"], { ...signedIn("cached_token"), usageLimits: { ...full("2026-10-20T00:00:00.000Z"), onCredits: true } } as Partial<ServerProvider>),
    // A login that says nothing of how it pays (OpenCode, Pi): unknown billing. A slug with no model is skipped.
    provider("opencode", ["anthropic/claude-haiku-5-5", "anthropic/"]),
    provider("pi", ["pi-model"], signedIn("pi")),
    // Not ready: signed out, auth unknown, still probing, in error, off.
    provider("pi-account-2", ["pi-model"], { auth: { status: "unauthenticated" } } as Partial<ServerProvider>),
    provider("muse-account-2", ["muse-1"], { auth: { status: "unknown" } } as Partial<ServerProvider>),
    provider("opencode-account-2", ["x"], { probePending: true } as Partial<ServerProvider>),
    provider("muse", ["muse-1"], { status: "error" } as Partial<ServerProvider>),
    provider("antigravity", ["gemini-3-pro"], { enabled: false }),
    // The Caveman engine: only its connected set (credits, a key, a local and a custom endpoint), never Auto itself.
    provider("caveman", ["auto", "caveman/anthropic/claude-sonnet-5-5", "openai~2/gpt-6-luna", "openai/o1-legacy", "ollama/qwen3", "custom-lab/m1"], signedIn("api_key")),
    // An ACP registry agent, and one the orchestrator can't run a child on.
    provider("gemini", ["gemini-3-flash"]),
    provider("no-adapter", ["m"]),
  ];
  const { pool, targets } = routePool({
    providers,
    capable: (p) => p.instanceId !== "no-adapter",
    hidden: (instanceId, slug) => instanceId === "claudeAgent" && slug === "claude-opus-5-5",
    cavemanConnected: ["caveman/anthropic/claude-sonnet-5-5", "openai~2/gpt-6-luna", "ollama/qwen3", "custom-lab/m1"],
    chatGptLogin: (id) => id === "codex-account-ab12",
    now,
  });
  const entry = (id: string, model: string, host: string, harness: string, billing?: string) => ({ id, model, host, via: "local", harness, ...(billing ? { billing } : {}) });
  // Round-robin: each instance's first model, then each one's second, and so on.
  expect(pool).toEqual([
    entry("claudeAgent/claude-sonnet-5-5[1m]", "claude-sonnet-5-5", "anthropic", "claude-agent", "subscription"),
    entry("codex-account-ab12/gpt-6.1-sol", "gpt-6.1-sol", "openai", "codex", "subscription"),
    entry("cursor/composer-2", "composer-2", "cursor", "cursor", "subscription"),
    entry("grok/grok-5", "grok-5", "xai", "grok", "subscription"),
    entry("opencode/anthropic/claude-haiku-5-5", "claude-haiku-5-5", "anthropic", "opencode"),
    entry("pi/pi-model", "pi-model", "pi", "pi"),
    entry("caveman/caveman/anthropic/claude-sonnet-5-5", "claude-sonnet-5-5", "caveman", "caveman", "credits"),
    entry("gemini/gemini-3-flash", "gemini-3-flash", "acp", "acp"),
    entry("codex-account-ab12/gpt-6-luna", "gpt-6-luna", "openai", "codex", "subscription"),
    entry("caveman/openai~2/gpt-6-luna", "gpt-6-luna", "openai", "caveman", "api_key"),
    entry("caveman/ollama/qwen3", "qwen3", "ollama", "caveman"),
    entry("caveman/custom-lab/m1", "m1", "custom-lab", "caveman"),
  ]);
  // Each id maps back to its instance and the instance's own slug.
  expect(targets.get("caveman/openai~2/gpt-6-luna")).toEqual({ instanceId: "caveman", model: "openai~2/gpt-6-luna" });
  expect(targets.get("claudeAgent/claude-sonnet-5-5[1m]")).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5[1m]" });
});

test("billing is said only where it is known", () => {
  const billing = (instanceId: string, type?: string, slug = "m") =>
    routePool({ providers: [provider(instanceId, [slug], { auth: { status: "authenticated", ...(type ? { type } : {}) } } as Partial<ServerProvider>)], capable: () => true, now }).pool[0]!.billing;
  expect(["max", "pro", "team", "enterprise", "claude_max"].map((t) => billing("claudeAgent", t))).toEqual(Array(5).fill("subscription"));
  expect(["apiKey", "bedrock", "vertex"].map((t) => billing("claudeAgent", t))).toEqual(Array(3).fill("api_key"));
  expect(billing("claudeAgent")).toBeUndefined();
  expect(billing("cursor", "api-key")).toBe("api_key");
  expect(billing("codex", "apiKey")).toBe("api_key");
  expect(billing("codex")).toBeUndefined();
  expect(billing("muse", "oauth")).toBeUndefined();
  // Every spelling Claude's CLI reports a plan in (ClaudeProvider claudeSubscriptionLabel) is a plan: a Max 20x login
  // left unsaid would rank last in Cloud's harness tie-break, behind a per-token key.
  expect(["max5", "max20", "maxplan", "claude_max_5x_subscription", "claude_max_20x_subscription", "claude_pro_subscription", "Claude Team Subscription"].map((t) => billing("claudeAgent", t))).toEqual(Array(7).fill("subscription"));
  expect(billing("claudeAgent", "free")).toBeUndefined();
  expect(billing("claudeAgent", "anthropic_api_key")).toBe("api_key");
  expect(billing("codex", "amazonBedrock")).toBe("api_key");
  expect(billing("grok", "cached_token")).toBe("subscription");
  expect(billing("caveman", "api_key", "lmstudio/m")).toBeUndefined();
  expect(billing("caveman", "api_key", "chatgpt/openai/m")).toBe("subscription");
});

test("a pool over Cloud's cap is shared fairly across instances, the same every time", () => {
  const big = provider("codex", Array.from({ length: 80 }, (_, n) => `m${n}`));
  const small = provider("claudeAgent", ["a", "b", "c"]);
  const once = routePool({ providers: [big, small], capable: () => true, now }).pool;
  expect(once).toHaveLength(64);
  expect(once.filter((e) => e.harness === "claude-agent").map((e) => e.model)).toEqual(["a", "b", "c"]);
  expect(routePool({ providers: [big, small], capable: () => true, now }).pool).toEqual(once);
});

test("a full window stops only what it covers: a model-scoped weekly its model, extra usage nothing", () => {
  const ahead = "2026-10-20T00:00:00.000Z";
  const limits = (...windows: ReadonlyArray<{ id: string; kind: string }>) =>
    ({ usageLimits: { checkedAt: ahead, windows: windows.map((w) => ({ ...w, label: w.id, usedPercent: 100, resetsAt: ahead })) } }) as unknown as Pick<ServerProvider, "usageLimits">;
  const opusWeek = limits({ id: "seven_day_opus", kind: "weekly" });
  expect(limitsExhausted(opusWeek, now, "claude-opus-5-5")).toBe(true);
  expect(limitsExhausted(opusWeek, now, "claude-opus-5-5[1m]")).toBe(true);
  expect(limitsExhausted(opusWeek, now, "claude-sonnet-5-5")).toBe(false);
  // A scope names a version: the next version is another model.
  const opus55 = limits({ id: "seven_day_opus_5_5", kind: "weekly" });
  expect(limitsExhausted(opus55, now, "claude-opus-5-5")).toBe(true);
  expect(limitsExhausted(opus55, now, "claude-opus-5-6")).toBe(false);
  // An unnamed overage bucket and extra usage stop nothing; the plan's own windows stop everything.
  expect(limitsExhausted(limits({ id: "seven_day_overage_included", kind: "weekly" }), now, "claude-fable-5-2")).toBe(false);
  expect(limitsExhausted(limits({ id: "monthly_spend", kind: "monthly" }), now, "claude-opus-5-5")).toBe(false);
  expect(limitsExhausted(limits({ id: "individual", kind: "monthly" }), now, "gpt-6.1-sol")).toBe(false);
  expect(limitsExhausted(limits({ id: "five_hour", kind: "session" }), now, "claude-sonnet-5-5")).toBe(true);
  // Codex Free and Go: the monthly allowance is the plan.
  expect(limitsExhausted(limits({ id: "primary", kind: "monthly" }), now, "gpt-6.1-sol")).toBe(true);
});

describe("plans before credits", () => {
  const plan = (instanceId: string, slugs: ReadonlyArray<string>, extra: Partial<ServerProvider> = {}) =>
    provider(instanceId, slugs, { auth: { status: "authenticated", type: "max" }, ...extra } as Partial<ServerProvider>);
  const credits = provider("caveman", ["caveman/anthropic/claude-opus-5-5", "caveman/anthropic/claude-sonnet-5-5", "caveman/zai/glm-5.3"], {
    auth: { status: "authenticated", type: "api_key" },
  } as Partial<ServerProvider>);
  const opusWeekFull = {
    usageLimits: { checkedAt: "2026-10-17T00:00:00.000Z", windows: [{ id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus", usedPercent: 100, resetsAt: "2026-10-20T00:00:00.000Z" }] },
  } as unknown as Partial<ServerProvider>;

  test("a lead's credits Opus finds the Claude plan that runs Opus, the next login when the first is out of Opus", () => {
    const providers = [plan("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"], opusWeekFull), plan("claudeAgent-account-2", ["claude-opus-5-5"]), credits];
    expect(planServing({ providers, capable: () => true, now }, "caveman/anthropic/claude-opus-5-5")).toEqual({ instanceId: "claudeAgent-account-2", model: "claude-opus-5-5" });
    expect(planServing({ providers, capable: () => true, now }, "caveman/anthropic/claude-sonnet-5-5")).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    // A plan with only the standard window doesn't stand for the long-context variant.
    expect(planServing({ providers, capable: () => true, now }, "caveman/anthropic/claude-opus-5-5[1m]")).toBeUndefined();
    // Nothing of the person's runs GLM: credits stay its payer.
    expect(planServing({ providers, capable: () => true, now }, "caveman/zai/glm-5.3")).toBeUndefined();
    expect([...planModels({ providers, capable: () => true, now })].toSorted()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  test("a key, a signed-out login, one that can't run a child or a hidden model is no plan", () => {
    const providers = [
      provider("claudeAgent", ["claude-opus-5-5"], { auth: { status: "authenticated", type: "apiKey" } } as Partial<ServerProvider>),
      plan("claudeAgent-account-2", ["claude-opus-5-5"], { auth: { status: "unauthenticated" } } as Partial<ServerProvider>),
      plan("claudeAgent-account-3", ["claude-opus-5-5"]),
      plan("claudeAgent-account-4", ["claude-opus-5-5"]),
      credits,
    ];
    const input = { providers, capable: (p: ServerProvider) => p.instanceId !== "claudeAgent-account-3", hidden: (id: string) => id === "claudeAgent-account-4", now };
    expect(planServing(input, "caveman/anthropic/claude-opus-5-5")).toBeUndefined();
  });

  test("only the credits key slot is credits", () => {
    expect(onCredits(credits, "caveman/anthropic/claude-opus-5-5")).toBe(true);
    expect(onCredits(credits, "anthropic/claude-opus-5-5")).toBe(false);
    expect(onCredits(plan("claudeAgent", []), "caveman/anthropic/claude-opus-5-5")).toBe(false);
  });

  test("the pool has one entry per harness and model, on its best billing; a login out of Opus still offers Sonnet", () => {
    const providers = [
      plan("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"], opusWeekFull),
      plan("claudeAgent-account-2", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]),
      provider("caveman", ["anthropic/claude-opus-5-5", "caveman/anthropic/claude-opus-5-5"], { auth: { status: "authenticated", type: "api_key" } } as Partial<ServerProvider>),
    ];
    const { pool, targets } = routePool({ providers, capable: () => true, now });
    expect(pool.map((e) => [e.id, e.billing])).toEqual([
      ["claudeAgent/claude-sonnet-5-5", "subscription"],
      ["claudeAgent-account-2/claude-opus-5-5", "subscription"],
      // The Caveman engine's Opus once, on Cloud's harness order (credits before a key).
      ["caveman/caveman/anthropic/claude-opus-5-5", "credits"],
      // A long-context variant is its own entry, from whichever login lists it (round-robin puts it second).
      ["claudeAgent-account-2/claude-sonnet-5-5[1m]", "subscription"],
    ]);
    expect(targets.get("claudeAgent-account-2/claude-opus-5-5")).toEqual({ instanceId: "claudeAgent-account-2", model: "claude-opus-5-5" });
  });
});

describe("against a fake Caveman Cloud", () => {
  let server: http.Server;
  let link: RouteLink;
  const seen: Array<{ readonly url: string; readonly auth: string | undefined; readonly body: Record<string, unknown> }> = [];
  let reply: (url: string) => { readonly status: number; readonly body?: unknown; readonly delayMs?: number } = () => ({ status: 200, body: {} });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
        const { status, body, delayMs } = reply(req.url ?? "");
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body === undefined ? {} : body));
        }, delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    link = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, fetch: globalThis.fetch, timeoutMs: 300 };
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const { pool, targets } = routePool({ providers: [provider("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]), provider("codex", ["gpt-6.1-sol", "gpt-6-luna"])], capable: () => true, now });
  const body = routeBody("gpt-6.1-sol", { kind: "review", agent: "reviewer", brief: "Review the parser change." }, pool);

  test("asks with the task body only, and maps Cloud's pool id back to an instance and model", async () => {
    reply = () => ({ status: 200, body: { model: "claude-sonnet-5-5", reason: "task_review", effort: "high", effort_mode: "top", pool_id: "claudeAgent/claude-sonnet-5-5", outcome_token: "tok" } });
    expect(await askRoute(link, "cave_k", body, targets)).toEqual({ kind: "pick", target: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" }, effort: "high", outcome: { token: "tok", url: link.url } });
    const sent = seen.at(-1)!;
    expect(sent.url).toBe("/v1/route");
    expect(sent.auth).toBe("Bearer cave_k");
    expect(Object.keys(sent.body).sort()).toEqual(["models", "pool", "task"]);
    expect(sent.body).toEqual({ models: ["gpt-6.1-sol"], task: { kind: "review", agent: "reviewer", brief: "Review the parser change." }, pool });
  });

  test.each(["implementation", "research", "review", "design", "test", "general"] as const)("sends %s as task.kind; Cloud can move an Opus lead's child to Codex Luna", async (kind) => {
    reply = () => ({ status: 200, body: { model: "gpt-6-luna", pool_id: "codex/gpt-6-luna", effort: "low" } });
    const request = routeBody("claude-opus-5-5", { kind, brief: "Read the parser." }, pool);
    expect(await askRoute(link, "cave_k", request, targets)).toEqual({ kind: "pick", target: { instanceId: "codex", model: "gpt-6-luna" }, effort: "low" });
    expect(seen.at(-1)!.body).toEqual({ models: ["claude-opus-5-5"], task: { kind, brief: "Read the parser." }, pool });
  });

  test("the agent name is cut to 128 bytes and the brief to the 32 KiB Cloud reads; the body stays under 256 KiB", () => {
    const big = routeBody("m", { kind: "general", agent: "ü".repeat(100), brief: '"\u0001é'.repeat(40_000) }, routePool({ providers: [provider("codex", Array.from({ length: 80 }, (_, n) => `model-with-a-long-name-${n}`))], capable: () => true, now }).pool);
    expect(Buffer.byteLength(big.task.agent!, "utf8")).toBeLessThanOrEqual(128);
    expect(big.task.agent).toBe("ü".repeat(64));
    expect(Buffer.byteLength(big.task.brief!, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeLessThan(256 * 1024);
  });

  test("an answer that is not an object is no decision", async () => {
    for (const body of [null, [], "ok", 3]) {
      reply = () => ({ status: 200, body });
      expect(await askRoute(link, "cave_k", routeBody("m", { kind: "general" }, pool), targets)).toEqual({ kind: "fallback", reason: "cloud_error" });
    }
  });

  test("no pool id is Cloud keeping the caller's default, with its token", async () => {
    reply = () => ({ status: 200, body: { model: "gpt-6.1-sol", reason: "no_alternative", outcome_token: "tok2" } });
    expect(await askRoute(link, "cave_k", body, targets)).toEqual({ kind: "default", outcome: { token: "tok2", url: link.url } });
  });

  test("every reason Cloud can't answer is a fallback", async () => {
    const cases: Array<[ReturnType<typeof reply>, string]> = [
      [{ status: 200, body: { model: "gpt-6.1-sol", reason: "allowance", notice: "Free routing used for October." } }, "quota"],
      [{ status: 200, body: { model: "gpt-6.1-sol", reason: "billing_limit" } }, "quota"],
      [{ status: 401, body: { error: { code: "cave_invalid_api_key" } } }, "cloud_unlinked"],
      [{ status: 403, body: { error: { code: "cave_api_key_scope_required" } } }, "cloud_unlinked"],
      [{ status: 402 }, "not_paying"],
      [{ status: 503 }, "cloud_error"],
      [{ status: 200, body: { model: "x", reason: "task_review", pool_id: "never-sent/x" } }, "cloud_error"],
    ];
    for (const [answer, reason] of cases) {
      reply = () => answer;
      expect(await askRoute(link, "cave_k", body, targets)).toEqual({ kind: "fallback", reason });
    }
    // Nothing listening.
    expect(await askRoute({ ...link, url: "http://127.0.0.1:9" }, "cave_k", body, targets)).toEqual({ kind: "fallback", reason: "cloud_error" });
  });

  test.each([401, 403])("a refused key triggers one remint and one retry (%s)", async (status) => {
    let calls = 0;
    let mints = 0;
    reply = () => ({ status: ++calls === 1 ? status : 200, body: { model: "gpt-6-luna", pool_id: "codex/gpt-6-luna" } });
    const credential = {
      get: async () => ({ key: "cave_new", url: link.url }),
      rejected: async (key: string, code: number, remint = true) => { if (remint) { expect([key, code]).toEqual(["cave_old", status]); mints++; } },
    };
    expect(await askRoute({ ...link, credential }, "cave_old", body, targets)).toMatchObject({ kind: "pick", target: { model: "gpt-6-luna" } });
    expect(mints).toBe(1);
    expect(seen.at(-1)?.auth).toBe("Bearer cave_new");
    calls = 0;
    reply = () => { calls++; return { status }; };
    await askRoute({ ...link, credential }, "cave_old", body, targets);
    expect(calls).toBe(2);
    expect(mints).toBe(2);
  });

  test("402 drops the held routing credential without retrying", async () => {
    let dropped = 0;
    reply = () => ({ status: 402 });
    const before = seen.length;
    const credential = { get: async () => undefined, rejected: async (_key: string, status: number) => { expect(status).toBe(402); dropped++; } };
    expect(await askRoute({ ...link, credential }, "cave_paid", body, targets)).toEqual({ kind: "fallback", reason: "not_paying" });
    expect(dropped).toBe(1);
    expect(seen.length - before).toBe(1);
  });

  test("delegation reads the runtime's shared paid-plan routing credential", async () => {
    const session = { cloud_url: link.url, access_token: "cave_login_fake", routing_key: "cave_paid_shared", routing_expires_at: "2099-01-01T00:00:00Z" };
    setRouterKey(makeRouterKey({ store: { load: async () => session, save: async () => {} }, credits: async () => undefined }));
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const auto = yield* SubagentAuto;
        const connected = yield* auto.connected;
        reply = () => ({ status: 200, body: { model: "gpt-6-luna", pool_id: "codex/gpt-6-luna" } });
        expect(connected.key).toBe("cave_paid_shared");
        return yield* auto.ask(connected.key!, body, targets);
      }).pipe(Effect.provide(layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))), Effect.provideService(SubagentRouteLink, link)));
      expect(result.kind).toBe("pick");
      expect(seen.at(-1)?.auth).toBe("Bearer cave_paid_shared");
    } finally { setRouterKey(undefined); }
  });

  test("a slow Cloud is cut off at the time box", async () => {
    reply = () => ({ status: 200, body: { pool_id: "codex/gpt-6.1-sol" }, delayMs: 2_000 });
    const started = Date.now();
    expect(await askRoute(link, "cave_k", body, targets)).toEqual({ kind: "fallback", reason: "cloud_error" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a refused key whose re-mint Cloud never answers keeps the ask inside the time box", async () => {
    reply = () => ({ status: 401 });
    let session: AccountSession | undefined = { cloud_url: "http://cloud.invalid", access_token: "cave_login_fake", routing_key: "cave_router_old", routing_expires_at: "2099-01-01T00:00:00Z" };
    // The mint's own 5 s abort is all that ends it.
    const unanswered = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const credential = makeRouterKey({ store: { load: async () => session, save: async (value) => void (session = value) }, credits: async () => undefined, fetch: unanswered });
    const started = Date.now();
    expect(await askRoute({ ...link, credential }, "cave_router_old", body, targets)).toEqual({ kind: "fallback", reason: "cloud_unlinked" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("an outcome posts its token and kind, and a refusal never throws", async () => {
    reply = () => ({ status: 202 });
    expect(await postOutcome(link, "cave_k", "tok", "completed")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ url: "/v1/route/outcomes", auth: "Bearer cave_k", body: { outcome_token: "tok", outcome_kind: "completed" } });
    reply = () => ({ status: 500 });
    expect(await postOutcome(link, "cave_k", "tok", "failed")).toBe(false);
  });

  test("the service keeps a runner by command, hands it to the child's thread, and posts its outcome once", async () => {
    reply = () => ({ status: 202 });
    const runner: SubagentRunner = { engine: "codex", instance_id: "codex", model: "gpt-6.1-sol", effort: "high", pick: { by: "auto", kind: "review" } };
    const program = Effect.gen(function* () {
      const auto = yield* SubagentAuto;
      yield* auto.remember("cmd-1", runner, { token: "tok-a", url: link.url });
      // A retry of the same delegation keeps the first record.
      yield* auto.remember("cmd-1", { ...runner, model: "other" }, { token: "tok-b", url: link.url });
      yield* auto.remember("cmd-2", { ...runner, pick: { by: "default", kind: "review", fallback: "cloud_unlinked" } }, undefined);
      expect(yield* auto.adopt("cmd-1", "thread-1")).toEqual(runner);
      expect(yield* auto.adopt("cmd-unknown", "thread-x")).toBeUndefined();
      yield* auto.adopt("cmd-2", "thread-2");
      const before = seen.length;
      yield* auto.finish("thread-1", "completed");
      yield* auto.finish("thread-1", "failed");
      // No token (a fallback): nothing to report.
      yield* auto.finish("thread-2", "completed");
      return seen.slice(before);
    });
    const posted = await Effect.runPromise(
      program.pipe(
        Effect.provide(layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))),
        Effect.provideService(SubagentRouteLink, { ...link, key: "cave_k" }),
      ),
    );
    expect(posted).toEqual([{ url: "/v1/route/outcomes", auth: "Bearer cave_k", body: { outcome_token: "tok-a", outcome_kind: "completed" } }]);
  });

  test("a runner an older runtime kept without its gateway still posts its outcome, where its credential goes", async () => {
    reply = () => ({ status: 202 });
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE caveman_subagent_runners (command_id TEXT PRIMARY KEY, runner TEXT NOT NULL, outcome_token TEXT, child_thread_id TEXT, outcome_sent INTEGER NOT NULL DEFAULT 0)`;
      yield* sql`INSERT INTO caveman_subagent_runners (command_id, runner, outcome_token) VALUES ('cmd-old', '{}', 'tok-old')`;
      const auto = yield* make;
      yield* auto.adopt("cmd-old", "thread-old");
      const before = seen.length;
      yield* auto.finish("thread-old", "completed");
      return seen.slice(before);
    });
    const posted = await Effect.runPromise(program.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.provideService(SubagentRouteLink, { ...link, key: "cave_k" })));
    expect(posted).toEqual([{ url: "/v1/route/outcomes", auth: "Bearer cave_k", body: { outcome_token: "tok-old", outcome_kind: "completed" } }]);
  });

  test("a runner that can't be written is logged, never a failed delegation", async () => {
    const program = Effect.gen(function* () {
      const auto = yield* SubagentAuto;
      yield* (yield* SqlClient.SqlClient)`DROP TABLE caveman_subagent_runners`;
      yield* auto.remember("cmd-lost", { engine: "codex", instance_id: "codex", model: "m", pick: { by: "auto" } }, { token: "tok", url: link.url });
      return "delegated";
    });
    const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
    expect(await Effect.runPromise(program.pipe(Effect.provide(Layer.provideMerge(layer, sqlite)), Effect.provideService(SubagentRouteLink, link)))).toBe("delegated");
  });

  describe("signed in to a company's own Cloud", () => {
    // Its device grant named the fake Cloud's gateway; the link keeps its default, Caveman's credits gateway.
    let session: AccountSession;
    let caveman: { readonly url: string; readonly seen: Array<string>; readonly close: () => Promise<void> };
    beforeAll(async () => {
      const hits: Array<string> = [];
      const server = http.createServer((req, res) => {
        hits.push(`${req.url} ${req.headers.authorization}`);
        req.resume();
        res.writeHead(401).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      caveman = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen: hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    });
    afterAll(() => caveman.close());

    const runner: SubagentRunner = { engine: "codex", instance_id: "codex", model: "gpt-6-luna", pick: { by: "auto", kind: "review" } };
    /** A delegation Auto routed on the company's Cloud; `meanwhile` runs before its child ends. */
    const delegated = (commandId: string, meanwhile: () => void) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auto = yield* SubagentAuto;
          const { key } = yield* auto.connected;
          const answer = yield* auto.ask(key!, body, targets);
          expect(answer.kind).toBe("pick");
          yield* auto.remember(commandId, runner, answer.kind === "pick" ? answer.outcome : undefined);
          yield* auto.adopt(commandId, `thread-${commandId}`);
          meanwhile();
          yield* auto.finish(`thread-${commandId}`, "completed");
        }).pipe(
          Effect.provide(layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))),
          Effect.provideService(SubagentRouteLink, { url: caveman.url, fetch: globalThis.fetch, timeoutMs: 300 }),
        ),
      );
    beforeEach(() => {
      session = { cloud_url: "https://cloud.customer.example", gateway_url: link.url, access_token: "cave_login_fake", routing_key: "cave_router_company", routing_expires_at: "2099-01-01T00:00:00Z" };
      setRouterKey(makeRouterKey({ store: { load: async () => session, save: async () => {} }, credits: async () => undefined }));
      reply = (url) => (url === "/v1/route" ? { status: 200, body: { model: "gpt-6-luna", pool_id: "codex/gpt-6-luna", outcome_token: "tok-company" } } : { status: 202 });
      caveman.seen.length = 0;
    });
    afterEach(() => setRouterKey(undefined));

    test("a child's outcome goes back to the gateway that issued its token, and Caveman's gateway never sees the company's key", async () => {
      const before = seen.length;
      await delegated("cmd-company", () => {});
      expect(seen.slice(before).map((s) => [s.url, s.auth, s.url === "/v1/route" ? undefined : s.body])).toEqual([
        ["/v1/route", "Bearer cave_router_company", undefined],
        ["/v1/route/outcomes", "Bearer cave_router_company", { outcome_token: "tok-company", outcome_kind: "completed" }],
      ]);
      expect(caveman.seen).toEqual([]);
    });

    test("a refused key re-minted for another gateway: the retry asks there, and the outcome goes back to that gateway", async () => {
      // The first gateway refuses the key; the re-mint's credential names the company Cloud's gateway.
      const credential = { get: async () => ({ key: "cave_router_reminted", url: link.url }), rejected: async () => {} };
      const answer = await askRoute({ ...link, url: caveman.url, credential }, "cave_router_refused", body, targets);
      expect(answer).toMatchObject({ kind: "pick", outcome: { token: "tok-company", url: link.url } });
      expect(caveman.seen).toEqual(["/v1/route Bearer cave_router_refused"]);
      expect(seen.at(-1)).toMatchObject({ url: "/v1/route", auth: "Bearer cave_router_reminted" });
    });

    /** Run against Caveman's gateway as the link's default. */
    const onCompanyCloud = <A>(program: Effect.Effect<A, never, SubagentAuto>) =>
      Effect.runPromise(
        program.pipe(
          Effect.provide(layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))),
          Effect.provideService(SubagentRouteLink, { url: caveman.url, fetch: globalThis.fetch, timeoutMs: 300 }),
        ),
      );

    test("a key another delegation's refusal takes back while this one picks never goes to Caveman's gateway", async () => {
      // The company gateway refuses the key; its re-mint is held open so this delegation asks inside that window.
      let minting!: () => void;
      const minted = new Promise<void>((resolve) => (minting = resolve));
      let release!: (response: Response) => void;
      const mint = (() => { minting(); return new Promise<Response>((resolve) => (release = resolve)); }) as unknown as typeof fetch;
      setRouterKey(makeRouterKey({ store: { load: async () => session, save: async (value) => void (session = value!) }, credits: async () => undefined, fetch: mint }));
      reply = (url) => (url === "/v1/route" ? { status: 401 } : { status: 202 });
      const before = seen.length;
      const answer = await onCompanyCloud(Effect.gen(function* () {
        const auto = yield* SubagentAuto;
        const { key } = yield* auto.connected;
        const other = yield* auto.ask(key!, body, targets).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => minted);
        const answer = yield* auto.ask(key!, body, targets);
        release(new Response(null, { status: 500 }));
        yield* Fiber.join(other);
        return answer;
      }));
      expect(answer).toEqual({ kind: "fallback", reason: "cloud_unlinked" });
      expect(seen.slice(before).map((s) => `${s.url} ${s.auth}`)).toEqual(["/v1/route Bearer cave_router_company"]);
      expect(caveman.seen).toEqual([]);
    });

    test("signed in to another Cloud while a delegation picks, the company's key never goes to that Cloud's gateway", async () => {
      const answer = await onCompanyCloud(Effect.gen(function* () {
        const auto = yield* SubagentAuto;
        const { key } = yield* auto.connected;
        session = { cloud_url: "https://other.example", gateway_url: caveman.url, access_token: "cave_login_other", routing_key: "cave_router_other", routing_expires_at: "2099-01-01T00:00:00Z" };
        return yield* auto.ask(key!, body, targets);
      }));
      expect(answer).toEqual({ kind: "fallback", reason: "cloud_unlinked" });
      expect(caveman.seen).toEqual([]);
    });

    test("signed in to another Cloud before the child ends, its outcome goes nowhere and no key leaves for a gateway it is not for", async () => {
      const before = seen.length;
      await delegated("cmd-moved", () => {
        session = { cloud_url: "https://other.example", gateway_url: caveman.url, access_token: "cave_login_other", routing_key: "cave_router_other", routing_expires_at: "2099-01-01T00:00:00Z" };
      });
      expect(seen.slice(before).map((s) => s.url)).toEqual(["/v1/route"]);
      expect(caveman.seen).toEqual([]);
    });
  });

  test("unlinked (no key, no credits key held) is said as such and posts nothing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auto = yield* SubagentAuto;
        yield* auto.remember("cmd-3", { engine: "codex", instance_id: "codex", model: "m", pick: { by: "auto" } }, { token: "tok-c", url: link.url });
        yield* auto.adopt("cmd-3", "thread-3");
        const before = seen.length;
        yield* auto.finish("thread-3", "interrupted");
        return { connected: yield* auto.connected, posted: seen.length - before };
      }).pipe(Effect.provide(layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })))), Effect.provideService(SubagentRouteLink, link)),
    );
    expect(result).toEqual({ connected: { key: undefined, caveman: undefined }, posted: 0 });
  });
});
