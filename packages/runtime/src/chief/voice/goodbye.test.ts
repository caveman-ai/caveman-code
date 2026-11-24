// After a goodbye nothing else is said, and the Chief's reply read out is not written twice: the real call (makeVoice)
// on the real Deepgram adapter, its 1 s tick running, with the runtime around it (store, board, clock) stood in for.
import type { ChiefBoard } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import { expect, test } from "vitest";

import { makeVoice, WORKING_MS, type VoiceOut } from "./Call.ts";
import { makeDeepgram } from "./deepgram.ts";
import { WORKING_LINES } from "./prompt.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
};

const NOTE = "Start the dark mode thing.";

/** A live call whose clock the test sets; `room` is today's cap left, in dollars. */
const rig = async () => {
  const clock = { now: Date.parse("2026-11-06T10:00:00Z") };
  let room: number | undefined;
  const events = Effect.runSync(PubSub.unbounded<never>());
  const boardChanges = Effect.runSync(PubSub.unbounded<ChiefBoard>());
  const kv = new Map<string, string>();
  const appended: Array<{ type: string; payload: { role?: string; text?: string } }> = [];
  const captured: Array<string> = [];
  const chief = {
    profile: { id: "chief-home", project_ids: [] },
    record: {
      session: { id: "sess-chief" },
      workspace: { id: "ws-chief" },
      internal: { threadId: "t" },
    },
  };
  const store = {
    append: (_session: string, f: () => Effect.Effect<{ events: ReadonlyArray<never> }>) =>
      f().pipe(Effect.map(({ events }) => void appended.push(...events))),
    kvGet: (k: string) => Effect.succeed(kv.get(k)),
    kvSet: (k: string, v: string) => Effect.sync(() => void kv.set(k, v)),
    getWorkspace: () => Effect.succeed(undefined),
    listWorkspaces: () => Effect.succeed([]),
    getBySession: () => Effect.succeed(undefined),
    readEvents: () => Effect.succeed([]),
    events,
  };
  const voice = await Effect.runPromise(
    makeVoice({
      engine: makeDeepgram({
        fetch: async () => ({
          status: 200,
          json: async () => ({ access_token: "test-token" }),
          text: async () => "",
        }),
      }),
      store: store as never,
      chief: () => Effect.succeed(chief as never),
      items: () => Effect.succeed([]),
      allItems: Effect.succeed([]),
      boardChanges,
      capture: (_chiefId, text) =>
        Effect.sync(() => {
          captured.push(text);
          const at = new Date(clock.now).toISOString();
          return {
            id: `ci-${captured.length}`,
            text,
            state: "unsorted",
            rank: 1,
            pinned: false,
            project_ids: [],
            source: "voice",
            workspace_ids: [],
            chief_id: "chief-home",
            created_at: at,
            updated_at: at,
            start: false,
          } as never;
        }),
      canThink: () => Effect.succeed(true),
      overCap: Effect.succeed(false),
      capRoom: Effect.sync(() => room),
      settings: Effect.succeed({} as never),
      projects: Effect.succeed([]),
      digest: () => Effect.succeed(undefined),
      keys: {
        read: Effect.succeed({ deepgram: "dg-test-key-0123456789" }),
        write: () => Effect.void,
        takes: Effect.void,
      },
      credits: Effect.succeed(undefined),
      recordSpend: () => Effect.void,
      now: () => clock.now,
    }),
  );
  const out: Array<VoiceOut> = [];
  const listener = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(voice.out);
        yield* Effect.forever(PubSub.take(sub).pipe(Effect.map((m) => void out.push(m))));
      }),
    ),
  );
  const watcher = Effect.runFork(voice.watch);
  await sleep(200);
  const { call } = await Effect.runPromise(voice.start({ device: "Test", connectionId: "conn-1" }));
  let seq = 0;
  const signal = (evs: ReadonlyArray<unknown>) =>
    Effect.runPromise(voice.signal(call.id, seq++, evs));
  const said = (sent: ReadonlyArray<unknown>) =>
    (sent as Array<{ type?: string; message?: string }>)
      .filter((m) => m.type === "InjectAgentMessage")
      .map((m) => m.message!);
  /** Every line sent to be spoken, from out[from] on. */
  const spokenSince = (from: number) =>
    out.slice(from).flatMap((m) => (m.kind === "send" ? said(m.messages) : []));
  /** The person hands off NOTE, it lands on the board, and at `turnAt` a Chief turn takes it (its filler is due WORKING_MS later). */
  const handOff = async (turnAt: number) => {
    await signal([{ type: "SettingsApplied" }]);
    await signal([
      { type: "ConversationText", role: "user", content: NOTE },
      {
        type: "FunctionCallRequest",
        functions: [{ id: "h1", name: "hand_to_chief", client_side: true }],
      },
    ]);
    clock.now += 3_000;
    await until(() => captured.length === 1);
    clock.now = turnAt;
    await Effect.runPromise(
      PubSub.publish(events, {
        session_id: "sess-chief",
        turn_id: "turn-1",
        type: "message.done",
        payload: { role: "user", text: NOTE },
      } as never),
    );
    await sleep(300);
  };
  /** The Chief's turn that took NOTE ends with `text` as its reply. */
  const chiefReplies = async (text: string) => {
    for (const event of [
      { type: "message.done", payload: { role: "assistant", text } },
      { type: "turn.done", payload: { status: "completed" } },
    ])
      await Effect.runPromise(
        PubSub.publish(events, { session_id: "sess-chief", turn_id: "turn-1", ...event } as never),
      );
    await sleep(300);
  };
  return {
    clock,
    appended,
    chiefReplies,
    setRoom: (usd: number | undefined) => (room = usd),
    out,
    signal,
    said,
    spokenSince,
    handOff,
    ended: () =>
      out.some((m) => m.kind === "updated" && m.call.id === call.id && m.call.state === "ended"),
    close: async () => {
      await Effect.runPromise(Fiber.interrupt(watcher));
      await Effect.runPromise(Fiber.interrupt(listener));
    },
  };
};

test("after the person's goodbye no 'still on it' is said, and the call hangs up once the goodbye has played", async () => {
  const r = await rig();
  try {
    const t0 = r.clock.now + 3_000;
    await r.handOff(t0);
    // Three seconds into the Chief's turn: "thanks, bye". The voice says its goodbye and finishes its audio.
    r.clock.now = t0 + 3_000;
    const answer = await r.signal([
      { type: "ConversationText", role: "user", content: "Thanks, bye." },
      {
        type: "FunctionCallRequest",
        functions: [{ id: "g1", name: "end_call", client_side: true }],
      },
    ]);
    expect(JSON.stringify(answer.send)).toContain("Hanging up.");
    const afterGoodbye = r.out.length;
    await r.signal([
      { type: "AgentStartedSpeaking" },
      { type: "ConversationText", role: "assistant", content: "Bye, talk soon." },
    ]);
    r.clock.now = t0 + 4_500;
    await r.signal([{ type: "AgentAudioDone" }]);
    await sleep(1_200);
    // The turn's filler would be due now.
    r.clock.now = t0 + WORKING_MS;
    await sleep(1_500);
    expect(r.spokenSince(afterGoodbye).filter((line) => WORKING_LINES.includes(line))).toEqual([]);
    // Its goodbye played out 1.5 s ago: hung up, not held toward GOODBYE_MS.
    expect(r.ended()).toBe(true);
  } finally {
    await r.close();
  }
}, 20_000);

test("after the call's own goodbye (today's cap), no 'still on it' follows it", async () => {
  const r = await rig();
  try {
    const turnAt = r.clock.now + 30_000;
    await r.handOff(turnAt);
    // Today's cap is reached: the next cap check wraps the call up, before the turn's filler is due.
    r.setRoom(0);
    r.clock.now = turnAt + 4_000;
    await sleep(1_500);
    expect(r.spokenSince(0).some((line) => line.startsWith("That's today's limit"))).toBe(true);
    // The filler comes due while the goodbye still plays; then the goodbye's audio finishes.
    r.clock.now = turnAt + WORKING_MS;
    await sleep(1_500);
    const afterGoodbye = r.out.length;
    const done = await r.signal([{ type: "AgentAudioDone" }]);
    await sleep(1_200);
    expect(
      [...r.said(done.send), ...r.spokenSince(afterGoodbye)].filter((line) =>
        WORKING_LINES.includes(line),
      ),
    ).toEqual([]);
  } finally {
    await r.close();
  }
}, 20_000);

test("the Chief's reply, read out on the call, writes no second line beside its message; the voice's own words do", async () => {
  const r = await rig();
  try {
    await r.handOff(r.clock.now + 3_000);
    const from = r.out.length;
    await r.chiefReplies("Nothing has started tonight. One chat is still running.");
    expect(r.spokenSince(from)).toContain(
      "Nothing has started tonight. One chat is still running.",
    );
    // The engine says it, and its transcript of what it said comes back.
    await r.signal([
      {
        type: "ConversationText",
        role: "assistant",
        content: "Nothing has started tonight. One chat is still running.",
      },
      { type: "ConversationText", role: "assistant", content: "Anything else?" },
    ]);
    await sleep(200);
    const voiceLines = r.appended
      .filter((e) => e.type === "voice.turn" && e.payload.role === "voice")
      .map((e) => e.payload.text);
    expect(voiceLines).toEqual(["Anything else?"]);
  } finally {
    await r.close();
  }
}, 20_000);
