// This Mac's side of "sign in once" (macConnections.ts) against the test Cloud (testCloudEngine.ts, which keeps one
// ordered list per person and is the only refresher): what a Mac lists, when an engine's chats here run on a
// connection, where each kind's credential comes from and how long it is kept, what happens offline, and that
// another person sees nothing. The secrets are the test provider's, made for the run.
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { tempRoot } from "../session-protocol/testHarness.ts";
import { STAND_IN_MARK } from "./engineLogins.ts";
import { CloudError, enroll } from "./identity.ts";
import { MacConnections } from "./macConnections.ts";
import {
  usedUpNote,
  type DataPlaneAnswer,
  type ModelConnection,
  type ModelConnectionList,
} from "./modelConnections.ts";
import { startTestCloud } from "./testCloud.ts";
import { startEngineCloud, type EngineCloud } from "./testCloudEngine.ts";

let inner: Awaited<ReturnType<typeof startTestCloud>>;
let cloud: EngineCloud;
const roots: Array<string> = [];
beforeAll(async () => {
  inner = await startTestCloud();
  cloud = await startEngineCloud(inner.url, { hosted: [] });
});
afterAll(async () => {
  await cloud.close();
  await inner.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

let people = 0;
const person = () => inner.state.chats.addPerson(`person-${++people}`);
const post = async (url: string, body: unknown) =>
  (
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

/** A sign-in at the provider, approved: what `claude setup-token` prints, or what `codex login` writes. */
async function signIn(kind: "claude"): Promise<string>;
async function signIn(
  kind: "chatgpt",
): Promise<{ access_token: string; refresh_token: string; id_token: string; account_id: string }>;
async function signIn(kind: "claude" | "chatgpt"): Promise<unknown> {
  const { state } = (await post(`${cloud.url}/__provider/oauth/start`, { kind })) as {
    state: string;
  };
  await cloud.approve();
  const out = (await post(`${cloud.url}/__provider/oauth/finish`, { state })) as { token?: string };
  return kind === "claude" ? out.token : out;
}

/** A Mac of `bearer`'s person: enrolled, with a sealed store and a remembered list of its own, and a clock the test moves. */
async function mac(bearer: string, now: () => number = Date.now) {
  const root = tempRoot("mac-connections-");
  roots.push(root);
  const identity = await enroll({
    dir: path.join(root, "link"),
    cloudUrl: cloud.url,
    bearer,
    name: "A Mac",
  });
  const at = {
    skewMs: 0,
    signedIn: true,
    remembered: undefined as ModelConnectionList | undefined,
  };
  const sealed = new Map<string, string>();
  const stateDir = path.join(root, "state");
  const connections = new MacConnections({
    identity: () => (at.signedIn ? identity : undefined),
    link: {},
    sealed: {
      get: async (id) => sealed.get(id),
      set: async (id, token) => void sealed.set(id, token),
      remove: async (id) => void sealed.delete(id),
    },
    remembered: {
      get: async () => at.remembered,
      set: async (list) => void (at.remembered = list),
    },
    stateDir,
    now: () => now() + at.skewMs,
  });
  return {
    connections,
    identity,
    sealed,
    at,
    stateDir,
    codexSlot: path.join(stateDir, "providers", "codex", "codex", "home"),
  };
}
const SCRUB = (upstream: string) => `http://127.0.0.1:9/${encodeURIComponent(upstream)}`;
const accessCalls = async (runtime: string) =>
  (await cloud.report()).access.filter((a) => a.runtime === runtime).length;
const only = (list: ModelConnectionList): ModelConnection => {
  expect(list.connections).toHaveLength(1);
  return list.connections[0]!;
};

test.each(["claude-agent", "codex"] as const)(
  "%s launch finds a plan connected on another Mac immediately after caching an empty list",
  async (engine) => {
    const bearer = person();
    const first = await mac(bearer);
    const instant = Date.now();
    const second = await mac(bearer, () => instant);
    const stranger = await mac(person(), () => instant);
    for (const m of [second, stranger]) {
      m.connections.routed(SCRUB);
      expect(await m.connections.list()).toEqual({ connections: [], kinds: {} });
    }
    if (engine === "codex") await first.connections.connectChatGpt(await signIn("chatgpt"));
    else await first.connections.connectClaude(await signIn("claude"));

    const env = await second.connections.launch(
      engine,
      { CODEX_HOME: second.codexSlot },
      "new-plan",
    );
    expect(env).toBeDefined();
    const launchCredentials =
      engine === "codex"
        ? fs.readFileSync(path.join(second.codexSlot, "auth.json"), "utf8")
        : JSON.stringify(env);
    expect(launchCredentials).toContain(STAND_IN_MARK);
    expect(
      await second.connections.launch(engine, { CODEX_HOME: second.codexSlot }, "next-launch"),
    ).toBeDefined();
    second.at.signedIn = false;
    expect(
      await second.connections.launch(engine, { CODEX_HOME: second.codexSlot }, "signed-out"),
    ).toBeUndefined();
    expect(
      await stranger.connections.launch(engine, { CODEX_HOME: stranger.codexSlot }, "other-person"),
    ).toBeUndefined();
    expect(stranger.sealed.size).toBe(0);
    expect(fs.existsSync(path.join(stranger.codexSlot, "auth.json"))).toBe(false);
  },
);

test("not signed in to Caveman: nothing is connected, nothing is asked of Cloud, and every launch is this Mac's own login", async () => {
  const m = await mac(person());
  m.at.signedIn = false;
  m.connections.routed(SCRUB);
  const before = (await cloud.report()).asked.length;
  expect(await m.connections.list()).toEqual({ connections: [], kinds: {} });
  expect(await m.connections.runsOn("claude-agent")).toBe(false);
  expect(await m.connections.ready("codex")).toBeUndefined();
  expect(await m.connections.launch("claude-agent", { PATH: "/usr/bin" }, "s1")).toBeUndefined();
  expect(m.connections.plane()).toBeUndefined();
  await expect(m.connections.connectClaude(("sk-" + "ant-oat01-never-sent"))).rejects.toBeInstanceOf(
    CloudError,
  );
  expect((await cloud.report()).asked.length).toBe(before);
});

test("a Claude plan connected on one Mac runs Claude Agent there on a stand-in, and on the person's second Mac with no sign-in", async () => {
  const bearer = person();
  const first = await mac(bearer);
  const token = await signIn("claude");
  // Nothing connected yet: this Mac's own claude login runs, as before.
  first.connections.routed(SCRUB);
  expect(await first.connections.launch("claude-agent", {}, "s0")).toBeUndefined();

  const made = await first.connections.connectClaude(token);
  expect(made).toMatchObject({
    kind: "claude_plan",
    provider: "anthropic",
    status: "ready",
    position: 0,
    serves: ["claude-agent"],
  });
  // A year, as the token lasts.
  expect(Date.parse(made.expires_at!) - Date.now()).toBeGreaterThan(364 * 86_400_000);
  expect(only(await first.connections.list()).id).toBe(made.id);
  expect(first.sealed.get(made.id)).toBe(token);
  expect(await first.connections.runsOn("claude-agent")).toBe(true);
  expect(await first.connections.runsOn("codex")).toBe(false);

  // The claude this Mac launches holds a stand-in, never the token; the token is what its request leaves with.
  const env = await first.connections.launch("claude-agent", { PATH: "/usr/bin" }, "s1");
  expect(JSON.stringify(env)).toContain(STAND_IN_MARK);
  expect(JSON.stringify(env)).not.toContain(token);
  expect(await first.connections.credential(made)).toEqual({ authorization: `Bearer ${token}` });
  // The Mac that made it never asks Cloud for the token: it kept a sealed copy.
  expect(await accessCalls(first.identity.runtimeId)).toBe(0);

  // The same person's second Mac: listed, and its token read from Cloud once, then kept sealed there too.
  const second = await mac(bearer);
  second.connections.routed(SCRUB);
  expect(only(await second.connections.list()).id).toBe(made.id);
  expect(JSON.stringify(await second.connections.launch("claude-agent", {}, "s2"))).toContain(
    STAND_IN_MARK,
  );
  expect(await second.connections.credential(made)).toEqual({ authorization: `Bearer ${token}` });
  expect(await second.connections.credential(made)).toEqual({ authorization: `Bearer ${token}` });
  expect(second.sealed.get(made.id)).toBe(token);
  expect(await accessCalls(second.identity.runtimeId)).toBe(1);

  // An account the person keeps in a folder of its own, a cloud lane and a gateway of their own keep their own credentials.
  const own = second.connections;
  expect(
    await own.launch(
      "claude-agent",
      { CLAUDE_CONFIG_DIR: path.join(second.stateDir, "providers", "claudeAgent", "work") },
      "s3",
    ),
  ).toBeUndefined();
  expect(await own.launch("claude-agent", { CLAUDE_CODE_USE_BEDROCK: "1" }, "s3")).toBeUndefined();
  expect(
    await own.launch("claude-agent", { ANTHROPIC_BASE_URL: "https://gateway.example.test" }, "s3"),
  ).toBeUndefined();
  expect(
    JSON.stringify(
      await own.launch("claude-agent", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, "s3"),
    ),
  ).toContain(STAND_IN_MARK);
  // The engines' launches are pointed at the scrub first: its route to Anthropic is still Anthropic, its route to a gateway is not.
  own.routed(SCRUB, (url) => url === SCRUB("https://api.anthropic.com"));
  expect(
    JSON.stringify(
      await own.launch(
        "claude-agent",
        { ANTHROPIC_BASE_URL: SCRUB("https://api.anthropic.com") },
        "s3",
      ),
    ),
  ).toContain(STAND_IN_MARK);
  expect(
    await own.launch(
      "claude-agent",
      { ANTHROPIC_BASE_URL: SCRUB("https://gateway.example.test") },
      "s3",
    ),
  ).toBeUndefined();
});

test("before the egress scrub runs nothing launches on a stand-in", async () => {
  const m = await mac(person());
  await m.connections.connectClaude(await signIn("claude"));
  expect(await m.connections.ready("claude-agent")).toBeUndefined();
  expect(await m.connections.launch("claude-agent", {}, "s1")).toBeUndefined();
  m.connections.routed(SCRUB);
  expect(await m.connections.ready("claude-agent")).toMatchObject({ kind: "claude_plan" });
});

test("another person sees nothing, and cannot read, order or remove what is not theirs", async () => {
  const owner = await mac(person());
  const made = await owner.connections.connectClaude(await signIn("claude"));
  const stranger = await mac(person());
  stranger.connections.routed(SCRUB);
  expect(await stranger.connections.list()).toEqual({ connections: [], kinds: {} });
  expect(await stranger.connections.credential(made)).toBeUndefined();
  expect(stranger.sealed.size).toBe(0);
  await expect(stranger.connections.remove(made.id)).rejects.toMatchObject({ status: 404 });
  await expect(stranger.connections.useFirst(made.id)).rejects.toMatchObject({ status: 404 });
  expect(only(await owner.connections.fresh()).id).toBe(made.id);
  // Cloud handed that connection's credential to nobody: its maker kept its own copy, and the stranger was told it is absent.
  expect((await cloud.report()).access.filter((a) => a.connection === made.id)).toEqual([]);
});

test("a key alone never takes an engine off this Mac's own login; once the plan is connected the person's order decides", async () => {
  const bearer = person();
  const m = await mac(bearer);
  m.connections.routed(SCRUB);
  // A key the person keeps in Cloud (their own device added it): it serves their Cloud computers.
  const added = await fetch(`${cloud.url}/api/v1/code/model-connections`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "api_key",
      provider: "anthropic",
      key: ("sk-" + "ant-api03-made-up-for-this-test"),
    }),
  });
  expect(added.status).toBe(201);
  const key = (await added.json()) as ModelConnection;
  expect(only(await m.connections.fresh()).id).toBe(key.id);
  expect(await m.connections.runsOn("claude-agent")).toBe(false);
  expect(await m.connections.launch("claude-agent", {}, "s1")).toBeUndefined();

  const plan = await m.connections.connectClaude(await signIn("claude"));
  expect((await m.connections.list()).connections.map((c) => c.id)).toEqual([key.id, plan.id]);
  // The key is first in the person's order, so it is what a chat here runs on now.
  expect((await m.connections.ready("claude-agent"))?.id).toBe(key.id);
  expect(await m.connections.credential(key)).toEqual({
    "x-api-key": ("sk-" + "ant-api03-made-up-for-this-test"),
  });
  // "Use first", for every computer.
  await m.connections.useFirst(plan.id);
  expect((await m.connections.list()).connections.map((c) => [c.id, c.position])).toEqual([
    [plan.id, 0],
    [key.id, 1],
  ]);
  expect((await m.connections.ready("claude-agent"))?.id).toBe(plan.id);
  expect((await cloud.report()).people[`person-${people}`]!.map((c) => c.id)).toEqual([
    plan.id,
    key.id,
  ]);
  // Removed here: gone in Cloud, and the sealed copy with it.
  await m.connections.remove(plan.id);
  expect(m.sealed.has(plan.id)).toBe(false);
  expect((await m.connections.list()).connections.map((c) => c.id)).toEqual([key.id]);
  expect(await m.connections.runsOn("claude-agent")).toBe(false);
});

test("a ChatGPT plan: Cloud keeps the sign-in and refreshes it; this Mac holds a short-lived access token in memory until it ends", async () => {
  const bearer = person();
  const m = await mac(bearer);
  m.connections.routed(SCRUB);
  const signed = await signIn("chatgpt");
  const made = await m.connections.connectChatGpt({
    access_token: signed.access_token,
    refresh_token: signed.refresh_token,
    id_token: signed.id_token,
  });
  expect(made).toMatchObject({
    kind: "chatgpt_plan",
    provider: "openai",
    status: "ready",
    serves: ["codex", "caveman"],
  });
  expect(made.label).toContain("ChatGPT");
  // Nothing of it is kept here.
  expect(m.sealed.size).toBe(0);
  expect(JSON.stringify(m.at.remembered)).not.toContain(signed.refresh_token);
  expect(JSON.stringify(m.at.remembered)).not.toContain(signed.access_token);

  const runtime = m.identity.runtimeId;
  expect(await m.connections.credential(made)).toEqual({
    authorization: `Bearer ${signed.access_token}`,
    "chatgpt-account-id": signed.account_id,
  });
  expect(await m.connections.credential(made)).toEqual({
    authorization: `Bearer ${signed.access_token}`,
    "chatgpt-account-id": signed.account_id,
  });
  expect(await accessCalls(runtime)).toBe(1);
  // Close to its end it is asked for again.
  m.at.skewMs = 59.5 * 60_000;
  expect(await m.connections.credential(made)).toBeDefined();
  expect(await accessCalls(runtime)).toBe(2);
  m.at.skewMs = 0;

  // Offline: it works until the access token ends, then there is no credential to be had.
  await cloud.configure({ offline: [runtime] });
  expect(await m.connections.credential(made)).toEqual({
    authorization: `Bearer ${signed.access_token}`,
    "chatgpt-account-id": signed.account_id,
  });
  expect((await m.connections.list()).connections.map((c) => c.id)).toEqual([made.id]);
  m.at.skewMs = 59.5 * 60_000;
  expect(await m.connections.credential(made)).toBeDefined();
  m.at.skewMs = 61 * 60_000;
  expect(await m.connections.credential(made)).toBeUndefined();
  // So a launch then is this Mac's own codex login: no stand-in, and none left in Codex's home.
  expect(await m.connections.launch("codex", { CODEX_HOME: m.codexSlot }, "s1")).toBeUndefined();
  expect(fs.existsSync(path.join(m.codexSlot, "auth.json"))).toBe(false);
  m.at.skewMs = 0;
  await cloud.configure({ offline: [] });
  // This Mac never asked the provider for a refresh: it holds no refresh token.
  expect((await cloud.report()).refreshes.filter((r) => r.by === "other")).toEqual([]);
});

test("a ChatGPT access token the provider refuses is asked of Cloud again, which alone refreshes it", async () => {
  await cloud.configure({ accessTtlMs: 2_500 });
  try {
    const m = await mac(person());
    m.connections.routed(SCRUB);
    const signed = await signIn("chatgpt");
    const made = await m.connections.connectChatGpt({
      access_token: signed.access_token,
      refresh_token: signed.refresh_token,
      id_token: signed.id_token,
    });
    const first = await m.connections.credential(made);
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    const before = (await cloud.report()).refreshes.length;
    // The provider answered 401: a newer token is to be had, so the request goes once more.
    expect(await m.connections.refused(made)).toBe(true);
    const second = await m.connections.credential(made);
    expect(second).toBeDefined();
    expect(second).not.toEqual(first);
    const refreshes = (await cloud.report()).refreshes.slice(before);
    expect(refreshes.length).toBeGreaterThan(0);
    expect(refreshes.every((r) => r.by === "cloud" && r.ok)).toBe(true);
  } finally {
    await cloud.configure({ accessTtlMs: 3_600_000 });
  }
});

test("Codex on a connection runs in a home of the runtime's own, on a stand-in sign-in: never in the person's ~/.codex", async () => {
  const m = await mac(person());
  m.connections.routed(SCRUB);
  const signed = await signIn("chatgpt");
  const made = await m.connections.connectChatGpt({
    access_token: signed.access_token,
    refresh_token: signed.refresh_token,
    id_token: signed.id_token,
  });
  // Codex's default home says so before the first chat, so its own probe reads signed in.
  expect(await m.connections.settleCodexHome()).toBe(true);
  const auth = fs.readFileSync(path.join(m.codexSlot, "auth.json"), "utf8");
  expect(auth).toContain(STAND_IN_MARK);
  for (const secret of [signed.access_token, signed.refresh_token, signed.id_token])
    expect(auth).not.toContain(secret);
  expect(await m.connections.settleCodexHome()).toBe(false);

  const env = await m.connections.launch("codex", { CODEX_HOME: m.codexSlot }, "s1");
  expect(env?.CODEX_HOME).toBe(m.codexSlot);
  // The person's own codex login is a launch a connection never stands behind.
  expect(
    await m.connections.launch("codex", { CODEX_HOME: "/Users/someone/.codex" }, "s2"),
  ).toBeUndefined();
  expect(await m.connections.launch("codex", {}, "s2")).toBeUndefined();

  // Removed: the stand-in goes with it, so Codex never reads as signed in on nothing.
  await m.connections.remove(made.id);
  expect(await m.connections.settleCodexHome()).toBe(true);
  expect(fs.existsSync(path.join(m.codexSlot, "auth.json"))).toBe(false);

  // A key of this Mac's own in that home is never touched: a connection then runs in a home beside it.
  fs.writeFileSync(
    path.join(m.codexSlot, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-this-macs-own-made-up" }),
  );
  const again = await signIn("chatgpt");
  await m.connections.connectChatGpt({
    access_token: again.access_token,
    refresh_token: again.refresh_token,
    id_token: again.id_token,
  });
  expect(await m.connections.settleCodexHome()).toBe(false);
  expect(await m.connections.codexHome()).toBe(
    path.join(m.stateDir, "providers", "codex", "everywhere", "home"),
  );
  const beside = await m.connections.launch("codex", { CODEX_HOME: m.codexSlot }, "s3");
  expect(beside?.CODEX_HOME).toBe(
    path.join(m.stateDir, "providers", "codex", "everywhere", "home"),
  );
  expect(fs.readFileSync(path.join(m.codexSlot, "auth.json"), "utf8")).toBe(
    JSON.stringify({ OPENAI_API_KEY: "sk-this-macs-own-made-up" }),
  );
});

test("offline, a Claude plan keeps working on the sealed copy and the last list, on a Mac that starts with Cloud out of reach too", async () => {
  const bearer = person();
  const m = await mac(bearer);
  m.connections.routed(SCRUB);
  const token = await signIn("claude");
  const made = await m.connections.connectClaude(token);
  await cloud.configure({ offline: [m.identity.runtimeId] });
  try {
    m.at.skewMs = 60_000;
    expect((await m.connections.fresh()).connections.map((c) => c.id)).toEqual([made.id]);
    expect(await m.connections.credential(made)).toEqual({ authorization: `Bearer ${token}` });
    expect(JSON.stringify(await m.connections.launch("claude-agent", {}, "s1"))).toContain(
      STAND_IN_MARK,
    );

    // The runtime restarted while offline: the list it remembered (no secret in it) and the sealed copy still serve.
    const restarted = new MacConnections({
      identity: () => m.identity,
      link: {},
      sealed: {
        get: async (id) => m.sealed.get(id),
        set: async (id, value) => void m.sealed.set(id, value),
        remove: async (id) => void m.sealed.delete(id),
      },
      remembered: { get: async () => m.at.remembered, set: async () => undefined },
      stateDir: m.stateDir,
    });
    restarted.routed(SCRUB);
    expect(JSON.stringify(m.at.remembered)).not.toContain(token);
    expect((await restarted.list()).connections.map((c) => c.id)).toEqual([made.id]);
    expect(JSON.stringify(await restarted.launch("claude-agent", {}, "s2"))).toContain(
      STAND_IN_MARK,
    );
    // What cannot be done offline says so, and changes nothing.
    await expect(restarted.remove(made.id)).rejects.toBeDefined();
    expect(m.sealed.get(made.id)).toBe(token);
  } finally {
    await cloud.configure({ offline: [] });
  }
});

test("what the providers say is heard at once: used up until a time, and over until it is connected again", async () => {
  const m = await mac(person());
  m.connections.routed(SCRUB);
  const made = await m.connections.connectClaude(await signIn("claude"));
  let changes = 0;
  m.connections.onChange(() => changes++);

  const until = Date.now() + 3 * 3_600_000;
  m.connections.usedUp(made, until);
  expect(only(await m.connections.list())).toMatchObject({
    status: "used_up",
    used_up_until: new Date(until).toISOString(),
  });
  expect(changes).toBe(1);
  // No time named: a quarter of an hour, as Cloud reads it.
  m.connections.usedUp(made, undefined);
  expect(Date.parse(only(await m.connections.list()).used_up_until!) - Date.now()).toBeGreaterThan(
    14 * 60_000,
  );
  // Still the plan this Mac runs on (the chat moves to the next in order, or asks): never back to another login in silence.
  expect(await m.connections.runsOn("claude-agent")).toBe(true);

  // Anthropic says the token is over: the copy here goes, and it reads expired until the person connects again.
  expect(await m.connections.refused(made)).toBe(false);
  expect(m.sealed.has(made.id)).toBe(false);
  expect(only(await m.connections.list()).status).toBe("expired");
  expect(await m.connections.runsOn("claude-agent")).toBe(false);
  expect(await m.connections.launch("claude-agent", {}, "s1")).toBeUndefined();
});

test("with every connection used up a new chat starts on this Mac's own login and says so once, in one line; any other way there says nothing", async () => {
  const bearer = person();
  const m = await mac(bearer);
  m.connections.routed(SCRUB);
  const heard: Array<DataPlaneAnswer> = [];
  m.connections.connections.onAnswer((answer) => heard.push(answer));

  // A key alone: this Mac never ran on connections, so its own login is no news.
  const added = await fetch(`${cloud.url}/api/v1/code/model-connections`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "api_key",
      provider: "anthropic",
      key: ("sk-" + "ant-api03-made-up-for-this-test"),
    }),
  });
  const key = (await added.json()) as ModelConnection;
  await m.connections.fresh();
  expect(await m.connections.launch("claude-agent", {}, "s0")).toBeUndefined();
  expect(heard).toEqual([]);

  // The plan connected and first: chats here run on it, and nothing is said.
  const plan = await m.connections.connectClaude(await signIn("claude"));
  await m.connections.useFirst(plan.id);
  expect((await m.connections.launch("claude-agent", {}, "s1"))?.CLAUDE_CODE_OAUTH_TOKEN).toContain(
    STAND_IN_MARK,
  );
  expect(heard).toEqual([]);

  // The plan runs out and the key still serves: the next chat starts on the key, on a stand-in, with nothing to say.
  const until = Math.ceil((Date.now() + 3 * 3_600_000) / 1000) * 1000;
  m.connections.usedUp(plan, until);
  expect((await m.connections.launch("claude-agent", {}, "s2"))?.ANTHROPIC_API_KEY).toContain(
    STAND_IN_MARK,
  );
  expect(heard).toEqual([]);

  // The key runs out too. A new chat starts on this Mac's own login, and hears which plan ran out and what it runs on.
  m.connections.usedUp(key, undefined);
  expect(await m.connections.launch("claude-agent", {}, "s3")).toBeUndefined();
  expect(heard).toHaveLength(1);
  expect(heard[0]).toMatchObject({
    type: "used_up",
    session: "s3",
    engine: "claude-agent",
    connection: { id: plan.id },
    until: new Date(until).toISOString(),
    own: true,
  });
  expect(heard[0]!.type === "used_up" && heard[0]!.next).toBeUndefined();
  const said = usedUpNote(heard[0] as Extract<DataPlaneAnswer, { type: "used_up" }>, Date.now());
  expect(said).toMatch(/^Claude plan used up (?:until|for) .+\. Running on this Mac's login\.$/);
  expect(said).not.toMatch(/[$€£]|\d\s?%|credit/i);
  // Never the credits question: nothing was refused, the chat runs.
  expect(heard.some((answer) => answer.type === "no_connection")).toBe(false);

  // An account the person keeps in a folder of its own was never on a connection: nothing to say.
  expect(
    await m.connections.launch(
      "claude-agent",
      { CLAUDE_CONFIG_DIR: path.join(m.stateDir, "providers", "claude", "second") },
      "s4",
    ),
  ).toBeUndefined();
  // Codex has no plan connected here: its own login, in silence, as before.
  expect(await m.connections.launch("codex", { CODEX_HOME: m.codexSlot }, "s5")).toBeUndefined();
  expect(heard).toHaveLength(1);

  // Once the plan serves again, chats run on it and say nothing.
  m.at.skewMs = 4 * 3_600_000;
  expect((await m.connections.launch("claude-agent", {}, "s6"))?.CLAUDE_CODE_OAUTH_TOKEN).toContain(
    STAND_IN_MARK,
  );
  expect(heard).toHaveLength(1);
});

test("a kind Cloud switched off is skipped here and refused when connected", async () => {
  const m = await mac(person());
  m.connections.routed(SCRUB);
  const token = await signIn("claude");
  const made = await m.connections.connectClaude(token);
  await cloud.configure({ kinds: { claude_plan: { on: false } } });
  try {
    expect((await m.connections.fresh()).kinds).toEqual({ claude_plan: { on: false } });
    expect(await m.connections.runsOn("claude-agent")).toBe(false);
    expect(await m.connections.launch("claude-agent", {}, "s1")).toBeUndefined();
    await expect(m.connections.connectClaude(await signIn("claude"))).rejects.toMatchObject({
      status: 403,
      code: "cave_code_connection_kind_off",
      message: "Claude plan connections are switched off on this Caveman Cloud.",
    });
  } finally {
    await cloud.configure({ kinds: {} });
  }
  expect((await m.connections.fresh()).connections.map((c) => c.id)).toEqual([made.id]);
  expect(await m.connections.runsOn("claude-agent")).toBe(true);
});

test("Cloud refuses what is not a plan's credential, and says why", async () => {
  const m = await mac(person());
  await expect(
    m.connections.connectClaude("sk-ant-api03-an-api-key-not-a-plan-token-0123456789"),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    m.connections.connectChatGpt({ access_token: "not-a-jwt", refresh_token: "rt" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await m.connections.fresh()).toEqual({ connections: [], kinds: {} });
  expect(m.sealed.size).toBe(0);
});
