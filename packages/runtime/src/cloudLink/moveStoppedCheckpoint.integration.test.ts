// A move parks the chat once its turns ended: a stopped turn's checkpoint and diff come after the turn's end, from an
// effect of their own, and the park waited only for the journal to go quiet for 300 ms. A checkpoint that took longer
// (many files, a loaded machine) landed on the computer the chat left, past the move's last copy, so the moved chat had
// no checkpoint or diff for that turn. Both ways a turn stops for a move: the move's park stops it, or the person's Stop
// does right before the move (chaos seed 1's order). Real runtime processes (This Mac and the Cloud computers), protocol
// clients and Claude Agent adapter; the test Cloud and the no-model CLI. Files the turn wrote make its checkpoint slow.
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { journalOf, Trace, World, type RuntimeProc } from "./chaos/world.ts";

/** Enough new files that git takes far longer than 300 ms to write the stopped turn's checkpoint. */
const FILES = 4_000;

const checkpointed = (events: ReadonlyArray<SessionEvent>, turn: string | undefined) =>
  ["checkpoint.created", "diff.changed"].filter((type) =>
    events.some((e) => e.type === type && e.turn_id === turn),
  );

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux, and adopts it in its checkout only where owner
// uid and mode bits show the agent cannot write it (gitTrusts); here it would never arrive.
test.skipIf(process.platform === "win32")(
  "a turn stopped for a move has its checkpoint and diff where the chat lands, never written on the computer it left past its last copy",
  async () => {
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const moveWith = async (title: string, to: RuntimeProc, stop: "park" | "person") => {
        const w = await createReady(world.mac.admin! as Parameters<typeof createReady>[0], {
          request_id: `w-${stop}`,
          repo: { path: world.macRepo },
          title,
          engine: "claude-agent",
          options: { model: MODEL },
        });
        const sessionId = w.session_id;
        await world.mac.call("turn.submit", {
          request_id: `first-${stop}`,
          session_id: sessionId,
          kind: "followup",
          input: { text: "slow 50: before the move" },
        });
        await until(
          async () =>
            (await journalOf(world.mac, sessionId)).events.some((e) => e.type === "turn.done"),
          60_000,
        );
        await until(
          () => world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
          60_000,
        );
        // A turn at work that has written many files.
        await world.mac.call("turn.submit", {
          request_id: `long-${stop}`,
          session_id: sessionId,
          kind: "followup",
          input: { text: "slow 60000: writing many files" },
        });
        await until(
          async () =>
            (await journalOf(world.mac, sessionId)).events.filter((e) => e.type === "turn.started")
              .length === 2,
          60_000,
        );
        const out = path.join(w.root_path!, "out");
        fs.mkdirSync(out);
        for (let i = 0; i < FILES; i++)
          fs.writeFileSync(path.join(out, `f${i}.txt`), `${i} ${"x".repeat(200)}\n`);
        if (stop === "person")
          await world.mac.call("turn.interrupt", {
            request_id: `stop-${stop}`,
            session_id: sessionId,
          });
        await world.mac.call("session.move", {
          request_id: `move-${stop}`,
          session_id: sessionId,
          to: { computer_id: to.computerId },
        });
        await until(
          async () =>
            world.ownerOf(sessionId) === to &&
            (await to.call("workspace.list", {})).workspaces.some(
              (x) => x.session_id === sessionId && x.status !== "starting",
            ),
          120_000,
        );
        const left = await journalOf(world.mac, sessionId);
        const turn = left.events.findLast(
          (e) =>
            e.type === "turn.done" && (e.payload as { status: string }).status === "interrupted",
        )?.turn_id;
        const parked = left.events.findIndex((e) => e.type === "session.parked");
        const there = await journalOf(to, sessionId);
        return {
          // Where it lands: the stopped turn's checkpoint and diff.
          there: checkpointed(there.events, turn),
          // Where it left: nothing of it past the park its last copy ends with.
          pastPark: left.events
            .slice(parked)
            .flatMap((e) => (e.turn_id === turn ? [`${e.cursor} ${e.type}`] : [])),
        };
      };
      const byPark = await moveWith("Stopped by its move", world.boxA, "park");
      const byPerson = await moveWith("Stopped, then moved", world.boxB, "person");
      expect({ byPark, byPerson }).toEqual({
        byPark: { there: ["checkpoint.created", "diff.changed"], pastPark: [] },
        byPerson: { there: ["checkpoint.created", "diff.changed"], pastPark: [] },
      });
    } finally {
      await world.close();
    }
  },
  480_000,
);
