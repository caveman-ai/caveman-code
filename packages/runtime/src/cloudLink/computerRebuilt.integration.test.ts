// A Cloud computer that comes back without its chats, or with a disk older than their copies (docs/
// cloud-computers-2026-11-09 CONTRACT §5.2, SPEC §7.1; findings R1 and R2; formal/NothingLost.tla's Crash and Wake with
// ReAdopt). On link-up the runtime asks Cloud which chats live here and takes each from its copy: the whole transcript,
// the uncommitted files, the turn checkpoints, under a new epoch, with a note that it continued from its last copy, and
// the next message is answered; a restore to a turn from before the disk was lost puts the files back to that turn's
// checkpoint and hands the engine the conversation up to it. A disk older than the copy ends with the copy's state, and
// the copy never goes backwards. A call queued for a chat the computer holds no record of takes the chat from its copy and is answered,
// also under a Cloud from before the list (which otherwise leaves the computer with what its disk has, as before).
//
// Real runtime processes (three Cloud computers, git in a tools container as in production), the real Claude Agent
// adapter and SDK on the no-model CLI, and the stand-in Cloud.
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, git, MODEL, until } from "../session-protocol/testHarness.ts";
import {
  copyOfChat,
  eventKey,
  journalOf,
  REPO,
  sleep,
  Trace,
  World,
  type RuntimeProc,
} from "./chaos/world.ts";

type Event<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
const of = <T extends SessionEvent["type"]>(events: ReadonlyArray<SessionEvent>, type: T) =>
  events.filter((e): e is Event<T> => e.type === type);
const CONTINUED = "Continued from its last copy";
/** Whether the engine answered in that turn with the person's message in hand (the no-model CLI says back what it was asked). */
const answeredWith = (
  events: ReadonlyArray<SessionEvent>,
  turnId: string | undefined,
  text: string,
) =>
  of(events, "message.done").some(
    (e) => e.turn_id === turnId && e.payload.role === "assistant" && e.payload.text.includes(text),
  );

// Skipped on Windows: a Cloud computer is Linux, and its git runs in a tools container over a Unix socket.
test.skipIf(process.platform === "win32")(
  "a Cloud computer that comes back on an empty or older disk takes its chats back from their copies: transcript, files, checkpoints, and the next message answered",
  async () => {
    const world = new World({ trace: new Trace(), cloudComputers: 3, tools: true });
    try {
      await world.start();
      const { cloud } = world;
      const person = async (method: string, route: string, body?: unknown) => {
        const response = await fetch(`${cloud.url}/api/v1/code/${route}`, {
          method,
          headers: {
            authorization: `Bearer ${cloud.state.personToken}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return (await response.json()) as Record<string, any>;
      };
      const chatOn = async (box: RuntimeProc, label: string) =>
        (
          await createReady(box.admin! as Parameters<typeof createReady>[0], {
            request_id: `w-${label}`,
            repo: { url: `https://github.com/${REPO}` },
            title: label,
            engine: "claude-agent",
            options: { model: MODEL },
          })
        ).session_id;
      /** One turn of the chat, to its end. */
      const turn = async (box: RuntimeProc, sessionId: string, requestId: string, text: string) => {
        const before = of((await journalOf(box, sessionId)).events, "turn.done").length;
        await box.call("turn.submit", {
          request_id: requestId,
          session_id: sessionId,
          kind: "followup",
          input: { text },
        });
        await until(
          async () => of((await journalOf(box, sessionId)).events, "turn.done").length > before,
          90_000,
        );
      };
      /** Cloud's copy holds all the chat's journal has on `box`, files and checkpoints of its last turn too. */
      const copied = async (box: RuntimeProc, sessionId: string) => {
        // Cloud accepts the journal index before the runtime commits its copy record. Killing or snapshotting
        // it in between captures older copy metadata, so wait for both sides before changing its disk.
        const db = new DatabaseSync(box.info!.dbPath);
        try {
          const read = db.prepare("SELECT value FROM caveman_sp_kv WHERE key = ?");
          await until(async () => {
            const { epoch, events } = await journalOf(box, sessionId);
            const head = events.length;
            const session = cloud.state.chats.sessions.get(sessionId);
            const row = read.get(`moves:${sessionId}`);
            const local =
              row === undefined
                ? undefined
                : (JSON.parse(String(row.value)) as {
                    cursor: number;
                    epoch: number;
                    boundary: boolean;
                  });
            return (
              session !== undefined &&
              session.cursor_seq >= head &&
              session.segments.at(-1)?.boundary === true &&
              local?.epoch === epoch &&
              local.cursor >= head &&
              local.boundary === true
            );
          }, 90_000);
        } finally {
          db.close();
        }
      };
      /** The chat as its computer has it: its journal, and the commit of every turn checkpoint it journaled. */
      const stateOf = async (box: RuntimeProc, sessionId: string) => {
        const journal = await journalOf(box, sessionId);
        const checkpoints = Object.fromEntries(
          of(journal.events, "checkpoint.created").map((e) => [
            e.payload.ref,
            git(
              box.checkout!,
              "rev-parse",
              "--verify",
              "--quiet",
              `${e.payload.ref}^{commit}`,
            ).trim(),
          ]),
        );
        return { epoch: journal.epoch, keys: journal.events.map(eventKey), checkpoints };
      };
      /** Where a file of a chat is on `box`: in the checkout or in a chat's worktree beside it. */
      const fileOn = (box: RuntimeProc, rel: string) => {
        const roots = git(box.checkout!, "worktree", "list", "--porcelain")
          .split("\n")
          .flatMap((line) =>
            line.startsWith("worktree ") ? [line.slice("worktree ".length)] : [],
          );
        const found = roots
          .map((root) => path.join(root, rel))
          .filter((file) => fs.existsSync(file));
        return found.length === 1
          ? fs.readFileSync(found[0]!, "utf8")
          : found.length === 0
            ? undefined
            : `in ${found.length} checkouts`;
      };
      const checkpointsOn = (box: RuntimeProc, refs: Record<string, string>) =>
        Object.fromEntries(
          Object.keys(refs).map((ref) => {
            try {
              return [
                ref,
                git(box.checkout!, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim(),
              ];
            } catch {
              return [ref, "missing"];
            }
          }),
        );
      /** The chat on `box` after it came back: what of `before` its journal begins with, its epoch, its note, its checkpoints, and a new message answered. */
      const back = async (
        box: RuntimeProc,
        sessionId: string,
        before: Awaited<ReturnType<typeof stateOf>>,
        label: string,
      ) => {
        await until(
          async () =>
            (await box.call("workspace.list", {})).workspaces.some(
              (w) => w.session_id === sessionId && w.status !== "starting",
            ),
          120_000,
        );
        await until(
          async () =>
            of((await journalOf(box, sessionId)).events, "notification").some(
              (e) => e.payload.title === CONTINUED,
            ),
          60_000,
        );
        const adopted = await journalOf(box, sessionId);
        const noted =
          of(adopted.events, "notification").find((e) => e.payload.title === CONTINUED)?.payload
            .body ?? "";
        await turn(box, sessionId, `after-${label}`, `and now ${label}`);
        const events = (await journalOf(box, sessionId)).events;
        const asked = of(events, "message.done").findLast(
          (e) => e.payload.role === "user" && e.payload.text === `and now ${label}`,
        );
        return {
          transcript:
            adopted.events.slice(0, before.keys.length).map(eventKey).join("\n") ===
            before.keys.join("\n"),
          newEpoch: adopted.epoch > before.epoch,
          notes: of(adopted.events, "notification").filter((e) => e.payload.title === CONTINUED)
            .length,
          // Said plainly where Cloud's row for the computer says its disk was lost.
          diskLost: noted.startsWith(
            "Caveman lost this Cloud computer's disk, so this chat continues from the copy Caveman keeps of it.",
          ),
          checkpoints:
            JSON.stringify(checkpointsOn(box, before.checkpoints)) ===
            JSON.stringify(before.checkpoints),
          checkpointCount: Object.keys(before.checkpoints).length,
          answered: of(events, "turn.done").find((e) => e.turn_id === asked?.turn_id)?.payload
            .status,
          said: answeredWith(events, asked?.turn_id, `and now ${label}`),
        };
      };

      const [boxA, boxB, boxC] = [world.boxA, world.boxB, world.runtimes[3]!];
      const [empty, older] = await Promise.all([
        // An empty disk: two chats with history, uncommitted files and checkpoints; the state dir and the checkout gone.
        (async () => {
          const one = await chatOn(boxA, "First chat");
          await turn(boxA, one, "one-1", "create: notes.txt first");
          await turn(boxA, one, "one-2", "create: more.txt second");
          const two = await chatOn(boxA, "Second chat");
          await turn(boxA, two, "two-1", "create: two.txt other");
          await copied(boxA, one);
          await copied(boxA, two);
          const before = { one: await stateOf(boxA, one), two: await stateOf(boxA, two) };
          const files = {
            notes: fileOn(boxA, "notes.txt"),
            more: fileOn(boxA, "more.txt"),
            two: fileOn(boxA, "two.txt"),
          };
          const lists = cloud.state.chats.sessionsHereReads.filter(
            (r) => r.computer_id === boxA.computerId,
          ).length;
          await boxA.kill();
          world.newDisk(boxA, "empty");
          // Cloud records that it lost the disk it kept for this computer (SPEC §7.4).
          Object.assign(cloud.state.chats.computers.get(boxA.computerId)!, {
            disk_lost_at: new Date().toISOString(),
            disk_lost_reason: "volume not found",
          });
          const emptied = {
            state: fs.readdirSync(boxA.base),
            checkout: fs.readdirSync(boxA.checkout!),
          };
          await boxA.start();
          const after = {
            one: await back(boxA, one, before.one, "one"),
            two: await back(boxA, two, before.two, "two"),
          };
          const filesAfter = {
            notes: fileOn(boxA, "notes.txt"),
            more: fileOn(boxA, "more.txt"),
            two: fileOn(boxA, "two.txt"),
          };
          // Back to the first chat's first turn, which ended before the disk was lost: its checkpoint came with the copy.
          const firstDone = of((await journalOf(boxA, one)).events, "turn.done")[0]!;
          const restored = await boxA
            .call("session.restore", {
              request_id: "restore-one",
              session_id: one,
              at: firstDone.cursor,
            })
            .then(
              (out) => out.branch?.title ?? "no branch",
              (error: Error) => `refused: ${error.message}`,
            );
          await turn(boxA, one, "after-restore", "and after the restore");
          const events = (await journalOf(boxA, one)).events;
          const marker = of(events, "session.restored")[0];
          const asked = of(events, "message.done").findLast(
            (e) => e.payload.role === "user" && e.payload.text === "and after the restore",
          );
          const answer =
            of(events, "message.done").find(
              (e) => e.turn_id === asked?.turn_id && e.payload.role === "assistant",
            )?.payload.text ?? "";
          return {
            emptied,
            files,
            after,
            filesAfter,
            asked:
              cloud.state.chats.sessionsHereReads.filter((r) => r.computer_id === boxA.computerId)
                .length > lists,
            restore: {
              // What came after is kept as a branch, forked at the turn that ran here.
              restored,
              at: marker?.payload.at === firstDone.cursor,
              // The files are that turn's: the second turn's file is gone from the chat.
              files: of(events, "diff.changed")
                .findLast((e) => e.cursor < (marker?.cursor ?? 0))
                ?.payload.files.map((f) => f.path),
              answered: of(events, "turn.done").find((e) => e.turn_id === asked?.turn_id)?.payload
                .status,
              // The engine was handed the conversation up to that turn, and nothing after it.
              heard: { first: answer.includes("notes.txt"), second: answer.includes("more.txt") },
            },
          };
        })(),
        // An older disk: the volume as a snapshot had it two turns ago.
        (async () => {
          const chat = await chatOn(boxB, "Older disk");
          await turn(boxB, chat, "old-1", "create: a.txt one");
          await copied(boxB, chat);
          await boxB.kill();
          const snapshot = boxB.snapshotDisk();
          await boxB.start();
          await until(
            async () => (await boxB.call("cloud.status", {})).state === "connected",
            30_000,
          );
          await turn(boxB, chat, "old-2", "create: b.txt two");
          // (Written whole: the no-model CLI would act again on an edit it reads in a handed-over transcript.)
          await turn(boxB, chat, "old-3", "create: a.txt uno");
          await copied(boxB, chat);
          const before = await stateOf(boxB, chat);
          const copyBefore = {
            cursor: cloud.state.chats.sessions.get(chat)!.cursor_seq,
            segments: cloud.state.chats.sessions.get(chat)!.segments.length,
            keys: cloud.state.chats.copyOf(chat).map((e) => `${e.cursor}:${e.type}`),
          };
          await boxB.kill();
          boxB.replaceDisk(snapshot);
          const stale = {
            a: fs.readFileSync(path.join(boxB.checkout!, "a.txt"), "utf8"),
            b: fs.existsSync(path.join(boxB.checkout!, "b.txt")),
          };
          // The copy never goes backwards while the older disk comes up.
          let backwards = 0;
          const watch = setInterval(() => {
            const session = cloud.state.chats.sessions.get(chat);
            if (
              session === undefined ||
              session.cursor_seq < copyBefore.cursor ||
              session.segments.length < copyBefore.segments
            )
              backwards++;
          }, 50);
          await boxB.start();
          const after = await back(boxB, chat, before, "older");
          await copied(boxB, chat);
          clearInterval(watch);
          const kept = (() => {
            try {
              return (
                git(
                  boxB.checkout!,
                  "rev-parse",
                  "--verify",
                  "--quiet",
                  `refs/caveman/kept/${chat}`,
                ).trim() !== ""
              );
            } catch {
              return false;
            }
          })();
          return {
            stale,
            after,
            files: { a: fileOn(boxB, "a.txt"), b: fileOn(boxB, "b.txt") },
            backwards,
            // What the copy held before is still its beginning.
            copyGrew:
              cloud.state.chats
                .copyOf(chat)
                .slice(0, copyBefore.keys.length)
                .map((e) => `${e.cursor}:${e.type}`)
                .join("\n") === copyBefore.keys.join("\n") &&
              cloud.state.chats.sessions.get(chat)!.cursor_seq > copyBefore.cursor,
            copyFiles: {
              a: copyOfChat(world, chat)?.show("a.txt"),
              b: copyOfChat(world, chat)?.show("b.txt"),
            },
            kept,
          };
        })(),
      ]);

      // A Cloud from before the list: the computer comes up with what its disk has; a queued call for a chat it holds
      // no record of takes the chat from its copy, and is answered.
      const queuedCall = await (async () => {
        const chat = await chatOn(boxC, "Called");
        await turn(boxC, chat, "call-1", "create: kept.txt kept");
        await copied(boxC, chat);
        const before = await stateOf(boxC, chat);
        await boxC.kill();
        cloud.state.chats.sessionsHereUnknown = true;
        world.newDisk(boxC, "empty");
        await boxC.start();
        await until(
          async () => (await boxC.call("cloud.status", {})).state === "connected",
          30_000,
        );
        await sleep(8_000);
        const asBefore = (await boxC.call("workspace.list", {})).workspaces.length;
        await person("POST", `chats/${chat}/calls`, {
          request_id: "queued-unknown",
          method: "turn.submit",
          params: {
            session_id: chat,
            kind: "followup",
            input: { text: "queued for a chat it lost" },
          },
          device_id: "phone-1",
        });
        await until(
          async () => (await person("GET", `chats/${chat}/calls/queued-unknown`)).status === "done",
          180_000,
        );
        await until(async () => {
          const events = (await journalOf(boxC, chat)).events;
          return (
            of(events, "turn.started").length === of(events, "turn.done").length &&
            of(events, "message.done").some(
              (e) => e.payload.role === "user" && e.payload.text === "queued for a chat it lost",
            )
          );
        }, 90_000);
        const journal = await journalOf(boxC, chat);
        const asked = of(journal.events, "message.done").findLast(
          (e) => e.payload.role === "user" && e.payload.text === "queued for a chat it lost",
        );
        return {
          asBefore,
          transcript:
            journal.events.slice(0, before.keys.length).map(eventKey).join("\n") ===
            before.keys.join("\n"),
          notes: of(journal.events, "notification").filter((e) => e.payload.title === CONTINUED)
            .length,
          asked: of(journal.events, "message.done").filter(
            (e) => e.payload.role === "user" && e.payload.text === "queued for a chat it lost",
          ).length,
          answered: of(journal.events, "turn.done").find((e) => e.turn_id === asked?.turn_id)
            ?.payload.status,
          said: answeredWith(journal.events, asked?.turn_id, "queued for a chat it lost"),
          file: fileOn(boxC, "kept.txt"),
        };
      })();

      const taken = (checkpointCount: number, diskLost = false) => ({
        transcript: true,
        newEpoch: true,
        notes: 1,
        diskLost,
        checkpoints: true,
        checkpointCount,
        answered: "completed",
        said: true,
      });
      expect(empty).toEqual({
        emptied: { state: [], checkout: [] },
        files: { notes: "first\n", more: "second\n", two: "other\n" },
        after: { one: taken(2, true), two: taken(1, true) },
        filesAfter: { notes: "first\n", more: "second\n", two: "other\n" },
        asked: true,
        restore: {
          restored: "First chat (before restore)",
          at: true,
          files: ["notes.txt"],
          answered: "completed",
          heard: { first: true, second: false },
        },
      });
      expect(older).toEqual({
        stale: { a: "one\n", b: false },
        after: taken(3),
        files: { a: "uno\n", b: "two\n" },
        backwards: 0,
        copyGrew: true,
        copyFiles: { a: "uno\n", b: "two\n" },
        kept: false,
      });
      expect(queuedCall).toEqual({
        asBefore: 0,
        transcript: true,
        notes: 1,
        asked: 1,
        answered: "completed",
        said: true,
        file: "kept\n",
      });
    } catch (error) {
      console.error(world.trace.tail(80));
      for (const rt of world.runtimes.slice(1)) {
        for (const w of await rt.call("workspace.list", {}).then(
          (out) => out.workspaces,
          () => [],
        )) {
          const events = await journalOf(rt, w.session_id).then(
            (j) => j.events,
            () => [],
          );
          console.error(
            `---- ${rt.name}: ${w.title}\n${events
              .slice(-14)
              .map(
                (e) =>
                  `${e.cursor} ${e.type} ${e.turn_id?.slice(-12) ?? ""} ${JSON.stringify(e.payload).slice(0, 220)}`,
              )
              .join("\n")}`,
          );
        }
      }
      for (const rt of world.runtimes.slice(1))
        console.error(
          `---- ${rt.name}\n${
            fs.existsSync(rt.logFile)
              ? fs
                  .readFileSync(rt.logFile, "utf8")
                  .split("\n")
                  .filter((line) => /parking|moves:|copy:|journal:|WARN|ERROR/i.test(line))
                  .slice(-60)
                  .join("\n")
              : ""
          }`,
        );
      throw error;
    } finally {
      await world.close();
    }
  },
  900_000,
);
