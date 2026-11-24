// A Cloud computer's runtime id changes at every wake (docs/ CONTRACT §5.3: Cloud
// mints a new identity at each wake and refuses the old one once the computer has stopped). Whatever a device remembers
// of the old runtime id, it looks the computer up again by its computer id: a chat open on the computer carries on
// across a sleep and a wake, what the person sent while it slept runs once, and their next message goes straight to
// the runtime the computer woke as. Nobody reloads, picks a computer or sends anything twice.
//
// A real runtime process as the Cloud computer (stopped as Cloud stops one, started again on the same disk under a new
// identity), the app's own sync hub as a web tab reaching it through a relay that refuses the revoked id before the
// socket opens, the real Claude Agent adapter and SDK on the no-model CLI, and the stand-in Cloud.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { eventKey, journalOf, logErrors, Trace, World } from "./chaos/world.ts";

const userSaid = (events: ReadonlyArray<SessionEvent>, text: string) =>
  events.filter(
    (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
  );
const turnsDone = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((e) => e.type === "turn.done").length;

// Skipped on Windows: a Cloud computer is Linux, and runs git in its checkout only where owner uid and mode bits show
// the agent cannot write it (gitTrusts).
test.skipIf(process.platform === "win32")(
  "a Cloud computer sleeps and wakes under a new runtime id: the open chat carries on, what was sent while it slept runs once, and nobody does anything",
  async () => {
    const trace = new Trace();
    const world = new World({ trace });
    try {
      await world.start();
      const box = world.boxA;
      const computerId = box.computerId;
      const chat = await createReady(box.admin! as Parameters<typeof createReady>[0], {
        request_id: "wake-workspace",
        repo: { url: "https://github.com/acme/chaos" },
        title: "Wake",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const session = chat.session_id;
      await until(() => world.cloud.state.chats.copyOf(session).length > 0, 60_000);

      // A web tab on no computer of its own: the chat is read from its Cloud computer, through the relay.
      await world.addDevices([{ name: "web", kind: "web", home: null }]);
      const device = world.device("web");
      const hub = device.hub!;
      await until(() => hub.list?.get().chats.has(session) === true, 30_000);
      const view = device.view(session);
      /** The view shows exactly the chat's journal on the computer, read live from its runtime. */
      const carriedOn = () =>
        until(async () => {
          const journal = await journalOf(box, session);
          return (
            view.state.kind === "live" &&
            view.epoch() === journal.epoch &&
            view.events.length === journal.events.length &&
            view.events.every((event, n) => eventKey(event) === eventKey(journal.events[n]!))
          );
        }, 90_000);
      const send = (name: string, text: string) =>
        device.clientFor(session).call("turn.submit", {
          request_id: `web-${name}`,
          session_id: session,
          kind: "followup",
          input: { text },
        });

      const before = box.runtimeId;
      await send("before", "slow 100: before it sleeps");
      await until(async () => turnsDone((await journalOf(box, session)).events) === 1, 60_000);
      await carriedOn();
      expect(hub.summary(session)).toMatchObject({ runtime_id: before, computer_id: computerId });
      expect(hub.viaFor(session)).toBe("relay");
      const epoch = view.epoch();

      // Cloud stops the computer: the open chat reads Cloud's copy, and a message sent meanwhile waits in Cloud's queue.
      await world.stopComputer(box);
      await until(() => view.state.kind === "copy", 30_000);
      const asleep = send("asleep", "slow 100: while it sleeps");
      await until(
        () => hub.queuedCalls(session).some((queued) => queued.call.request_id === "web-asleep"),
        30_000,
      );

      // It wakes under a new runtime id, on the same disk. The old id is refused from now on.
      const after = await world.wakeUnderNewIdentity(box);
      expect(after).not.toBe(before);
      expect(box.computerId).toBe(computerId);
      await asleep;

      // The message sent while it slept ran on the runtime it woke as, once, and the open view is live on it again:
      // the same view, never reopened, every event once and in order, on the same journal.
      await until(async () => turnsDone((await journalOf(box, session)).events) === 2, 90_000);
      await carriedOn();
      expect(hub.summary(session)).toMatchObject({ runtime_id: after, computer_id: computerId });
      expect(hub.viaFor(session)).toBe("relay");
      expect(view.epoch()).toBe(epoch);
      await until(() => hub.queuedCalls(session).length === 0, 30_000);

      // The next message goes straight to that runtime: not to Cloud's queue, and never toward the old id.
      const queuedBefore = world.relay.frames().length;
      await send("after", "slow 100: after it woke");
      await until(async () => turnsDone((await journalOf(box, session)).events) === 3, 60_000);
      await carriedOn();
      const sent = world.relay
        .frames()
        .slice(queuedBefore)
        .filter((frame) => frame.head.includes("web-after"));
      expect(sent.map((frame) => frame.runtimeId)).toEqual([after]);
      expect(
        world.relay
          .frames()
          .some((frame) => frame.runtimeId === before && frame.head.includes("web-asleep")),
      ).toBe(false);

      const journal = await journalOf(box, session);
      for (const text of [
        "slow 100: before it sleeps",
        "slow 100: while it sleeps",
        "slow 100: after it woke",
      ])
        expect(userSaid(journal.events, text), `one "${text}"`).toHaveLength(1);
      expect(view.misorders).toEqual([]);
      expect(view.events).toEqual(journal.events);
      // Nothing holds a socket to the old id, and nothing reaches the computer under it.
      expect(world.relay.streams().filter((stream) => stream.runtimeId === before)).toEqual([]);
      expect(world.relaySide(before)).toBeUndefined();
      console.log(
        `PASS: ${box.name} slept as ${before.slice(0, 8)} and woke as ${after.slice(0, 8)}; one open view carried on over ${journal.events.length} events, 3 messages each once, ${world.relay.refused().length} attempts on the old id refused`,
      );
    } catch (error) {
      console.error(trace.tail(80));
      for (const runtime of world.runtimes) console.error(`${runtime.name}: ${logErrors(runtime)}`);
      throw error;
    } finally {
      await world.close();
    }
  },
  300_000,
);
