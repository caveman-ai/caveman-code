// A chat started from the phone: on a Mac through its runtime, in Cloud through Cloud's own route and then the
// computer Cloud picked; on the board from the tap, saying what it waits for; and what it says when it cannot start.
// Cloud and the computer are stand-ins that record what they were asked; the real ones are in packages/runtime's
// phoneLive.integration.test.ts.
import { describe, expect, it } from "vitest";

import type { BoardChange, LiveChat, StartInput } from "./source";
import {
  cannotStart,
  didNotStart,
  ENGINE_ID,
  isStarting,
  startChat,
  type StartRequest,
  type StartWith,
} from "./start";

function board() {
  let chats: LiveChat[] = [];
  const lines: string[] = [];
  return {
    chats: () => chats,
    lines,
    dispatch(change: BoardChange) {
      if (change.type === "add") chats = [change.chat, ...chats];
      else if (change.type === "remove") chats = chats.filter((c) => c.id !== change.id);
      else {
        if (change.patch.line) lines.push(change.patch.line);
        chats = chats.map((c) => {
          if (c.id !== change.id) return c;
          const next = { ...c, ...change.patch };
          if (change.type === "update") for (const key of change.clear ?? []) delete next[key];
          return next;
        });
      }
    },
  };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits up to 2 s for `done`: tries again on a timer, whose tick is 15.6 ms on Windows. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await settle(10);
};
const relay = { name: "relay", github: "acme/relay", path: "/Users/ada/code/relay" };
const STUDIO = { kind: "mac", computer_id: "c-mac", name: "Studio" } as const;
const ask = (patch: Partial<StartRequest> = {}): StartRequest => ({
  text: "Fix the relay test",
  title: "Fix the relay test",
  project: relay,
  engine: "claude",
  model: "",
  on: STUDIO,
  ...patch,
});

/** What stands in for Cloud, the connection and the screen: each records what it was asked. */
function world(patch: Partial<StartWith> = {}) {
  const shown = board();
  const cloud: Array<{ title: string; repo: string; engine: string }> = [];
  const reached: string[] = [];
  const started: StartInput[] = [];
  const done: Array<[string, string]> = [];
  const failed: Array<[string, string, string, boolean]> = [];
  const a: StartWith = {
    board: shown,
    device: (computerId) => (computerId ? `live:${computerId}` : "live:cloud"),
    startInCloud: async (input) => {
      cloud.push(input);
      return { computer_id: "c-box" };
    },
    reach: async (computerId, said) => {
      reached.push(computerId);
      // It wakes, then connects, each a later turn rather than a timer, so a test's settle() outlasts it on any OS:
      // timers fire on Windows' ~16 ms tick, where waits of 1 and then 5 ms ran past a 20 ms settle.
      await Promise.resolve();
      said(`Waking ${computerId}`);
      await Promise.resolve();
      said(`Connecting to ${computerId}`);
      return {
        start: async (input) => {
          started.push(input);
          return "w-new";
        },
      };
    },
    onStarted: (placeholder, real) => done.push([placeholder, real]),
    onFailed: (placeholder, text, why, again) => failed.push([placeholder, text, why, again]),
    now: () => 1_000,
    ...patch,
  };
  return { a, shown, cloud, reached, started, done, failed };
}

describe("a chat started on a Mac", () => {
  it("is on the board from the tap, and starts in the project's folder there through its runtime", async () => {
    const w = world();
    const id = startChat(ask(), w.a);
    expect(isStarting(id)).toBe(true);
    // At once: your message in it, at work, saying what it waits for.
    expect(w.shown.chats()).toMatchObject([
      {
        id,
        title: "Fix the relay test",
        repo: "relay",
        device: "live:c-mac",
        engine: "claude",
        phase: "working",
        line: "Sending",
        items: [{ kind: "you", text: "Fix the relay test", state: "sending" }],
      },
    ]);
    await settle(20);
    expect(w.cloud).toEqual([]);
    expect(w.reached).toEqual(["c-mac"]);
    expect(w.started).toEqual([
      {
        repo: { path: "/Users/ada/code/relay" },
        engine: "claude-agent",
        text: "Fix the relay test",
        title: "Fix the relay test",
      },
    ]);
    expect(w.done).toEqual([[id, "w-new"]]);
    expect(w.failed).toEqual([]);
    // What the wait said, in order.
    expect(w.shown.lines).toEqual(["Waking c-mac", "Connecting to c-mac"]);
  });

  it("clones a repository the Mac has no checkout of, and hands over the model picked with its effort and speed", async () => {
    const w = world();
    startChat(
      ask({
        project: { name: "site", github: "acme/site" },
        model: "claude-sonnet-5-5",
        effort: "high",
        speed: "fast",
      }),
      w.a,
    );
    await settle(20);
    expect(w.started).toEqual([
      {
        repo: { url: "https://github.com/acme/site" },
        engine: "claude-agent",
        text: "Fix the relay test",
        title: "Fix the relay test",
        model: "claude-sonnet-5-5",
        effort: "high",
        speed: "fast",
      },
    ]);
  });

  it("starts on what its place runs once the place answers, and says so from then on", async () => {
    const asked: unknown[] = [];
    const w = world({
      // The Mac has no Caveman engine: the chat starts on the agent it does run, at that agent's own model.
      settle: async (computerId, pick) => {
        asked.push([computerId, pick]);
        return { engine: "claude", model: "claude-opus-5-5" };
      },
    });
    const id = startChat(ask({ engine: "caveman", model: "auto", effort: "medium" }), w.a);
    expect(w.shown.chats()[0]).toMatchObject({ engine: "caveman", model: "auto" });
    await settle(20);
    // Asked only once the Mac answers, with what was picked and whether the person picked it themselves.
    expect(asked).toEqual([["c-mac", { engine: "caveman", model: "auto", picked: undefined }]]);
    expect(w.started).toMatchObject([
      { engine: "claude-agent", model: "claude-opus-5-5", effort: "medium" },
    ]);
    expect(w.shown.chats()[0]).toMatchObject({ id, engine: "claude", model: "claude-opus-5-5" });
    expect(w.done).toEqual([[id, "w-new"]]);
  });

  it("does not start where its place has nothing to run it on, and says so in the place's words", async () => {
    const w = world({
      settle: async () => {
        throw new Error(
          "No agent is set up on Studio yet. Set one up there (Settings > Models & keys).",
        );
      },
    });
    const id = startChat(ask(), w.a);
    await settle(20);
    expect(w.started).toEqual([]);
    expect(w.failed).toEqual([
      [
        id,
        "Fix the relay test",
        "The chat didn't start: No agent is set up on Studio yet. Set one up there (Settings > Models & keys).",
        true,
      ],
    ]);
  });
});

describe("a chat started in Cloud", () => {
  it("asks Cloud for the computer first, then starts on the one Cloud picked, cloned from GitHub", async () => {
    const w = world();
    const id = startChat(ask({ on: { kind: "cloud" }, engine: "codex" }), w.a);
    expect(w.shown.chats()).toMatchObject([{ id, device: "live:cloud", line: "Waking Cloud…" }]);
    await settle(20);
    // Only what Cloud's route takes: no person, no computer. Which computer is Cloud's choice.
    expect(w.cloud).toEqual([{ title: "Fix the relay test", repo: "acme/relay", engine: "codex" }]);
    expect(w.reached).toEqual(["c-box"]);
    // Never the Mac's folder: a Cloud computer clones it.
    expect(w.started).toEqual([
      {
        repo: { url: "https://github.com/acme/relay" },
        engine: "codex",
        text: "Fix the relay test",
        title: "Fix the relay test",
      },
    ]);
    expect(w.done).toEqual([[id, "w-new"]]);
    // It runs in Cloud, whichever of Cloud's computers Caveman picked: nobody reads which.
    expect(w.shown.chats()[0]!.device).toBe("live:cloud");
  });

  it("names every engine as the protocol does", () => {
    expect(ENGINE_ID).toEqual({
      caveman: "caveman",
      claude: "claude-agent",
      codex: "codex",
      cursor: "cursor",
      opencode: "opencode",
      grok: "grok",
    });
  });
});

describe("a chat that cannot start", () => {
  it("keeps your message where it is, marked as not sent, with the one line under it: what did not happen, and why", async () => {
    const why =
      "You have used this month's Cloud computer time. It comes back on Dec 1, or add credits in Caveman.";
    const w = world({
      startInCloud: async () => {
        throw new Error(why);
      },
    });
    const id = startChat(ask({ on: { kind: "cloud" } }), w.a);
    await settle(20);
    expect(w.reached).toEqual([]);
    expect(w.started).toEqual([]);
    // Trying again can work (the plan resets, credits are added): Try again is offered beside Discard.
    expect(w.failed).toEqual([[id, "Fix the relay test", `The chat didn't start: ${why}`, true]]);
    const chat = w.shown.chats()[0]!;
    expect(chat).toMatchObject({ id, phase: "done", line: "Not sent" });
    // What was typed is never dropped: it reads "Not sent", and the web's line says why in Cloud's own sentence.
    expect(chat.items).toMatchObject([
      { kind: "you", text: "Fix the relay test", state: "failed" },
      { kind: "text", text: `The chat didn't start: ${why}` },
    ]);
    // Nothing waits any more.
    expect(chat).not.toHaveProperty("wait");
    expect(didNotStart(chat)).toBe(true);
  });

  it("keeps what was typed under it while it was being started, marked as not sent too", async () => {
    const w = world({
      reach: async () => {
        await settle(10);
        throw new Error("Studio is asleep.");
      },
    });
    const id = startChat(ask(), w.a);
    // A follow-up typed while the chat was still being started.
    w.shown.dispatch({
      type: "update",
      id,
      patch: {
        items: [
          ...w.shown.chats()[0]!.items,
          {
            kind: "you",
            id: `${id}:after:1`,
            text: "And the timeout case?",
            at: 1_000,
            state: "sending",
          },
        ],
      },
    });
    await settle(30);
    expect(w.shown.chats()[0]!.items).toMatchObject([
      { kind: "you", text: "Fix the relay test", state: "failed" },
      { kind: "you", text: "And the timeout case?", state: "failed" },
      { kind: "text", text: "The chat didn't start: Studio is asleep." },
    ]);
  });

  it("says a computer that will not come, in the connection's own words", async () => {
    const w = world({
      reach: async () => {
        throw new Error("Studio is asleep. Start it in Cloud instead.");
      },
    });
    const id = startChat(ask(), w.a);
    await settle(20);
    expect(w.failed).toEqual([
      [
        id,
        "Fix the relay test",
        "The chat didn't start: Studio is asleep. Start it in Cloud instead.",
        true,
      ],
    ]);
    expect(w.started).toEqual([]);
  });

  it("says a failure in the words it is handed, as one sentence, and whether a second try can work", async () => {
    const refusal = new Error(
      "could not clone https://github.com/acme/relay.git: repository not found",
    );
    const heard: unknown[] = [];
    const w = world({
      reach: async () => ({
        start: async () => {
          throw refusal;
        },
      }),
      // What failed underneath is never the sentence (words.ts startWords): the place's name stands for it.
      words: (error, where) => {
        heard.push([error, where]);
        return `${where.name} couldn't start it`;
      },
      retries: () => false,
    });
    const id = startChat(ask({ project: { name: "relay", github: "acme/relay" } }), w.a);
    await settle(20);
    expect(heard).toEqual([[refusal, { name: "Studio", cloud: false }]]);
    expect(w.shown.chats()[0]!.items.at(-1)).toMatchObject({
      kind: "text",
      text: "The chat didn't start: Studio couldn't start it.",
    });
    expect(w.failed).toEqual([
      [id, "Fix the relay test", "The chat didn't start: Studio couldn't start it.", false],
    ]);
  });

  it("asks nobody for what is known not to work: a folder that is on no GitHub, in Cloud", async () => {
    const notes = { name: "notes", path: "/Users/ada/notes" };
    // The web's sentences for the same cases.
    expect(cannotStart({ project: notes, on: { kind: "cloud" } })).toBe(
      "Cloud needs this project on GitHub.",
    );
    expect(cannotStart({ project: notes, on: STUDIO })).toBeNull();
    expect(cannotStart({ project: { name: "ghost" }, on: STUDIO })).toBe(
      "Studio doesn't have ghost. Add it there first.",
    );
    const w = world();
    const id = startChat(ask({ project: notes, on: { kind: "cloud" } }), w.a);
    await settle(20);
    expect(w.cloud).toEqual([]);
    expect(w.reached).toEqual([]);
    // No second try changes what the project is: only Discard is offered.
    expect(w.failed).toEqual([
      [
        id,
        "Fix the relay test",
        "The chat didn't start: Cloud needs this project on GitHub.",
        false,
      ],
    ]);
    expect(didNotStart(w.shown.chats()[0]!)).toBe(true);
  });

  it("starts nothing for a chat its person let go of while it waited", async () => {
    const w = world();
    const id = startChat(ask({ on: { kind: "cloud" } }), w.a);
    w.shown.dispatch({ type: "remove", id });
    await settle(20);
    // No computer is woken for it, and nothing is started.
    expect(w.reached).toEqual([]);
    expect(w.started).toEqual([]);
    expect(w.done).toEqual([]);
    expect(w.failed).toEqual([]);
  });

  it("tries a start again by itself while Caveman cannot be reached, saying so in the one line, before it gives up", async () => {
    let tries = 0;
    const w = world({
      startInCloud: async () => {
        tries++;
        if (tries < 3) throw new TypeError("Network request failed");
        return { computer_id: "c-box" };
      },
    });
    const id = startChat(ask({ on: { kind: "cloud" } }), { ...w.a, again: 5 });
    await settle(5);
    // The person is not asked to do anything: the wait says what happened and that it is tried again.
    expect(w.shown.chats()[0]).toMatchObject({
      id,
      phase: "working",
      wait: { words: "Cloud couldn't start. Trying again." },
    });
    await until(() => w.done.length > 0 || w.failed.length > 0);
    expect(tries).toBe(3);
    expect(w.failed).toEqual([]);
    expect(w.done).toHaveLength(1);
  });

  it("tries a start Cloud has no room for again by itself, saying so, and no more than a few times", async () => {
    // What a Cloud computer's runtime answers a start it has no room for (session-protocol capacity.ts COMPUTER_FULL),
    // and what Cloud itself answers (409 cave_code_computer_full).
    const full = Object.assign(new Error("Cloud is busy. Trying again."), {
      name: "SessionProtocolError",
    });
    const refused = Object.assign(new Error("That Cloud computer runs as many chats as it can."), {
      name: "CloudError",
      status: 409,
      code: "cave_code_computer_full",
    });
    let tries = 0;
    const once = world({
      reach: async () => ({
        start: async () => {
          tries++;
          if (tries === 1) throw full;
          if (tries === 2) throw refused;
          return "w-new";
        },
      }),
    });
    const id = startChat(ask({ on: { kind: "cloud" } }), { ...once.a, again: 5 });
    await settle(3);
    expect(once.shown.chats()[0]).toMatchObject({
      id,
      phase: "working",
      wait: { words: "Cloud is busy. Trying again." },
    });
    await until(() => once.done.length > 0 || once.failed.length > 0);
    expect(tries).toBe(3);
    expect(once.failed).toEqual([]);
    expect(once.done).toEqual([[id, "w-new"]]);

    // Still no room after six tries: it says so and stops, with Try again and Discard.
    let asked = 0;
    const never = world({
      reach: async () => ({
        start: async () => {
          asked++;
          throw full;
        },
      }),
      words: () => "Cloud is busy.",
    });
    const stuck = startChat(ask({ on: { kind: "cloud" } }), { ...never.a, again: 2 });
    await until(() => never.failed.length > 0);
    expect(asked).toBe(6);
    expect(never.failed).toEqual([
      [stuck, "Fix the relay test", "The chat didn't start: Cloud is busy.", true],
    ]);
  });

  it("says what it waits for in one line from the tap, and never that it works before anything does", async () => {
    const w = world();
    const mac = startChat(ask(), w.a);
    expect(w.shown.chats().find((c) => c.id === mac)).toMatchObject({ wait: { words: "Sending" } });
    const cloud = startChat(ask({ on: { kind: "cloud" } }), w.a);
    expect(w.shown.chats().find((c) => c.id === cloud)).toMatchObject({
      line: "Waking Cloud…",
      wait: { words: "Waking Cloud…" },
    });
    await settle(20);
  });
});
