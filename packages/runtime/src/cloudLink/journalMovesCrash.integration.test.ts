// Regression for a departed journal colliding with its continuation's epoch after a crash.
// Real runtime subprocesses, protocol clients and Claude Agent adapter; test Cloud and no-model CLI.
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { journalOf, Trace, World } from "./chaos/world.ts";

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux, and adopts it in its checkout only where
// owner uid and mode bits show the agent cannot write it (gitTrusts); here it would never arrive.
test.skipIf(process.platform === "win32")("a crashed moved-away journal does not claim the continuing computer's epoch", async () => {
  const world = new World({ trace: new Trace() });
  try {
    await world.start();
    const workspace = await createReady(world.mac.admin! as Parameters<typeof createReady>[0], {
      request_id: "epoch-workspace",
      repo: { path: world.macRepo },
      title: "Departed journal",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const sessionId = workspace.session_id;
    await world.mac.call("turn.submit", {
      request_id: "epoch-first-turn",
      session_id: sessionId,
      kind: "followup",
      input: { text: "slow 50: before the move" },
    });
    await until(async () => (await journalOf(world.mac, sessionId)).events.some((e) => e.type === "turn.done"), 30_000);
    await until(() => world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true, 30_000);
    const before = await journalOf(world.mac, sessionId);
    await world.mac.call("session.move", {
      request_id: "epoch-move",
      session_id: sessionId,
      to: { computer_id: world.boxA.computerId },
    });
    await until(async () => world.ownerOf(sessionId) === world.boxA && (await journalOf(world.boxA, sessionId)).epoch > before.epoch, 30_000);
    await until(async () => (await world.mac.call("workspace.get", { workspace_id: workspace.id })).computer.kind === "caveman_cloud", 30_000);
    const continuation = await journalOf(world.boxA, sessionId);
    const departed = await journalOf(world.mac, sessionId);
    expect(departed.epoch).toBe(before.epoch);
    await world.mac.kill();
    await world.mac.start();
    const restarted = await journalOf(world.mac, sessionId);
    // Only Cloud's current holder can allocate the continuing journal's epoch.
    // A local-only increment would make these distinct branches share an identity.
    expect(restarted.epoch).toBe(departed.epoch);
    expect(restarted.epoch).not.toBe(continuation.epoch);
    expect(restarted.events).toEqual(departed.events);
  } finally {
    await world.close();
  }
}, 120_000);
