// Every system after a chat moves, both ways (This Mac to Cloud, and back): real runtime processes for This Mac and
// the Cloud computer, the stand-in Cloud between them, the stand-in CLI as Claude Agent. What it settles:
//
// - A chat keeps its model where it moves: a chat on a model that is not the agent's default there still runs on it
//   after the move, and after the move back. Nothing says "this chat runs on … now", which is only said where a chat
//   on Auto lands on a computer that does not run Auto for its agent (handlers.ts adopt, autoLeftNote).
// - A chat's changes move with it: what it changed and did not commit is listed the same (git.status, fs.diff) on the
//   computer it lands on, and again where it comes back.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { journalOf, Trace, World } from "./chaos/world.ts";

const started = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "turn.started" ? [(e.payload as { model?: string }).model] : [],
  );
const done = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((e) => e.type === "turn.done").length;
const notes = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "notification" ? [e.payload.title] : []));

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux (gitTrusts).
test.skipIf(process.platform === "win32")(
  "a chat keeps its model and its changes when it moves to Cloud, and when it moves back",
  async () => {
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const mac = world.mac;
      const box = world.boxA;
      // A model that is not Claude Agent's default: a chat that fell to the default would start its next turn on another.
      const w = await createReady(mac.admin! as Parameters<typeof createReady>[0], {
        request_id: "moves-chat",
        repo: { path: world.macRepo },
        title: "Keeps its model",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const session = w.session_id;
      const turn = async (on: typeof mac, name: string, text: string) => {
        const before = done((await journalOf(on, session)).events);
        await on.call("turn.submit", {
          request_id: `moves-${name}`,
          session_id: session,
          kind: "followup",
          input: { text },
        });
        await until(async () => done((await journalOf(on, session)).events) > before, 60_000);
      };
      const listed = async (on: typeof mac) =>
        (await on.call("workspace.list", {})).workspaces.find(
          (one: { session_id: string; status: string }) =>
            one.session_id === session && one.status !== "archived",
        );
      /** The chat is this computer's to run: Cloud says so, and the computer has taken it in. */
      const landed = async (on: typeof mac) => {
        await until(() => world.ownerOf(session) === on, 90_000);
        await until(
          async () =>
            (await listed(on)) !== undefined && (await journalOf(on, session)).events.length > 0,
          90_000,
        );
      };
      const changes = async (on: typeof mac) => {
        const here = (await listed(on))!;
        return {
          status: (await on.call("git.status", { workspace_id: here.id })).files
            .map((file: { path: string }) => file.path)
            .sort(),
          diff: (await on.call("fs.diff", { workspace_id: here.id })).files
            .map((file: { path: string; status: string }) => [file.path, file.status])
            .sort(),
        };
      };
      const copied = () =>
        until(
          () => world.cloud.state.chats.sessions.get(session)?.segments.at(-1)?.boundary === true,
          30_000,
        );

      // ---- On This Mac: one turn that changes a file and adds another, neither committed.
      await turn(
        mac,
        "mac-1",
        ["sh: printf 'changed on the Mac\\n' >> README.md", "sh: printf 'new\\n' > NOTES.md"].join(
          "\n",
        ),
      );
      const onMac = await changes(mac);
      expect(onMac.status).toEqual(["NOTES.md", "README.md"]);
      await copied();

      // ---- To Cloud.
      await mac.call("session.move", {
        request_id: "moves-to-cloud",
        session_id: session,
        to: { computer_id: box.computerId },
      });
      await landed(box);
      expect(await changes(box)).toEqual(onMac);
      await turn(box, "cloud-1", "sh: printf 'in Cloud\\n' > CLOUD.md");
      const inCloud = await changes(box);
      expect(inCloud.status).toEqual(["CLOUD.md", "NOTES.md", "README.md"]);
      const there = (await journalOf(box, session)).events;
      expect(started(there)).toEqual([MODEL, MODEL]);
      expect(notes(there).filter((title) => /runs on .* now/.test(title))).toEqual([]);
      await copied();

      // ---- And back to This Mac.
      await mac.call("session.move", {
        request_id: "moves-back",
        session_id: session,
        to: "this_mac",
      });
      await landed(mac);
      await until(async () => done((await journalOf(mac, session)).events) === 2, 90_000);
      // The Mac has taken in what ran in Cloud (its journal first, then the files).
      await until(async () => (await changes(mac)).status.includes("CLOUD.md"), 60_000);
      expect(await changes(mac)).toEqual(inCloud);
      await turn(mac, "mac-2", "slow 50: back on the Mac");
      const back = (await journalOf(mac, session)).events;
      expect(started(back)).toEqual([MODEL, MODEL, MODEL]);
      expect(notes(back).filter((title) => /runs on .* now/.test(title))).toEqual([]);
    } finally {
      await world.close();
    }
  },
  420_000,
);
