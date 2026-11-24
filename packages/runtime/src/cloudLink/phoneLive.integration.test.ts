// The phone's connection, end to end: the modules the phone app runs (apps/mobile/src/live: its Cloud client, its
// device key, its connection and its live source), on the phone's own WebCrypto (the noble libraries, forced on:
// phone.testkit.ts), against a real runtime (the harness, with the stand-in Claude) linked to the stand-in Cloud and
// its relay. The Mac's side runs on Node's WebCrypto, so every hello and sealed frame crosses the two implementations.
import { connect, deviceCode, type Client, type SessionEvent } from "@caveman-app/session-protocol";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { cloudAway, whyNotCloud } from "../../../../apps/mobile/src/live/away.ts";
import {
  phoneCloud,
  SignedOut,
  type Computer,
  type PhoneCloud,
} from "../../../../apps/mobile/src/live/cloud.ts";
import { computerStatus, UPDATES_ON_WAKE } from "../../../../apps/mobile/src/live/computers.ts";
import {
  openConnection,
  wakeComputer,
  type Connection,
  type Link,
} from "../../../../apps/mobile/src/live/connection.ts";
import { deviceKeyOnce, loadDeviceKey } from "../../../../apps/mobile/src/live/deviceKey.ts";
import {
  liveSource,
  type BoardChange,
  type LiveChat,
  type LiveSource,
} from "../../../../apps/mobile/src/live/source.ts";
import { isStarting, startChat } from "../../../../apps/mobile/src/live/start.ts";
import { pairingCodeOn, sayHello, testDevice } from "../session-protocol/devices.testkit.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { journalOf, logErrors, Trace, World, type RuntimeProc } from "./chaos/world.ts";
import { asPhone, asPhoneRtc, cryptoCalls, memorySecrets, splitCrypto } from "./phone.testkit.ts";
import { startTestCloud } from "./testCloud.ts";
import { startPhoneCloud } from "./testCloudPhone.ts";

let restoreCrypto: () => void;
beforeAll(() => {
  restoreCrypto = splitCrypto();
});
afterAll(() => restoreCrypto());

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A Mac with Remote control on, linked to the stand-in Cloud, with one chat; and what a phone reaches of that Cloud. */
async function world(name = "Studio") {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const front = await startPhoneCloud(cloud);
  cleanups.push(front.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name,
  });
  await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const repo = makeRepo(tempRoot("phone-repo-"), { "README.md": "hi\n" });
  const workspace = await createReady(local, {
    request_id: "w0",
    repo: { path: repo },
    title: "Fix the relay test",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  return { cloud, front, runtime, local, workspace, repo };
}

/** A phone: its Keychain, its Cloud client and its device key, as the app wires them (link.ts). */
function phone(front: { readonly url: string }, name = "iPhone") {
  const secrets = memorySecrets();
  const cloud = asPhone(() => phoneCloud({ url: front.url, secrets }));
  const device = deviceKeyOnce(() => asPhone(() => loadDeviceKey(secrets, name)));
  return { secrets, cloud, device };
}

/** Signs the phone in: the code its screen shows is approved on Cloud's page. */
async function signIn(cloud: PhoneCloud, front: { approve(code: string): boolean }) {
  const pending = await asPhone(() => cloud.signIn());
  expect(pending.user_code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  expect(front.approve(pending.user_code)).toBe(true);
  return pending.done;
}

const states = (connection: Connection) => {
  const seen: Array<Link> = [connection.state()];
  connection.subscribe((state) => seen.push(state));
  return seen;
};
const phaseIs = (connection: Connection, phase: Link["phase"]) =>
  until(() => connection.state().phase === phase, 20_000);

/** This Mac's own screen allows the device that waits. */
async function allow(local: Client, deviceId: string) {
  const request = (await local.call("device.list", {})).requests.find(
    (r) => r.device_id === deviceId,
  );
  expect(request).toBeDefined();
  await local.call("device.allow", {
    request_id: `allow-${deviceId}`,
    device_id: deviceId,
    role: request!.role ?? "device",
  });
}

test("a phone signs in, finds its person's Mac, waits for that Mac's Allow with its own code, and is served only after it", async () => {
  const { front, local, workspace, cloud } = await world();
  const { secrets, cloud: mine, device } = phone(front);

  // Signed out: nothing is listed, and nothing but the sign-in works.
  expect(await asPhone(() => mine.account())).toBeNull();
  await expect(asPhone(() => mine.computers())).rejects.toBeInstanceOf(SignedOut);
  expect(await signIn(mine, front)).toEqual({ email: "ada@example.com" });
  expect(await asPhone(() => mine.account())).toEqual({ email: "ada@example.com" });
  // The sign-in rests in the Keychain and nowhere else; the relay bearer is never kept.
  expect([...secrets.entries.keys()]).toEqual(["caveman.cloud.session"]);
  expect(secrets.entries.get("caveman.cloud.session")).not.toContain("cvdt_");

  const { computers } = await asPhone(() => mine.computers());
  expect(computers).toMatchObject([{ kind: "laptop", name: "Studio", online: true }]);
  const mac = computers[0]!;

  const before = { ...cryptoCalls };
  const connection = asPhone(() => openConnection({ computer: mac, cloud: mine, device }));
  cleanups.push(() => connection.close());
  const seen = states(connection);

  // The Mac asks its person. The phone shows its own key's code, the one the Mac's screen shows for the request.
  await phaseIs(connection, "waiting");
  const own = await device();
  const code = deviceCode(own.device_id);
  expect(connection.state()).toEqual({ phase: "waiting", code });
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{3}){3}$/);
  const listed = await local.call("device.list", {});
  expect(listed.requests).toMatchObject([{ device_id: own.device_id, name: "iPhone", code }]);
  expect(listed.devices).toEqual([]);
  // The key was made on the phone and is in its Keychain; Cloud saw none of it.
  expect([...secrets.entries.keys()].sort()).toEqual([
    "caveman.cloud.session",
    "caveman.device.key",
  ]);
  const kept = JSON.parse(secrets.entries.get("caveman.device.key")!) as { d: string; x: string };
  expect(kept.x).toBe(own.public_key.x);
  expect(JSON.stringify(front.state.seen)).not.toContain(kept.d);

  // Before the Mac's Allow nothing is served: a call waits, unanswered, and the runtime ran none of it.
  let answered = false;
  const waitingCall = connection.client
    .call("workspace.list", {})
    .then((out) => ((answered = true), out));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(answered).toBe(false);
  expect(connection.state().phase).toBe("waiting");

  await allow(local, own.device_id);
  await phaseIs(connection, "open");
  expect(connection.state()).toEqual({ phase: "open", path: "relay" });
  // Served now, sealed: the Mac's chats, as it lists them.
  const { workspaces } = await waitingCall;
  expect(workspaces.map((w) => w.id)).toEqual([workspace.id]);
  expect(workspaces[0]).toMatchObject({ title: "Fix the relay test", status: "idle" });
  expect(seen.map((s) => s.phase)).toEqual(["connecting", "waiting", "open"]);

  // The relay carried the hello in the clear and nothing after it: every later frame, each way, is a sealed one.
  const relay = cloud.state.relays[0]!;
  const fromMac = relay.frames.filter((f) => f.type === 2).map((f) => f.payload.toString("utf8"));
  const sealedFromMac = fromMac.filter((text) => text.startsWith('{"device_frame"'));
  expect(sealedFromMac.length).toBeGreaterThan(0);
  expect(fromMac.join("\n")).not.toContain("Fix the relay test");
  expect(
    fromMac
      .filter((text) => !text.startsWith('{"device_frame"'))
      .every((text) => /"device\.(challenge|status)"|"status":"(pending|approved)"/.test(text)),
  ).toBe(true);
  // The phone's crypto ran on the adapter, the Mac's on Node's: the two met over the wire.
  expect(cryptoCalls.phone).toBeGreaterThan(before.phone);
  expect(cryptoCalls.mac).toBeGreaterThan(before.mac);

  // A second connection of the same phone is let in at once: the Mac allows a device once.
  const again = asPhone(() => openConnection({ computer: mac, cloud: mine, device }));
  cleanups.push(() => again.close());
  const second = states(again);
  await phaseIs(again, "open");
  expect(second.map((s) => s.phase)).toEqual(["connecting", "open"]);
  expect((await local.call("device.list", {})).devices).toMatchObject([
    { device_id: own.device_id, name: "iPhone", connected: true },
  ]);
}, 120_000);

/** The board's chats under the source's changes, as the app's store applies them (store/board.ts), and every change in order. */
function board() {
  let chats: Array<LiveChat> = [];
  const changes: Array<BoardChange> = [];
  return {
    changes,
    chats: () => chats,
    chat: (id: string) => chats.find((c) => c.id === id),
    dispatch(change: BoardChange) {
      changes.push(change);
      if (change.type === "add") chats = [change.chat, ...chats];
      else if (change.type === "remove") chats = chats.filter((c) => c.id !== change.id);
      else
        chats = chats.map((c) => {
          if (c.id !== change.id) return c;
          const next = { ...c, ...change.patch };
          if (change.type === "update") for (const key of change.clear ?? []) delete next[key];
          return next;
        });
    },
  };
}

/** A phone signed in, allowed on the Mac and connected, with the live source over its connection. */
async function connected(w: Awaited<ReturnType<typeof world>>) {
  const mine = phone(w.front);
  await signIn(mine.cloud, w.front);
  const mac = (await asPhone(() => mine.cloud.computers())).computers[0]!;
  const connection = asPhone(() =>
    openConnection({ computer: mac, cloud: mine.cloud, device: mine.device }),
  );
  cleanups.push(() => connection.close());
  await phaseIs(connection, "waiting");
  await allow(w.local, (await mine.device()).device_id);
  await phaseIs(connection, "open");
  const errors: Array<string> = [];
  const shown = board();
  const source = asPhone(() =>
    liveSource({
      client: connection.client,
      board: shown,
      device: `live:${mac.runtime_id}`,
      onError: (message) => errors.push(message),
    }),
  );
  cleanups.push(() => source.close());
  return { ...mine, mac, connection, source, shown, errors };
}

const idle = (local: Client, workspaceId: string) =>
  until(
    async () =>
      (await local.call("workspace.get", { workspace_id: workspaceId })).status === "idle",
    30_000,
  );
const texts = (chat: LiveChat | undefined) =>
  (chat?.items ?? []).flatMap((item) =>
    item.kind === "text" || item.kind === "you" ? [`${item.kind}: ${item.text}`] : [],
  );

test("the Mac's chats show on the phone, a turn reaches it as it happens, and a message sent from the phone is answered", async () => {
  const w = await world();
  const { local, workspace } = w;
  // A turn made on the Mac before the phone came: history.
  await local.call("turn.submit", {
    request_id: "t0",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "say: The relay test is fixed." },
  });
  await idle(local, workspace.id);

  const { source, shown, errors, mac } = await connected(w);
  await asPhone(() => source.sync());
  // The chat list: the Mac's chat, by its title and project, at rest. Its transcript is not read until it is opened.
  expect(shown.chats()).toMatchObject([
    {
      id: workspace.id,
      title: "Fix the relay test",
      device: `live:${mac.runtime_id}`,
      engine: "claude",
      phase: "done",
      line: "Done",
      chief: null,
      items: [],
    },
  ]);
  expect(shown.chats()[0]!.repo).toMatch(/^repo-/);
  expect(source.owns(workspace.id)).toBe(true);
  expect(source.owns("ask-1")).toBe(false);

  asPhone(() => source.open(workspace.id));
  await until(() => texts(shown.chat(workspace.id)).length === 2);
  expect(texts(shown.chat(workspace.id))).toEqual([
    "you: say: The relay test is fixed.",
    "text: The relay test is fixed.",
  ]);
  expect(shown.chat(workspace.id)!.model).toBe(MODEL);

  // A turn the Mac's own screen starts reaches the phone as it happens: its answer, then its tool calls gathering into
  // one work group, then its closing words, each on the board before the turn is over. (The stand-in engine's replies
  // reach every client whole, the Mac's own too; words arriving one piece at a time are transcript.test.ts's.)
  const before = shown.changes.length;
  const ANSWER =
    "All five checks pass on the relay now. The flake was the reconnect timer firing twice when the socket closed during the handshake.";
  await local.call("turn.submit", {
    request_id: "t1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: `chief-shape: ${ANSWER}` },
  });
  await until(() => shown.chat(workspace.id)?.phase === "working");
  await idle(local, workspace.id);
  await until(() => shown.chat(workspace.id)?.phase === "done");
  // What the board showed last at each change while the turn ran, runs of the same thing as one.
  const lastShown = shown.changes.slice(before).flatMap((change) => {
    const last =
      change.type === "live" || change.type === "update" ? change.patch.items?.at(-1) : undefined;
    return last === undefined
      ? []
      : [
          last.kind === "text"
            ? `text: ${last.text}`
            : last.kind === "work"
              ? `work: ${last.steps.length}`
              : last.kind,
        ];
  });
  // From the message that started the turn on (the chat's change to "working" can come ahead of it).
  const all = lastShown.filter((stage, i) => stage !== lastShown[i - 1]);
  const stages = all.slice(all.indexOf("you"));
  expect(stages[0]).toBe("you");
  expect(stages[1]).toBe(`text: ${ANSWER}`);
  expect(stages.at(-1)).toBe("text: All set. Let me know what you'd like to work on.");
  // Between the two, the work group, growing to its three calls.
  const working = stages.slice(2, -1);
  expect(working.length).toBeGreaterThan(0);
  expect(working.every((stage) => /^work: [123]$/.test(stage))).toBe(true);
  expect(working.at(-1)).toBe("work: 3");
  const after = shown.chat(workspace.id)!;
  const work = after.items.filter((item) => item.kind === "work");
  // One work group, the turn's three calls, closed. (The chat's worktree being made is not shown as work.)
  expect(work).toMatchObject([
    {
      kind: "work",
      steps: [
        { tool: "run", text: "echo item 1" },
        { tool: "run", text: "echo item 2" },
        { tool: "run", text: "echo item 3" },
      ],
    },
  ]);
  expect((work[0] as { endedAt?: number }).endedAt).toBeTypeOf("number");
  expect(after.items.at(-1)?.kind).toBe("text");
  expect(after.line).toBe("Done");

  // A message from the phone: on screen at once ("Sending"), the chat at work, then the runtime's answer.
  const beforeSend = shown.changes.length;
  asPhone(() => source.send(workspace.id, "say: Sent from the phone."));
  await until(
    () =>
      shown
        .chat(workspace.id)
        ?.items.some((item) => item.kind === "you" && item.text === "say: Sent from the phone.") ===
      true,
  );
  // The first the board heard of it: the message, still sending, and the chat at work, before the runtime had answered.
  const first = shown.changes
    .slice(beforeSend)
    .find((change) => change.type === "update" && change.patch.items?.at(-1)?.kind === "you");
  expect(first).toMatchObject({ type: "update", patch: { phase: "working" } });
  expect(first?.type === "update" ? first.patch.items?.at(-1) : undefined).toMatchObject({
    kind: "you",
    text: "say: Sent from the phone.",
    state: "sending",
  });
  await until(() => texts(shown.chat(workspace.id)).at(-1) === "text: Sent from the phone.");
  await until(() => shown.chat(workspace.id)?.phase === "done");
  const sent = shown
    .chat(workspace.id)!
    .items.filter((item) => item.kind === "you" && item.text === "say: Sent from the phone.");
  // Once: the runtime's own event took the echo's place.
  expect(sent).toMatchObject([{ kind: "you", state: "sent" }]);
  expect((await local.call("workspace.get", { workspace_id: workspace.id })).status).toBe("idle");

  // It asks before it runs a command: the phone shows what it wants to run, Allow lets it, and it goes on.
  asPhone(() => source.send(workspace.id, "ask: run the migration"));
  await until(() => shown.chat(workspace.id)?.phase === "needs");
  await until(
    () =>
      shown.chat(workspace.id)?.need !== undefined &&
      shown.chat(workspace.id)!.items.some((item) => item.kind === "ask"),
  );
  const asking = shown.chat(workspace.id)!;
  expect(asking.need).toMatchObject({ kind: "approval" });
  expect(asking.ask).toBe((asking.need as { command: string }).command);
  expect(asking.line).toBe(asking.ask);
  expect(await asPhone(() => source.respond(workspace.id, { kind: "allow" }))).toBe(true);
  await until(() => shown.chat(workspace.id)?.phase === "done");
  expect(shown.chat(workspace.id)!.items.findLast((item) => item.kind === "ask")).toMatchObject({
    answer: "allowed",
  });
  expect(shown.chat(workspace.id)!.need).toBeUndefined();
  expect(shown.chat(workspace.id)!.ask).toBeUndefined();

  // And Deny refuses it.
  asPhone(() => source.send(workspace.id, "ask: drop the table"));
  await until(
    () =>
      shown.chat(workspace.id)?.phase === "needs" && shown.chat(workspace.id)!.need !== undefined,
  );
  expect(await asPhone(() => source.respond(workspace.id, { kind: "deny" }))).toBe(true);
  await until(() => shown.chat(workspace.id)?.phase === "done");
  expect(shown.chat(workspace.id)!.items.findLast((item) => item.kind === "ask")).toMatchObject({
    answer: "denied",
  });
  // With nothing asked, there is nothing to answer.
  expect(await asPhone(() => source.respond(workspace.id, { kind: "allow" }))).toBe(false);

  // Stop ends a turn that is running, and the chat says so.
  asPhone(() => source.send(workspace.id, "slow 20000: wait for me"));
  await until(
    () =>
      shown.chat(workspace.id)?.phase === "working" &&
      texts(shown.chat(workspace.id)).at(-1)?.startsWith("text: smoke ok") === true,
  );
  asPhone(() => source.stop(workspace.id));
  await until(() => shown.chat(workspace.id)?.phase === "done");
  expect(shown.chat(workspace.id)!.items.at(-1)).toMatchObject({ kind: "stop" });
  expect(shown.chat(workspace.id)!.line).toBe("Stopped");

  // A chat started on the Mac appears on the phone by itself, and one archived there leaves.
  const second = await createReady(local, {
    request_id: "w1",
    repo: { path: w.repo },
    title: "Second chat",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  // Local startup can finish before the phone receives its idle update over the relay.
  await until(() => shown.chat(second.id)?.phase === "done");
  expect(shown.chat(second.id)).toMatchObject({ title: "Second chat", phase: "done" });
  await local.call("workspace.archive", { request_id: "a1", workspace_id: second.id });
  await until(() => shown.chat(second.id) === undefined);
  expect(errors).toEqual([]);
}, 240_000);

const reasonIn = (reply: { error?: unknown }) =>
  (reply.error as { data?: { reason?: string } } | undefined)?.data?.reason;
const SEALED = '{"device_frame"';

test("the code on the phone is its own key's: allowing a request that shows another code does not let the phone in, forged hellos are refused, and the Mac's Don't allow ends it", async () => {
  const w = await world();
  const mine = phone(w.front);
  await signIn(mine.cloud, w.front);
  const mac = (await asPhone(() => mine.cloud.computers())).computers[0]!;
  const connection = asPhone(() =>
    openConnection({ computer: mac, cloud: mine.cloud, device: mine.device }),
  );
  cleanups.push(() => connection.close());
  await phaseIs(connection, "waiting");
  const own = await mine.device();
  const shown = deviceCode(own.device_id);
  expect(connection.state()).toEqual({ phase: "waiting", code: shown });

  // A relay that puts a key of its own forward as the phone asks, under the phone's name.
  const relay = w.cloud.state.relays[0]!;
  const mallory = await testDevice("iPhone");
  expect((await sayHello(relay, relay.open(), mallory)).reply.result).toMatchObject({
    status: "pending",
  });
  const { requests } = await w.local.call("device.list", {});
  expect(requests.map((r) => r.name)).toEqual(["iPhone", "iPhone"]);
  // Two requests by one name. Only the phone's own shows the code on the phone's screen: the other's cannot match it.
  expect(requests.filter((r) => r.code === shown).map((r) => r.device_id)).toEqual([own.device_id]);
  // The person allows the one whose code does not match, the mistake the code is there to stop. The phone is not let
  // in by it: its own key is still waiting, and nothing it asks is answered.
  await allow(w.local, mallory.device_id);
  let answered = false;
  connection.client.call("workspace.list", {}).then(
    () => (answered = true),
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(connection.state()).toEqual({ phase: "waiting", code: shown });
  expect(answered).toBe(false);

  // Hellos the Mac must refuse, made with the phone's own crypto. Signed for another runtime (Cloud passing one Mac's
  // challenge to another):
  const forger = await asPhone(() => testDevice("iPad"));
  expect(
    reasonIn(
      (
        await asPhone(() =>
          sayHello(relay, relay.open(), forger, {
            runtimeId: "00000000-0000-4000-8000-000000000000",
          }),
        )
      ).reply,
    ),
  ).toBe("device_not_approved");
  // the allowed key's id, claimed by another key:
  expect(
    reasonIn(
      (await asPhone(() => sayHello(relay, relay.open(), forger, { deviceId: mallory.device_id })))
        .reply,
    ),
  ).toBe("device_not_approved");
  // and a pairing proof that was not made from the code on the Mac's screen: a guess, then the wrong code typed.
  await pairingCodeOn(w.local);
  const notThisMac = await asPhone(() => testDevice("Not this person's Mac", "mac"));
  expect(
    reasonIn(
      (await asPhone(() => sayHello(relay, relay.open(), notThisMac, { proof: "A".repeat(43) })))
        .reply,
    ),
  ).toBe("invalid_params");
  const code = await pairingCodeOn(w.local);
  expect(
    reasonIn(
      (
        await asPhone(() =>
          sayHello(relay, relay.open(), notThisMac, {
            pair: code === "0000-0000-0000" ? "1111-1111-1111" : "0000-0000-0000",
          }),
        )
      ).reply,
    ),
  ).toBe("invalid_params");
  // None of them became a device, or a request.
  const after = await w.local.call("device.list", {});
  expect(after.devices.map((d) => d.device_id)).toEqual([mallory.device_id]);
  expect(after.requests.map((r) => r.device_id)).toEqual([own.device_id]);

  // Don't allow, on the Mac: the phone says so, with its code, and stops asking.
  await w.local.call("device.remove", { request_id: "no-1", device_id: own.device_id });
  await phaseIs(connection, "refused");
  expect(connection.state()).toEqual({ phase: "refused", code: shown });
  const attaches = w.front.state.attaches.length;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(w.front.state.attaches.length).toBe(attaches);
  expect(answered).toBe(false);
  // Asked again from the phone, the Mac refuses at once without asking its person: the phone is blocked there.
  const again = asPhone(() =>
    openConnection({ computer: mac, cloud: mine.cloud, device: mine.device }),
  );
  cleanups.push(() => again.close());
  await phaseIs(again, "refused");
  expect((await w.local.call("device.list", {})).requests).toEqual([]);
}, 180_000);

test("a relay that changes, replays or forges a frame gets nothing: the phone drops the link and comes back clean, the Mac closes on a replay, and a removed phone is cut off", async () => {
  const w = await world();
  const { connection, source, shown, device } = await connected(w);
  const seen = states(connection);
  const drops = () => seen.filter((state) => state.phase === "connecting" && state.again).length;
  const backOpen = async (count: number) => {
    await until(() => drops() === count, 20_000);
    await phaseIs(connection, "open");
  };
  await asPhone(() => source.sync());
  asPhone(() => source.open(w.workspace.id));

  // Changed: one sealed frame to the phone with a character of its ciphertext swapped. It does not open, so the phone
  // ends that socket, reading nothing of it, and connects again; the call it made is answered on the new one.
  let changed = 0;
  w.front.relayed.tamper = (text) => {
    if (changed > 0 || !text.startsWith(SEALED)) return text;
    changed += 1;
    const frame = JSON.parse(text) as { device_frame: { seq: number; ct: string } };
    const ct = frame.device_frame.ct;
    return JSON.stringify({
      device_frame: {
        ...frame.device_frame,
        ct: `${ct.slice(0, 20)}${ct[20] === "A" ? "B" : "A"}${ct.slice(21)}`,
      },
    });
  };
  const list = asPhone(() => connection.client.call("workspace.list", {}));
  await backOpen(1);
  expect(changed).toBe(1);
  expect((await list).workspaces.map((each) => each.id)).toEqual([w.workspace.id]);
  w.front.relayed.tamper = undefined;

  // Replayed: a sealed frame the Mac did send on this socket, sent to the phone a second time. Its place has passed.
  await asPhone(() => connection.client.call("workspace.list", {}));
  const sealedToPhone = w.front.relayed.frames.findLast(
    (frame) => frame.to === "phone" && frame.text.startsWith(SEALED),
  )!;
  w.front.relayed.toPhone(sealedToPhone.text);
  await backOpen(2);

  // Forged: a plain frame of the relay's own, naming a chat the Mac does not have. An approved link takes sealed
  // frames only, so nothing of it reaches the board.
  w.front.relayed.toPhone(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: {
        ...w.workspace,
        id: "ws-forged",
        session_id: "ses-forged",
        title: "Forged by the relay",
      },
    }),
  );
  await backOpen(3);
  expect(shown.chats().map((chat) => chat.title)).toEqual(["Fix the relay test"]);

  // Toward the Mac: the phone's sealed message, sent a second time by the relay. The Mac closes the stream on it,
  // and the message is in the chat once.
  const sentBefore = w.front.relayed.frames.length;
  asPhone(() => source.send(w.workspace.id, "say: Said once."));
  await until(() => texts(shown.chat(w.workspace.id)).at(-1) === "text: Said once.");
  await until(() => shown.chat(w.workspace.id)?.phase === "done");
  const submit = w.front.relayed.frames
    .slice(sentBefore)
    .find((frame) => frame.to === "mac" && frame.text.startsWith(SEALED))!;
  expect(w.front.relayed.closedByMac()).toBe(false);
  w.front.relayed.toMac(submit.text);
  await until(() => w.front.relayed.closedByMac(), 20_000);
  await backOpen(4);
  await idle(w.local, w.workspace.id);
  expect(
    texts(shown.chat(w.workspace.id)).filter((text) => text === "you: say: Said once."),
  ).toHaveLength(1);
  // The link is whole again after each: the Mac still answers this phone.
  expect(
    (await asPhone(() => connection.client.call("workspace.list", {}))).workspaces,
  ).toHaveLength(1);

  // Removed on the Mac: its open connection ends at once, and the phone says it is not allowed.
  await w.local.call("device.remove", {
    request_id: "rm-1",
    device_id: (await device()).device_id,
  });
  await phaseIs(connection, "refused");
  expect((await w.local.call("device.list", {})).devices).toEqual([]);
}, 240_000);

test("what the phone says while a computer is away or its sign-in runs out: an old bearer is renewed unseen, a Mac out of reach comes back by itself, a Cloud computer is woken, and a revoked sign-in ends it", async () => {
  const w = await world();
  const { connection, cloud: mine, device, secrets } = await connected(w);
  const seen = states(connection);

  // An hour on, the relay stops taking the bearer and closes (4401), and the sign-in's access token is long past its
  // fifteen minutes. The phone refreshes the sign-in (the next one kept in the Keychain), mints another bearer from it
  // and is back by itself; the Mac knows its key and does not ask again.
  const minted = w.front.state.bearers.size;
  const session = secrets.entries.get("caveman.cloud.session");
  w.front.lapseAccess();
  w.front.lapseBearers();
  await until(() => seen.some((state) => state.phase === "connecting" && state.again), 20_000);
  await phaseIs(connection, "open");
  expect(w.front.state.bearers.size).toBe(minted + 1);
  expect(secrets.entries.get("caveman.cloud.session")).not.toBe(session);
  expect(secrets.entries.get("caveman.cloud.session")).not.toContain("cvdt_");
  expect((await w.local.call("device.list", {})).requests).toEqual([]);
  expect((await asPhone(() => mine.computers())).computers).toMatchObject([{ name: "Studio" }]);

  // The Mac goes out of the relay's reach (Remote control off there; asleep or shut reads the same): the phone says
  // so, keeps trying, and is back by itself when the Mac is.
  await w.local.call("settings.set", { request_id: "rc-off", settings: { remote_control: false } });
  await phaseIs(connection, "asleep");
  await w.local.call("settings.set", { request_id: "rc-on-2", settings: { remote_control: true } });
  await phaseIs(connection, "open");
  expect(
    (await asPhone(() => connection.client.call("workspace.list", {}))).workspaces,
  ).toHaveLength(1);

  // A Cloud computer that is not running: the phone says it is waking, and asks Cloud to wake it, once.
  w.cloud.enrollRuntime({ kind: "cloud", name: "Cloud computer" });
  const { computers } = await asPhone(() => mine.computers());
  expect(computers.map((c) => [c.kind, c.name])).toEqual([
    ["laptop", "Studio"],
    ["cloud", "Cloud computer"],
  ]);
  const box = computers[1]!;
  const toCloud = asPhone(() => openConnection({ computer: box, cloud: mine, device }));
  cleanups.push(() => toCloud.close());
  const towardCloud = states(toCloud);
  await phaseIs(toCloud, "waking");
  await until(() => w.front.state.wakes.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(w.front.state.wakes).toEqual([box.computer_id]);
  // The relay took each socket before saying the computer was away. That never read as connected.
  expect(
    w.front.state.attaches.filter(
      (attach) => attach.runtime_id === box.runtime_id && attach.outcome === "4404",
    ).length,
  ).toBeGreaterThan(0);
  // Cloud says the machine runs, so the wait says it is up and linking: still waking, in more words.
  expect(towardCloud).toEqual([
    { phase: "connecting", again: false },
    { phase: "waking" },
    { phase: "waking", step: "up" },
  ]);
  toCloud.close();

  // That computer stops and wakes under a new runtime id (Cloud mints one at every wake, and refuses the old one once
  // the computer has stopped). The phone finds the computer again by its computer id and is handed the runtime it
  // runs as now: never "No longer one of your computers", and nothing for the person to tap.
  const woke: Array<{
    readonly runtime_id: string;
    readonly computer_id: string;
    readonly kind: string;
  }> = [];
  const follows = asPhone(() =>
    openConnection({ computer: box, cloud: mine, device, onWoke: (next) => woke.push(next) }),
  );
  cleanups.push(() => follows.close());
  const following = states(follows);
  await phaseIs(follows, "waking");
  w.cloud.state.runtimes.get(box.runtime_id)!.status = "revoked";
  // Refused and not up again yet: it reads as waking, and the computer is asked to wake, not called gone.
  await until(
    () =>
      w.front.state.attaches.some(
        (attach) => attach.runtime_id === box.runtime_id && attach.outcome !== "4404",
      ),
    20_000,
  );
  expect(woke).toEqual([]);
  expect(follows.state().phase).toBe("waking");
  const wokeAs = w.cloud.enrollRuntime({
    kind: "cloud",
    name: "Cloud computer",
    computerId: box.computer_id,
  });
  await until(() => woke.length === 1, 30_000);
  expect(woke[0]).toMatchObject({
    runtime_id: wokeAs.runtimeId,
    computer_id: box.computer_id,
    kind: "cloud",
  });
  expect(following.map((state) => state.phase)).not.toContain("gone");
  // The connection to the old id has ended: nothing more is tried on it.
  const tried = w.front.state.attaches.filter(
    (attach) => attach.runtime_id === box.runtime_id,
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(
    w.front.state.attaches.filter((attach) => attach.runtime_id === box.runtime_id).length,
  ).toBe(tried);

  // Signed out of Caveman from elsewhere (or the month ran out): the connection ends there, the sign-in leaves the
  // Keychain, and nothing is tried again. The phone's key stays: signing in again does not ask the Mac again.
  const attaches = () => w.front.state.attaches.length;
  w.front.revoke();
  await phaseIs(connection, "signed-out");
  expect(await asPhone(() => mine.account())).toBeNull();
  expect([...secrets.entries.keys()]).toEqual(["caveman.device.key"]);
  const settled = attaches();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(attaches()).toBe(settled);
  await signIn(mine, w.front);
  const back = asPhone(() => openConnection({ computer: computers[0]!, cloud: mine, device }));
  cleanups.push(() => back.close());
  const again = states(back);
  await phaseIs(back, "open");
  expect(again.map((state) => state.phase)).toEqual(["connecting", "open"]);
}, 240_000);

test("given a WebRTC implementation, the same connection moves to the direct path by itself, sealed under the same handshake", async () => {
  const w = await world();
  const mine = phone(w.front);
  await signIn(mine.cloud, w.front);
  // What the install says of direct channels arrives with the computers (Cloud's list).
  w.front.state.direct = { enabled: true, stun_servers: [] };
  const listed = await asPhone(() => mine.cloud.computers());
  expect(listed.direct).toEqual({ enabled: true, stun_servers: [] });
  const mac = listed.computers[0]!;
  // A phone's JavaScript engine has no RTCPeerConnection; a native WebRTC module would hand one in here. Node's stands
  // in for it. Nothing else about the connection changes.
  const rtc = asPhoneRtc(RTCPeerConnection as never);
  const connection = asPhone(() =>
    openConnection({
      computer: mac,
      cloud: mine.cloud,
      device: mine.device,
      direct: { advert: () => listed.direct, rtc, network: () => () => undefined },
    }),
  );
  cleanups.push(() => connection.close());
  const seen = states(connection);
  await phaseIs(connection, "waiting");
  await allow(w.local, (await mine.device()).device_id);
  await until(
    () => connection.state().phase === "open" && connection.client.path() === "direct",
    30_000,
  );
  expect(
    seen.map((state) => (state.phase === "open" ? `open:${state.path}` : state.phase)),
  ).toEqual(["connecting", "waiting", "open:relay", "open:direct"]);
  // Served on it: the relay carries none of these calls.
  const carried = w.front.relayed.frames.length;
  for (let i = 0; i < 5; i++)
    expect(
      (await asPhone(() => connection.client.call("workspace.list", {}))).workspaces,
    ).toHaveLength(1);
  expect(w.front.relayed.frames.length).toBe(carried);

  // Where the install turns direct channels off, the phone stays on the relay even with an implementation at hand.
  const off = asPhone(() =>
    openConnection({
      computer: mac,
      cloud: mine.cloud,
      device: mine.device,
      direct: {
        advert: () => ({ enabled: false, stun_servers: [] }),
        rtc,
        network: () => () => undefined,
      },
    }),
  );
  cleanups.push(() => off.close());
  await phaseIs(off, "open");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(off.state()).toEqual({ phase: "open", path: "relay" });
}, 180_000);

// ---------------------------------------------------------------- every computer, from the phone
//
// The phone's own modules again (its Cloud client, the wait for a sleeping computer, its connection, its live source
// and what it does through Cloud while a computer is away), against real runtime processes: a Mac and two Cloud
// computers of the chaos harness (chaos/world.ts), each the real runtime on the real Claude Agent adapter and the
// no-model CLI, linked to the stand-in Cloud, with the phone's side of that Cloud in front (testCloudPhone.ts). The
// test plays the computers service: it stops a Cloud computer as boat stops one, and starts it again under a new
// runtime id when Cloud's row says it should run.

/** A Cloud computer asleep as on boat: its runtime ends cleanly, and the visit that sees it stopped ends its key (CONTRACT §5.3). */
async function sleepBox(world: World, box: RuntimeProc) {
  await world.stopComputer(box);
  world.cloud.state.runtimes.get(box.runtimeId)!.status = "revoked";
  for (const [token, record] of world.cloud.state.tokens)
    if (record.runtimeId === box.runtimeId) world.cloud.state.tokens.delete(token);
}

/**
 * A chat started from the phone as the app starts it (apps/mobile/src/live/start.ts, wired as link.ts wires it): its
 * placeholder is on the board at once with the message in it, and the computer's own chat takes its place. Answers
 * that chat's id.
 */
async function startFromPhone(
  cloud: Pick<PhoneCloud, "startInCloud">,
  shown: ReturnType<typeof board>,
  request: Parameters<typeof startChat>[0],
  sourceOf: (computerId: string) => Pick<LiveSource, "start">,
) {
  const done: Array<string> = [];
  const failed: Array<string> = [];
  const placeholder = asPhone(() =>
    startChat(request, {
      board: shown,
      device: (computerId) => `live:${computerId ?? "cloud"}`,
      startInCloud: (input) => cloud.startInCloud(input),
      reach: async (computerId) => sourceOf(computerId),
      onStarted: (_placeholder, real) => done.push(real),
      onFailed: (_placeholder, _text, why) => failed.push(why),
    }),
  );
  expect(isStarting(placeholder)).toBe(true);
  expect(shown.chat(placeholder)).toMatchObject({
    title: request.title,
    phase: "working",
    items: [{ kind: "you", text: request.text, state: "sending" }],
  });
  await until(() => done.length + failed.length > 0, 60_000);
  expect(failed).toEqual([]);
  shown.dispatch({ type: "remove", id: placeholder });
  return done[0]!;
}
const userSaid = (events: ReadonlyArray<SessionEvent>, text: string) =>
  events.filter(
    (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
  );
const lastText = (chat: LiveChat | undefined) =>
  texts(chat)
    .filter((line) => line.startsWith("text: ") && line !== "text: ")
    .at(-1);

test.skipIf(process.platform === "win32")(
  "from the phone: every computer is listed whatever its state, a sleeping Cloud computer is woken and followed to the runtime it wakes as, a chat starts in Cloud and on the Mac, a message sent to a sleeping computer waits in Cloud and is answered, and with the Mac's runtime stopped its chat runs in Cloud, held by one place throughout",
  async () => {
    const trace = new Trace();
    const world = new World({ trace });
    cleanups.push(() => world.close());
    try {
      await world.start();
      const { cloud, mac, boxA, boxB } = world;
      const front = await startPhoneCloud(cloud);
      cleanups.push(front.close);
      const mine = phone(front);
      await signIn(mine.cloud, front);
      // Each computer has a model its new chats start on, as a real one does once its engine is set up (the stand-in
      // claude lists none of its own): a chat started from the phone with no model of the computer's picked runs on it.
      for (const rt of [mac, boxA])
        await rt.call("settings.set", {
          request_id: `default-model-${rt.name}`,
          settings: { engines: { "claude-agent": { model: MODEL } } },
        });
      /** The phone's connection to a computer with its live source over it, wired as the app wires them (link.ts). */
      const reach = (
        computer: Computer,
        shown: ReturnType<typeof board>,
        onWoke?: (next: Computer) => void,
      ) => {
        const connection = asPhone(() =>
          openConnection({
            computer,
            cloud: mine.cloud,
            device: mine.device,
            ...(onWoke ? { onWoke } : {}),
          }),
        );
        const errors: Array<string> = [];
        const source = asPhone(() =>
          liveSource({
            client: connection.client,
            board: shown,
            device: `live:${computer.computer_id}`,
            computer,
            reachable: () => connection.state().phase === "open",
            away: cloudAway(mine.cloud, mine.device),
            onError: (message) => errors.push(message),
          }),
        );
        cleanups.push(() => (source.close(), connection.close()));
        return { connection, source, errors };
      };

      // ---- Every computer is on the list, whatever its state.
      await sleepBox(world, boxA);
      const lostAt = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
      Object.assign(cloud.state.chats.computers.get(boxA.computerId)!, {
        disk_lost_at: lostAt,
        disk_lost_reason: "the volume was gone",
      });
      cloud.state.minRuntimeVersion = "999.0.0";
      const listed = await asPhone(() => mine.cloud.computers());
      cloud.state.minRuntimeVersion = "";
      expect(listed.cloud).toBe(true);
      expect(listed.computers.map((c) => [c.kind, c.name, c.online, c.runtime_id])).toEqual([
        ["laptop", "mac", true, mac.runtimeId],
        ["cloud", "box-a", false, ""],
        ["cloud", "box-b", true, boxB.runtimeId],
      ]);
      const [onMac, asleep, awake] = listed.computers as [Computer, Computer, Computer];
      expect(asleep).toMatchObject({
        computer_id: boxA.computerId,
        state: "suspended",
        row: { desired_state: "suspended", observed_state: "suspended", disk_lost_at: lostAt },
      });
      expect(computerStatus(onMac)).toMatchObject({ state: "online", label: "Online", notes: [] });
      expect(computerStatus(asleep)).toMatchObject({ state: "asleep", label: "Asleep" });
      expect(computerStatus(asleep).notes).toHaveLength(1);
      expect(computerStatus(asleep).notes[0]).toMatch(
        /^Caveman lost this computer's disk on [A-Z][a-z]{2} \d+\. Its chats continued from their last copy\.$/,
      );
      expect(computerStatus(awake)).toMatchObject({
        state: "online",
        label: "Running",
        notes: [UPDATES_ON_WAKE],
      });
      // The chat list names runtimes, and a sleeping Cloud computer has none: a Cloud that keeps its computers' rows from
      // the sign-in (before Caveman Cloud the spec) lists the phone only what runs, and starts no chat in Cloud for it.
      const older = await startPhoneCloud(cloud, { computersRoute: false });
      cleanups.push(older.close);
      const before0165 = phone(older, "Old iPhone");
      await signIn(before0165.cloud, older);
      const byRuntimes = await asPhone(() => before0165.cloud.computers());
      expect(byRuntimes.cloud).toBe(false);
      expect(byRuntimes.computers.map((c) => [c.name, c.row])).toEqual([
        ["mac", undefined],
        ["box-b", undefined],
      ]);
      await expect(
        asPhone(() =>
          before0165.cloud.startInCloud({ title: "x", repo: "acme/chaos", engine: "claude-agent" }),
        ),
      ).rejects.toThrow("does not start Cloud chats from a phone yet");

      // ---- Tapping the sleeping computer wakes it and connects, by its computer id.
      // Where nothing pays for its time Cloud will not wake it: the wait ends with Cloud's own sentence, and asks no more.
      front.state.refuseWakes = {
        status: 402,
        code: "cave_code_credits_exhausted",
        message: "Your plan's usage is used up. It resets on Monday.",
      };
      const refused = asPhone(() =>
        wakeComputer({ computer: asleep, cloud: mine.cloud, onWoke: () => undefined, every: 100 }),
      );
      cleanups.push(() => refused.close());
      await until(() => refused.state().phase === "held");
      expect(refused.state()).toEqual({
        phase: "held",
        reason: "Your plan's usage is used up. It resets on Monday.",
      });
      front.state.refuseWakes = undefined;
      expect(front.state.wakes).toEqual([]);

      const woke: Array<Computer> = [];
      const waking = asPhone(() =>
        wakeComputer({
          computer: asleep,
          cloud: mine.cloud,
          onWoke: (next) => woke.push(next),
          every: 100,
        }),
      );
      cleanups.push(() => waking.close());
      const said: Array<Link> = [waking.state()];
      waking.subscribe((state) => said.push(state));
      // Cloud was asked, and says the computer is starting. Nothing has woken yet: the phone waits, saying so.
      await until(() =>
        said.some((state) => state.phase === "waking" && state.step === "starting"),
      );
      expect(front.state.wakes).toEqual([boxA.computerId]);
      expect(cloud.state.chats.computers.get(boxA.computerId)!.state).toBe("starting");
      expect(woke).toEqual([]);
      // The computers service starts it: the same computer and disk under a new runtime id. The phone is handed that runtime.
      const firstId = boxA.runtimeId;
      const secondId = await world.wakeUnderNewIdentity(boxA);
      await until(() => woke.length === 1, 30_000);
      expect(secondId).not.toBe(firstId);
      expect(woke[0]).toMatchObject({
        computer_id: boxA.computerId,
        runtime_id: secondId,
        kind: "cloud",
        online: true,
      });
      expect(said).toEqual([
        { phase: "waking" },
        { phase: "waking", step: "starting" },
        { phase: "waking", step: "up" },
      ]);
      // Asked once: the wait never floods Cloud with hints.
      expect(front.state.wakes).toEqual([boxA.computerId]);

      // A Cloud computer asks nobody's Allow: the phone is connected to the runtime it woke as, and reads its chats.
      const shown = board();
      const followed: Array<Computer> = [];
      let box = reach(woke[0]!, shown, (next) => followed.push(next));
      await phaseIs(box.connection, "open");
      await asPhone(() => box.source.sync());
      expect(shown.chats()).toEqual([]);

      // ---- A chat started from the phone in Cloud: Cloud places it (the project's computer, never a machine the
      // person picked), and on that computer its first message is its first turn.
      // Started as the app starts it (start.ts): on the board from the tap, Cloud asked for the computer, then the chat
      // made on the computer Cloud named. No model the computer lists was picked, so it runs on the computer's own.
      const cloudChat = await startFromPhone(
        mine.cloud,
        shown,
        {
          text: "say: Started in Cloud from the phone.",
          title: "Cloud chat",
          project: { name: "chaos", github: "acme/chaos" },
          engine: "claude",
          model: "claude-sonnet-5-5",
          on: { kind: "cloud" },
        },
        (computerId) => {
          expect(computerId).toBe(boxA.computerId);
          return box.source;
        },
      );
      expect(front.state.workspaces).toMatchObject([
        {
          repo: "acme/chaos",
          engine: "claude-agent",
          title: "Cloud chat",
          created_by: "user-1",
          computer_id: boxA.computerId,
        },
      ]);
      await until(
        () => lastText(shown.chat(cloudChat)) === "text: Started in Cloud from the phone.",
        60_000,
      );
      await until(() => shown.chat(cloudChat)?.phase === "done", 30_000);
      expect(shown.chat(cloudChat)!.model).toBe(MODEL);
      expect(texts(shown.chat(cloudChat))).toEqual([
        "you: say: Started in Cloud from the phone.",
        "text: Started in Cloud from the phone.",
      ]);
      expect(shown.chat(cloudChat)).toMatchObject({
        title: "Cloud chat",
        repo: "chaos",
        device: `live:${boxA.computerId}`,
        engine: "claude",
      });
      const cloudSession = box.source.sessionOf(cloudChat)!;
      await until(() => cloud.state.chats.copyOf(cloudSession).length > 0, 60_000);

      // ---- A message sent while its computer sleeps waits in Cloud, shows as sent, and is answered once it wakes.
      await sleepBox(world, boxA);
      await phaseIs(box.connection, "waking");
      asPhone(() => box.source.send(cloudChat, "say: Sent while it slept."));
      await until(() => shown.chat(cloudChat)?.line === "Queued · waking box-a", 30_000);
      expect(shown.chat(cloudChat)).toMatchObject({ phase: "working" });
      expect(shown.chat(cloudChat)!.items.at(-1)).toMatchObject({
        kind: "you",
        text: "say: Sent while it slept.",
        state: "sent",
      });
      expect(box.source.waiting(cloudChat)).toBe(true);
      // In Cloud's queue, signed by this phone's own key, and nothing of it reached a runtime: there is none.
      const queued = [...cloud.state.chats.calls.values()].filter(
        (call) => call.session_id === cloudSession,
      );
      expect(queued).toMatchObject([
        {
          method: "turn.submit",
          status: "queued",
          params: {
            session_id: cloudSession,
            kind: "followup",
            input: { text: "say: Sent while it slept." },
          },
        },
      ]);
      expect(cloud.state.chats.computers.get(boxA.computerId)!.state).toBe("starting");
      // It wakes under yet another runtime id. The phone's connection to the old one is handed the new, and the chat's
      // transcript there holds the message once, with its answer.
      const thirdId = await world.wakeUnderNewIdentity(boxA);
      await until(() => followed.length === 1, 60_000);
      expect(followed[0]).toMatchObject({
        runtime_id: thirdId,
        computer_id: boxA.computerId,
        online: true,
      });
      box.source.close();
      box.connection.close();
      box = reach(followed[0]!, shown);
      await phaseIs(box.connection, "open");
      await asPhone(() => box.source.sync());
      asPhone(() => box.source.open(cloudChat));
      await until(() => lastText(shown.chat(cloudChat)) === "text: Sent while it slept.", 90_000);
      await until(() => shown.chat(cloudChat)?.phase === "done", 30_000);
      expect(texts(shown.chat(cloudChat))).toEqual([
        "you: say: Started in Cloud from the phone.",
        "text: Started in Cloud from the phone.",
        "you: say: Sent while it slept.",
        "text: Sent while it slept.",
      ]);
      expect(
        userSaid((await journalOf(boxA, cloudSession)).events, "say: Sent while it slept."),
      ).toHaveLength(1);
      expect(box.errors).toEqual([]);

      // ---- A chat started on the Mac from the phone, through the device connection the Mac allowed.
      const onBoard = board();
      const studio = reach(onMac, onBoard);
      await phaseIs(studio.connection, "waiting");
      await allow(mac.admin!, (await mine.device()).device_id);
      await phaseIs(studio.connection, "open");
      await asPhone(() => studio.source.sync());
      // In its project's own folder on the Mac, and nothing is asked of Cloud for it.
      const macChat = await startFromPhone(
        mine.cloud,
        onBoard,
        {
          text: "say: Started on the Mac from the phone.",
          title: "Mac chat",
          project: { name: "chaos", github: "acme/chaos", path: world.macRepo },
          engine: "claude",
          model: "",
          on: { kind: "mac", computer_id: mac.computerId, name: "mac" },
        },
        (computerId) => {
          expect(computerId).toBe(mac.computerId);
          return studio.source;
        },
      );
      expect(front.state.workspaces).toHaveLength(1);
      await until(
        () => lastText(onBoard.chat(macChat)) === "text: Started on the Mac from the phone.",
        60_000,
      );
      await until(() => onBoard.chat(macChat)?.phase === "done", 30_000);
      expect(texts(onBoard.chat(macChat))).toEqual([
        "you: say: Started on the Mac from the phone.",
        "text: Started on the Mac from the phone.",
      ]);
      expect(onBoard.chat(macChat)).toMatchObject({
        title: "Mac chat",
        device: `live:${mac.computerId}`,
        engine: "claude",
      });
      const macSession = studio.source.sessionOf(macChat)!;

      // It asks before it runs a command, and the phone's Allow lets it.
      asPhone(() => studio.source.send(macChat, "ask: run the migration"));
      await until(
        () => onBoard.chat(macChat)?.phase === "needs" && onBoard.chat(macChat)!.need !== undefined,
        30_000,
      );
      expect(onBoard.chat(macChat)!.need).toMatchObject({ kind: "approval" });
      expect(await asPhone(() => studio.source.respond(macChat, { kind: "allow" }))).toBe(true);
      await until(() => onBoard.chat(macChat)?.phase === "done", 30_000);
      expect(onBoard.chat(macChat)!.items.findLast((item) => item.kind === "ask")).toMatchObject({
        answer: "allowed",
      });

      // A follow-up while a turn runs goes as a steer (the reply under way, held half said, would otherwise never end):
      // the runtime cuts that reply and answers the follow-up, once.
      const half = "I am halfway through explaining how the relay reconnects when";
      asPhone(() => studio.source.send(macChat, `steer-cut: ${half}`));
      await until(
        () =>
          onBoard.chat(macChat)?.phase === "working" &&
          lastText(onBoard.chat(macChat)) === `text: ${half}`,
        30_000,
      );
      asPhone(() => studio.source.send(macChat, "say it shorter"));
      await until(() =>
        onBoard
          .chat(macChat)!
          .items.some((item) => item.kind === "you" && item.text === "say it shorter"),
      );
      expect(onBoard.chat(macChat)!.items.findLast((item) => item.kind === "you")).toMatchObject({
        text: "say it shorter",
        steer: true,
      });
      await until(
        () => lastText(onBoard.chat(macChat)) === "text: smoke ok: say it shorter",
        60_000,
      );
      await until(() => onBoard.chat(macChat)?.phase === "done", 30_000);
      expect(onBoard.chat(macChat)!.items.findLast((item) => item.kind === "you")).toMatchObject({
        text: "say it shorter",
        state: "sent",
      });
      expect(userSaid((await journalOf(mac, macSession)).events, "say it shorter")).toHaveLength(1);

      // Stop ends a turn that is running.
      asPhone(() => studio.source.send(macChat, "slow 20000: wait for me"));
      await until(
        () =>
          onBoard.chat(macChat)?.phase === "working" &&
          lastText(onBoard.chat(macChat))?.startsWith("text: smoke ok: wait for me") === true,
        30_000,
      );
      asPhone(() => studio.source.stop(macChat));
      await until(() => onBoard.chat(macChat)?.phase === "done", 30_000);
      expect(onBoard.chat(macChat)!.line).toBe("Stopped");
      expect(studio.errors).toEqual([]);

      // ---- The Mac's runtime stops (its lid shut for the night, the app quit). Its chat says so, and runs in Cloud.
      // Cloud holds the chat's copy through its last turn before the Mac goes.
      await until(async () => {
        const last = (await journalOf(mac, macSession)).events.at(-1)?.cursor;
        return last !== undefined && cloud.state.chats.copyOf(macSession).at(-1)?.cursor === last;
      }, 60_000);
      const held = cloud.state.chats.sessions.get(macSession)!;
      expect(held.computer_id).toBe(mac.computerId);
      const epoch = held.epoch;
      const macBefore = (await journalOf(mac, macSession)).events;
      const macTurns = macBefore.filter((event) => event.type === "turn.started").length;
      await mac.term();
      // Cloud last heard from it ten minutes ago: not on line any more, and asleep for all a phone can tell.
      cloud.state.chats.lastHeartbeat.set(mac.runtimeId, Date.now() - 10 * 60_000);
      world.lapseLeases(mac);
      await phaseIs(studio.connection, "asleep");
      const macNow = (await asPhone(() => mine.cloud.computers())).computers.find(
        (c) => c.computer_id === mac.computerId,
      )!;
      expect(computerStatus(macNow)).toMatchObject({ state: "asleep", label: "Asleep" });
      // What Cloud lists of the chat: on the Mac, a repository on GitHub, so nothing known bars the move.
      const listedChat = (await asPhone(() => mine.cloud.chats())).find(
        (chat) => chat.session_id === macSession,
      )!;
      expect(listedChat).toMatchObject({
        workspace_id: macChat,
        computer_id: mac.computerId,
        where: { kind: "laptop", name: "mac" },
        repo: "acme/chaos",
        kind: "chat",
        engine: "claude-agent",
      });
      expect(whyNotCloud(listedChat)).toBeNull();

      // Run in Cloud: Cloud's own move, from its copy, to the project's Cloud computer. The phone is told where it is.
      const ran = await asPhone(() => studio.source.runInCloud(macChat));
      expect(ran).toEqual({ computer_id: boxA.computerId, session_id: macSession });
      // The phone follows the chat to that computer: its history came along, and the next message is answered there.
      await until(async () => {
        await asPhone(() => box.source.sync());
        return box.source.chatOf(macSession) !== undefined;
      }, 90_000);
      const moved = box.source.chatOf(macSession)!;
      asPhone(() => box.source.open(moved));
      await until(
        () => texts(shown.chat(moved)).includes("text: Started on the Mac from the phone."),
        60_000,
      );
      asPhone(() => box.source.send(moved, "say: Carried on in Cloud."));
      await until(() => lastText(shown.chat(moved)) === "text: Carried on in Cloud.", 90_000);
      await until(() => shown.chat(moved)?.phase === "done", 30_000);
      expect(shown.chat(moved)).toMatchObject({
        device: `live:${boxA.computerId}`,
        title: "Mac chat",
      });
      expect(box.errors).toEqual([]);

      // One place holds the chat throughout. Cloud moved it once, to the Cloud computer, on the next epoch; that
      // computer's journal has the new turn once; and the Mac, back up, holds none of it and runs nothing of it.
      const now = cloud.state.chats.sessions.get(macSession)!;
      expect(now.computer_id).toBe(boxA.computerId);
      expect(now.epoch).toBe(epoch + 1);
      expect(cloud.state.chats.epochBumps.filter((bump) => bump.session_id === macSession)).toEqual(
        [{ session_id: macSession, epoch: epoch + 1, why: "move" }],
      );
      const onBox = await journalOf(boxA, macSession);
      expect(userSaid(onBox.events, "say: Carried on in Cloud.")).toHaveLength(1);
      expect(userSaid(onBox.events, "say: Started on the Mac from the phone.")).toHaveLength(1);
      await mac.start();
      await until(async () => (await mac.call("cloud.status", {})).state === "connected", 60_000);
      const backOnMac = await journalOf(mac, macSession);
      expect(userSaid(backOnMac.events, "say: Carried on in Cloud.")).toEqual([]);
      expect(backOnMac.events.filter((event) => event.type === "turn.started")).toHaveLength(
        macTurns,
      );
      expect(macTurns).toBe(5);
      // Still the Cloud computer's after the Mac is back: Cloud's row, and the Mac's own word on where the chat is.
      expect(cloud.state.chats.sessions.get(macSession)!.computer_id).toBe(boxA.computerId);
      await until(
        async () =>
          (await mac.call("workspace.get", { workspace_id: macChat })).computer.kind ===
          "caveman_cloud",
        60_000,
      );
      console.log(
        `PASS: the phone listed 3 computers, woke ${boxA.name} twice (${firstId.slice(0, 8)} -> ${secondId.slice(0, 8)} -> ${thirdId.slice(0, 8)}), started a chat in Cloud and on the Mac, and ran the Mac's chat in Cloud on epoch ${now.epoch}`,
      );
    } catch (error) {
      console.error(trace.tail(80));
      for (const runtime of world.runtimes) console.error(`${runtime.name}: ${logErrors(runtime)}`);
      throw error;
    }
  },
  600_000,
);
