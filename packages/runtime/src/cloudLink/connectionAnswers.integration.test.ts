// What a chat on a Cloud computer shows when Cloud's data plane answers its model requests (cloud-computers CONTRACT
// §3, SPEC §4.1), where the person's credentials stay outside the computer: a plan that runs out and the connection
// the engine carries on with, a kind switched off, nothing to run on (one note that says why and what happens next,
// the question before credits are spent, and the chat carrying on by itself once something serves it), Cloud pacing
// the computer's requests; and that no sign-in or key is taken inside the computer. A real runtime, the stand-in
// claude calling its model through the scrub, and the stand-in Cloud's data plane (testCloudEngine.ts).
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect, createScrubber, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, expect, test, vi } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { ANTHROPIC_VIA_PROXY, startEgressProxy } from "../secrets/EgressScrub.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { CREDITS_ASK, NOT_NOW, USE_CREDITS } from "../session-protocol/connectionNotes.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { CloudValues, layerBroker } from "./computerSecrets.ts";
import { tokenFor } from "./computers.ts";
import { OUTSIDE_CONNECT } from "./credentialRule.ts";
import { FollowedLogins } from "./engineLogins.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";
import {
  CODEX_NOT_STARTED,
  kindOffNote,
  listModelConnections,
  noConnectionMessage,
  noConnectionNote,
  nothingServesNote,
  OutsideConnections,
  RATE_MESSAGE,
  untilText,
  UPSTREAM_MESSAGE,
  usedUpNote,
  whenText,
  type DataPlaneAnswer,
  type ModelConnection,
  type ModelConnectionList,
} from "./modelConnections.ts";
import { SignInsHere } from "./signInHere.ts";
import { startTestCloud } from "./testCloud.ts";
import {
  startEngineCloud,
  type EngineCloudConfig,
  type EngineConnection,
} from "./testCloudEngine.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PLAN: EngineConnection = {
  id: "conn-claude-plan",
  kind: "claude_plan",
  provider: "anthropic",
  label: "Claude Max",
  position: 0,
  status: "ready",
  serves: ["claude-agent"],
};
const KEY: EngineConnection = {
  id: "conn-anthropic-key",
  kind: "api_key",
  provider: "anthropic",
  label: "Anthropic",
  position: 1,
  status: "ready",
  serves: ["claude-agent", "caveman"],
};

/** A Cloud computer under the rule with one chat open, and what that chat shows. */
async function computer(config: Partial<EngineCloudConfig>) {
  const inner = await startTestCloud();
  cleanups.push(inner.close);
  const cloud = await startEngineCloud(inner.url, { credentialsOutside: true, ...config });
  cleanups.push(cloud.close);
  vi.spyOn(appProxy, "url").mockReturnValue(undefined);
  vi.spyOn(codexProxy, "url").mockReturnValue(undefined);
  const root = tempRoot("connection-answers-");
  const linkDir = path.join(root, "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: inner.state.personToken,
    name: "computer",
  });
  const checkout = makeRepo(path.join(root, "workspace"), { "README.md": "widgets\n" });
  fs.chmodSync(checkout, 0o755);
  const link: LinkState = {};
  const info = { linkDir, computerId: identity.computerId, workspaceRoot: checkout };
  const serverConfig = await makeConfig();
  // The stand-in claude also answers as the Caveman engine, to see what a turn on Caveman credits is sent.
  const runtime = await startRuntime(serverConfig, "fake-claude", undefined, {
    cloudComputer: { computer: info, link },
    egress: true,
    alsoAs: ["caveman"],
  });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
  // The computer's broker, as server.ts builds it: it joins the engines' launches to this computer's connections.
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  await Effect.runPromise(
    Layer.buildWithScope(
      layerBroker.pipe(
        Layer.provideMerge(ServerSettingsModule.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(CloudComputer, info),
            Layer.succeed(CloudLinkState, link),
            Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
          ),
        ),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, serverConfig)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ) as Layer.Layer<any, unknown, never>,
      scope,
    ),
  );
  const workspace = await createReady(client, {
    request_id: "w1",
    repo: { url: "https://github.com/acme/widgets" },
    title: "Answers",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => events.push(event));
  let n = 0;
  const turn = async (text: string) => {
    const before = events.filter((event) => event.type === "turn.done").length;
    await client.call("turn.submit", {
      request_id: `t${++n}`,
      session_id: workspace.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => events.filter((event) => event.type === "turn.done").length > before, 60_000);
  };
  const notes = () =>
    events.flatMap((event) =>
      event.type === "notification"
        ? [
            {
              level: event.payload.level,
              title: event.payload.title,
              ...(event.payload.body === undefined ? {} : { body: event.payload.body }),
            },
          ]
        : [],
    );
  const said = () =>
    events.flatMap((event) =>
      event.type === "message.done" && event.payload.role === "assistant"
        ? [event.payload.text]
        : [],
    );
  const asked = () =>
    events.flatMap((event) =>
      event.type === "ask.user" ? [{ id: event.item_id!, payload: event.payload }] : [],
    );
  /** Everything the chat shows a person, as text: no amount of money may be in it. */
  const shown = () =>
    JSON.stringify(
      events.filter((event) =>
        ["notification", "ask.user", "error", "message.done"].includes(event.type),
      ),
    );
  return { cloud, client, workspace, events, turn, notes, said, asked, shown };
}

const NO_MONEY = /[$€£]\s?\d|\d\s?(?:usd|dollars?|cents?)\b|\bcost\b|\bspent\b/i;

/** What words.md keeps out of anything a person reads about a plan, and a zone no sentence names. */
const NOT_OUR_WORDS =
  /\b(?:connections?|credentials?|tokens?|logins?|engines?|UTC|GMT)\b|Caveman Cloud|a Cloud computer|Claude Code/i;

test("the notes, word for word", () => {
  const plan = PLAN as ModelConnection;
  const key = KEY as ModelConnection;
  const now = Date.parse("2026-11-09T20:00:00Z");
  const base = { session: "s", engine: "claude-agent" as const };
  const LA = "America/Los_Angeles";
  const all: Array<string> = [];
  const says = (said: string | { readonly title: string; readonly body?: string }) => (
    all.push(typeof said === "string" ? said : `${said.title} ${said.body ?? ""}`),
    said
  );

  // A Mac's clock is the person's own: a clock time, with the day when it is not today.
  expect(
    says(
      usedUpNote(
        { type: "used_up", ...base, connection: plan, until: "2026-11-10T07:08:00Z", next: key },
        now,
        LA,
      ),
    ),
  ).toBe("Claude plan used up until 11:08 PM. Running on your Anthropic key.");
  // A Cloud computer's clock is UTC, not theirs: how long from now, and never a zone.
  expect(
    says(
      usedUpNote(
        { type: "used_up", ...base, connection: plan, until: "2026-11-09T23:08:00Z", next: key },
        now,
        "UTC",
      ),
    ),
  ).toBe("Claude plan used up for 3 hours. Running on your Anthropic key.");
  expect(
    says(
      usedUpNote(
        { type: "used_up", ...base, connection: plan, until: undefined, next: key },
        now,
        "UTC",
      ),
    ),
  ).toBe("Claude plan used up. Running on your Anthropic key.");
  // Two plans of one kind are told apart by their labels.
  expect(
    says(
      usedUpNote(
        {
          type: "used_up",
          ...base,
          connection: plan,
          until: undefined,
          next: { ...plan, id: "other", label: "Work" },
        },
        now,
        "UTC",
      ),
    ),
  ).toBe("Claude plan (Claude Max) used up. Running on your Claude plan (Work).");
  // A chat started on a Mac with nothing left says what it runs on instead: the same line, never an amount.
  const own = says(
    usedUpNote(
      {
        type: "used_up",
        ...base,
        connection: plan,
        until: "2026-11-10T07:08:00Z",
        next: undefined,
        own: true,
      },
      now,
      LA,
    ),
  );
  expect(own).toBe("Claude plan used up until 11:08 PM. Running on this Mac's login.");
  expect(
    says(
      usedUpNote(
        {
          type: "used_up",
          ...base,
          connection: plan,
          until: undefined,
          next: undefined,
          own: true,
        },
        now,
        "UTC",
      ),
    ),
  ).toBe("Claude plan used up. Running on this Mac's login.");
  expect(own).not.toMatch(NO_MONEY);

  // How long from now: minutes under an hour, hours up to 48, then days. A real zone: the clock.
  expect(whenText("2026-11-09T20:00:20Z", now, "UTC")).toEqual({ for: "1 minute" });
  expect(whenText("2026-11-09T20:19:30Z", now, "UTC")).toEqual({ for: "20 minutes" });
  expect(whenText("2026-11-09T21:00:00Z", now, "Etc/UTC")).toEqual({ for: "1 hour" });
  expect(whenText("2026-11-10T22:00:00Z", now, "UTC")).toEqual({ for: "26 hours" });
  expect(whenText("2026-11-11T20:00:00Z", now, "UTC")).toEqual({ for: "48 hours" });
  expect(whenText("2026-11-12T20:00:00Z", now, "UTC")).toEqual({ for: "3 days" });
  expect(whenText("2026-11-10T07:08:00Z", now, LA)).toEqual({ at: "11:08 PM" });
  expect(whenText("2026-11-12T23:08:00Z", now, LA)).toEqual({ at: "Nov 12, 3:08 PM" });
  expect(whenText("2026-11-09T19:00:00Z", now, "UTC")).toBeUndefined();
  expect(whenText(undefined, now, LA)).toBeUndefined();
  // The builders' note still reads the clock time with its zone (session-protocol/builders.ts).
  expect(untilText("2026-11-09T23:08:00Z", now, "UTC")).toBe("11:08 PM UTC");
  expect(untilText("2026-11-09T19:00:00Z", now, "UTC")).toBeUndefined();

  expect(says(kindOffNote({ type: "kind_off", ...base, connection: plan, next: key }))).toBe(
    "Your admin turned Claude plans off. Running on your Anthropic key.",
  );

  // Nothing is connected for it: what is missing and where to connect it. In Cloud that is the person's Mac.
  const body = "Connect it on your Mac (Settings > Models & keys). It then works in Cloud too.";
  expect(says(noConnectionNote("claude-agent"))).toEqual({
    title: "Claude isn't connected for Cloud.",
    body,
  });
  expect(says(noConnectionNote("codex"))).toEqual({
    title: "ChatGPT isn't connected for Cloud.",
    body,
  });
  expect(says(noConnectionNote("caveman", "openai"))).toEqual({
    title: "Your OpenAI key isn't connected for Cloud.",
    body,
  });
  expect(says(noConnectionNote("caveman"))).toEqual({
    title: "This model has no key connected for Cloud.",
    body,
  });
  expect(says(noConnectionMessage("claude-agent"))).toBe(
    `Claude isn't connected for Cloud. ${body}`,
  );
  // A chat on a Mac that runs on the person's plans hears the same refusals: never "for Cloud" there.
  expect(says(noConnectionNote("claude-agent", undefined, "mac"))).toEqual({
    title: "Claude isn't connected.",
    body: "Connect it in Settings > Models & keys.",
  });
  expect(says(noConnectionMessage("codex", undefined, "mac"))).toBe(
    "ChatGPT isn't connected. Connect it in Settings > Models & keys.",
  );

  // Nothing serves the chat, by why: one note each, and each says what happens next.
  const nothing = (
    why: Extract<DataPlaneAnswer, { type: "no_connection" }>["why"],
    options: Parameters<typeof nothingServesNote>[2] = {},
    engine: "claude-agent" | "codex" = "claude-agent",
  ) =>
    says(
      nothingServesNote({ engine, provider: undefined, why }, now, { timeZone: LA, ...options }),
    );
  const chatgpt = {
    ...plan,
    id: "conn-chatgpt",
    kind: "chatgpt_plan",
    provider: "openai",
  } as ModelConnection;
  expect(nothing({ reason: "none" })).toEqual({ title: "Claude isn't connected for Cloud.", body });
  expect(nothing({ reason: "expired", connection: plan })).toEqual({
    title: "Your Claude sign-in expired.",
    body: "Reconnect it on your Mac (Settings > Models & keys).",
  });
  expect(nothing({ reason: "expired", connection: chatgpt }, {}, "codex")).toEqual({
    title: "Your ChatGPT sign-in expired.",
    body: "Reconnect it on your Mac (Settings > Models & keys).",
  });
  expect(nothing({ reason: "expired", connection: plan }, { place: "mac" })).toEqual({
    title: "Your Claude sign-in expired.",
    body: "Reconnect it in Settings > Models & keys.",
  });
  expect(nothing({ reason: "kind_off", connection: plan, keys: true })).toEqual({
    title: "Your admin turned Claude plans off.",
    body: "Add an Anthropic key, or run this chat on your Mac.",
  });
  expect(nothing({ reason: "kind_off", connection: chatgpt, keys: true }, {}, "codex")).toEqual({
    title: "Your admin turned ChatGPT plans off.",
    body: "Add an OpenAI key, or run this chat on your Mac.",
  });
  // Keys are off too: adding one would not help.
  expect(nothing({ reason: "kind_off", connection: plan, keys: false })).toEqual({
    title: "Your admin turned Claude plans off.",
    body: "Run this chat on your Mac.",
  });
  expect(nothing({ reason: "kind_off", connection: key, keys: false })).toEqual({
    title: "Your admin turned API keys off.",
    body: "Run this chat on your Mac.",
  });
  expect(nothing({ reason: "kind_off", connection: plan, keys: true }, { place: "mac" })).toEqual({
    title: "Your admin turned Claude plans off.",
    body: "Add an Anthropic key in Settings > Models & keys.",
  });
  // Used up with nothing else: the chat waits and carries on by itself, so the note says when.
  expect(
    nothing(
      { reason: "used_up", connection: plan, until: "2026-11-10T07:08:00Z" },
      { carriesOn: true },
    ),
  ).toEqual({ title: "Claude plan used up. Carries on at 11:08 PM." });
  expect(
    nothing(
      { reason: "used_up", connection: plan, until: "2026-11-09T23:08:00Z" },
      { carriesOn: true, timeZone: "UTC" },
    ),
  ).toEqual({ title: "Claude plan used up. Carries on in 3 hours." });
  expect(
    nothing({ reason: "used_up", connection: plan, until: undefined }, { carriesOn: true }),
  ).toEqual({ title: "Claude plan used up. Carries on when it resets." });
  // Where no chat waits (what the engine reads, an engine's probe, a chat that stopped waiting): only until when.
  expect(nothing({ reason: "used_up", connection: plan, until: "2026-11-10T07:08:00Z" })).toEqual({
    title: "Claude plan used up until 11:08 PM.",
  });
  expect(
    nothing(
      { reason: "used_up", connection: plan, until: "2026-11-09T23:08:00Z" },
      { timeZone: "UTC" },
    ),
  ).toEqual({ title: "Claude plan used up for 3 hours." });
  expect(nothing({ reason: "used_up", connection: plan, until: undefined })).toEqual({
    title: "Claude plan used up.",
  });

  expect(says(RATE_MESSAGE)).toBe("Too many requests right now. It tries again by itself.");
  expect(says(UPSTREAM_MESSAGE)).toBe("Can't reach the model provider. Try again in a moment.");
  expect(says(CODEX_NOT_STARTED)).toBe("Codex couldn't start in Cloud. Send your message again.");
  expect(CREDITS_ASK).toMatchObject({
    title: "Run this chat on Caveman credits?",
    detail: "It carries on with the Caveman agent and sends your last message again.",
  });
  if (CREDITS_ASK.kind === "approval")
    says(
      `${CREDITS_ASK.title} ${CREDITS_ASK.detail} ${CREDITS_ASK.options.map((option) => option.label).join(" ")}`,
    );

  // Not one of them holds an amount, a zone, or a word a person is never shown for a plan.
  for (const said of all) {
    expect(said).not.toMatch(NO_MONEY);
    // A plan is never called a login; the Mac's own is, as Settings > Models & keys says it.
    expect(said.replace("this Mac's login", "")).not.toMatch(NOT_OUR_WORDS);
  }
});

test.skipIf(process.platform === "win32")(
  "a plan that runs out: one note, and the engine carries on with the next connection in order",
  async () => {
    const until2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const chat = await computer({ connections: [PLAN, KEY], usedUpOnUse: { [PLAN.id]: until2h } });
    await chat.turn("model: first");
    // The same request went out again on the key, and the turn never noticed.
    expect(chat.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    const expected = usedUpNote(
      {
        type: "used_up",
        session: "s",
        engine: "claude-agent",
        connection: PLAN as ModelConnection,
        until: until2h,
        next: KEY as ModelConnection,
      },
      Date.now(),
    );
    // "until 11:08 PM" where this computer's clock is the person's; "for 2 hours" where it is UTC.
    expect(expected).toMatch(
      /^Claude plan used up (?:until|for) .+\. Running on your Anthropic key\.$/,
    );
    expect(chat.notes()).toEqual([{ level: "info", title: expected }]);
    let report = await chat.cloud.report();
    expect(report.plane.map((p) => [p.named, p.status])).toEqual([
      [PLAN.id, 429],
      [KEY.id, 200],
    ]);
    expect(report.upstream.map((seen) => seen.credentials)).toEqual([["anthropicKey"]]);
    // The next turn runs on the key from its first request, and says nothing more.
    await chat.turn("model: second");
    report = await chat.cloud.report();
    expect(report.plane.map((p) => [p.named, p.status])).toEqual([
      [PLAN.id, 429],
      [KEY.id, 200],
      [KEY.id, 200],
    ]);
    expect(chat.notes()).toHaveLength(1);
    expect(chat.asked()).toEqual([]);
    expect(chat.shown()).not.toMatch(NO_MONEY);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a kind switched off: one note, and the next connection serves",
  async () => {
    const chat = await computer({ connections: [PLAN, KEY] });
    await chat.turn("model: first");
    expect((await chat.cloud.report()).plane.map((p) => [p.named, p.status])).toEqual([
      [PLAN.id, 200],
    ]);
    await chat.cloud.configure({ kinds: { claude_plan: { on: false } } });
    await chat.turn("model: second");
    expect(chat.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    expect(chat.notes()).toEqual([
      {
        level: "info",
        title: "Your admin turned Claude plans off. Running on your Anthropic key.",
      },
    ]);
    expect(
      (await chat.cloud.report()).plane.slice(1).map((p) => [p.named, p.status, p.code]),
    ).toEqual([
      [PLAN.id, 403, "cave_code_connection_kind_off"],
      [KEY.id, 200, undefined],
    ]);
    expect(chat.asked()).toEqual([]);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "Cloud pacing the computer: the engine waits as long as Cloud said and tries again; the chat says nothing",
  async () => {
    const chat = await computer({
      connections: [PLAN],
      rateLimited: { count: 1, retryAfter: "1" },
    });
    const started = Date.now();
    await chat.turn("model: paced");
    expect(chat.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect((await chat.cloud.report()).plane.map((p) => [p.status, p.code])).toEqual([
      [429, "cave_code_engine_rate"],
      [200, undefined],
    ]);
    expect(chat.notes()).toEqual([]);
    expect(chat.asked()).toEqual([]);
  },
  120_000,
);

const NOT_CONNECTED = {
  level: "warning",
  title: "Claude isn't connected for Cloud.",
  body: "Connect it on your Mac (Settings > Models & keys). It then works in Cloud too.",
};
const ANSWER = "smoke ok: model said: answer from the provider";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a chat's journal shows of its turns and the person's messages. */
const journal = (chat: Awaited<ReturnType<typeof computer>>) => ({
  typed: chat.events.flatMap((event) =>
    event.type === "message.done" && event.payload.role === "user" ? [event.payload.text] : [],
  ),
  started: chat.events.filter((event) => event.type === "turn.started").length,
  ended: chat.events.flatMap((event) => (event.type === "turn.done" ? [event.payload.status] : [])),
  resolved: chat.events.flatMap((event) =>
    event.type === "ask.resolved" ? [event.payload.outcome] : [],
  ),
});

test.skipIf(process.platform === "win32")(
  "nothing connected: the chat says what to connect and where, then asks before spending Caveman credits; yes runs it on credits and it is never sent twice",
  async () => {
    const chat = await computer({ connections: [PLAN] });
    await chat.turn("model: first");
    // The plan is gone from the person's list: the data plane has nothing for the lane.
    await chat.cloud.configure({ connections: [] });
    await chat.turn("model: carry on with the parser");
    expect((await chat.cloud.report()).plane.at(-1)).toMatchObject({
      status: 402,
      code: "cave_code_no_connection",
    });
    // The engine read the refusal as its provider's, in the words the chat's note says it in.
    expect(chat.said().at(-1)).toBe(`API Error: 402 ${NOT_CONNECTED.title} ${NOT_CONNECTED.body}`);
    expect(chat.notes()).toEqual([NOT_CONNECTED]);
    // The question comes after the note and the refused turn, and only once.
    await until(() => chat.asked().length === 1, 20_000);
    const ask = chat.asked()[0]!;
    expect(ask.payload).toEqual(CREDITS_ASK);
    const order = chat.events
      .filter(
        (event) =>
          event.type === "notification" || event.type === "ask.user" || event.type === "turn.done",
      )
      .map((event) => event.type);
    expect(order.slice(-3)).toEqual(["notification", "turn.done", "ask.user"]);
    expect(chat.shown()).not.toMatch(NO_MONEY);

    // No: the card closes and nothing runs.
    await chat.client.call("ask.respond", {
      request_id: "a1",
      session_id: chat.workspace.session_id,
      ask_id: ask.id,
      response: { kind: "approval", option_id: NOT_NOW },
    });
    expect(chat.events.filter((event) => event.type === "ask.resolved")).toHaveLength(1);
    expect(
      (await chat.client.call("workspace.get", { workspace_id: chat.workspace.id })).engine,
    ).toBe("claude-agent");

    // Asked again at the next refusal, with nothing said twice: the chat still waits, and its note stands.
    await chat.turn("model: carry on with the parser, please");
    await until(() => chat.asked().length === 2, 20_000);
    expect(chat.notes()).toEqual([NOT_CONNECTED]);
    // Yes sends the person's last message again on the Caveman engine's credits model.
    await chat.cloud.configure({ connections: [PLAN] });
    const turns = chat.events.filter((event) => event.type === "turn.done").length;
    await chat.client.call("ask.respond", {
      request_id: "a2",
      session_id: chat.workspace.session_id,
      ask_id: chat.asked()[1]!.id,
      response: { kind: "approval", option_id: USE_CREDITS },
    });
    await until(
      () => chat.events.filter((event) => event.type === "turn.done").length > turns,
      60_000,
    );
    const after = await chat.client.call("workspace.get", { workspace_id: chat.workspace.id });
    expect(after.engine).toBe("caveman");
    const sent = chat.events
      .filter((event) => event.type === "message.done" && event.payload.role === "user")
      .at(-1);
    expect(sent).toMatchObject({ payload: { text: "model: carry on with the parser, please" } });
    expect(chat.shown()).not.toMatch(NO_MONEY);

    // The plan is listed again, and the chat that waited for it looks at the list every few seconds: the message the
    // person chose to run on credits is not sent a second time.
    const before = journal(chat);
    await sleep(12_000);
    expect(journal(chat)).toEqual(before);
    expect(
      before.typed.filter((text) => text === "model: carry on with the parser, please"),
    ).toHaveLength(2);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "nothing connected: the message that was refused runs by itself once a plan is connected, once",
  async () => {
    // Nothing is connected when the chat's first message is sent: its engine never starts.
    const chat = await computer({ connections: [] });
    await chat.turn("model: first");
    expect(chat.notes()).toEqual([NOT_CONNECTED]);
    // The turn failed in the same words, and no request ever reached the data plane.
    expect(chat.events.filter((event) => event.type === "turn.done").at(-1)).toMatchObject({
      payload: { status: "failed", error: `${NOT_CONNECTED.title} ${NOT_CONNECTED.body}` },
    });
    expect((await chat.cloud.report()).plane).toEqual([]);
    await until(() => chat.asked().length === 1, 20_000);
    expect(journal(chat)).toEqual({
      typed: ["model: first"],
      started: 1,
      ended: ["failed"],
      resolved: [],
    });

    // The person connects their Claude plan from their Mac: Cloud's list says so, and nothing is done in this chat.
    await chat.cloud.configure({ connections: [PLAN] });
    await until(() => chat.said().at(-1) === ANSWER, 60_000);
    await until(() => journal(chat).ended.length === 2, 20_000);
    // Their message went again as it was, on the chat's own engine, and the model answered. The credits question
    // closed as not answered: nothing was spent.
    expect(journal(chat)).toEqual({
      typed: ["model: first", "model: first"],
      started: 2,
      ended: ["failed", "completed"],
      resolved: ["cancelled"],
    });
    expect(
      (await chat.client.call("workspace.get", { workspace_id: chat.workspace.id })).engine,
    ).toBe("claude-agent");
    expect((await chat.cloud.report()).plane.map((p) => [p.named, p.status])).toEqual([
      [PLAN.id, 200],
    ]);
    expect(chat.notes()).toEqual([NOT_CONNECTED]);
    expect(chat.asked()).toHaveLength(1);

    // Once: the chat no longer waits, however often the list is read after that.
    const before = journal(chat);
    await sleep(12_000);
    expect(journal(chat)).toEqual(before);
    expect((await chat.cloud.report()).plane).toHaveLength(1);
    expect(chat.shown()).not.toMatch(NO_MONEY);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a plan used up with nothing else to run on: one note that says when, one question, and the chat carries on by itself when the time has passed",
  async () => {
    const chat = await computer({ connections: [PLAN] });
    const resets = new Date(Date.now() + 12_000).toISOString();
    await chat.cloud.configure({ usedUpOnUse: { [PLAN.id]: resets } });
    await chat.turn("model: first");
    // Two requests of the one turn were refused: the provider's own 429 for the plan, then, tried again, nothing left.
    expect((await chat.cloud.report()).plane.map((p) => [p.status, p.code])).toEqual([
      [429, undefined],
      [402, "cave_code_no_connection"],
    ]);
    // One note, which says until when (a clock time where this computer's clock is the person's; how long where it is UTC).
    // It promises nothing: Cloud may sleep before then, and the wait is kept in memory.
    const note = chat.notes();
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({
      level: "warning",
      title: expect.stringMatching(
        /^Claude plan used up (?:until \d{1,2}:\d\d [AP]M|for 1 minute)\.$/,
      ),
    });
    expect(note[0]).not.toHaveProperty("body");
    // The engine read that its plan is used up and until when, never that nothing is connected.
    expect(chat.said().at(-1)).toMatch(
      /^API Error: 402 Claude plan used up (?:until \d{1,2}:\d\d [AP]M|for 1 minute)\.$/,
    );
    await until(() => chat.asked().length === 1, 20_000);
    expect(journal(chat)).toEqual({
      typed: ["model: first"],
      started: 1,
      ended: ["failed"],
      resolved: [],
    });

    // Nothing is done. The plan's time passes, and the chat sends the message again by itself: one wait, one send.
    await until(() => chat.said().at(-1) === ANSWER, 60_000);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resets));
    await until(() => journal(chat).ended.length === 2, 20_000);
    expect(journal(chat)).toEqual({
      typed: ["model: first", "model: first"],
      started: 2,
      ended: ["failed", "completed"],
      resolved: ["cancelled"],
    });
    expect((await chat.cloud.report()).plane.map((p) => [p.named, p.status])).toEqual([
      [PLAN.id, 429],
      [null, 402],
      [PLAN.id, 200],
    ]);
    const before = journal(chat);
    await sleep(12_000);
    expect(journal(chat)).toEqual(before);
    expect(chat.notes()).toHaveLength(1);
    expect(chat.asked()).toHaveLength(1);
    expect(chat.shown()).not.toMatch(NO_MONEY);
    expect(chat.shown()).not.toMatch(/\bUTC\b/);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a message sent again and refused again waits for the plan's new time: it is never sent in a loop",
  async () => {
    const chat = await computer({ connections: [PLAN] });
    const first = new Date(Date.now() + 8_000).toISOString();
    await chat.cloud.configure({ usedUpOnUse: { [PLAN.id]: first } });
    await chat.turn("model: first");
    expect(chat.notes()).toHaveLength(1);
    // When its time has passed the plan serves one request and runs out again, for much longer.
    const second = new Date(Date.now() + 3 * 3_600_000).toISOString();
    await chat.cloud.configure({ usedUpOnUse: { [PLAN.id]: second } });
    await until(() => journal(chat).ended.length === 2, 60_000);
    // The message went again once, was refused, and the chat says the new time: it waits for that, and asks again.
    expect(journal(chat)).toEqual({
      typed: ["model: first", "model: first"],
      started: 2,
      ended: ["failed", "failed"],
      resolved: ["cancelled"],
    });
    await until(() => chat.asked().length === 2, 20_000);
    const notes = chat.notes();
    expect(notes).toHaveLength(2);
    for (const note of notes)
      expect(note.title).toMatch(/^Claude plan used up (?:until|for) .+\.$/);
    expect(notes[1]!.title).not.toBe(notes[0]!.title);
    // However often the list is read meanwhile, nothing is sent while the plan is used up.
    const before = journal(chat);
    const requests = (await chat.cloud.report()).plane.length;
    await sleep(12_000);
    expect(journal(chat)).toEqual(before);
    expect((await chat.cloud.report()).plane).toHaveLength(requests);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a sign-in that expired, then a kind their admin turned off: each says what it is and what to do, and the chat carries on once a key serves it",
  async () => {
    // The plan is listed, and its sign-in expired: not "nothing connected".
    const chat = await computer({ connections: [{ ...PLAN, status: "expired" }] });
    await chat.turn("model: first");
    const expired = {
      level: "warning",
      title: "Your Claude sign-in expired.",
      body: "Reconnect it on your Mac (Settings > Models & keys).",
    };
    expect(chat.notes()).toEqual([expired]);
    expect(chat.events.filter((event) => event.type === "turn.done").at(-1)).toMatchObject({
      payload: { status: "failed", error: `${expired.title} ${expired.body}` },
    });
    await until(() => chat.asked().length === 1, 20_000);

    // They reconnect it, and meanwhile their admin turned Claude plans off: still nothing serves the chat, so it waits.
    await chat.cloud.configure({ connections: [PLAN], kinds: { claude_plan: { on: false } } });
    await chat.turn("model: second");
    const off = {
      level: "warning",
      title: "Your admin turned Claude plans off.",
      body: "Add an Anthropic key, or run this chat on your Mac.",
    };
    // One note for the new reason, and no second "isn't connected" note; the question already open is the only one.
    expect(chat.notes()).toEqual([expired, off]);
    expect(chat.asked()).toHaveLength(1);

    // They add an Anthropic key on their Mac: the chat carries on with it by itself, with their last message.
    await chat.cloud.configure({ connections: [PLAN, KEY] });
    await until(() => chat.said().at(-1) === ANSWER, 60_000);
    await until(() => journal(chat).ended.length === 3, 20_000);
    expect(journal(chat)).toEqual({
      typed: ["model: first", "model: second", "model: second"],
      started: 3,
      ended: ["failed", "failed", "completed"],
      resolved: ["cancelled"],
    });
    expect((await chat.cloud.report()).plane.map((p) => [p.named, p.status])).toEqual([
      [KEY.id, 200],
    ]);
    expect(chat.notes()).toEqual([expired, off]);
    expect(chat.shown()).not.toMatch(NO_MONEY);
  },
  180_000,
);

test("why nothing serves, read from the person's list: a used-up plan first, then a kind switched off, then a sign-in that expired", async () => {
  const plan = PLAN as ModelConnection;
  const key = KEY as ModelConnection;
  let now = Date.parse("2026-11-09T20:00:00Z");
  let list: ModelConnectionList = { connections: [], kinds: {} };
  const connections = new OutsideConnections({ list: async () => list, now: () => now });
  const heard: Array<DataPlaneAnswer> = [];
  connections.onAnswer((answer) => heard.push(answer));
  const listed = (next: ModelConnectionList) => ((list = next), connections.forget());

  expect(await connections.nothingServes("claude-agent")).toEqual({ reason: "none" });
  // A key for another provider is not this engine's.
  listed({
    connections: [{ ...key, provider: "openai", serves: ["codex", "caveman"] }],
    kinds: {},
  });
  expect(await connections.nothingServes("claude-agent")).toEqual({ reason: "none" });
  expect(await connections.nothingServes("caveman", "anthropic")).toEqual({ reason: "none" });

  const expired = { ...plan, status: "expired" as const };
  listed({ connections: [expired], kinds: {} });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "expired",
    connection: expired,
  });
  listed({ connections: [{ ...plan, status: "revoked" }], kinds: {} });
  expect(await connections.nothingServes("claude-agent")).toMatchObject({ reason: "expired" });

  // Switched off comes before expired (reconnecting would not help), and says whether a key would still serve.
  listed({ connections: [expired], kinds: { claude_plan: { on: false } } });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "kind_off",
    connection: expired,
    keys: true,
  });
  listed({ connections: [plan], kinds: { claude_plan: { on: false }, api_key: { on: false } } });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "kind_off",
    connection: plan,
    keys: false,
  });
  // Keys switched off beside a plan that expired: connecting the plan again is what helps. Keys alone: that they are off.
  listed({ connections: [expired, key], kinds: { api_key: { on: false } } });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "expired",
    connection: expired,
  });
  listed({ connections: [key], kinds: { api_key: { on: false } } });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "kind_off",
    connection: key,
    keys: false,
  });

  // Used up comes first: it comes back by itself. Cloud's mark, with and without a time; the soonest of two.
  const until = "2026-11-09T23:08:00.000Z";
  const usedUp = { ...plan, status: "used_up" as const, used_up_until: until };
  listed({ connections: [usedUp, { ...key, status: "expired" }], kinds: {} });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "used_up",
    connection: usedUp,
    until,
  });
  listed({ connections: [{ ...plan, status: "used_up", used_up_until: null }], kinds: {} });
  expect(await connections.nothingServes("claude-agent")).toMatchObject({
    reason: "used_up",
    until: undefined,
  });
  const sooner = { ...key, status: "used_up" as const, used_up_until: "2026-11-09T21:00:00.000Z" };
  listed({ connections: [usedUp, sooner], kinds: {} });
  expect(await connections.nothingServes("claude-agent")).toEqual({
    reason: "used_up",
    connection: sooner,
    until: sooner.used_up_until,
  });

  // A launch with nothing to run on is refused with why, and its chat hears why, once.
  listed({ connections: [usedUp], kinds: {} });
  expect(heard).toEqual([]);
  const launch = await connections.launch("claude-agent", {}, { session: "chat-1" });
  expect(launch).toEqual({
    unavailable: nothingServesNote(
      {
        engine: "claude-agent",
        provider: undefined,
        why: { reason: "used_up", connection: usedUp, until },
      },
      now,
    ).title,
  });
  expect("unavailable" in launch && launch.unavailable).toMatch(
    /^Claude plan used up (?:until|for) .+\.$/,
  );
  expect(heard).toEqual([
    {
      type: "no_connection",
      session: "chat-1",
      engine: "claude-agent",
      provider: undefined,
      why: { reason: "used_up", connection: usedUp, until },
    },
  ]);
  // An engine's probe is no chat: it reads the same, and nobody hears.
  expect(await connections.launch("claude-agent", {})).toEqual(launch);
  expect(heard.map((answer) => answer.session)).toEqual(["chat-1", undefined]);
  listed({ connections: [], kinds: {} });
  expect(await connections.launch("codex", {})).toEqual({
    unavailable:
      "ChatGPT isn't connected for Cloud. Connect it on your Mac (Settings > Models & keys). It then works in Cloud too.",
  });
  // Once its time has passed, the plan serves again.
  listed({ connections: [usedUp], kinds: {} });
  expect(await connections.serving("claude-agent")).toEqual([]);
  now = Date.parse(until) + 1;
  expect(await connections.serving("claude-agent")).toEqual([usedUp]);

  // A request refused as used up, or as switched off, with nothing else to carry on with: the chat hears one answer.
  now = Date.parse("2026-11-09T20:00:00Z");
  listed({ connections: [plan], kinds: {} });
  const issued = { engine: "claude-agent" as const, connectionId: plan.id, provider: "anthropic" };
  heard.length = 0;
  expect(await connections.usedUp(issued, plan.id, until, "chat-2")).toBeUndefined();
  expect(heard).toEqual([
    {
      type: "no_connection",
      session: "chat-2",
      engine: "claude-agent",
      provider: undefined,
      why: { reason: "used_up", connection: plan, until },
    },
  ]);
  // Its CLI reads why for the request that follows, and the chat hears that one too.
  expect(await connections.noConnection(issued, "chat-2")).toMatch(
    /^Claude plan used up (?:until|for) .+\.$/,
  );
  expect(heard).toHaveLength(2);
  now = Date.parse(until) + 1;
  heard.length = 0;
  expect(await connections.kindOff(issued, plan.id, "chat-2")).toBeUndefined();
  expect(heard).toEqual([
    {
      type: "no_connection",
      session: "chat-2",
      engine: "claude-agent",
      provider: undefined,
      why: { reason: "kind_off", connection: plan, keys: true },
    },
  ]);
  expect(await connections.refusalText(issued)).toBe(
    "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
  );
  expect(heard).toHaveLength(1);
  // With a key to carry on with, each still says what the engine runs on now, and nothing is refused.
  listed({ connections: [plan, key], kinds: {} });
  heard.length = 0;
  expect(await connections.kindOff(issued, plan.id, "chat-3")).toEqual(key);
  expect(heard).toEqual([
    { type: "kind_off", session: "chat-3", engine: "claude-agent", connection: plan, next: key },
  ]);
  listed({ connections: [plan, key], kinds: {} });
  heard.length = 0;
  expect(await connections.usedUp(issued, plan.id, "2026-11-10T23:08:00.000Z", "chat-3")).toEqual(
    key,
  );
  expect(heard).toEqual([
    {
      type: "used_up",
      session: "chat-3",
      engine: "claude-agent",
      connection: plan,
      until: "2026-11-10T23:08:00.000Z",
      next: key,
    },
  ]);

  // Codex's own refresh, asked with a token that is not a stand-in of this run.
  expect(connections.answerCodexRefresh({ refresh_token: "rt_someone-elses" })).toEqual({
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "Connect ChatGPT on your Mac (Settings > Models & keys).",
    },
  });
  // Codex with a plan to run on and no home to keep its stand-in sign-in in.
  listed({
    connections: [
      { ...plan, id: "conn-chatgpt", kind: "chatgpt_plan", provider: "openai", serves: ["codex"] },
    ],
    kinds: {},
  });
  expect(
    await connections.launch(
      "codex",
      {},
      {
        files: {
          read: async () => undefined,
          write: async () => undefined,
          removeStandIn: async () => undefined,
        },
      },
    ),
  ).toEqual({ unavailable: CODEX_NOT_STARTED });
});

test.skipIf(process.platform === "win32")(
  "no sign-in and no key is taken inside the computer: the answer says where to connect",
  async () => {
    const chat = await computer({ connections: [PLAN] });
    const refusal = (call: Promise<unknown>) =>
      call.then(
        () => "ok",
        (error: { error?: { message?: string; data?: { reason?: string } } }) =>
          `${error.error?.data?.reason}: ${error.error?.message}`,
      );
    const signIn =
      "unsupported: Connect it on your Mac (Settings > Models & keys). It then works in Cloud too.";
    expect(
      await refusal(
        chat.client.call("engine.account.signin", {
          request_id: "s1",
          engine: "claude-agent",
          provider: "anthropic",
        }),
      ),
    ).toBe(signIn);
    expect(
      await refusal(
        chat.client.call("engine.account.add", {
          request_id: "s2",
          engine: "codex",
          chatgpt: true,
        }),
      ),
    ).toBe(signIn);
    expect(
      await refusal(
        chat.client.call("engine.account.complete", {
          request_id: "s3",
          engine: "claude-agent",
          account_id: "default",
          callback_url: "code#state",
        }),
      ),
    ).toBe(signIn);
    expect(
      await refusal(
        chat.client.call("engine.account.add", {
          request_id: "s4",
          engine: "caveman",
          provider: "openai",
          key: "sk-a-key-typed-into-the-computer",
        }),
      ),
    ).toBe(`unsupported: ${OUTSIDE_CONNECT}`);
    // Nor is one removed there: nothing was kept to remove.
    const remove = "unsupported: Remove it on your Mac (Settings > Models & keys).";
    expect(
      await refusal(
        chat.client.call("engine.account.remove", {
          request_id: "s5",
          engine: "claude-agent",
          account_id: "default",
        }),
      ),
    ).toBe(remove);
    expect(
      await refusal(
        chat.client.call("engine.account.remove", {
          request_id: "s6",
          engine: "codex",
          account_id: "chatgpt",
        }),
      ),
    ).toBe(remove);
    // Not one call reached a route the rule closes (a sign-in read, written or removed, a key switched).
    expect((await chat.cloud.report()).closed).toEqual([]);
  },
  120_000,
);

test("the scrub under the rule: a key request leaves through the key lane, scrubbed; an endpoint off the list keeps its stand-in", async () => {
  const inner = await startTestCloud();
  cleanups.push(inner.close);
  const OPENAI: EngineConnection = {
    id: "conn-openai-key",
    kind: "api_key",
    provider: "openai",
    label: "OpenAI",
    position: 0,
    status: "ready",
    serves: ["codex", "caveman"],
  };
  const cloud = await startEngineCloud(inner.url, {
    credentialsOutside: true,
    connections: [PLAN, OPENAI],
  });
  cleanups.push(cloud.close);
  vi.spyOn(appProxy, "url").mockReturnValue(`${cloud.url}/__provider/claude`);
  vi.spyOn(codexProxy, "url").mockReturnValue(undefined);
  const linkDir = path.join(tempRoot("scrub-outside-"), "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: inner.state.personToken,
    name: "computer",
  });
  const link: LinkState = {};
  const token = await tokenFor(identity, link, fetch);
  const connections = new OutsideConnections({ list: () => listModelConnections(identity, link) });
  const SECRET = "hunter2-a-repository-secret-value";
  const scrubber = createScrubber([{ name: "DEPLOY_KEY", value: SECRET }]);
  const proxy = await startEgressProxy({
    scrubber: () => scrubber,
    dataPlane: () => ({ connections, cloudUrl: cloud.url, token: async () => token }),
  });
  cleanups.push(proxy.close);

  // The Caveman engine's own-key slot is a stand-in; its request, as pi-ai sends it to the provider's base URL.
  const keys = await connections.keys();
  expect(keys).toEqual([
    { provider: "openai", key: expect.stringMatching(/^sk-caveman-stand-in-[0-9a-f]{48}-\d+$/) },
  ]);
  const answer = await fetch(
    `${proxy.route("https://api.openai.com/v1")}/chat/completions?beta=1`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${keys[0]!.key}`,
        "content-type": "application/json",
        "x-cave-session": "thread-1",
        cookie: "session=of-the-agent",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: `the key is ${SECRET}` }],
      }),
    },
  );
  expect(answer.status).toBe(200);
  expect(await answer.text()).toContain("response.completed");
  let report = await cloud.report();
  expect(report.plane).toEqual([
    {
      lane: "key/openai",
      path: "/v1/chat/completions",
      named: OPENAI.id,
      served: OPENAI.id,
      status: 200,
    },
  ]);
  expect(report.upstream[0]).toMatchObject({
    lane: "key/openai",
    path: "/v1/chat/completions",
    credentials: ["openaiKey"],
    standIn: false,
    runtimeToken: false,
  });
  // Scrubbed as ever, before it left the computer.
  expect(report.upstream[0]!.body).toContain("[secret:DEPLOY_KEY]");
  expect(report.upstream[0]!.body).not.toContain(SECRET);

  // Claude's stand-in on an endpoint its lane does not serve: not the data plane's, and worth nothing where it lands.
  const launch = await connections.launch("claude-agent", {});
  const standIn = "env" in launch ? launch.env.CLAUDE_CODE_OAUTH_TOKEN! : "";
  expect(standIn).toMatch(/^sk-ant-oat01-caveman-stand-in-/);
  await fetch(`${proxy.route(ANTHROPIC_VIA_PROXY)}/v1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${standIn}`, "content-type": "application/json" },
    body: "{}",
  });
  report = await cloud.report();
  expect(report.plane).toHaveLength(1);
  expect(report.upstream[1]).toMatchObject({
    lane: "claude",
    path: "/w/caveman-code-claude/v1/files",
    credentials: [],
    standIn: true,
  });
  // On one it does, the same stand-in is the data plane's, with the connection it names.
  const listed = await fetch(`${proxy.route(ANTHROPIC_VIA_PROXY)}/v1/models`, {
    headers: { authorization: `Bearer ${standIn}` },
  });
  expect(listed.status).toBe(200);
  report = await cloud.report();
  expect(report.plane[1]).toEqual({
    lane: "claude",
    path: "/v1/models",
    named: PLAN.id,
    served: PLAN.id,
    status: 200,
  });
  expect(report.upstream[2]).toMatchObject({
    credentials: ["claudePlan"],
    standIn: false,
    runtimeToken: false,
  });
  expect(report.answersWithCanary).toEqual([]);
}, 60_000);

test("a sign-in in the computer refuses before its CLI is started, and ends one that was open", async () => {
  const stateDir = tempRoot("sign-in-refused-");
  let refuse: string | undefined;
  let spawned = 0;
  let killed = 0;
  const signIns = new SignInsHere({
    stateDir,
    logins: new FollowedLogins(),
    binaries: { claude: "claude", codex: "codex" },
    refusal: async () => refuse,
    spawn: async () => {
      spawned++;
      return {
        write: () => {},
        kill: () => void killed++,
        onData: (listener) =>
          void setTimeout(
            () => listener("Open https://claude.ai/oauth/authorize?code=true&client_id=x\n"),
            5,
          ),
        onExit: () => {},
      };
    },
  });
  expect((await signIns.start("claude-agent")).url).toContain("/oauth/authorize?");
  expect(spawned).toBe(1);
  refuse = OUTSIDE_CONNECT;
  await expect(signIns.start("claude-agent")).rejects.toThrow("Settings > Models & keys");
  await expect(signIns.submit("claude-agent", "code#state")).rejects.toThrow(
    "Settings > Models & keys",
  );
  // The one that was open is over, and its folder gone with whatever the CLI wrote there.
  expect([spawned, killed]).toEqual([1, 1]);
  expect(fs.readdirSync(path.join(stateDir, "sign-ins"))).toEqual([]);
});
