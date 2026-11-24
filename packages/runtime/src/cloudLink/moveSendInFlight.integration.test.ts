// A send This Mac took in as the person moved the chat (chaos seed 1 at load 110: a send, a Stop, then session.move on
// the Mac). The send passed every check before the move began, but T3 took it in only after the move had parked the
// chat and made its last copy: its turn ran on the parked chat, past that copy, so the person's message was nowhere the
// chat went. Real runtime processes (This Mac and a Cloud computer), protocol clients and Claude Agent adapter; the test
// Cloud and the no-model CLI. The send waits between its checks and T3 (CHAOS_HOLD_SEND, chaos.runtime.ts) as that busy
// machine kept it waiting, 3.7 s.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { connect, type Client, type SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { createReady, MODEL, until } from "../session-protocol/testHarness.ts";
import { journalOf, Trace, World } from "./chaos/world.ts";

const userTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : [],
  );

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux, and adopts it in its checkout only where owner
// uid and mode bits show the agent cannot write it (gitTrusts); here it would never arrive.
test.skipIf(process.platform === "win32")(
  "a send on its way in as the person moves the chat is in the chat where it lands, and no turn of it runs on the computer it left past its last copy",
  async () => {
    const hold = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "move-send-hold-")), "release");
    const text = "slow 30000: sent as the chat moves";
    process.env.CHAOS_HOLD_SEND = "sent as the chat moves";
    process.env.CHAOS_HOLD_FILE = hold;
    const world = new World({ trace: new Trace() });
    let desktop: Client | undefined;
    try {
      await world.start();
      const w = await createReady(world.mac.admin! as Parameters<typeof createReady>[0], {
        request_id: "in-flight-workspace",
        repo: { path: world.macRepo },
        title: "Moved with a send on its way in",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await world.mac.call("turn.submit", {
        request_id: "in-flight-first",
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

      // The desktop's send: past every check (nothing moves the chat yet), not yet in T3.
      desktop = connect(world.mac.desktopPipe.url, world.mac.info!.token);
      const sent = desktop.call("turn.submit", {
        request_id: "in-flight-send",
        session_id: sessionId,
        kind: "followup",
        input: { text },
      });
      await until(() => fs.existsSync(`${hold}.held`), 30_000);
      // The person at the Mac moves the chat to a Cloud computer meanwhile, from another connection (the send's lane never
      // holds it up). The send goes on once the move has parked the chat, or once the move waits for it to land.
      const moved = world.mac.call("session.move", {
        request_id: "in-flight-move",
        session_id: sessionId,
        to: { computer_id: world.boxA.computerId },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.some((e) => e.type === "session.parked") ||
          fs.readFileSync(world.mac.logFile, "utf8").includes(`moves: ${sessionId} waits for`),
        60_000,
      );
      fs.writeFileSync(hold, "");
      expect(await sent).toMatchObject({ disposition: "started" });
      await moved;
      await until(
        async () =>
          world.ownerOf(sessionId) === world.boxA &&
          (await world.boxA.call("workspace.list", {})).workspaces.some(
            (x) => x.session_id === sessionId && x.status !== "starting",
          ),
        60_000,
      );

      // Where the chat landed: the person's message, once, in the turn the move stopped ("Stop this turn and move").
      const there = await journalOf(world.boxA, sessionId);
      expect(userTexts(there.events)).toEqual(["slow 50: before the move", text]);
      const turn = there.events.find(
        (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
      )?.turn_id;
      expect(
        there.events.find((e) => e.type === "turn.done" && e.turn_id === turn)?.payload,
      ).toMatchObject({ status: "interrupted" });
      // The computer it left: no turn of it journaled past the park its last copy ends with.
      const left = await journalOf(world.mac, sessionId);
      const parked = left.events.findIndex((e) => e.type === "session.parked");
      expect(
        left.events
          .slice(parked)
          .flatMap((e) =>
            e.type === "turn.started" || e.type === "message.done" || e.type === "turn.done"
              ? [`${e.cursor} ${e.type}`]
              : [],
          ),
      ).toEqual([]);
    } finally {
      delete process.env.CHAOS_HOLD_SEND;
      delete process.env.CHAOS_HOLD_FILE;
      desktop?.close();
      await world.close();
    }
  },
  240_000,
);

// A message the runtime writes for a chat is no send of the person's: during a move it was neither refused nor waited
// for, so a mail's wake that reached the chat as the move checked with Cloud got into T3 after the park and the last
// copy, ran nowhere the chat went (or on the parked chat). The park waits for what is on its way in and takes nothing
// more. The wake waits between its checks and T3 (CHAOS_HOLD_SEND) until the park waits for it, or the chat parked.
test.skipIf(process.platform === "win32")(
  "a mail's wake on its way in, sent while the move's park closes the chat, or sent once it moved, runs where the chat lands, the agent's",
  async () => {
    const hold = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "move-wake-hold-")), "release");
    const marker = "woken as the chat moves";
    process.env.CHAOS_HOLD_SEND = marker;
    process.env.CHAOS_HOLD_FILE = hold;
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const admin = world.mac.admin! as Parameters<typeof createReady>[0];
      const w = await createReady(admin, {
        request_id: "wake-moved-workspace",
        repo: { path: world.macRepo },
        title: "Moved as mail wakes it",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sender = await createReady(admin, {
        request_id: "wake-sender-workspace",
        repo: { path: world.macRepo },
        title: "Sends the mail",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const closer = await createReady(admin, {
        request_id: "wake-closer-workspace",
        repo: { path: world.macRepo },
        title: "Mails as the park closes",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await world.mac.call("turn.submit", {
        request_id: "wake-first",
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
        request_id: "wake-running",
        session_id: sessionId,
        kind: "followup",
        input: { text: "slow 60000: working as mail comes" },
      });
      await until(
        async () =>
          (await journalOf(world.mac, sessionId)).events.filter((e) => e.type === "turn.started")
            .length === 2,
        30_000,
      );

      // The person moves the chat; Cloud takes a while to check the move, and the mail comes meanwhile.
      world.cloud.state.chats.delay.check = 5_000;
      const moved = world.mac.call("session.move", {
        request_id: "wake-move",
        session_id: sessionId,
        to: { computer_id: world.boxA.computerId },
      });
      await until(() => world.cloud.state.chats.moveChecksPending > 0, 30_000);
      const mailed = world.mac.call("mail.task", {
        request_id: "wake-mail",
        session_id: sender.session_id,
        to_workspace_id: w.id,
        body: `Look at this, ${marker}.`,
      });
      await until(() => fs.existsSync(`${hold}.held`), 30_000);
      // The park closes the chat and waits for that wake on its way in. Another mail comes now: the park refuses its
      // wake (it would run past the move's last copy), which the move carries instead.
      await until(
        () =>
          fs
            .readFileSync(world.mac.logFile, "utf8")
            .includes(
              `moves: ${sessionId} waits for 1 message(s) on their way into it before it parks`,
            ),
        60_000,
      );
      await world.mac.call("mail.task", {
        request_id: "wake-mail-closing",
        session_id: closer.session_id,
        to_workspace_id: w.id,
        body: "Two, sent while the park closes the chat.",
      });
      fs.writeFileSync(hold, "");
      await mailed;
      await moved;
      delete world.cloud.state.chats.delay.check;
      await until(() => world.ownerOf(sessionId) === world.boxA, 60_000);
      // Mail to the chat once it moved: handed on to where it is now.
      await world.mac.call("mail.task", {
        request_id: "wake-mail-after",
        session_id: sender.session_id,
        to_workspace_id: w.id,
        body: "Three, sent once it moved.",
      });

      // Where the chat landed: each wake runs there, the agent's that sent it, never the person's.
      const fromOf = (events: ReadonlyArray<SessionEvent>, text: string) => {
        const said = events.find(
          (e) =>
            e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes(text),
        );
        return said?.type === "message.done" ? (said.payload.from ?? "the person") : undefined;
      };
      const texts = [
        marker,
        "Two, sent while the park closes the chat.",
        "Three, sent once it moved.",
      ];
      await until(async () => {
        const there = (await journalOf(world.boxA, sessionId)).events;
        return texts.every((text) => fromOf(there, text) !== undefined);
      }, 90_000);
      const there = (await journalOf(world.boxA, sessionId)).events;
      expect(texts.map((text) => fromOf(there, text))).toEqual([
        { title: "Sends the mail", agent: true },
        { title: "Mails as the park closes", agent: true },
        { title: "Sends the mail", agent: true },
      ]);
      // The computer it left: no turn of it journaled past the park its last copy ends with.
      const left = await journalOf(world.mac, sessionId);
      const parked = left.events.findIndex((e) => e.type === "session.parked");
      expect(
        left.events
          .slice(parked)
          .flatMap((e) =>
            e.type === "turn.started" || e.type === "message.done" || e.type === "turn.done"
              ? [`${e.cursor} ${e.type}`]
              : [],
          ),
      ).toEqual([]);
    } finally {
      delete process.env.CHAOS_HOLD_SEND;
      delete process.env.CHAOS_HOLD_FILE;
      await world.close();
    }
  },
  300_000,
);

// A move a device asked through Cloud (a move mail) whose park found a send still on its way in was refused as any
// failed move: the chat said the move did not go through, the mail was taken as done, and on This Mac the device's
// signed move and stop were spent. It is made again in a moment instead, as when Cloud is not reached, and goes once
// the send is in the chat. Move mails were acted on one after another, so that chat's wait (up to 30 s for the send,
// then up to 60 s for a stopped turn's checkpoint) held up every other chat's move and adopt: another chat's move goes
// meanwhile. On a Cloud computer, where a device's move comes as mail; the send waits between its checks and T3
// (CHAOS_HOLD_SEND) past the 30 s the move gives it.
test.skipIf(process.platform === "win32")(
  "a move asked through Cloud while a send is still on its way into the chat is made again once it landed, never dropped, and holds up no other chat's move",
  async () => {
    const hold = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "move-mail-hold-")), "release");
    const text = "slow 50: on its way as Cloud moves the chat";
    process.env.CHAOS_HOLD_SEND = "on its way as Cloud moves the chat";
    process.env.CHAOS_HOLD_FILE = hold;
    const world = new World({ trace: new Trace() });
    try {
      await world.start();
      const w = await createReady(world.boxA.admin! as Parameters<typeof createReady>[0], {
        request_id: "mail-move-workspace",
        repo: { url: "https://github.com/acme/chaos" },
        title: "Moved through Cloud with a send on its way in",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const other = await createReady(world.boxA.admin! as Parameters<typeof createReady>[0], {
        request_id: "mail-move-other-workspace",
        repo: { url: "https://github.com/acme/chaos" },
        title: "Moved meanwhile",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const sessionId = w.session_id;
      await until(
        () =>
          world.cloud.state.chats.copyOf(sessionId).length > 0 &&
          world.cloud.state.chats.copyOf(other.session_id).length > 0,
        60_000,
      );
      await world.addDevices([{ name: "web", kind: "web", home: null }]);
      const web = world.device("web");
      await until(
        () =>
          web.hub!.list?.get().chats.has(sessionId) === true &&
          web.hub!.list?.get().chats.has(other.session_id) === true,
        30_000,
      );

      const sent = world.boxA.call("turn.submit", {
        request_id: "mail-move-send",
        session_id: sessionId,
        kind: "followup",
        input: { text },
      });
      await until(() => fs.existsSync(`${hold}.held`), 30_000);
      void web
        .clientFor(sessionId)
        .call("session.move", {
          request_id: "web-move-1",
          session_id: sessionId,
          to: { computer_id: world.boxB.computerId },
        })
        .catch(() => undefined);
      // While that move waits for the send, the other chat's move goes, well before the first one gives up on it.
      const failedHere = () =>
        fs
          .readFileSync(world.boxA.logFile, "utf8")
          .includes(`moves: letting ${sessionId} go failed`);
      await until(
        () => fs.readFileSync(world.boxA.logFile, "utf8").includes(`moves: ${sessionId} waits for`),
        60_000,
      );
      void web
        .clientFor(other.session_id)
        .call("session.move", {
          request_id: "web-move-2",
          session_id: other.session_id,
          to: { computer_id: world.boxB.computerId },
        })
        .catch(() => undefined);
      await until(() => world.ownerOf(other.session_id) === world.boxB, 120_000);
      expect(failedHere()).toBe(false);
      const failedNotes = async () =>
        (await journalOf(world.boxA, sessionId)).events.flatMap((e) =>
          e.type === "notification" && e.payload.title === "The move did not go through"
            ? [e.payload.body ?? ""]
            : [],
        );
      // The move gave the send its time, and its park refused to stop the chat with the send still on its way.
      await until(async () => failedHere() || (await failedNotes()).length > 0, 120_000);
      expect(await failedNotes()).toEqual([]);
      fs.writeFileSync(hold, "");
      await sent;
      // Made again: the chat goes, with the send in it.
      await until(() => world.ownerOf(sessionId) === world.boxB, 120_000);
      await until(
        async () => userTexts((await journalOf(world.boxB, sessionId)).events).includes(text),
        60_000,
      );
    } finally {
      delete process.env.CHAOS_HOLD_SEND;
      delete process.env.CHAOS_HOLD_FILE;
      await world.close();
    }
  },
  300_000,
);
