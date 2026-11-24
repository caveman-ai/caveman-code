// A NEW chat started in Cloud on a project whose computer is not up yet (CONTRACT §6.8), timed from Send: when Cloud
// has placed it, when the computer's runtime is linked, when the chat's first event exists, and when the first token
// of the answer arrives. The same step the founder's story measures on the real stack; here against the stand-in Cloud, a round trip away (FAR_MS), with a real Cloud computer's
// runtime in this process and the stand-in Claude CLI (no model). The stand-in has no machine to boot: its "computer"
// is the runtime starting, so what this measures is the runtime's own part (its start-up, its link, the start it
// takes from Cloud's queue, the first turn), not a VM's. Printed, and written to CAVEMAN_NEW_CHAT_RESULTS when set.
import * as fs from "node:fs";
import * as os from "node:os";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { makeRepo, MODEL, tempRoot } from "../session-protocol/testHarness.ts";
import { builderKit, type TestCloud } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

/** A round trip to Cloud (CAVEMAN_NEW_CHAT_FAR_MS, 25): each request to the stand-in waits that long before it is looked at. */
const FAR_MS = Number(process.env.CAVEMAN_NEW_CHAT_FAR_MS ?? 25);
/** From Send to the first token, the runtime's start-up included (it starts after Send here): judged up to MAX_LOAD per core. */
const FIRST_TOKEN_BUDGET_MS = 20_000;
const MAX_LOAD = 3.5;
const loadPerCore = () => os.loadavg()[0]! / os.cpus().length;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime } = builderKit(cleanups);
/** until, looked at every few milliseconds: these are timings. */
const soon = async (check: () => boolean | Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
};
/** The answer's first token: the assistant's first streamed text, or its whole message from an engine that streams none. */
const isAnswer = (event: SessionEvent) =>
  event.type === "message.delta" ||
  (event.type === "message.done" && event.payload.role === "assistant");

/** Send, as the person's window makes it: one request, which places the chat on their Cloud computer and queues its start. */
const send = async (cloud: TestCloud, requestId: string, text: string) => {
  const response = await fetch(`${cloud.url}/api/v1/code/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cloud.state.personToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: text,
      repo: "acme/widgets",
      engine: "claude-agent",
      computer: { kind: "cloud" },
      start: {
        request_id: requestId,
        params: {
          repo: { url: "https://github.com/acme/widgets" },
          title: text,
          engine: "claude-agent",
          task: { text },
          options: { model: MODEL },
        },
      },
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      id: string;
      computer_id: string;
      session_id: string;
      start?: { status: string };
    },
  };
};

test.skipIf(process.platform === "win32")(
  `a new chat started in Cloud, its computer not up yet, a Cloud ${FAR_MS} ms away: placed, linked, its first event and its first token, from Send`,
  { timeout: 300_000 },
  async (context) => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    await startTools();
    cloud.state.gitBackend = githubWith(
      makeRepo(tempRoot("new-chat-source-"), { "README.md": "widgets\n" }),
    );
    cloud.state.latencyMs = FAR_MS;
    const loadBefore = loadPerCore();
    let sentAt = 0;
    let placedMs = 0;
    let linkedMs = 0;
    let placed: Awaited<ReturnType<typeof send>>["body"] | undefined;
    const { client } = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend!, "new-chat-"),
      "new-chat",
      undefined,
      undefined,
      async (enrolled) => {
        cloud.state.chats.markCloud(enrolled.computerId, "Project computer");
        // Send, before the computer's runtime has started: all the person's window does.
        sentAt = Date.now();
        const sent = await send(cloud, "start-1", "Say what this repository is");
        placedMs = Date.now() - sentAt;
        expect(sent.status).toBe(201);
        placed = sent.body;
        // Linked: Cloud holds the runtime's relay (what a device reaches the chat through).
        void soon(
          () =>
            cloud.state.relays.some(
              (relay) => cloud.state.tokens.get(relay.token)?.runtimeId === enrolled.runtimeId,
            ),
          120_000,
        ).then(() => (linkedMs = Date.now() - sentAt));
      },
    );
    const session = placed!.session_id;
    // The chat as a device attached to it sees it: its events from the first, live.
    const events: Array<{ readonly event: SessionEvent; readonly at: number }> = [];
    await soon(
      async () =>
        (await client.call("workspace.list", {})).workspaces.some((w) => w.session_id === session),
      60_000,
    );
    await client.attach(session, 0, (event) => events.push({ event, at: Date.now() }));
    const answer = () => events.find(({ event }) => isAnswer(event));
    await soon(() => answer() !== undefined, 120_000);
    cloud.state.latencyMs = 0;
    await soon(() => linkedMs > 0, 10_000);
    // An event from before this test attached counts from when it was journaled (its own `at`), a live one from when it came.
    const since = (seen: { readonly event: SessionEvent; readonly at: number }) =>
      Math.min(seen.at, Date.parse(seen.event.at) || seen.at) - sentAt;
    const first = events[0]!;
    const token = answer()!;
    const copied = cloud.state.chats.copyOf(session)[0];
    const load = Math.max(loadBefore, loadPerCore());
    const result = {
      far_ms: FAR_MS,
      placed_ms: placedMs,
      linked_ms: linkedMs,
      first_event_ms: since(first),
      first_event: first.event.type,
      first_token_ms: since(token),
      first_token: token.event.type,
      in_clouds_copy: copied === undefined ? "not yet" : copied.type,
      load_per_core: Number(load.toFixed(2)),
      cpus: os.cpus().length,
    };
    console.log(`new chat timing: ${JSON.stringify(result)}`);
    if (process.env.CAVEMAN_NEW_CHAT_RESULTS)
      fs.appendFileSync(process.env.CAVEMAN_NEW_CHAT_RESULTS, `${JSON.stringify(result)}\n`);
    // In order: placed before the runtime linked, linked before the chat's first event, that before the first token.
    expect(result.placed_ms).toBeLessThanOrEqual(result.linked_ms);
    expect(result.first_event_ms).toBeLessThanOrEqual(result.first_token_ms);
    if (load > MAX_LOAD)
      return context.skip(
        `the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`,
      );
    expect(result.first_token_ms).toBeLessThan(FIRST_TOKEN_BUDGET_MS);
  },
);
