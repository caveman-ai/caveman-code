// A chat started in Cloud is queued in Cloud (CONTRACT §6.8): a real Cloud computer's runtime, and This Mac's, against
// the stand-in Cloud, with the stand-in Claude CLI (no model). A person's Send places the chat and queues its start; the
// computer Cloud placed it on runs that start when it links, with nobody's window waiting for it, as the session Cloud
// placed and under the workspace id every device derives from the placement. The start's request id is the one a
// client's own live workspace.create carries, so the two make one workspace whichever comes first. A Mac never runs a
// queued start, and a call a runtime does not run from the queue is answered with a code. Cloud's own half is
// control-api's chats_start_test.go.
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { relayWire, replyOn } from "../session-protocol/devices.testkit.ts";
import { placedWorkspaceId, submittedMessageId } from "../session-protocol/store.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { builderKit, type TestCloud } from "./builders.kit.ts";
import { DeviceApproval } from "./calls.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime } = builderKit(cleanups);

/** The person, at Cloud's own routes. */
const person = async (cloud: TestCloud, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${cloud.url}/api/v1/code/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${cloud.state.personToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** What a client sends as a chat's start: workspace.create's params, without the workspace Cloud places. */
const startOf = (text: string) => ({
  repo: { url: "https://github.com/acme/widgets" },
  title: text,
  engine: "claude-agent",
  task: { text },
  options: { model: MODEL },
});
/** Send: the person's one request. Cloud places the chat on their Cloud computer and queues its start. */
const send = (cloud: TestCloud, requestId: string, text: string) =>
  person(cloud, "POST", "workspaces", {
    title: text,
    repo: "acme/widgets",
    engine: "claude-agent",
    computer: { kind: "cloud" },
    start: { request_id: requestId, params: startOf(text) },
  });
const callOf = async (cloud: TestCloud, sessionId: string, requestId: string) =>
  (await person(cloud, "GET", `chats/${sessionId}/calls/${requestId}`)).body;

async function cloudWithGitHub() {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  cloud.state.gitBackend = githubWith(
    makeRepo(tempRoot("start-source-"), { "README.md": "widgets\n" }),
  );
  return cloud;
}

/** The person's own client through the relay to a Cloud computer's runtime (`cloud:<user>`, as a browser window's). */
function relayed(cloud: TestCloud, runtimeId: string) {
  const relay = [...cloud.state.relays]
    .reverse()
    .find(
      (side) =>
        side.ws.readyState === side.ws.OPEN &&
        cloud.state.tokens.get(side.token)?.runtimeId === runtimeId,
    )!;
  const wire = relayWire(relay, relay.open());
  let next = 0;
  return async (method: string, params: unknown) => {
    const id = ++next;
    wire.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const reply = await replyOn(wire, id, 60_000);
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result as Record<string, any>;
  };
}

test.skipIf(process.platform === "win32")(
  "a start queued while its Cloud computer was still on its way up runs once when the computer links: the chat is the session Cloud placed, and the same start over the relay or said to Cloud again makes nothing more",
  async () => {
    const cloud = await cloudWithGitHub();
    let sent: Awaited<ReturnType<typeof send>> | undefined;
    const { client, identity } = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend!, "start-linking-"),
      "linking",
      undefined,
      undefined,
      async (enrolled) => {
        // Send, before the computer's runtime has started: the only thing the person's window does.
        cloud.state.chats.markCloud(enrolled.computerId, "Project computer");
        sent = await send(cloud, "start-1", "Make the build green");
      },
    );
    expect(sent!.status).toBe(201);
    const placed = sent!.body as {
      id: string;
      computer_id: string;
      session_id: string;
      start: { status: string; method: string };
    };
    expect(placed).toMatchObject({
      computer_id: identity.computerId,
      start: { status: "queued", method: "workspace.create" },
    });

    // No client asked the computer for anything: its runtime took the start from Cloud's queue when it linked.
    await until(
      async () => (await callOf(cloud, placed.session_id, "start-1")).status === "done",
      60_000,
    );
    const made = (await callOf(cloud, placed.session_id, "start-1")).result as Workspace;
    // The chat is the session Cloud placed, under the id every device derives from the placement: a window that
    // opened the chat at Send is already on it.
    expect(made).toMatchObject({
      id: placedWorkspaceId(placed.id),
      session_id: placed.session_id,
      title: "Make the build green",
    });
    expect(cloud.state.chats.placements.get(placed.id)?.taken).toBe(placed.session_id);
    expect(cloud.state.chats.sessions.get(placed.session_id)?.workspace_id).toBe(placed.id);
    const listed = async () =>
      (await client.call("workspace.list", {})).workspaces.map((w) => [w.id, w.session_id]);
    expect(await listed()).toEqual([[made.id, placed.session_id]]);

    // Its first message is in the transcript once, under the id a device that showed it at Send expects.
    const events: Array<SessionEvent> = [];
    await client.attach(placed.session_id, 0, (event) => events.push(event));
    const said = () => events.filter((e) => e.type === "message.done" && e.payload.role === "user");
    await until(() => said().length > 0 && events.some((e) => e.type === "turn.started"), 60_000);
    expect(said().map((e) => [e.item_id, e.type === "message.done" ? e.payload.text : ""])).toEqual(
      [[submittedMessageId(placed.session_id, "start-1:task"), "Make the build green"]],
    );

    // The same start over the relay, as the client's own live call would send it (the same request id and params, with
    // the workspace Cloud placed): answered from the receipt, never run again.
    const live = relayed(cloud, identity.runtimeId);
    const again = await live("workspace.create", {
      request_id: "start-1",
      ...startOf("Make the build green"),
      placed_workspace_id: placed.id,
    });
    expect([again.id, again.session_id]).toEqual([made.id, placed.session_id]);
    // And the same Send said to Cloud again answers the first placement, with nothing more queued.
    const resent = await send(cloud, "start-1", "Make the build green");
    expect(resent.body).toMatchObject({
      id: placed.id,
      session_id: placed.session_id,
      start: { status: "done" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await listed()).toEqual([[made.id, placed.session_id]]);
    expect(
      [...cloud.state.chats.calls.values()].filter((c) => c.method === "workspace.create"),
    ).toHaveLength(1);
    expect(cloud.state.chats.callResults.filter((r) => r.ok)).toHaveLength(1);
    expect(said()).toHaveLength(1);
    // Nothing the runtime sent was a body Cloud's strict decoder refuses.
    expect(cloud.state.chats.refused).toEqual([]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "on a computer that is up, a queued start is taken off the long poll at once, and the client's own live call beside it makes the same workspace whichever runs first",
  async () => {
    const cloud = await cloudWithGitHub();
    const { client, identity } = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend!, "start-awake-"),
      "awake",
    );
    cloud.state.chats.markCloud(identity.computerId, "Project computer");
    // The runtime holds its wait before anything is queued.
    await until(() => cloud.state.chats.waits.some((x) => x.channel === "call"), 20_000);

    const sentAt = Date.now();
    const first = (await send(cloud, "start-a", "First chat")).body;
    await until(
      async () => (await callOf(cloud, first.session_id, "start-a")).status === "done",
      60_000,
    );
    // Off the long poll, not a 30 s poll.
    expect(Date.now() - sentAt).toBeLessThan(10_000);

    // Send, and the live call a client makes when it cannot tell whether the queue will run it (a fallback's start),
    // at the same moment: one workspace, and both answers name it.
    const placed = (await send(cloud, "start-b", "Second chat")).body;
    const live = relayed(cloud, identity.runtimeId);
    const answered = await live("workspace.create", {
      request_id: "start-b",
      ...startOf("Second chat"),
      placed_workspace_id: placed.id,
    });
    await until(
      async () => (await callOf(cloud, placed.session_id, "start-b")).status === "done",
      60_000,
    );
    const queued = (await callOf(cloud, placed.session_id, "start-b")).result as Workspace;
    expect([answered.id, answered.session_id]).toEqual([queued.id, queued.session_id]);
    expect(queued.id).toBe(placedWorkspaceId(placed.id));
    const titles = (await client.call("workspace.list", {})).workspaces.map((w) => w.title).sort();
    expect(titles).toEqual(["First chat", "Second chat"]);
    expect(cloud.state.chats.placements.get(placed.id)?.taken).toBe(queued.session_id);
  },
  300_000,
);

test("This Mac never runs a queued start, and a call a runtime does not run from the queue is answered with a code its device reads", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: Layer.succeed(DeviceApproval, {
      approved: () => Effect.succeed(true),
    }) as Layer.Layer<any>,
  });
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await local.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, remote_control: true },
  });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const w = await createReady(local, {
    request_id: "w1",
    repo: { path: makeRepo(tempRoot("start-mac-"), { "README.md": "hello\n" }) },
    title: "On the Mac",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => cloud.state.chats.summaries.has(w.session_id), 20_000);

  // Cloud queues a start only with a placement on a Cloud computer; one that reached a Mac all the same, and a method
  // from a Cloud newer than this runtime, as Cloud's own call mail.
  const queue = (requestId: string, method: string, params: Record<string, unknown>) =>
    cloud.state.chats.calls.set(requestId, {
      id: requestId,
      session_id: w.session_id,
      person: "user-1",
      request_id: requestId,
      method: method as never,
      params,
      params_key: requestId,
      status: "queued",
      created_at: Date.now(),
    });
  queue("start-on-mac", "workspace.create", {
    ...startOf("Not here"),
    placed_workspace_id: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  });
  queue("newer-method", "workspace.fork_everything", { session_id: w.session_id });
  const read = async (requestId: string) =>
    (await callOf(cloud, w.session_id, requestId)) as { status: string; error?: { code: string } };
  await until(
    async () =>
      (await read("start-on-mac")).status === "failed" &&
      (await read("newer-method")).status === "failed",
    30_000,
  );
  expect((await read("start-on-mac")).error).toMatchObject({ code: "unsupported" });
  expect((await read("newer-method")).error).toMatchObject({ code: "method_not_found" });
  // Nothing was made for either.
  expect((await local.call("workspace.list", {})).workspaces.map((x) => x.title)).toEqual([
    "On the Mac",
  ]);
}, 120_000);
