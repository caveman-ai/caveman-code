// Settings > Models & keys, "sign in once": the account model the page reads (order, where each account works, every
// state a connection can be in and when it asks to be reconnected) and every sentence the page says about them.
import type {
  AccountConnection,
  EngineAccount,
  EngineDescriptor,
} from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { THIS_COMPUTER } from "../../lib/platform.ts";
import { moves } from "./Connections.tsx";
import {
  accountsFromCloud,
  agentsFromCloud,
  agentStatus,
  asksClaudeToken,
  canUseFirst,
  cloudIdOf,
  connectingLine,
  connectionsOf,
  connectionState,
  connectLabel,
  enterCode,
  MANAGE,
  planConnected,
  planOf,
  planOffer,
  RECONNECT_BEFORE_MS,
  removeEverywhere,
  SIGN_IN_PAGE,
  untilText,
  whereLabel,
} from "./connections-model.ts";

// Noon in Los Angeles on the day the feature shipped.
const NOW = Date.parse("2026-11-09T20:00:00Z");
const LA = "America/Los_Angeles";
const DAY = 24 * 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();

const connection = (
  id: string,
  c: Partial<AccountConnection> = {},
  a: Partial<EngineAccount> = {},
): EngineAccount => ({
  id: `connection:${id}`,
  label: "Claude plan",
  kind: "login",
  active: false,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", ...c },
  ...a,
});
const own = (id: string, a: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  label: "julius@example.com",
  kind: "login",
  active: true,
  where: "this_mac",
  ...a,
});
const engine = (
  id: string,
  accounts: ReadonlyArray<EngineAccount>,
  everywhere?: "available" | "off" | "manage",
): Pick<EngineDescriptor, "id" | "auth"> =>
  ({ id, auth: { state: "signed_in", accounts, ...(everywhere ? { everywhere } : {}) } }) as Pick<
    EngineDescriptor,
    "id" | "auth"
  >;

test("a row says where its plan or key works: everywhere, in Cloud alone, or on this computer alone", () => {
  expect(whereLabel("everywhere")).toBe("Everywhere");
  expect(whereLabel("cloud")).toBe("Cloud");
  expect(whereLabel("this_mac", "This Mac")).toBe("This Mac only");
  expect(whereLabel("this_mac")).toBe(`${THIS_COMPUTER} only`);
  // A runtime that is not signed in to Caveman says nothing about where: the row says nothing either.
  expect(whereLabel(undefined)).toBeUndefined();
});

test("connections are listed in the order they are tried, ahead of this computer's own accounts", () => {
  const accounts = [
    connection("b", {}, { active: true }),
    connection("a"),
    own("claudeAgent:default", { active: false }),
  ];
  expect(connectionsOf(accounts).map((a) => a.id)).toEqual(["connection:b", "connection:a"]);
  // Any but the first can be moved to the top, never this computer's own account.
  expect(accounts.map((a) => canUseFirst(accounts, a))).toEqual([false, true, false]);
  // A kind the admin turned off cannot be moved first.
  const off = connection("c", { off: true });
  expect(canUseFirst([...accounts, off], off)).toBe(false);
});

test("a plan's or key's state, one word or short line: used up until a time, expiring, expired, turned off; nothing to say of one that is fine", () => {
  // "Ready" is never said: one that is fine says only where it works.
  expect(connectionState({ kind: "claude_plan", status: "ready" }, NOW, LA)).toEqual({
    is: "ready",
    text: "",
    tone: "ok",
    reconnect: false,
  });
  expect(
    connectionState(
      { kind: "claude_plan", status: "used_up", used_up_until: "2026-11-10T07:08:00Z" },
      NOW,
      LA,
    ),
  ).toEqual({ is: "used_up", text: "Used up until 11:08 PM", tone: "warn", reconnect: false });
  // Not today: the day is said too. No time, or one already past: only that it is used up.
  expect(
    connectionState(
      { kind: "claude_plan", status: "used_up", used_up_until: "2026-11-11T07:08:00Z" },
      NOW,
      LA,
    ).text,
  ).toBe("Used up until Nov 10, 11:08 PM");
  expect(connectionState({ kind: "claude_plan", status: "used_up" }, NOW, LA).text).toBe("Used up");
  expect(
    connectionState({ kind: "claude_plan", status: "used_up", used_up_until: at(NOW - 1) }, NOW, LA)
      .text,
  ).toBe("Used up");
  expect(connectionState({ kind: "claude_plan", status: "expired" }, NOW, LA)).toEqual({
    is: "expired",
    text: "Expired",
    tone: "bad",
    reconnect: true,
  });
  // One the provider no longer accepts is expired to a person: the same word, the same Reconnect.
  expect(connectionState({ kind: "chatgpt_plan", status: "revoked" }, NOW, LA)).toEqual({
    is: "expired",
    text: "Expired",
    tone: "bad",
    reconnect: true,
  });
  // Turned off wins over whatever state it is in, and asks nothing of the person.
  expect(connectionState({ kind: "claude_plan", status: "expired", off: true }, NOW, LA)).toEqual({
    is: "off",
    text: "Turned off by your admin",
    tone: "quiet",
    reconnect: false,
  });
  // A key that ended is replaced where keys are added: its row offers no Reconnect.
  expect(connectionState({ kind: "api_key", status: "revoked" }, NOW, LA).reconnect).toBe(false);
});

test("a Claude plan asks to be reconnected from a week before its sign-in ends, no sooner, and at once when it has ended", () => {
  const state = (expires: number, status: AccountConnection["status"] = "ready") =>
    connectionState({ kind: "claude_plan", status, expires_at: at(expires) }, NOW, LA);
  expect(RECONNECT_BEFORE_MS).toBe(7 * DAY);
  // More than a week away: nothing to say, nothing to do. Never an amber line for a month.
  expect(state(NOW + 7 * DAY + 1)).toMatchObject({ is: "ready", text: "", reconnect: false });
  expect(state(NOW + 12 * DAY)).toMatchObject({ is: "ready", reconnect: false });
  expect(state(NOW + 364 * DAY)).toMatchObject({ is: "ready", reconnect: false });
  // From a week before.
  expect(state(NOW + 7 * DAY)).toMatchObject({
    is: "expiring",
    text: "Expires in 7 days",
    tone: "warn",
    reconnect: true,
  });
  expect(state(NOW + 4 * DAY + 3_600_000)).toMatchObject({
    text: "Expires in 5 days",
    reconnect: true,
  });
  expect(state(NOW + DAY + 1)).toMatchObject({ text: "Expires in 2 days" });
  expect(state(NOW + DAY)).toMatchObject({ text: "Expires in 1 day" });
  expect(state(NOW + 60_000)).toMatchObject({ text: "Expires in 1 day", reconnect: true });
  // Its time has passed, whether or not Cloud has said so yet.
  expect(state(NOW)).toMatchObject({
    is: "expired",
    text: "Expired",
    tone: "bad",
    reconnect: true,
  });
  expect(state(NOW - DAY)).toMatchObject({ text: "Expired", reconnect: true });
  // Used up and ending within the week: both are true, and Reconnect is offered.
  expect(
    connectionState(
      {
        kind: "claude_plan",
        status: "used_up",
        used_up_until: "2026-11-10T07:08:00Z",
        expires_at: at(NOW + 3 * DAY),
      },
      NOW,
      LA,
    ),
  ).toMatchObject({ text: "Used up until 11:08 PM", reconnect: true });
});

test("when a used-up connection serves again reads as a time today, and with its day otherwise", () => {
  expect(untilText("2026-11-10T07:08:00Z", NOW, LA)).toBe("11:08 PM");
  expect(untilText("2026-11-10T08:00:00Z", NOW, LA)).toBe("Nov 10, 12:00 AM");
  expect(untilText(undefined, NOW, LA)).toBeUndefined();
  expect(untilText("not a time", NOW, LA)).toBeUndefined();
});

test("what the page offers for an engine's plan follows where the runtime stands", () => {
  // Not signed in to Caveman: nothing is offered, and the page is as it was before connections.
  expect(
    planOffer(
      engine("claude-agent", [
        { id: "claudeAgent:default", label: "julius@example.com", kind: "login", active: true },
      ]),
    ),
  ).toBeUndefined();
  // This computer has the plan's own login: that row offers "Use everywhere".
  expect(planOffer(engine("claude-agent", [own("claudeAgent:default")], "available"))).toBe(
    "use_everywhere",
  );
  expect(planOffer(engine("codex", [own("codex-account-chatgpt")], "available"))).toBe(
    "use_everywhere",
  );
  // No login of its own here (an API key only, or nothing): a row of its own offers "Connect".
  expect(
    planOffer(engine("codex", [own("codex-account-1", { kind: "api_key" })], "available")),
  ).toBe("connect");
  expect(planOffer(engine("claude-agent", [], "available"))).toBe("connect");
  // Connected already, in whatever state: its own row carries what there is to do.
  expect(
    planOffer(
      engine(
        "claude-agent",
        [connection("a", { status: "expired" }), own("claudeAgent:default")],
        "available",
      ),
    ),
  ).toBeUndefined();
  expect(planConnected(engine("claude-agent", [connection("a")], "available"))).toBe(true);
  // Another kind of connection (a key) is not the plan.
  expect(
    planConnected(engine("claude-agent", [connection("k", { kind: "api_key" })], "available")),
  ).toBe(false);
  expect(planOffer(engine("claude-agent", [own("claudeAgent:default")], "off"))).toBe("off");
  expect(planOffer(engine("codex", [], "manage"))).toBe("manage");
  // Only Claude Agent and Codex have a plan that connects once.
  expect(planOffer(engine("cursor", [], "available"))).toBeUndefined();
  expect(planOf("caveman")).toBeUndefined();
  expect(planOf("codex")).toMatchObject({
    kind: "chatgpt_plan",
    name: "ChatGPT plan",
    own: "codex-account-chatgpt",
  });
});

const HERE = { here: "this Mac", timeZone: LA };
const status = (e: Pick<EngineDescriptor, "id" | "auth">) => agentStatus(e, NOW, HERE);
const signedOut = (id: string, auth: Partial<EngineDescriptor["auth"]> = {}) =>
  ({ id, auth: { state: "signed_out", accounts: [], ...auth } }) as Pick<
    EngineDescriptor,
    "id" | "auth"
  >;

test("an agent's row says one thing, in one colour, with one button: where what it runs on works", () => {
  // Connected once: it works everywhere, and there is nothing to press.
  expect(
    status(
      engine(
        "claude-agent",
        [connection("r", {}, { active: true }), own("claudeAgent:default", { active: false })],
        "available",
      ),
    ),
  ).toEqual({ text: "Everywhere", tone: "ok" });
  // Only this Mac's own login: it says so, and its one button makes it work everywhere.
  expect(status(engine("claude-agent", [own("claudeAgent:default")], "available"))).toEqual({
    text: "This Mac only",
    tone: "ok",
    action: "use_everywhere",
  });
  // Not signed in to Caveman, or an agent with no plan to connect: it works here, and no button that would be refused.
  expect(status(engine("claude-agent", [own("claudeAgent:default")]))).toEqual({
    text: "This Mac only",
    tone: "ok",
  });
  expect(status(engine("cursor", [own("cursor:default")]))).toEqual({
    text: "This Mac only",
    tone: "ok",
  });
  // A plan that serves Cloud while this Mac runs on its own login: the agent works everywhere.
  expect(
    status(
      engine(
        "claude-agent",
        [connection("r", {}, { where: "cloud" }), own("claudeAgent:default")],
        "available",
      ),
    ),
  ).toEqual({ text: "Everywhere", tone: "ok" });
  // Nothing to run on: one sign-in, in the browser, where this Mac can start it; its own sign-in anywhere else.
  expect(status(signedOut("claude-agent", { everywhere: "available" }))).toEqual({
    text: "Not signed in",
    tone: "idle",
    action: "connect",
  });
  expect(status(signedOut("cursor"))).toEqual({
    text: "Not signed in",
    tone: "idle",
    action: "sign_in",
  });
  expect(status(signedOut("opencode", { state: "unavailable" }))).toEqual({
    text: "Not installed",
    tone: "idle",
    action: "set_up",
  });
  expect(status(signedOut("codex", { state: "checking" }))).toEqual({
    text: "Checking…",
    tone: "busy",
  });
  // No status ever starts with "Ready", counts accounts ("and 1 more") or names two things.
  const all = [
    engine(
      "claude-agent",
      [
        connection("r", {}, { active: true }),
        connection("k", { kind: "api_key" }, { label: "Anthropic key" }),
        own("claudeAgent:default", { active: false }),
      ],
      "available",
    ),
  ].map((e) => status(e).text);
  expect(all).toEqual(["Everywhere"]);
});

test("the one state that needs the person takes the row: expired, then expiring, then used up, with what runs now", () => {
  const key = connection(
    "k",
    { kind: "api_key" },
    { label: "Anthropic key", kind: "api_key", active: true },
  );
  const usedUp = connection("u", { status: "used_up", used_up_until: "2026-11-10T07:08:00Z" });
  // Used up with a key behind it: what runs now is said, in the person's words.
  expect(status(engine("claude-agent", [usedUp, key], "available"))).toEqual({
    text: "Used up until 11:08 PM · now on your Anthropic key",
    tone: "warn",
  });
  // With this Mac's own login behind it.
  expect(
    status(engine("claude-agent", [usedUp, own("claudeAgent:default")], "available")).text,
  ).toBe("Used up until 11:08 PM · now on this Mac's login");
  // With nothing behind it.
  expect(
    status({
      id: "claude-agent",
      auth: { state: "signed_out", accounts: [usedUp], everywhere: "available" },
    } as never).text,
  ).toBe("Used up until 11:08 PM");
  const ending = connection("e", { expires_at: at(NOW + 5 * DAY - 60_000) }, { active: true });
  expect(status(engine("claude-agent", [usedUp, ending], "available"))).toMatchObject({
    text: "Expires in 5 days",
    tone: "warn",
    action: "reconnect",
    account: ending,
  });
  // Twelve days out is nobody's news: the row says where it works.
  expect(
    status(
      engine(
        "claude-agent",
        [connection("f", { expires_at: at(NOW + 12 * DAY) }, { active: true })],
        "available",
      ),
    ),
  ).toEqual({ text: "Everywhere", tone: "ok" });
  const ended = connection("x", { status: "expired" });
  expect(status(engine("claude-agent", [usedUp, ending, ended], "available"))).toMatchObject({
    text: "Expired · now on your Claude plan",
    tone: "bad",
    action: "reconnect",
    account: ended,
  });
  expect(
    status({
      id: "codex",
      auth: {
        state: "signed_out",
        accounts: [
          connection("v", { kind: "chatgpt_plan", status: "revoked" }, { label: "ChatGPT plan" }),
        ],
        everywhere: "available",
      },
    } as never),
  ).toMatchObject({ text: "Expired", tone: "bad", action: "reconnect" });
  // Where this window cannot start a sign-in (a page with no Mac app behind it), no Reconnect is offered: the status
  // says where it is done, unless something else carries the agent meanwhile.
  expect(
    status({
      id: "claude-agent",
      auth: { state: "signed_out", accounts: [ended], everywhere: "manage", no_sign_in_here: true },
    } as never),
  ).toEqual({ text: "Expired · reconnect from the desktop app", tone: "bad" });
  expect(
    status({
      id: "claude-agent",
      auth: {
        state: "api_key",
        accounts: [
          ended,
          connection(
            "k",
            { kind: "api_key" },
            { kind: "api_key", active: true, label: "Anthropic key" },
          ),
        ],
        everywhere: "manage",
        no_sign_in_here: true,
      },
    } as never),
  ).toEqual({ text: "Expired · now on your Anthropic key", tone: "bad" });
  expect(
    status({
      id: "claude-agent",
      auth: {
        state: "signed_in",
        accounts: [{ ...ending, active: true }],
        everywhere: "manage",
        no_sign_in_here: true,
      },
    } as never),
  ).toEqual({ text: "Expires in 5 days · reconnect from the desktop app", tone: "warn" });
});

test("turned off by the admin, nothing to press; a page with no Mac app says where a plan is connected", () => {
  expect(
    status(
      engine("claude-agent", [connection("o", { off: true }), own("claudeAgent:default")], "off"),
    ),
  ).toEqual({ text: "Turned off by your admin · runs on this Mac's login", tone: "idle" });
  // Another plan or key still serves: the agent works, and that is what the row says.
  expect(
    status(
      engine(
        "claude-agent",
        [
          connection("o", { off: true }),
          connection("k", { kind: "api_key" }, { kind: "api_key", active: true }),
        ],
        "available",
      ),
    ).text,
  ).toBe("Everywhere");
  // On a Cloud computer nothing is signed in: no "Set up" that opens onto a sentence, the sentence is the status.
  expect(status(signedOut("codex", { everywhere: "manage", no_sign_in_here: true }))).toEqual({
    text: "Not signed in · connect from the desktop app",
    tone: "idle",
  });
  expect(MANAGE).toEqual({
    fromMac: "Connect from the desktop app",
    againFromMac: "Reconnect from the desktop app",
    noMac: "No Mac?",
    claudeToken: "Run `claude setup-token` on any computer and paste the token here.",
  });
});

test("a sign-in in progress is the row's status on every window, by the Mac it is approved on", () => {
  const connecting = { request_id: "r1", since: at(NOW - 8_000) };
  expect(
    status({
      id: "claude-agent",
      auth: {
        state: "signed_in",
        accounts: [own("claudeAgent:default")],
        everywhere: "available",
        connecting,
      },
    } as never),
  ).toEqual({ text: "Connecting… approve in the browser on this Mac", tone: "busy" });
  expect(connectingLine("Studio")).toBe("Connecting… approve in the browser on Studio");
  expect(connectLabel("claude-agent")).toBe("Connect Claude");
  expect(connectLabel("codex")).toBe("Connect ChatGPT");
  expect(enterCode("ABCD-1234")).toBe("Enter ABCD-1234 on the sign-in page.");
  expect(SIGN_IN_PAGE).toBe("Open the sign-in page");
});

test("removing a plan everywhere is the one question the page asks; no sentence says Claude Code or a Cloud computer", () => {
  expect(removeEverywhere("Claude plan", "this Mac")).toEqual({
    title: "Remove Claude plan everywhere?",
    description: "It stops running chats on this Mac and in Cloud.",
    confirm: "Remove everywhere",
  });
  const said = JSON.stringify([
    removeEverywhere("Claude plan"),
    MANAGE,
    connectingLine(),
    connectLabel("claude-agent"),
  ]);
  expect(said).not.toContain("Claude Code");
  expect(said).not.toMatch(/Cloud computer|Caveman Cloud|token sealed|connection/i);
});

test("a drag's new order becomes the fewest moves to the top: one for a plan dragged first, else the changed part replayed", () => {
  expect(moves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  expect(moves(["a", "b"], ["b", "a"])).toEqual(["b"]);
  expect(moves(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c"]);
  // a, c, b: c goes to the top, then a.
  const replay = moves(["a", "b", "c"], ["a", "c", "b"]);
  expect(replay).toEqual(["b", "c", "a"]);
  const apply = (from: string[], tops: ReadonlyArray<string>) =>
    tops.reduce((order, id) => [id, ...order.filter((x) => x !== id)], from);
  expect(apply(["a", "b", "c"], replay)).toEqual(["a", "c", "b"]);
  expect(apply(["a", "b", "c", "d"], moves(["a", "b", "c", "d"], ["b", "d", "a", "c"]))).toEqual([
    "b",
    "d",
    "a",
    "c",
  ]);
});

test("a Cloud computer's page asks for a Claude plan's token when none is connected, or the one there ends", () => {
  expect(asksClaudeToken([], NOW)).toBe(true);
  expect(asksClaudeToken([connection("a")], NOW)).toBe(false);
  expect(asksClaudeToken([connection("a", { status: "expired" })], NOW)).toBe(true);
  expect(asksClaudeToken([connection("a", { expires_at: at(NOW + 5 * DAY) })], NOW)).toBe(true);
  // A used-up plan serves again by itself.
  expect(asksClaudeToken([connection("a", { status: "used_up" })], NOW)).toBe(false);
  // A key is not a plan.
  expect(asksClaudeToken([connection("k", { kind: "api_key" })], NOW)).toBe(true);
});

test("Cloud's answer to a page's own write reads as the engine's accounts, in Cloud's order", () => {
  const list = {
    connections: [
      {
        id: "k1",
        kind: "api_key" as const,
        provider: "anthropic",
        label: "",
        position: 2,
        status: "ready" as const,
        serves: ["claude-agent", "caveman"],
      },
      {
        id: "c1",
        kind: "claude_plan" as const,
        provider: "anthropic",
        label: "",
        position: 0,
        status: "used_up" as const,
        used_up_until: "2026-11-10T07:08:00Z",
        expires_at: null,
        serves: ["claude-agent"],
      },
      {
        id: "g1",
        kind: "chatgpt_plan" as const,
        provider: "openai",
        label: "",
        position: 1,
        status: "ready" as const,
        serves: ["codex"],
      },
    ],
    kinds: {},
  };
  const known = [
    connection("k1", { kind: "api_key" }, { label: "Anthropic key", kind: "api_key" }),
  ];
  const claude = accountsFromCloud(list, "claude-agent", known);
  expect(claude).toEqual([
    // Just added, so the runtime has not named it yet: its plan's name. Used up, so the next one is the one chats run on.
    {
      id: "connection:c1",
      label: "Claude plan",
      kind: "login",
      active: false,
      where: "everywhere",
      connection: { kind: "claude_plan", status: "used_up", used_up_until: "2026-11-10T07:08:00Z" },
    },
    // Known to the runtime: its name stays.
    {
      id: "connection:k1",
      label: "Anthropic key",
      kind: "api_key",
      active: true,
      where: "everywhere",
      connection: { kind: "api_key", status: "ready" },
    },
  ]);
  expect(accountsFromCloud(list, "codex").map((a) => a.label)).toEqual(["ChatGPT plan"]);
  // Cloud's own label wins over the kind's name; a key the runtime never named falls back to its provider.
  expect(
    accountsFromCloud(
      { connections: [{ ...list.connections[1]!, label: "Work" }] },
      "claude-agent",
    )[0]!.label,
  ).toBe("Work");
  expect(accountsFromCloud(list, "caveman")[0]!.label).toBe("anthropic");
  // A kind turned off: listed, marked off, and never the one chats run on.
  const off = accountsFromCloud({ ...list, kinds: { api_key: { on: false } } }, "caveman");
  expect(off[0]).toMatchObject({
    active: false,
    connection: { kind: "api_key", status: "ready", off: true },
  });
  expect(cloudIdOf("connection:c1")).toBe("c1");
});

test("a browser window with no computer behind it lists the two agents a plan connects for, from Cloud's list alone", () => {
  const list = {
    connections: [
      {
        id: "c1",
        kind: "claude_plan" as const,
        provider: "anthropic",
        label: "",
        position: 0,
        status: "ready" as const,
        serves: ["claude-agent"],
      },
      {
        id: "k1",
        kind: "api_key" as const,
        provider: "anthropic",
        label: "",
        position: 1,
        status: "ready" as const,
        serves: ["claude-agent", "caveman"],
      },
    ],
    kinds: {},
  };
  const [claude, codex] = agentsFromCloud(list);
  expect([claude!.id, claude!.label, codex!.id, codex!.label]).toEqual([
    "claude-agent",
    "Claude Agent",
    "codex",
    "Codex",
  ]);
  // Claude Agent runs on the plan everywhere; Codex has nothing, and nothing is signed in from this page.
  expect(claude!.auth).toMatchObject({
    state: "signed_in",
    no_sign_in_here: true,
    everywhere: "manage",
  });
  expect(claude!.auth.accounts.map((a) => a.id)).toEqual(["connection:c1", "connection:k1"]);
  expect(status(claude!)).toMatchObject({ text: "Everywhere" });
  expect(status(claude!).action).toBeUndefined();
  expect(codex!.auth).toMatchObject({ state: "signed_out", accounts: [] });
  expect(status(codex!).text).toBe("Not signed in · connect from the desktop app");
  expect(status(codex!).action).toBeUndefined();
  // Nothing connected at all: both say where a plan is connected, with nothing to press that would be refused.
  expect(agentsFromCloud({ connections: [] }).map((e) => status(e).text)).toEqual([
    "Not signed in · connect from the desktop app",
    "Not signed in · connect from the desktop app",
  ]);
});
