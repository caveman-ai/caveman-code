// A stop Cloud names in the heartbeat reply (docs/ CONTRACT §5.1, SPEC §7.3;
// formal/NothingLost.tla's Announce, Park, StopAcked, StopDeadline and Wake). A Cloud computer whose chat is inside a
// tool when the stop comes lets the tool finish, stops the turn at that boundary, copies the chat whole and only then
// says `parked`; a message meanwhile waits in Cloud's queue. After the computer went down and woke on the same disk, or
// the stop was called off, the turn carries on, told what already ran, and the queued message is answered. A tool that
// outlives the stop's deadline is never cut by the runtime and never acknowledged: Cloud takes the computer down
// mid-tool, and after the wake the turn carries on as after any crash (upstream restart continuation), told that a command
// it started may or may not have finished, and nothing carries it on a second time. A person's message to a computer
// parked for an idle stop calls the stop off at once: the heartbeat that follows says the computer is in use.
//
// Real runtime processes (four Cloud computers, one case each, at once: a stop is heard on the 30 s heartbeat), the
// real Claude Agent adapter and SDK on the no-model CLI, and the stand-in Cloud.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until as untilNow } from "../session-protocol/testHarness.ts";
import {
  copyOfChat,
  journalOf,
  REPO,
  sleep,
  Trace,
  World,
  type RuntimeProc,
} from "./chaos/world.ts";

/** Looked at four times a second: several cases run at once, each reading whole journals. */
const until = (check: () => boolean | Promise<boolean>, ms = 20_000) =>
  untilNow(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return check();
  }, ms);
type Event<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
const of = <T extends SessionEvent["type"]>(events: ReadonlyArray<SessionEvent>, type: T) =>
  events.filter((e): e is Event<T> => e.type === type);
const said = (events: ReadonlyArray<SessionEvent>, role: "user" | "assistant") =>
  of(events, "message.done").filter((e) => e.payload.role === role);
/** The note the runtime writes for the engine when a stopped turn carries on. */
const CARRIES_ON =
  "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now.";

// Skipped on Windows: a Cloud computer is Linux, and adopts a chat in its checkout only where owner uid and mode bits
// show the agent cannot write it (gitTrusts).
test.skipIf(process.platform === "win32")(
  "a stop parks a chat at its next tool boundary, says parked only once the copy holds all of it, and the turn carries on after the wake, a call-off, or a missed deadline",
  async () => {
    const world = new World({ trace: new Trace(), cloudComputers: 4 });
    const made: Array<{ readonly box: RuntimeProc; readonly sessionId: string }> = [];
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
      /** How many heartbeats of `box` Cloud has answered. */
      const beats = (box: RuntimeProc) =>
        cloud.state.heartbeats.filter(
          (h) => cloud.state.tokens.get(h.token)?.runtimeId === box.runtimeId,
        ).length;
      /** Cloud answered a heartbeat of `box` that reached it after now, and the runtime had 2 s to read the reply: it has Cloud's word as it stands. */
      const heard = async (box: RuntimeProc) => {
        const before = beats(box);
        await until(() => beats(box) > before, 90_000);
        await sleep(2_000);
      };

      /** A chat on `box` with one turn copied, now inside a shell command that takes `toolMs` and writes built.txt as it ends; the engine then thinks on. */
      const midTool = async (box: RuntimeProc, label: string, toolMs: number) => {
        const w = await createReady(box.admin! as Parameters<typeof createReady>[0], {
          request_id: `w-${label}`,
          repo: { url: `https://github.com/${REPO}` },
          title: label,
          engine: "claude-agent",
          options: { model: MODEL },
        });
        const sessionId = w.session_id;
        await box.call("turn.submit", {
          request_id: `first-${label}`,
          session_id: sessionId,
          kind: "followup",
          input: { text: "slow 50: before the stop" },
        });
        await until(
          async () => of((await journalOf(box, sessionId)).events, "turn.done").length === 1,
          60_000,
        );
        await until(
          () => cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
          60_000,
        );
        await box.call("turn.submit", {
          request_id: `long-${label}`,
          session_id: sessionId,
          kind: "followup",
          input: { text: `run ${toolMs}: built.txt done hold 600000` },
        });
        // The turn's own command (the chat's first event is the checkout that made its branch).
        const command = async () =>
          of((await journalOf(box, sessionId)).events, "tool.started").find(
            (e) => e.turn_id !== undefined && e.payload.kind === "command",
          );
        await until(async () => (await command()) !== undefined, 60_000);
        const tool = (await command())!;
        made.push({ box, sessionId });
        // The computer's first chat holds its checkout.
        return { box, sessionId, built: path.join(box.checkout!, "built.txt"), tool };
      };
      type Chat = Awaited<ReturnType<typeof midTool>>;
      const queue = (chat: Chat, requestId: string, text: string) =>
        person("POST", `chats/${chat.sessionId}/calls`, {
          request_id: requestId,
          method: "turn.submit",
          params: { session_id: chat.sessionId, kind: "followup", input: { text } },
          device_id: "phone-1",
        });
      const call = (chat: Chat, requestId: string) =>
        person("GET", `chats/${chat.sessionId}/calls/${requestId}`);

      /**
       * The stop is named mid-tool and acknowledged: what the journal and Cloud's copy held as `parked` arrived, and a
       * message sent meanwhile, which waits in Cloud.
       */
      const parks = async (chat: Chat, label: string, reason: "usage" | "owner") => {
        const { box, sessionId } = chat;
        const waits = cloud.waitsForParked(box.computerId);
        const stop = cloud.setStop(box.computerId, reason, 300_000);
        await heard(box);
        // The stop stands and the tool runs on: nothing is cut, nothing is said, and no new turn starts here.
        const during = await journalOf(box, sessionId);
        const refused = await box
          .call("turn.submit", {
            request_id: `refused-${label}`,
            session_id: sessionId,
            kind: "followup",
            input: { text: "slow 50: sent while it stops" },
          })
          .then(
            () => "ran",
            (error: Error & { error?: { data?: { reason?: string } } }) =>
              error.error?.data?.reason ?? error.message,
          );
        const midway = {
          toolDone: of(during.events, "tool.done").some((e) => e.item_id === chat.tool.item_id),
          turnsDone: of(during.events, "turn.done").length,
          built: fs.existsSync(chat.built),
          parked: cloud.parkedFor(stop) !== undefined,
          refused,
        };
        await queue(chat, `queued-${label}`, "slow 50: queued while it was parked");
        await until(() => cloud.parkedFor(stop) !== undefined, 180_000);
        const parked = cloud.parkedFor(stop)!;
        const journal = await journalOf(box, sessionId);
        const done = of(journal.events, "tool.done").find((e) => e.item_id === chat.tool.item_id);
        const stopped = of(journal.events, "turn.done").at(-1)!;
        // Cloud's copy as it stood when `parked` arrived.
        const copy = copyOfChat(world, sessionId, parked.copies[sessionId]?.segments)!;
        return {
          stop,
          head: journal.events.length,
          epoch: journal.epoch,
          // Its heartbeats said it parks, so Cloud waits for its word.
          waits,
          midway,
          // The tool ended by itself, before the turn was stopped; the file it wrote as it ended is there.
          tool: {
            status: done?.payload.status,
            beforeTheStop: (done?.cursor ?? Infinity) < stopped.cursor,
            built: fs.readFileSync(chat.built, "utf8"),
          },
          turn: { status: stopped.payload.status, turns: of(journal.events, "turn.done").length },
          note: of(journal.events, "notification").some(
            (e) => e.payload.title === "Paused while this computer sleeps",
          ),
          // `parked` came once, for the stop that stands, after the copy held every event and the file.
          parkedFor: {
            current: parked.current,
            times: cloud.state.parked.filter((p) => p.stop === stop).length > 0,
            copied: parked.copies[sessionId]?.cursor_seq,
            copyEvents: copy.bundle.events.length,
            copyBuilt: copy.show("built.txt"),
          },
          // Not run and not refused: it waits in Cloud's mail (handed out and let go again while the stop stands).
          queued: ["queued", "delivered"].includes((await call(chat, `queued-${label}`)).status)
            ? "waits"
            : (await call(chat, `queued-${label}`)).status,
        };
      };
      /** After the stop is gone: the stopped turn carried on and ended, and the queued message was answered. */
      const carriedOn = async (chat: Chat, label: string) => {
        const { box, sessionId } = chat;
        await until(async () => {
          const events = (await journalOf(box, sessionId)).events;
          return (
            said(events, "user").some((e) =>
              e.payload.text.includes("queued while it was parked"),
            ) &&
            of(events, "turn.started").length === of(events, "turn.done").length &&
            (await call(chat, `queued-${label}`)).status === "done"
          );
        }, 180_000);
        const events = (await journalOf(box, sessionId)).events;
        const note = said(events, "user").filter((e) => e.payload.text.startsWith(CARRIES_ON));
        const continued = of(events, "turn.done").find((e) => e.turn_id === note[0]?.turn_id);
        const answered = of(events, "turn.done").find(
          (e) =>
            e.turn_id ===
            said(events, "user").find((m) => m.payload.text.includes("queued while it was parked"))
              ?.turn_id,
        );
        return {
          notes: note.length,
          // The engine is told the command already ran, and does not run it again.
          told:
            note[0]?.payload.text.includes(
              `- ${chat.tool.payload.title.replace(/\s+/g, " ").slice(0, 160)} (completed)`,
            ) === true,
          continued: continued?.payload.status,
          commands: of(events, "tool.started").filter(
            (e) => e.turn_id !== undefined && e.payload.kind === "command",
          ).length,
          queuedSaid: said(events, "user").filter((e) =>
            e.payload.text.includes("queued while it was parked"),
          ).length,
          queuedAnswered: answered?.payload.status,
          refusedSaid: said(events, "user").filter((e) =>
            e.payload.text.includes("sent while it stops"),
          ).length,
          built: fs.readFileSync(chat.built, "utf8"),
        };
      };

      const [boxA, boxB, boxC, boxD] = [
        world.boxA,
        world.boxB,
        world.runtimes[3]!,
        world.runtimes[4]!,
      ];
      const [acked, calledOff, deadline, idle] = await Promise.all([
        // The stop is acknowledged, Cloud stops the runtime cleanly (systemctl stop) and takes the computer down, and it
        // wakes on the same disk.
        (async () => {
          const chat = await midTool(boxA, "acked", 50_000);
          const parked = await parks(chat, "acked", "usage");
          const starts = boxA.starts;
          const clean = await boxA.term();
          cloud.clearStop(boxA.computerId);
          await boxA.start();
          const after = await carriedOn(chat, "acked");
          // A clean stop after parking counts no chat as crashed: the journal keeps its epoch.
          return {
            parked,
            after,
            restarted: boxA.starts === starts + 1,
            clean,
            sameEpoch: (await journalOf(boxA, chat.sessionId)).epoch === parked.epoch,
          };
        })(),
        // The stop is acknowledged and then called off (the owner changed their mind): the same runtime carries the turn on.
        (async () => {
          const chat = await midTool(boxB, "called-off", 50_000);
          const parked = await parks(chat, "called-off", "owner");
          const starts = boxB.starts;
          cloud.clearStop(boxB.computerId);
          const after = await carriedOn(chat, "called-off");
          // It stops saying parked once the stop is gone.
          await heard(boxB);
          return {
            parked,
            after,
            restarted: boxB.starts !== starts,
            stillSaysParked:
              cloud.state.heartbeats.findLast(
                (h) => cloud.state.tokens.get(h.token)?.runtimeId === boxB.runtimeId,
              )?.parked !== undefined,
          };
        })(),
        // The tool outlives the stop's deadline: never cut, never acknowledged; Cloud takes the computer down mid-tool.
        (async () => {
          const chat = await midTool(boxC, "deadline", 600_000);
          const stop = cloud.setStop(boxC.computerId, "funding", 5_000);
          await heard(boxC);
          // Past the deadline, the stop known here (no turn starts), the tool runs on and nothing is acknowledged.
          await sleep(8_000);
          const refused = await boxC
            .call("turn.submit", {
              request_id: "refused-deadline",
              session_id: chat.sessionId,
              kind: "followup",
              input: { text: "slow 50: sent while it stops" },
            })
            .then(
              () => "ran",
              (error: Error & { error?: { data?: { reason?: string } } }) =>
                error.error?.data?.reason ?? error.message,
            );
          const during = (await journalOf(boxC, chat.sessionId)).events;
          const before = {
            refused,
            toolDone: of(during, "tool.done").some((e) => e.item_id === chat.tool.item_id),
            turnsDone: of(during, "turn.done").length,
            parked: cloud.parkedFor(stop) !== undefined,
          };
          await boxC.kill();
          cloud.clearStop(boxC.computerId);
          await boxC.start();
          await until(async () => {
            const events = (await journalOf(boxC, chat.sessionId)).events;
            return of(events, "turn.started").length === 3 && of(events, "turn.done").length === 3;
          }, 180_000);
          // Nothing more comes: no second continuation beside the restart's.
          await sleep(10_000);
          const events = (await journalOf(boxC, chat.sessionId)).events;
          const resumed = of(events, "notification").filter(
            (e) => e.payload.title === "Caveman Code restarted and resumed this turn",
          );
          return {
            before,
            resumed: resumed.length,
            // The engine is told the command may or may not have finished: it is never run again without a word.
            told: /may have finished or may still be running/.test(resumed[0]?.payload.body ?? ""),
            continued: of(events, "turn.done").find((e) => e.turn_id === resumed[0]?.turn_id)
              ?.payload.status,
            turns: of(events, "turn.started").length,
            notes: said(events, "user").filter((e) => e.payload.text.startsWith(CARRIES_ON)).length,
            commands: of(events, "tool.started").filter(
              (e) => e.turn_id !== undefined && e.payload.kind === "command",
            ).length,
            built: fs.existsSync(chat.built),
            parked: cloud.parkedFor(stop) !== undefined,
          };
        })(),
        // An idle computer parks for an idle stop; a person's message then calls the stop off at once.
        (async () => {
          const w = await createReady(boxD.admin! as Parameters<typeof createReady>[0], {
            request_id: "w-idle",
            repo: { url: `https://github.com/${REPO}` },
            title: "idle",
            engine: "claude-agent",
            options: { model: MODEL },
          });
          const sessionId = w.session_id;
          made.push({ box: boxD, sessionId });
          await boxD.call("turn.submit", {
            request_id: "first-idle",
            session_id: sessionId,
            kind: "followup",
            input: { text: "slow 50: before it idles" },
          });
          await until(
            async () => of((await journalOf(boxD, sessionId)).events, "turn.done").length === 1,
            60_000,
          );
          // Cloud asks an idle computer only: a heartbeat since the turn ended says it is not in use.
          const since = cloud.state.heartbeats.length;
          await until(
            () =>
              cloud.state.heartbeats
                .slice(since)
                .some(
                  (h) => cloud.state.tokens.get(h.token)?.runtimeId === boxD.runtimeId && !h.active,
                ),
            150_000,
          );
          const stop = cloud.setStop(boxD.computerId, "idle", 300_000);
          await until(() => cloud.parkedFor(stop) !== undefined, 120_000);
          // The person's message reaches the parked computer directly: refused, and Cloud hears at once that it is in use.
          const sentAt = Date.now();
          const refused = await boxD
            .call("turn.submit", {
              request_id: "direct-idle",
              session_id: sessionId,
              kind: "followup",
              input: { text: "slow 50: wakes it" },
            })
            .then(
              () => "ran",
              (error: Error & { error?: { data?: { reason?: string } } }) =>
                error.error?.data?.reason ?? error.message,
            );
          await until(() => cloud.state.lifecycle.get(boxD.computerId)?.stop === undefined, 20_000);
          const calledOffAtOnce = Date.now() - sentAt < 5_000;
          // The device, told lease_lost, queues the message in Cloud; the computer, its stop gone, runs it.
          await person("POST", `chats/${sessionId}/calls`, {
            request_id: "direct-idle",
            method: "turn.submit",
            params: {
              session_id: sessionId,
              kind: "followup",
              input: { text: "slow 50: wakes it" },
            },
            device_id: "phone-1",
          });
          await until(async () => {
            const events = (await journalOf(boxD, sessionId)).events;
            return of(events, "turn.started").length === 2 && of(events, "turn.done").length === 2;
          }, 120_000);
          const events = (await journalOf(boxD, sessionId)).events;
          const asked = said(events, "user").filter((e) => e.payload.text === "slow 50: wakes it");
          return {
            parked: true,
            refused,
            calledOffAtOnce,
            said: asked.length,
            answered: of(events, "turn.done").find((e) => e.turn_id === asked[0]?.turn_id)?.payload
              .status,
          };
        })(),
      ]);

      const parkedWhole = (parked: typeof acked.parked) => ({
        epoch: parked.epoch,
        waits: true,
        midway: {
          toolDone: false,
          turnsDone: 1,
          built: false,
          parked: false,
          refused: "lease_lost",
        },
        tool: { status: "completed", beforeTheStop: true, built: "done\n" },
        turn: { status: "interrupted", turns: 2 },
        note: true,
        parkedFor: {
          current: true,
          times: true,
          copied: parked.head,
          copyEvents: parked.head,
          copyBuilt: "done\n",
        },
        queued: "waits",
      });
      const after = {
        notes: 1,
        told: true,
        continued: "completed",
        commands: 1,
        queuedSaid: 1,
        queuedAnswered: "completed",
        refusedSaid: 0,
        built: "done\n",
      };
      expect({ ...acked.parked, stop: undefined, head: undefined }).toEqual({
        ...parkedWhole(acked.parked),
        stop: undefined,
        head: undefined,
      });
      expect({
        after: acked.after,
        restarted: acked.restarted,
        clean: acked.clean,
        sameEpoch: acked.sameEpoch,
      }).toEqual({ after, restarted: true, clean: true, sameEpoch: true });
      expect({ ...calledOff.parked, stop: undefined, head: undefined }).toEqual({
        ...parkedWhole(calledOff.parked),
        stop: undefined,
        head: undefined,
      });
      expect({
        after: calledOff.after,
        restarted: calledOff.restarted,
        stillSaysParked: calledOff.stillSaysParked,
      }).toEqual({ after, restarted: false, stillSaysParked: false });
      expect(idle).toEqual({
        parked: true,
        refused: "lease_lost",
        calledOffAtOnce: true,
        said: 1,
        answered: "completed",
      });
      expect(deadline).toEqual({
        before: { refused: "lease_lost", toolDone: false, turnsDone: 1, parked: false },
        resumed: 1,
        told: true,
        continued: "completed",
        turns: 3,
        notes: 0,
        commands: 1,
        built: false,
        parked: false,
      });
    } catch (error) {
      console.error(world.trace.tail(80));
      for (const { box, sessionId } of made) {
        const events = await journalOf(box, sessionId).then(
          (j) => j.events,
          () => [],
        );
        console.error(
          `---- ${box.name}'s journal\n${events.map((e) => `${e.cursor} ${e.type} ${e.turn_id?.slice(-12) ?? ""} ${JSON.stringify(e.payload).slice(0, 160)}`).join("\n")}`,
        );
      }
      for (const rt of world.runtimes.slice(1))
        console.error(
          `---- ${rt.name}\n${
            fs.existsSync(rt.logFile)
              ? fs
                  .readFileSync(rt.logFile, "utf8")
                  .split("\n")
                  .filter((line) => /parking|stop|moves:|copy:|WARN|ERROR/i.test(line))
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
  600_000,
);

// R3 of cloud-computers-2026-11-09: what a shell command wrote used to wait for the turn's end (only a tool that names
// its files marked them changed), so a long turn that built with commands had nothing of it in Cloud's copy.
test.skipIf(process.platform === "win32")(
  "what a shell command wrote is in Cloud's copy while its turn still runs",
  async () => {
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const box = world.boxA;
      const w = await createReady(box.admin! as Parameters<typeof createReady>[0], {
        request_id: "w-r3",
        repo: { url: `https://github.com/${REPO}` },
        title: "Command",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await box.call("turn.submit", {
        request_id: "first-r3",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 50: before the command" },
      });
      await until(
        async () => of((await journalOf(box, sessionId)).events, "turn.done").length === 1,
        60_000,
      );
      await until(
        () => world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
        60_000,
      );
      // A command that takes 1.5 s and writes a file, in a turn that then goes on for minutes.
      await box.call("turn.submit", {
        request_id: "long-r3",
        session_id: sessionId,
        kind: "followup",
        input: { text: "run 1500: made.txt yes hold 600000" },
      });
      await until(async () => {
        await sleep(500);
        return copyOfChat(world, sessionId)?.show("made.txt") === "yes\n";
      }, 60_000);
      const events = (await journalOf(box, sessionId)).events;
      expect({
        turnsDone: of(events, "turn.done").length,
        boundary: world.cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary,
      }).toEqual({ turnsDone: 1, boundary: false });
      await box.call("turn.interrupt", { request_id: "stop-r3", session_id: sessionId });
      await until(
        async () => of((await journalOf(box, sessionId)).events, "turn.done").length === 2,
        60_000,
      );
    } finally {
      await world.close();
    }
  },
  240_000,
);

// The gate before each tool (SPEC §7.3, engine-core ToolGate): the gap the park had. A tool that started between the
// park's look for a running tool and its interrupt was cut. Now a tool that would start once a stop stands is held at
// the gate and never runs. With CAVEMAN_TOOL_GATE=off in the environment this case fails: the second command starts
// while the stop stands.
test.skipIf(process.platform === "win32")(
  "no tool starts once a stop stands: the command that would run next is held, the turn parks at that boundary with the command never started, and carries on once the stop is called off",
  async () => {
    // Every command the engine starts adds a line here (the stand-in CLI's SMOKE_CLAUDE_RUN_LOG).
    const runLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stop-gate-")), "runs.log");
    process.env.SMOKE_CLAUDE_RUN_LOG = runLog;
    const started = () =>
      fs.existsSync(runLog) ? fs.readFileSync(runLog, "utf8").split("\n").filter(Boolean) : [];
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const { cloud } = world;
      const box = world.boxA;
      const w = await createReady(box.admin! as Parameters<typeof createReady>[0], {
        request_id: "w-gate",
        repo: { url: `https://github.com/${REPO}` },
        title: "Gate",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await box.call("turn.submit", {
        request_id: "first-gate",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 50: before the stop" },
      });
      await until(
        async () => of((await journalOf(box, sessionId)).events, "turn.done").length === 1,
        60_000,
      );
      await until(
        () => cloud.state.chats.sessions.get(sessionId)?.segments.at(-1)?.boundary === true,
        60_000,
      );
      // Two commands, one after the other: the first takes 50 s (a stop is heard on the 30 s heartbeat), and the second
      // would start the moment the first ends.
      await box.call("turn.submit", {
        request_id: "two-gate",
        session_id: sessionId,
        kind: "followup",
        input: { text: "run 50000: first.txt one run 1000: second.txt two" },
      });
      await until(() => started().includes("started first.txt"), 60_000);
      const stop = cloud.setStop(box.computerId, "owner", 300_000);
      await until(() => cloud.parkedFor(stop) !== undefined, 180_000);
      const parked = (await journalOf(box, sessionId)).events;
      const commands = of(parked, "tool.started").filter(
        (e) => e.turn_id !== undefined && e.payload.kind === "command",
      );
      const ends = commands.map(
        (command) =>
          of(parked, "tool.done").find((e) => e.item_id === command.item_id)?.payload.status,
      );
      expect({
        // The first command ended by itself, and what it wrote as it ended is there.
        first: fs.readFileSync(path.join(box.checkout!, "first.txt"), "utf8"),
        // The second never started: nothing of it ran, so nothing of it was cut.
        started: started(),
        second: fs.existsSync(path.join(box.checkout!, "second.txt")),
        turn: of(parked, "turn.done").at(-1)?.payload.status,
        firstEnded: ends[0],
      }).toEqual({
        first: "one\n",
        started: ["started first.txt"],
        second: false,
        turn: "interrupted",
        firstEnded: "completed",
      });
      // Called off: the turn carries on here, told the first command ran.
      cloud.clearStop(box.computerId);
      await until(async () => {
        const events = (await journalOf(box, sessionId)).events;
        return (
          said(events, "user").some((e) => e.payload.text.startsWith(CARRIES_ON)) &&
          of(events, "turn.started").length === of(events, "turn.done").length
        );
      }, 180_000);
      const after = (await journalOf(box, sessionId)).events;
      const note = said(after, "user").find((e) => e.payload.text.startsWith(CARRIES_ON))!.payload
        .text;
      expect(note).toContain(
        `- ${commands[0]!.payload.title.replace(/\s+/g, " ").slice(0, 160)} (completed)`,
      );
      expect(of(after, "turn.done").at(-1)?.payload.status).toBe("completed");
      expect(started()).toEqual(["started first.txt"]);
    } catch (error) {
      console.error(world.trace.tail(60));
      throw error;
    } finally {
      delete process.env.SMOKE_CLAUDE_RUN_LOG;
      await world.close();
    }
  },
  480_000,
);
