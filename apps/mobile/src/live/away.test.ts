// A chat whose computer does not answer, as the live source holds it: its chats from Cloud's list, a message queued
// in Cloud signed by this phone and what it says while it waits, a message that was refused kept in the thread, one
// Caveman could not be reached for sent again by itself, an answer that waits said as waiting, Cloud's move both ways,
// and a runtime bound and let go without losing any of it. The sentences themselves are pinned in words.test.ts; the
// real routes and runtimes are in packages/runtime's phoneLive.integration.test.ts. Here Cloud is a stand-in that
// records what it was asked.
import type { Client } from "@caveman-app/session-protocol/client";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { describe, expect, it, vi } from "vitest";

import { queuedLine, whyNotCloud, type Away } from "./away";
import type { CloudChat, QueuedCall } from "./cloud";
import { liveSource, type BoardChange, type LiveChat, type SourceWords } from "./source";
import { queuedAnswer, waitingLine } from "./words";

const AT = "2026-11-09T10:00:00.000Z";
const chat = (patch: Partial<CloudChat> = {}): CloudChat => ({
  session_id: "s1",
  workspace_id: "w1",
  computer_id: "c-mac",
  runtime_id: "rt-mac",
  where: { kind: "laptop", name: "Studio", online: false },
  kind: "chat",
  title: "Fix the relay test",
  engine: "claude-agent",
  repo: "acme/relay",
  branch: "caveman/fix-the-relay-test",
  status: "idle",
  last_activity_at: AT,
  calls: [],
  ...patch,
});
const without = (key: keyof CloudChat): CloudChat => {
  const { [key]: _gone, ...rest } = chat();
  return rest as CloudChat;
};

describe("whether a chat can run in Cloud, by what Cloud lists of it", () => {
  it("reads what Cloud lists before anyone asks: whether the chat can move, and the code of why not", () => {
    expect(whyNotCloud(chat({ movable: true }))).toBeNull();
    expect(whyNotCloud(chat({ movable: false, stays: { code: "folder" } }))).toBe(
      "This project is a folder on your Mac.",
    );
    expect(whyNotCloud(chat({ movable: false, stays: { code: "no_plan" } }))).toBe(
      "Connect Claude on your Mac (Settings > Models & keys).",
    );
    // False with no code, or a code from a newer Cloud: the one plain line.
    expect(whyNotCloud(chat({ movable: false }))).toBe("This chat can't run in Cloud yet.");
    expect(whyNotCloud(chat({ movable: false, stays: { code: "something_new" } }))).toBe(
      "This chat can't run in Cloud yet.",
    );
    // A chat in Cloud that stays there.
    expect(
      whyNotCloud(
        chat({
          movable: false,
          stays: { code: "kind" },
          where: { kind: "cloud", name: "acme-web" },
        }),
      ),
    ).toBe("Chiefs and agents stay where they started.");
  });

  it("guesses nothing: a chat whose Mac has not said is left to Cloud's move, whatever else is listed of it", () => {
    expect(whyNotCloud(chat())).toBeNull();
    expect(whyNotCloud(without("branch"))).toBeNull();
    expect(whyNotCloud(chat({ engine: "cursor", repo_verified: false }))).toBeNull();
    // One Cloud does not list has nothing saved to run anywhere else.
    expect(whyNotCloud(undefined)).toBe("Not saved yet. It can run in Cloud after its next turn.");
  });
});

describe("the source's own words for a call that waits, which name its computer", () => {
  const call = (patch: Partial<QueuedCall>): QueuedCall => ({
    request_id: "r1",
    method: "turn.submit",
    status: "queued",
    ...patch,
  });
  it("are the ones the runtime's tests of the phone read; the app passes its own (words.ts)", () => {
    expect(queuedLine(call({}), { name: "box-a", cloud: true })).toBe("Queued · waking box-a");
    expect(
      queuedLine(call({ waiting: { reason: "laptop_asleep" } }), { name: "Studio", cloud: false }),
    ).toBe("Waiting for Studio");
    expect(queuedLine(call({ status: "done" }), { name: "Studio", cloud: false })).toBeNull();
  });
});

/** The board under the source's changes, as the app's store applies them. */
function board() {
  let chats: LiveChat[] = [];
  return {
    chats: () => chats,
    chat: (id: string) => chats.find((c) => c.id === id),
    dispatch(change: BoardChange) {
      if (change.type === "add") chats = [change.chat, ...chats];
      else if (change.type === "remove") chats = chats.filter((c) => c.id !== change.id);
      else
        chats = chats.map((c) => {
          if (c.id !== change.id) return c;
          const next = { ...c, ...change.patch };
          if (change.type === "update") for (const key of change.clear ?? []) delete next[key];
          return next;
        });
    },
  };
}

/** Cloud's routes as a stand-in: its list of the person's chats, and every call and move it was asked for. */
function cloud(list: CloudChat[]) {
  const queued: Array<{ session: string; call: Parameters<Away["queue"]>[1] }> = [];
  const moves: Array<{ session: string; move: Parameters<Away["move"]>[1] }> = [];
  const state = {
    list,
    call: { request_id: "", method: "turn.submit", status: "queued" } as QueuedCall,
    moved: { pending: false, computer_id: "c-box" } as Awaited<ReturnType<Away["move"]>>,
    refuse: null as Error | null,
    down: false,
  };
  const away: Away = {
    chats: async () => state.list,
    queue: async (session, call) => {
      // No network: fetch itself fails, and nothing reached Caveman.
      if (state.down) throw new TypeError("Network request failed");
      if (state.refuse) throw state.refuse;
      queued.push({ session, call });
      return (state.call = { ...state.call, request_id: call.request_id, method: call.method });
    },
    queued: async () => state.call,
    move: async (session, move) => {
      if (state.refuse) throw state.refuse;
      moves.push({ session, move });
      return state.moved;
    },
    sign: async (call) => ({
      device_id: "phone-1",
      at: AT,
      signature: `signed:${call.method}:${call.request_id}:${JSON.stringify(call.params)}`,
    }),
  };
  return { away, queued, moves, state };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Long enough for the source's own short timers to run. Windows fires timers on a ~15.6 ms tick, so a few of them take
 * past 20 ms there; the checks after it include ones that something did not happen, so it stays a wait, not a poll.
 */
const moment = () => settle(process.platform === "win32" ? 100 : 20);
const STUDIO = { computer_id: "c-mac", name: "Studio", kind: "laptop" } as const;

/** The app's own words (words.ts), as link.ts hands them to the source. */
const WORDS: SourceWords = {
  waiting: waitingLine,
  answer: queuedAnswer,
  unreached: "No network. Sends when you're back online.",
};

/** A runtime stand-in: what it lists, what it was called with, and the events it hands whoever attached. */
function runtime(workspaces: Workspace[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const state = {
    events: (() => {}) as (event: SessionEvent) => void,
    attached: 0,
    refuse: null as Error | null,
  };
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (state.refuse && method !== "workspace.list") throw state.refuse;
      return method === "workspace.list" ? { workspaces } : {};
    },
    on: () => () => {},
    attach: async (_session: string, _cursor: number, onEvent: (event: SessionEvent) => void) => {
      state.events = onEvent;
      state.attached++;
      return { detach: async () => {} };
    },
  } as unknown as Client;
  return { client, calls, state };
}
const workspace = (patch: Record<string, unknown> = {}) =>
  ({
    id: "w1",
    session_id: "s1",
    title: "Fix the relay test",
    repo: { path: "/Users/ada/code/relay" },
    engine: "claude-agent",
    status: "idle",
    created_at: AT,
    updated_at: AT,
    ...patch,
  }) as unknown as Workspace;
const event = (cursor: number, type: string, payload: unknown, item?: string) =>
  ({
    session_id: "s1",
    cursor,
    at: AT,
    type,
    payload,
    ...(item ? { item_id: item } : {}),
  }) as unknown as SessionEvent;

describe("a computer that stopped answering in the middle of a turn", () => {
  it("queues your words as a message of their own, and says what they wait for rather than the turn's last line", async () => {
    const shown = board();
    const { away, queued } = cloud([chat()]);
    let up = true;
    const { client, state } = runtime([workspace({ status: "working" })]);
    const source = liveSource({
      client,
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      reachable: () => up,
      away,
      words: WORDS,
    });
    await source.sync();
    source.open("w1");
    await settle();
    state.events(event(1, "turn.started", { turn_id: "t1" }));
    await settle();
    expect(shown.chat("w1")).toMatchObject({ phase: "working" });
    expect(shown.chat("w1")).not.toHaveProperty("wait");
    // Its lid closes: the turn's end never reaches the phone.
    up = false;
    source.send("w1", "And the timeout case?");
    await moment();
    // Queuing first loads the device signer (a dynamic import), slower than a moment on a cold CI runner.
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued).toMatchObject([
      {
        session: "s1",
        call: {
          method: "turn.submit",
          params: { kind: "followup", input: { text: "And the timeout case?" } },
        },
      },
    ]);
    // Cloud has it and has not said what it waits on yet.
    expect(shown.chat("w1")).toMatchObject({ line: "Sending", wait: { words: "Sending" } });
    expect(shown.chat("w1")!.items.at(-1)).toMatchObject({
      kind: "you",
      text: "And the timeout case?",
      state: "sent",
    });
    expect(shown.chat("w1")!.items.at(-1)).not.toHaveProperty("steer");
    source.close();
  });
});

describe("a lead's builders, as the computer the lead runs on says became of each", () => {
  it("each row is its builder's one state, in the desktop's words, whatever its own turn last did", async () => {
    const shown = board();
    const { away } = cloud([chat()]);
    const builder = (
      id: string,
      state: Record<string, unknown>,
      more: Record<string, unknown> = {},
    ) =>
      workspace({
        id,
        session_id: `s-${id}`,
        title: id,
        parent_workspace_id: "w1",
        builder: state,
        ...more,
      });
    const { client } = runtime([
      workspace({ status: "working" }),
      builder("b-working", { state: "working" }, { status: "idle" }),
      builder("b-done", { state: "done" }),
      builder("b-merged", { state: "merged" }),
      builder("b-left", { state: "left_out", why: "conflicts in a.ts" }),
      builder("b-paused", { state: "paused", plan: "Claude plan" }, { status: "working" }),
      builder("b-failed", { state: "failed", why: "its agent stopped" }, { status: "failed" }),
      // A runtime from before the field: the row reads as it did.
      workspace({
        id: "b-old",
        session_id: "s-old",
        title: "b-old",
        parent_workspace_id: "w1",
        status: "failed",
      }),
    ]);
    const source = liveSource({
      client,
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      words: WORDS,
    });
    await source.sync();
    const row = (id: string) => {
      const c = shown.chat(id)!;
      return [c.phase, c.line, c.fate?.words, c.fate?.tone, c.parent];
    };
    expect(row("b-working")).toEqual(["working", "Working", "Working", "quiet", "w1"]);
    expect(row("b-done")).toEqual(["done", "Done", "Done", "quiet", "w1"]);
    expect(row("b-merged")).toEqual(["done", "Merged", "Merged", "quiet", "w1"]);
    expect(row("b-left")).toEqual([
      "done",
      "Left out: conflicts in a.ts",
      "Left out: conflicts in a.ts",
      "warn",
      "w1",
    ]);
    expect(row("b-paused")).toEqual(["done", "Paused", "Paused", "warn", "w1"]);
    expect(row("b-failed")).toEqual([
      "done",
      "Failed: its agent stopped",
      "Failed: its agent stopped",
      "bad",
      "w1",
    ]);
    expect(row("b-old")).toEqual(["done", "Failed", undefined, undefined, "w1"]);
    // The lead itself is no builder.
    expect(shown.chat("w1")).not.toHaveProperty("fate");
    source.close();
  });
});

describe("a computer with no runtime to reach", () => {
  it("shows its chats as Cloud lists them, and only its own", async () => {
    const shown = board();
    const { away } = cloud([
      chat(),
      chat({
        session_id: "s2",
        workspace_id: "w2",
        title: "On another computer",
        computer_id: "c-box",
      }),
      chat({ session_id: "s3", workspace_id: "w3", kind: "chief", title: "The Chief" }),
    ]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    expect(shown.chats()).toMatchObject([
      {
        id: "w1",
        title: "Fix the relay test",
        repo: "relay",
        device: "live:c-mac",
        engine: "claude",
        phase: "done",
        items: [],
      },
    ]);
    expect(source.owns("w1")).toBe(true);
    expect(source.owns("w2")).toBe(false);
    expect(source.chats()).toEqual(["w1"]);
    expect(source.sessionOf("w1")).toBe("s1");
    expect(source.chatOf("s1")).toBe("w1");
    source.close();
  });

  it("says what a chat asks from Cloud's own line of it, and its model, before any runtime was read", async () => {
    const shown = board();
    const { away } = cloud([
      chat({
        status: "needs_you",
        needs_you: { kind: "approval", summary: "Run the migration on staging?" },
        model: "claude-sonnet-5-5",
      }),
    ]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    expect(shown.chat("w1")).toMatchObject({
      phase: "needs",
      line: "Run the migration on staging?",
      model: "claude-sonnet-5-5",
    });
    source.close();
  });

  it("names a chat's project as the board last did where Cloud names no repository, and makes none up", async () => {
    const shown = board();
    // Seen while its Mac was awake: a chat in a plain folder, which Cloud lists with no repository.
    shown.dispatch({
      type: "add",
      chat: {
        id: "w1",
        title: "Tidy my notes",
        repo: "notes",
        device: "live:c-mac",
        chief: null,
        engine: "claude",
        model: "",
        phase: "done",
        line: "Done",
        items: [],
        startedAt: 1,
        updatedAt: 2,
      },
    });
    const plain = (id: string): CloudChat => {
      const {
        repo: _repo,
        branch: _branch,
        ...rest
      } = chat({ session_id: `s-${id}`, workspace_id: id, title: "Tidy my notes" });
      return rest;
    };
    const { away } = cloud([plain("w1"), plain("w2")]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    expect(shown.chat("w1")!.repo).toBe("notes");
    // One the phone never saw is in a folder it cannot name.
    expect(shown.chat("w2")!.repo).toBe("Folder");
    source.close();
  });

  it("queues your message in Cloud, signed by this phone: a sleeping Mac's chat that Cloud is moving says it runs in Cloud", async () => {
    const shown = board();
    const { away, queued, state } = cloud([chat()]);
    const errors: string[] = [];
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      onError: (message) => errors.push(message),
      words: WORDS,
    });
    await source.sync();
    state.call = {
      request_id: "",
      method: "turn.submit",
      status: "queued",
      waiting: { reason: "laptop_asleep" },
    };
    source.send("w1", "Carry on with the test");
    await moment();
    // Queuing first loads the device signer (a dynamic import), slower than a moment on a cold CI runner.
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued).toHaveLength(1);
    const { session, call } = queued[0]!;
    expect(session).toBe("s1");
    expect(call).toMatchObject({
      method: "turn.submit",
      params: {
        session_id: "s1",
        kind: "followup",
        input: { text: "Carry on with the test" },
        request_id: call.request_id,
      },
    });
    // Signed over exactly what Cloud was handed.
    expect(call.device).toEqual({
      device_id: "phone-1",
      at: AT,
      signature: `signed:turn.submit:${call.request_id}:${JSON.stringify(call.params)}`,
    });
    // One line, under the message: nothing is pressed to run it there.
    expect(shown.chat("w1")).toMatchObject({
      phase: "working",
      line: "Studio is asleep. Running in Cloud.",
      wait: { words: "Studio is asleep. Running in Cloud." },
    });
    expect(shown.chat("w1")!.items).toMatchObject([
      { kind: "you", text: "Carry on with the test", state: "sent" },
    ]);
    expect(source.waiting("w1")).toBe(true);
    expect(errors).toEqual([]);
    source.close();
  });

  it("keeps a message for a chat that cannot run in Cloud until its Mac wakes, and says a folder project is one", async () => {
    const shown = board();
    const { repo: _repo, branch: _branch, ...folder } = chat();
    const { away, state } = cloud([
      chat({ session_id: "s2", workspace_id: "w2" }),
      { ...folder, session_id: "s3", workspace_id: "w3" },
    ]);
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      words: WORDS,
    });
    await source.sync();
    const waiting = {
      reason: "not_movable",
      detail: "Studio is asleep. It stays on its laptop: its runtime does not follow it for moves.",
    } as const;
    state.call = { request_id: "", method: "turn.submit", status: "queued", waiting };
    source.send("w2", "One more thing");
    await moment();
    expect(shown.chat("w2")).toMatchObject({ wait: { words: "Sends when Studio wakes" } });
    // Cloud says why by its code, never by what else it lists of the chat.
    state.call = {
      request_id: "",
      method: "turn.submit",
      status: "queued",
      waiting: { ...waiting, code: "folder" },
    };
    source.send("w3", "Tidy the notes");
    await moment();
    expect(shown.chat("w3")).toMatchObject({
      wait: { words: "Folder project. Sends when Studio wakes." },
    });
    source.close();
  });

  it("says a message for Cloud that sleeps is waking it, in one line", async () => {
    const shown = board();
    const there = chat({ computer_id: "c-box", where: { kind: "cloud", name: "box-a" } });
    const { away } = cloud([there]);
    const source = liveSource({
      board: shown,
      device: "live:cloud",
      computer: { computer_id: "c-box", name: "Cloud", kind: "cloud" },
      away,
      words: WORDS,
    });
    await source.sync();
    source.send("w1", "Carry on");
    await moment();
    expect(shown.chat("w1")).toMatchObject({
      phase: "working",
      line: "Waking Cloud…",
      wait: { words: "Waking Cloud…" },
    });
    expect(JSON.stringify(shown.chat("w1"))).not.toContain("box-a");
    source.close();
  });

  it("puts your message under what the phone kept of the chat, as last seen", async () => {
    const shown = board();
    const kept = [
      { kind: "you", id: "m1", text: "Fix the relay test", at: 1, state: "sent" },
      { kind: "text", id: "m2", text: "Done. All five checks pass.", at: 2 },
    ] as const;
    shown.dispatch({
      type: "add",
      chat: {
        id: "w1",
        title: "Fix the relay test",
        repo: "relay",
        device: "live:c-mac",
        chief: null,
        engine: "claude",
        model: "",
        phase: "done",
        line: "Done",
        items: kept,
        startedAt: 1,
        updatedAt: 2,
      },
    });
    const { away } = cloud([chat()]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    // Listed by Cloud, not read from its runtime: what the board kept stays.
    expect(shown.chat("w1")!.items).toEqual(kept);
    source.send("w1", "And the timeout case?");
    await moment();
    expect(shown.chat("w1")!.items).toMatchObject([
      ...kept,
      { kind: "you", text: "And the timeout case?", state: "sent" },
    ]);
    source.close();
  });

  it("never deletes what was typed: a message Cloud refuses stays in the thread, marked as not sent, and Send again sends it", async () => {
    const shown = board();
    const { away, queued, state } = cloud([chat()]);
    const errors: string[] = [];
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      onError: (message) => errors.push(message),
      words: WORDS,
    });
    await source.sync();
    state.refuse = new Error("The chat is archived or ended.");
    source.send("w1", "Too late");
    await moment();
    expect(shown.chat("w1")).toMatchObject({
      phase: "done",
      items: [{ kind: "you", text: "Too late", state: "failed" }],
    });
    expect(shown.chat("w1")).not.toHaveProperty("wait");
    // Nothing is said in a toast that goes away: the message itself says it.
    expect(errors).toEqual([]);
    expect(source.waiting("w1")).toBe(false);
    // Put right: the same words go again, once, in the same place.
    state.refuse = null;
    const failed = shown.chat("w1")!.items[0]!;
    source.resend("w1", failed.id);
    await moment();
    expect(queued).toMatchObject([
      { call: { method: "turn.submit", params: { input: { text: "Too late" } } } },
    ]);
    expect(shown.chat("w1")!.items).toMatchObject([
      { kind: "you", text: "Too late", state: "sent" },
    ]);
    source.close();
  });

  it("keeps a message that was not sent across a relaunch: the board kept it, and the chat holds it again", async () => {
    const shown = board();
    shown.dispatch({
      type: "add",
      chat: {
        id: "w1",
        title: "Fix the relay test",
        repo: "relay",
        device: "live:c-mac",
        chief: null,
        engine: "claude",
        model: "",
        phase: "done",
        line: "Done",
        items: [{ kind: "you", id: "sp-msg:1", text: "Too late", at: 5, state: "failed" }],
        startedAt: 1,
        updatedAt: 2,
      },
    });
    const { away, queued } = cloud([chat()]);
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      words: WORDS,
    });
    await source.sync();
    source.resend("w1", "sp-msg:1");
    await moment();
    expect(queued).toMatchObject([{ call: { params: { input: { text: "Too late" } } } }]);
    source.close();
  });

  it("sends a message again by itself while Caveman cannot be reached, and says so once that has lasted", async () => {
    const shown = board();
    const { away, queued, state } = cloud([chat()]);
    let now = 1_000_000;
    const errors: string[] = [];
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      onError: (message) => errors.push(message),
      words: WORDS,
      now: () => now,
    });
    await source.sync();
    state.down = true;
    source.send("w1", "From the train");
    await moment();
    // Kept, still on its way: the person is not asked to do anything.
    expect(shown.chat("w1")!.items).toMatchObject([
      { kind: "you", text: "From the train", state: "sending" },
    ]);
    expect(queued).toHaveLength(0);
    now += 11_000;
    source.refresh();
    expect(shown.chat("w1")).toMatchObject({
      wait: { words: "No network. Sends when you're back online." },
    });
    state.down = false;
    await settle(3_100);
    expect(queued).toMatchObject([{ call: { params: { input: { text: "From the train" } } } }]);
    expect(shown.chat("w1")!.items).toMatchObject([
      { kind: "you", text: "From the train", state: "sent" },
    ]);
    expect(errors).toEqual([]);
    source.close();
  }, 10_000);

  it("runs a chat in Cloud, or on a Mac, by Cloud's own move, signed as a move, and says where it is now", async () => {
    const shown = board();
    const { away, moves, state } = cloud([chat()]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    expect(await source.runInCloud("w1")).toEqual({ computer_id: "c-box", session_id: "s1" });
    expect(moves).toHaveLength(1);
    const { session, move } = moves[0]!;
    expect(session).toBe("s1");
    expect(move).toMatchObject({
      to: "cloud",
      device: {
        device_id: "phone-1",
        signature: `signed:session.move:${move.request_id}:{"to":"cloud"}`,
      },
    });
    // The other way: to one of the person's Macs, by its computer id, signed over that very target.
    state.moved = { pending: false, computer_id: "c-mac-2" };
    expect(await source.runOn("w1", "c-mac-2")).toEqual({
      computer_id: "c-mac-2",
      session_id: "s1",
    });
    expect(moves[1]!.move).toMatchObject({
      to: { computer_id: "c-mac-2" },
      device: {
        signature: `signed:session.move:${moves[1]!.move.request_id}:{"to":{"computer_id":"c-mac-2"}}`,
      },
    });
    // What Cloud refuses is said in Cloud's words, and a chat Cloud never listed is not saved there yet.
    state.refuse = new Error(
      "Nothing you have connected runs Claude Agent on a Cloud computer. Connect Claude for it in Settings > Models & keys.",
    );
    await expect(source.runInCloud("w1")).rejects.toThrow(
      "Nothing you have connected runs Claude Agent on a Cloud computer.",
    );
    await expect(source.runInCloud("w9")).rejects.toThrow(
      "Not saved to Cloud yet. It can run there after its next turn.",
    );
    source.close();
  });

  it("starts no chat: there is nothing to start it on", async () => {
    const { away } = cloud([]);
    const source = liveSource({ board: board(), device: "live:c-mac", computer: STUDIO, away });
    await expect(
      source.start({ repo: { path: "/Users/ada/code/relay" }, engine: "claude-agent", text: "hi" }),
    ).rejects.toThrow("Studio is not connected.");
    source.close();
  });
});

describe("a runtime bound when there is one to reach, and let go when it sleeps", () => {
  it("holds the same chats across it: Cloud's list first, the runtime's own word once bound, and what was sent meanwhile", async () => {
    const shown = board();
    const { away, queued } = cloud([chat()]);
    let up = false;
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      reachable: () => up,
      away,
      words: WORDS,
    });
    await source.sync();
    source.send("w1", "While it slept");
    await moment();
    expect(queued).toHaveLength(1);
    expect(source.waiting("w1")).toBe(true);
    // It wakes: the runtime is bound, and the message that waits is still the chat's.
    const { client, state } = runtime([workspace()]);
    source.bind(client);
    up = true;
    await source.sync();
    expect(source.waiting("w1")).toBe(true);
    expect(shown.chat("w1")!.items).toMatchObject([{ kind: "you", text: "While it slept" }]);
    source.open("w1");
    await settle();
    expect(state.attached).toBe(1);
    // It sleeps again and wakes as another runtime: followed anew there, once.
    source.bind(undefined);
    const next = runtime([workspace()]);
    source.bind(next.client);
    source.open("w1");
    await settle();
    expect(next.state.attached).toBe(1);
    source.close();
  });

  it("reads only its own chats off the board: another computer's stay when this one's list is read", async () => {
    const shown = board();
    shown.dispatch({
      type: "add",
      chat: {
        id: "w-cloud",
        title: "In Cloud",
        repo: "relay",
        device: "live:cloud",
        chief: null,
        engine: "claude",
        model: "",
        phase: "done",
        line: "Done",
        items: [],
        startedAt: 1,
        updatedAt: 2,
      },
    });
    shown.dispatch({
      type: "add",
      chat: {
        id: "w-gone",
        title: "Archived on the Mac",
        repo: "relay",
        device: "live:c-mac",
        chief: null,
        engine: "claude",
        model: "",
        phase: "done",
        line: "Done",
        items: [],
        startedAt: 1,
        updatedAt: 2,
      },
    });
    const { away } = cloud([chat()]);
    const { client } = runtime([workspace()]);
    const source = liveSource({
      client,
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
    });
    await source.sync();
    expect(
      shown
        .chats()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["w-cloud", "w1"]);
    source.close();
  });

  it("lets go of a chat that runs somewhere else now, leaving it on the board for the computer that holds it there", async () => {
    const shown = board();
    const { away } = cloud([chat()]);
    const source = liveSource({ board: shown, device: "live:c-mac", computer: STUDIO, away });
    await source.sync();
    source.release("w1");
    expect(source.owns("w1")).toBe(false);
    expect(shown.chat("w1")).toBeDefined();
    source.close();
  });
});

describe("an approval answered while its computer could not hear it", () => {
  const asking = () => {
    const shown = board();
    const there = chat({
      computer_id: "c-box",
      where: { kind: "cloud", name: "box-a" },
      status: "needs_you",
    });
    const { away, queued, state } = cloud([there]);
    let up = true;
    const rt = runtime([workspace({ status: "needs_input" })]);
    const errors: string[] = [];
    const source = liveSource({
      client: rt.client,
      board: shown,
      device: "live:cloud",
      computer: { computer_id: "c-box", name: "Cloud", kind: "cloud" },
      reachable: () => up,
      away,
      onError: (message) => errors.push(message),
      words: WORDS,
    });
    const ask = async () => {
      await source.sync();
      await settle();
      rt.state.events(event(1, "turn.started", { turn_id: "t1" }));
      rt.state.events(
        event(
          2,
          "ask.user",
          {
            kind: "approval",
            title: "Run a command",
            detail: "pnpm db:migrate",
            options: [
              { id: "yes", label: "Allow", decision: "allow" },
              { id: "no", label: "Deny", decision: "deny" },
            ],
          },
          "ask-1",
        ),
      );
      await settle();
    };
    return { shown, queued, state, rt, errors, source, ask, sleep: () => (up = false) };
  };

  it("says the answer is queued, never that it was given, until the computer has it", async () => {
    const { shown, queued, source, ask, sleep, rt } = asking();
    await ask();
    expect(shown.chat("w1")).toMatchObject({ phase: "needs" });
    sleep();
    expect(await source.respond("w1", { kind: "allow" })).toBe(true);
    expect(queued).toMatchObject([
      {
        call: {
          method: "ask.respond",
          params: { ask_id: "ask-1", response: { kind: "approval", option_id: "yes" } },
        },
      },
    ]);
    // No longer asking the person, and not allowed either: the ask's own line says it waits.
    expect(shown.chat("w1")).toMatchObject({
      phase: "working",
      line: "Allow queued · waking Cloud",
    });
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).toMatchObject({
      pending: "Allow queued · waking Cloud",
    });
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).not.toHaveProperty(
      "answer",
    );
    // The computer has it: allowed, as it says.
    rt.state.events(
      event(
        3,
        "ask.resolved",
        { outcome: "answered", response: { kind: "approval", option_id: "yes" } },
        "ask-1",
      ),
    );
    await settle();
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).toMatchObject({
      answer: "allowed",
    });
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).not.toHaveProperty(
      "pending",
    );
    source.close();
  });

  it("keeps an answer in hand shown as queued from the tap on, through the time it can still be taken back", async () => {
    const { shown, queued, source, ask, sleep } = asking();
    await ask();
    sleep();
    // The tap: nothing is sent yet (the person can still take it back), and the ask already says the answer waits.
    expect(source.hold("w1", "allow")).toBe("Allow queued · waking Cloud");
    expect(queued).toEqual([]);
    expect(shown.chat("w1")).toMatchObject({
      phase: "working",
      line: "Allow queued · waking Cloud",
      wait: { words: "Allow queued · waking Cloud" },
    });
    expect(shown.chat("w1")).not.toHaveProperty("need");
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).toMatchObject({
      pending: "Allow queued · waking Cloud",
    });
    // Taken back: it asks again, as it did.
    expect(source.hold("w1", null)).toBeNull();
    expect(shown.chat("w1")).toMatchObject({ phase: "needs" });
    expect(shown.chat("w1")!.items.find((item) => item.kind === "ask")).not.toHaveProperty(
      "pending",
    );
    source.close();
  });

  it("holds nothing back from a computer that hears: the answer goes as given, with no line about a queue", async () => {
    const { source, ask } = asking();
    await ask();
    expect(source.hold("w1", "deny")).toBeNull();
    source.close();
  });

  it("tells the truth when the computer went to sleep with the ask open and never heard the answer", async () => {
    const { shown, state, errors, source, ask, sleep, rt } = asking();
    await ask();
    sleep();
    await source.respond("w1", { kind: "allow" });
    // As the runtime writes it when Cloud puts its computer to sleep: the ask cancelled, the turn cut, and its own note.
    rt.state.events(event(3, "ask.resolved", { outcome: "cancelled" }, "ask-1"));
    rt.state.events(event(4, "turn.done", { turn_id: "t1", status: "interrupted" }, "t1"));
    rt.state.events(
      event(5, "notification", {
        level: "info",
        title: "Paused while this computer sleeps",
        body: "It carries on by itself when the computer wakes.",
      }),
    );
    await settle();
    const items = shown.chat("w1")!.items;
    // Not "Denied" (nobody said no) and not "You stopped" (nobody stopped it).
    expect(items.some((item) => item.kind === "ask")).toBe(false);
    expect(items.some((item) => item.kind === "stop")).toBe(false);
    // Said once: the answer did not arrive. Cloud giving the queued answer up later ("this ask was already answered")
    // adds nothing, and is never read as another device having answered.
    expect(errors).toEqual(["Your answer didn't arrive. It asks again when it carries on."]);
    state.call = {
      ...state.call,
      status: "failed",
      error: { code: "invalid_state", message: "this ask was already answered" },
    };
    await settle(2_100);
    expect(errors).toHaveLength(1);
    source.close();
  }, 10_000);
});

describe("a chat read while its computer sleeps", () => {
  const BOX = { computer_id: "c-box", name: "Cloud", kind: "cloud" } as const;
  const inCloud = (patch: Partial<CloudChat> = {}) =>
    chat({
      computer_id: "c-box",
      runtime_id: "",
      where: { kind: "cloud", name: "acme-web", online: false },
      epoch: 1,
      ...patch,
    });
  const saved =
    (events: SessionEvent[]) => async (_session: string, epoch: number, after: number) => ({
      epoch,
      events: events
        .filter((e) => e.cursor > after)
        .map((e) => ({ cursor: e.cursor, type: e.type, at: AT, event: e })),
      more: false,
    });

  it("reads what Caveman saved of it, with nothing woken: the whole chat, and what it asks", async () => {
    const shown = board();
    const { away, queued } = cloud([
      inCloud({ status: "needs_you", needs_you: { kind: "approval", summary: "pnpm db:migrate" } }),
    ]);
    const read: number[] = [];
    away.saved = async (session, epoch, after) => {
      read.push(after);
      return saved([
        event(1, "message.done", { role: "user", text: "Migrate the usage table" }, "m1"),
        event(2, "turn.started", { turn_id: "t1" }),
        event(
          3,
          "ask.user",
          {
            kind: "approval",
            title: "Run a command",
            detail: "pnpm db:migrate",
            options: [
              { id: "yes", label: "Allow", decision: "allow" },
              { id: "no", label: "Deny", decision: "deny" },
            ],
          },
          "ask-1",
        ),
      ])(session, epoch, after);
    };
    const source = liveSource({
      board: shown,
      device: "live:cloud",
      computer: BOX,
      away,
      words: WORDS,
    });
    await source.sync();
    source.open("w1");
    await settle(10);
    expect(read).toEqual([0]);
    expect(shown.chat("w1")!.items).toMatchObject([
      { kind: "you", text: "Migrate the usage table" },
      { kind: "ask" },
    ]);
    // The ask is known by its id, so an answer can wait in Cloud for the computer: nothing else wakes it.
    expect(await source.respond("w1", { kind: "allow" })).toBe(true);
    expect(queued).toMatchObject([
      { session: "s1", call: { method: "ask.respond", params: { ask_id: "ask-1" } } },
    ]);
    expect(shown.chat("w1")).toMatchObject({ line: "Allow queued · waking Cloud" });
    source.close();
  });

  it("says an answer could not be given when the phone does not know what was asked", async () => {
    const shown = board();
    const { away, queued } = cloud([
      inCloud({ status: "needs_you", needs_you: { kind: "approval", summary: "pnpm db:migrate" } }),
    ]);
    const errors: string[] = [];
    const source = liveSource({
      board: shown,
      device: "live:cloud",
      computer: BOX,
      away,
      words: WORDS,
      onError: (message) => errors.push(message),
    });
    await source.sync();
    source.hold("w1", "allow");
    expect(await source.respond("w1", { kind: "allow" })).toBe(false);
    expect(queued).toEqual([]);
    expect(errors).toEqual(["Your answer didn't arrive. It asks again when it carries on."]);
    // Never left reading as queued.
    expect(shown.chat("w1")).not.toHaveProperty("wait");
    source.close();
  });
});

describe("a message that waits when its chat goes to another computer", () => {
  it("goes with the chat: still in the thread, still saying what it waits for", async () => {
    const shown = board();
    const { away, state } = cloud([chat()]);
    const mac = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      words: WORDS,
    });
    await mac.sync();
    mac.send("w1", "And the timeout case?");
    await moment();
    expect(shown.chat("w1")!.items.at(-1)).toMatchObject({
      kind: "you",
      text: "And the timeout case?",
    });
    // Cloud runs the chat itself now: the Mac's side lets it go, and Cloud's side takes what was under way.
    const carried = mac.release("w1");
    expect(carried).toMatchObject({
      unsaid: [{ text: "And the timeout case?" }],
      queued: { status: "queued" },
    });
    state.list = [
      chat({
        computer_id: "c-box",
        runtime_id: "",
        where: { kind: "cloud", name: "acme-web", online: false },
      }),
    ];
    const box = liveSource({
      board: shown,
      device: "live:cloud",
      computer: { computer_id: "c-box", name: "Cloud", kind: "cloud" },
      away,
      words: WORDS,
    });
    await box.sync();
    box.carry("w1", carried!);
    expect(shown.chat("w1")).toMatchObject({
      device: "live:cloud",
      wait: { words: "Waking Cloud…" },
    });
    expect(shown.chat("w1")!.items.at(-1)).toMatchObject({
      kind: "you",
      text: "And the timeout case?",
    });
    // What the Mac's side still hears of it changes nothing on the board.
    await mac.sync();
    expect(shown.chat("w1")).toMatchObject({ device: "live:cloud" });
    mac.close();
    box.close();
  });

  it("says only that it is sending while nobody has it yet, never that anything works", async () => {
    const shown = board();
    const { away, state } = cloud([chat()]);
    state.down = true;
    const source = liveSource({
      board: shown,
      device: "live:c-mac",
      computer: STUDIO,
      away,
      words: WORDS,
    });
    await source.sync();
    source.send("w1", "One more thing");
    await moment();
    expect(shown.chat("w1")).toMatchObject({ line: "Sending", wait: { words: "Sending" } });
    source.close();
  });
});
