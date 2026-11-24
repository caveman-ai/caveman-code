// The messages a person queued behind a turn go with the chat when it moves, and run where it lands in the order they
// were queued. The computer it lands on queues them again one by one as follow-ups (adopt): each went in front of the
// ones queued before it, so three ran second, third, first (chaos seed 301: a direct send and a Cloud-queued send both
// arrive as follow-ups, and ran reversed). Real runtime processes (This Mac and a Cloud computer), protocol clients and
// Claude Agent adapter; the test Cloud and the no-model CLI.
import { type SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { journalOf, Trace, World } from "./chaos/world.ts";

/** The texts in the order their turns started. */
const startOrder = (events: ReadonlyArray<SessionEvent>, texts: ReadonlyArray<string>) => {
  const startedAt = (text: string) => {
    const turn = events.find(
      (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
    )?.turn_id;
    return events.findIndex((e) => e.type === "turn.started" && e.turn_id === turn);
  };
  return [...texts].sort((a, b) => startedAt(a) - startedAt(b));
};
const answered = (events: ReadonlyArray<SessionEvent>, text: string) =>
  events.some(
    (e) =>
      e.type === "message.done" &&
      e.payload.role === "assistant" &&
      e.payload.text.includes(text.replace(/^slow \d+: /, "")),
  );

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux, and adopts it in its checkout only where owner
// uid and mode bits show the agent cannot write it (gitTrusts); here it would never arrive.
test.skipIf(process.platform === "win32")(
  "three messages queued behind a turn run in the order they were queued where the chat moves",
  async () => {
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const w = await createReady(world.mac.admin! as Parameters<typeof createReady>[0], {
        request_id: "queue-order-workspace",
        repo: { path: world.macRepo },
        title: "Moved with three messages queued",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await world.mac.call("turn.submit", {
        request_id: "queue-order-first",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 50: before the move" },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.some((e) => e.type === "turn.done"),
        30_000,
      );
      await until(
        () => world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
        30_000,
      );

      // A long turn, and three messages queued behind it. The first runs a while where the chat lands, so the other two
      // queue there behind it.
      await world.mac.call("turn.submit", {
        request_id: "queue-order-running",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 60000: working as it moves" },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.filter((e) => e.type === "turn.started")
            .length === 2,
        30_000,
      );
      const queued = ["slow 3000: queued one", "slow 50: queued two", "slow 50: queued three"];
      for (const [i, text] of queued.entries()) {
        expect(
          await world.mac.call("turn.submit", {
            request_id: `queue-order-${i}`,
            session_id: sessionId,
            kind: "queue",
            input: { text },
          }),
        ).toMatchObject({ disposition: "queued" });
      }

      // Moved by hand: the move stops the turn, and what was queued behind it goes with the chat.
      await world.mac.call("session.move", {
        request_id: "queue-order-move",
        session_id: sessionId,
        to: { computer_id: world.boxA.computerId },
      });
      await until(() => world.ownerOf(sessionId) === world.boxA, 60_000);
      await until(async () => {
        const there = (await journalOf(world.boxA, sessionId)).events;
        return queued.every((text) => answered(there, text));
      }, 60_000);
      expect(startOrder((await journalOf(world.boxA, sessionId)).events, queued)).toEqual(queued);
    } finally {
      await world.close();
    }
  },
  240_000,
);

// A move carried each queued message as plain text, which the computer it lands on queued as a follow-up: a message
// queued for later became one, so a follow-up the person sent there went behind it instead of ahead of it. The move
// carries each message's kind: where the chat lands, a follow-up goes behind the follow-ups it carried and ahead of
// what was queued for later, as it would have on the computer it left.
test.skipIf(process.platform === "win32")(
  "a moved chat's queue keeps each message's kind: a follow-up sent where it lands goes behind the carried follow-ups and ahead of what was queued for later",
  async () => {
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const w = await createReady(world.mac.admin! as Parameters<typeof createReady>[0], {
        request_id: "queue-kind-workspace",
        repo: { path: world.macRepo },
        title: "Moved with a follow-up and two for later",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await world.mac.call("turn.submit", {
        request_id: "queue-kind-first",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 50: before the move" },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.some((e) => e.type === "turn.done"),
        30_000,
      );
      await until(
        () => world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
        30_000,
      );
      await world.mac.call("turn.submit", {
        request_id: "queue-kind-running",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 60000: working as it moves" },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.filter((e) => e.type === "turn.started")
            .length === 2,
        30_000,
      );
      // Behind the turn: a follow-up (it runs first where the chat lands, for a while), then two queued for later.
      const followup = "slow 5000: the follow-up";
      const later = ["slow 50: for later one", "slow 50: for later two"];
      expect(
        await world.mac.call("turn.submit", {
          request_id: "queue-kind-followup",
          session_id: sessionId,
          kind: "followup",
          input: { text: followup },
        }),
      ).toMatchObject({ disposition: "queued" });
      for (const [i, text] of later.entries()) {
        expect(
          await world.mac.call("turn.submit", {
            request_id: `queue-kind-later-${i}`,
            session_id: sessionId,
            kind: "queue",
            input: { text },
          }),
        ).toMatchObject({ disposition: "queued" });
      }

      await world.mac.call("session.move", {
        request_id: "queue-kind-move",
        session_id: sessionId,
        to: { computer_id: world.boxA.computerId },
      });
      await until(() => world.ownerOf(sessionId) === world.boxA, 60_000);
      // Where it lands: the follow-up runs, the two for later wait behind it, and the person sends another follow-up.
      await until(
        async () =>
          (await world.boxA.call("queue.list", { session_id: sessionId })).turns.length ===
          later.length,
        60_000,
      );
      const sentThere = "slow 50: a follow-up sent where it landed";
      expect(
        await world.boxA.call("turn.submit", {
          request_id: "queue-kind-there",
          session_id: sessionId,
          kind: "followup",
          input: { text: sentThere },
        }),
      ).toMatchObject({ disposition: "queued" });
      const all = [followup, sentThere, ...later];
      await until(async () => {
        const there = (await journalOf(world.boxA, sessionId)).events;
        return all.every((text) => answered(there, text));
      }, 90_000);
      expect(startOrder((await journalOf(world.boxA, sessionId)).events, all)).toEqual(all);
    } finally {
      await world.close();
    }
  },
  240_000,
);
