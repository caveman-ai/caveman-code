// The person's own board behind the app's own store and seams: a computer's chats land on the board through the
// board's reducer (store/board.ts), and what the screens call (board/script.ts send, resend, respond, takeBack, stop,
// start) reaches that computer instead of the script. The runtime here is a stand-in client that records its calls; the real one is in
// packages/runtime's phoneLive.integration.test.ts.
import type { Client } from "@caveman-app/session-protocol/client";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: {
    board: "board",
    inbox: "inbox",
    sessions: "sessions",
    boot: "boot",
    away: "away",
    link: "link",
  },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import {
  adoptDevices,
  CLOUD,
  computerRows,
  DEVICES,
  deviceById,
  deviceByLabel,
  startDevices,
} from "../board/model";
import {
  addProject,
  adoptProjects,
  blocked,
  candidates,
  type Place,
  projects,
  searchNote,
  settle as settleOn,
} from "../board/places";
import * as script from "../board/script";
import { clearForLive, dispatch, store } from "../store/store";
import { getDraft } from "../store/sessions";
import {
  computerIdOf,
  connected,
  deviceIdOf,
  deviceOf,
  goLive,
  isLive,
  leave,
  reach,
  runtimeOf,
  startsWith,
  type Followed,
  type LiveStart,
  type Runtime,
} from "./seams";
import { liveSource, type LiveSource } from "./source";

const STUDIO: Followed = { runtime_id: "rt-1", computer_id: "c-1", kind: "laptop", name: "Studio" };
const AT = "2026-11-09T10:00:00.000Z";

const workspace = (patch: Partial<Workspace> = {}): Workspace =>
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
  }) as Workspace;

/** A runtime's client, as much as the source uses: what was called, the list it answers with, and events to send. */
function standIn(list: Workspace[]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let changed: (w: Workspace) => void = () => {};
  let events: (event: SessionEvent) => void = () => {};
  let cursor = 0;
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "workspace.list") return { workspaces: list };
      if (method === "workspace.get") return list[0];
      if (method === "engine.list") return { engines: stand.engines };
      if (method === "workspace.create")
        return workspace({
          id: `w-new-${calls.length}`,
          session_id: `s-new-${calls.length}`,
          status: "working",
        });
      return {};
    },
    on: (_name: string, handler: (w: Workspace) => void) => {
      changed = handler;
      return () => {};
    },
    attach: async (_session: string, _cursor: number, onEvent: (event: SessionEvent) => void) => {
      events = onEvent;
      return { detach: async () => {} };
    },
  } as unknown as Client;
  const send = (type: SessionEvent["type"], payload: unknown, item_id?: string) =>
    events({
      session_id: "s1",
      cursor: ++cursor,
      at: AT,
      type,
      payload,
      ...(item_id ? { item_id } : null),
    } as unknown as SessionEvent);
  const stand = {
    client,
    calls,
    send,
    change: (w: Workspace) => changed(w),
    called: (method: string) => calls.filter((c) => c.method === method),
    engines: [] as Array<{
      id: string;
      models: Array<{ id: string; efforts?: string[]; speeds?: string[] }>;
    }>,
  };
  return stand;
}

const chat = (id = "w1") => store.get().board.chats.find((c) => c.id === id);
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Until the runtime has heard `count` messages: a send names its message by a WebCrypto digest before it is handed over. */
const submitted = (count: number) =>
  vi.waitFor(() => expect(runtime.called("turn.submit")).toHaveLength(count));

let source: LiveSource;
/** What the seams are handed for it. */
let reached: Runtime;
let runtime: ReturnType<typeof standIn>;
const closed = vi.fn();

beforeEach(async () => {
  // As link.ts does when someone signs in.
  script.stopScript();
  goLive();
  clearForLive();
  runtime = standIn([workspace()]);
  source = liveSource({
    client: runtime.client,
    board: { chats: () => store.get().board.chats, dispatch: (change) => dispatch(change) },
    device: deviceIdOf(STUDIO),
  });
  // Its computer answers: an answer is heard at once, never queued.
  reached = {
    owns: source.owns,
    send: source.send,
    resend: source.resend,
    stop: source.stop,
    respond: source.respond,
    holds: (chat, said) => source.hold(chat, said),
    choose: () => undefined,
  };
  connected({ runtime: reached, close: closed });
  await source.sync();
});

afterEach(() => {
  source.close();
  leave();
  closed.mockClear();
});

describe("a computer's chats on the person's own board", () => {
  it("are the board's, by the computer's own name, and the script leaves them alone", async () => {
    expect(isLive()).toBe(true);
    expect(store.get().board.chats).toHaveLength(1);
    expect(chat()).toMatchObject({
      id: "w1",
      title: "Fix the relay test",
      repo: "relay",
      device: "live:c-1",
      engine: "claude",
      phase: "done",
      chief: null,
    });
    // The script does not start on a board that is a computer's own: no greeting, no turn played on its chats.
    script.ensureScript();
    await settle(20);
    expect(store.get().board.greeted).toBe(false);
    expect(chat()?.plan).toBeUndefined();
  });

  it("words arrive through the board's reducer as they are written, without the chat moving in its lists", async () => {
    source.open("w1");
    await settle();
    runtime.change(workspace({ status: "working" }));
    runtime.send("turn.started", { model: "claude-sonnet-4-5" });
    runtime.send("message.delta", { text: "All five " }, "m1");
    await settle();
    const first = chat()!;
    expect(first).toMatchObject({
      phase: "working",
      line: "Writing",
      model: "claude-sonnet-4-5",
      items: [{ kind: "text", text: "All five " }],
    });
    runtime.send("message.delta", { text: "checks pass." }, "m1");
    await settle();
    expect(chat()!.items).toMatchObject([{ kind: "text", text: "All five checks pass." }]);
    // A word is not news: the chat keeps its place (lists sort by updatedAt).
    expect(chat()!.updatedAt).toBe(first.updatedAt);
  });

  it("what the board kept of a chat stays until its transcript is read again", async () => {
    dispatch({
      type: "update",
      id: "w1",
      patch: { items: [{ kind: "text", id: "kept", text: "From last time.", at: 1 }] },
    });
    // The computer's list comes again (a reconnect): the row is brought up to date, the transcript it has is not wiped.
    await source.sync();
    expect(chat()!.items).toMatchObject([{ id: "kept" }]);
    source.open("w1");
    await settle();
    runtime.send("message.done", { role: "assistant", text: "The real one." }, "m1");
    await settle();
    expect(chat()!.items).toMatchObject([{ kind: "text", text: "The real one." }]);
  });
});

describe("the seams reach the computer's runtime", () => {
  it("a message goes to it, shown at once", async () => {
    expect(runtimeOf("w1")).toBe(reached);
    expect(runtimeOf("migration")).toBeNull();
    script.send("w1", "Run the tests again");
    await submitted(1);
    expect(runtime.called("turn.submit")).toMatchObject([
      { params: { session_id: "s1", kind: "followup", input: { text: "Run the tests again" } } },
    ]);
    expect(chat()).toMatchObject({
      phase: "working",
      items: [{ kind: "you", text: "Run the tests again", state: "sent" }],
    });
    // Nothing of the script's: no plan to play, no scripted acknowledgement.
    expect(chat()!.plan).toBeUndefined();
  });

  it("an answer shows now, reaches the runtime after its Undo has passed, and never does when taken back", async () => {
    source.open("w1");
    await settle();
    const ask = () => {
      runtime.send(
        "tool.started",
        {
          name: "Bash",
          title: "pnpm db:migrate",
          kind: "command",
          input: { command: "pnpm db:migrate" },
        },
        "t1",
      );
      runtime.send(
        "ask.user",
        {
          kind: "approval",
          title: "Run a command",
          tool_item_id: "t1",
          options: [
            { id: "yes", decision: "allow" },
            { id: "no", decision: "deny" },
          ],
        },
        "ask1",
      );
      runtime.change(workspace({ status: "needs_input" }));
    };
    ask();
    await settle();
    expect(chat()).toMatchObject({
      phase: "needs",
      ask: "pnpm db:migrate",
      need: { kind: "approval", command: "pnpm db:migrate" },
    });

    // Taken back inside the hold: the ask is back as it was, and the runtime heard nothing.
    const asked = script.respond("w1", { kind: "allow" }, 40);
    expect(asked?.phase).toBe("needs");
    expect(chat()).toMatchObject({ phase: "working" });
    expect(chat()!.need).toBeUndefined();
    script.takeBack(asked!);
    await settle(80);
    expect(runtime.called("ask.respond")).toEqual([]);
    expect(chat()).toMatchObject({ phase: "needs", need: { kind: "approval" } });

    // Left alone, it is heard once the hold has passed.
    script.respond("w1", { kind: "allow" }, 40);
    expect(runtime.called("ask.respond")).toEqual([]);
    await settle(80);
    expect(runtime.called("ask.respond")).toMatchObject([
      {
        params: {
          session_id: "s1",
          ask_id: "ask1",
          response: { kind: "approval", option_id: "yes" },
        },
      },
    ]);
  });

  it("an answer its place cannot hear says it is queued from the tap on: never Allowed, nothing at work, no ask docked again", async () => {
    source.open("w1");
    await settle();
    runtime.send(
      "tool.started",
      {
        name: "Bash",
        title: "pnpm db:migrate",
        kind: "command",
        input: { command: "pnpm db:migrate" },
      },
      "t1",
    );
    runtime.send(
      "ask.user",
      {
        kind: "approval",
        title: "Run a command",
        tool_item_id: "t1",
        options: [
          { id: "yes", decision: "allow" },
          { id: "no", decision: "deny" },
        ],
      },
      "ask1",
    );
    runtime.change(workspace({ status: "needs_input" }));
    await settle();
    // Its place sleeps: what the seam says an answer given now reads.
    connected({
      runtime: {
        ...reached,
        holds: (_chat, said) => (said ? "Allow queued · waking Cloud" : null),
      },
      close: closed,
    });
    const asked = script.respond("w1", { kind: "allow" }, 40);
    expect(asked?.phase).toBe("needs");
    expect(chat()).toMatchObject({
      phase: "working",
      line: "Allow queued · waking Cloud",
      wait: { words: "Allow queued · waking Cloud" },
    });
    expect(chat()!.need).toBeUndefined();
    const ask = chat()!.items.find((item) => item.kind === "ask");
    expect(ask).toMatchObject({ pending: "Allow queued · waking Cloud" });
    expect(ask).not.toHaveProperty("answer");
    // Taken back: it asks again, and nothing says it waits.
    script.takeBack(asked!);
    expect(chat()).toMatchObject({ phase: "needs", need: { kind: "approval" } });
    expect(chat()).not.toHaveProperty("wait");
  });

  it("Stop interrupts its turn", async () => {
    runtime.change(workspace({ status: "working" }));
    script.stop("w1");
    await settle();
    expect(runtime.called("turn.interrupt")).toMatchObject([{ params: { session_id: "s1" } }]);
    // The stop mark comes from the runtime's own event, not from the script.
    expect(chat()!.items).toEqual([]);
  });

  it("a chat it starts runs on the model picked where the computer lists it, else on the computer's own default", async () => {
    const created = () => runtime.called("workspace.create").map((c) => c.params);
    runtime.engines = [{ id: "claude-agent", models: [{ id: "claude-sonnet-5-5" }] }];
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      text: "Add a dark theme",
      model: "claude-sonnet-5-5",
    });
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      text: "Add a dark theme",
      model: "claude-opus-9",
    });
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "codex",
      text: "Add a dark theme",
      model: "claude-sonnet-5-5",
    });
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      text: "Add a dark theme",
    });
    expect(created().map((p) => p.options)).toEqual([
      { model: "claude-sonnet-5-5" },
      undefined,
      undefined,
      undefined,
    ]);
    expect(created()[0]).toMatchObject({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      task: { text: "Add a dark theme" },
    });
    // Asked only when a model was picked.
    expect(runtime.called("engine.list")).toHaveLength(3);
  });

  it("a chat it starts takes the effort and speed picked where the computer lists them for the model", async () => {
    runtime.engines = [
      {
        id: "claude-agent",
        models: [{ id: "claude-opus-5-5", efforts: ["low", "high"], speeds: ["fast"] }],
      },
    ];
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      text: "Add a dark theme",
      model: "claude-opus-5-5",
      effort: "high",
      speed: "fast",
    });
    // An effort or a speed the model lacks there is left to the computer's own default, never sent to be refused.
    await source.start({
      repo: { path: "/Users/ada/code/relay" },
      engine: "claude-agent",
      text: "Add a dark theme",
      model: "claude-opus-5-5",
      effort: "ultracode",
      speed: "ultrafast",
    });
    expect(runtime.called("workspace.create").map((c) => c.params.options)).toEqual([
      { model: "claude-opus-5-5", effort: "high", speed: "fast" },
      { model: "claude-opus-5-5" },
    ]);
  });

  it("a pick in a chat's own picker goes with its next turn, and shows as the chat's own meanwhile", async () => {
    // As link.ts hands it over: by the ids the chat's computer lists.
    connected({
      runtime: {
        ...reached,
        choose: (id, pick) =>
          source.choose(id, {
            engine: "codex",
            model: pick.model,
            ...(pick.effort ? { effort: pick.effort } : {}),
          }),
      },
      close: closed,
    });
    script.setModel("w1", { engine: "codex", model: "gpt-5-5", effort: "high" });
    expect(chat()).toMatchObject({ engine: "codex", model: "gpt-5-5", effort: "high" });
    script.send("w1", "Run the tests again");
    await submitted(1);
    expect(runtime.called("turn.submit")).toMatchObject([
      {
        params: {
          kind: "followup",
          input: { text: "Run the tests again" },
          options: { engine: "codex", model: "gpt-5-5", effort: "high" },
        },
      },
    ]);
    // The chat keeps saying its pick while its computer still names the agent it ran on before.
    runtime.change(workspace({ status: "working" }));
    expect(chat()).toMatchObject({ engine: "codex", model: "gpt-5-5" });
    // Words for a turn that runs steer it as it runs: they carry no pick.
    script.send("w1", "Also the timeout case");
    await submitted(2);
    expect(runtime.called("turn.submit")[1]!.params).toMatchObject({ kind: "steer" });
    expect(runtime.called("turn.submit")[1]!.params).not.toHaveProperty("options");
  });

  it("names a chat's project as the app lists it, where it knows, and again once that is read anew", async () => {
    const names = new Map<string, string>();
    const made = standIn([
      workspace({
        id: "w7",
        session_id: "s7",
        repo: { path: "/home/caveman/workspace" },
        project_id: "p1",
      } as Partial<Workspace>),
    ]);
    const named = liveSource({
      client: made.client,
      board: { chats: () => store.get().board.chats, dispatch: (change) => dispatch(change) },
      device: deviceIdOf(STUDIO),
      project: (w) => (w.project_id ? names.get(w.project_id) : undefined),
    });
    made.change(
      workspace({
        id: "w7",
        session_id: "s7",
        repo: { path: "/home/caveman/workspace" },
        project_id: "p1",
      } as Partial<Workspace>),
    );
    // Not told yet: the folder's own name.
    expect(chat("w7")!.repo).toBe("workspace");
    names.set("p1", "relay");
    named.refresh();
    expect(chat("w7")!.repo).toBe("relay");
    named.close();
  });

  it("a new chat starts for real, through the link, and the script never makes one up", () => {
    // Before the link has loaded there is nothing to start it: no chat is made, and the caller has nothing to open.
    expect(
      script.start("Add a dark theme", {
        engine: "claude",
        model: "sonnet",
        effort: "high",
        repo: "relay",
      }),
    ).toBe("");
    expect(store.get().board.chats).toHaveLength(1);

    const asked: LiveStart[] = [];
    startsWith((start) => {
      asked.push(start);
      return "starting:1";
    });
    expect(
      script.start("Add a dark theme", {
        engine: "claude",
        model: "sonnet",
        effort: "high",
        repo: "relay",
        device: "live:c-1",
      }),
    ).toBe("starting:1");
    expect(asked).toEqual([
      {
        text: "Add a dark theme",
        repo: "relay",
        device: "live:c-1",
        engine: "claude",
        model: "sonnet",
        effort: "high",
      },
    ]);
    // Nothing to send, nothing started.
    expect(
      script.start("   ", { engine: "claude", model: "sonnet", effort: "high", repo: "relay" }),
    ).toBe("");
    expect(asked).toHaveLength(1);
    // The script made no chat of its own, and plays no turn.
    expect(store.get().board.chats).toHaveLength(1);
    startsWith(null);
  });

  it("a real chat no computer holds is never played by the script: nothing is made up, and what was typed goes back to its box", async () => {
    // As after a relaunch before Caveman's list was read: the board holds a chat from last time that nothing holds yet.
    dispatch({
      type: "add",
      chat: {
        ...chat()!,
        id: "from-last-time",
        title: "From last time",
        phase: "needs",
        need: { kind: "approval", command: "pnpm deploy", summary: "", at: 1 },
        ask: "pnpm deploy",
        items: [],
      },
    });
    expect(reach("from-last-time")).toBe("away");
    expect(reach("w1")).toBe(reached);
    const before = chat("from-last-time");

    script.send("from-last-time", "Ship it");
    expect(script.respond("from-last-time", { kind: "allow" }, 0)).toBeNull();
    script.stop("from-last-time");
    await settle(30);
    expect(runtime.calls.filter((c) => c.method !== "workspace.list")).toEqual([]);
    // Untouched: no message of yours, no made-up answer, still asking.
    expect(chat("from-last-time")).toBe(before);
    // Never deleted: the words are back in the chat's own box, and one line says so.
    expect(getDraft("from-last-time")).toBe("Ship it");
    expect(store.get().board.toast?.text).toBe("Not sent. Your words are back in the box.");
  });

  it("a message that was not sent is sent again through the seam, in its place", async () => {
    script.resend("w1", "sp-msg:none");
    await settle(10);
    // Nothing by that id was held back: nothing is sent twice.
    expect(runtime.called("turn.submit")).toEqual([]);
    // The script's own chats have no such thing.
    expect(() => script.resend("migration", "x")).not.toThrow();
  });

  it("starting again ends the connections and gives the seams back to the script", () => {
    leave();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(isLive()).toBe(false);
    expect(runtimeOf("w1")).toBeNull();
    expect(reach("w1")).toBeNull();
    // The scripted world's computers are back.
    expect(deviceById("mbp").name).toBe("Julius's MacBook Pro");
  });
});

describe("a place by its name", () => {
  it("is a Mac by its own name, and Cloud as Cloud whichever of its computers: never a machine's name", async () => {
    adoptDevices([
      deviceOf(STUDIO, "online"),
      deviceOf(
        { runtime_id: "rt-2", computer_id: "c-2", kind: "cloud", name: "acme-web" },
        "asleep",
      ),
    ]);
    expect(DEVICES.map((d) => [d.id, d.name, d.kind, d.status])).toEqual([
      ["live:c-1", "Studio", "mac", "online"],
      ["live:c-2", "Cloud", "cloud", "asleep"],
    ]);
    expect(deviceById("live:c-1")).toMatchObject({ name: "Studio", about: "Online" });
    expect(JSON.stringify(DEVICES)).not.toContain("acme-web");
  });

  it("is the same computer whichever runtime it runs as", () => {
    // A Cloud computer runs as another runtime after every wake, and with none while it sleeps.
    const asleep: Followed = { runtime_id: "", computer_id: "c-2", kind: "cloud", name: "box-a" };
    expect(deviceIdOf(asleep)).toBe("live:c-2");
    const awake: Followed = { ...asleep, runtime_id: "rt-9" };
    expect(deviceIdOf(awake)).toBe("live:c-2");
    expect(computerIdOf("live:c-2")).toBe("c-2");
    // The scripted computers, and Cloud as a pick, stand for no computer of the person's.
    expect(computerIdOf("mbp")).toBeNull();
    expect(computerIdOf("live:cloud")).toBeNull();
  });
});

describe("where a new chat can start on the person's own board", () => {
  const relay: Place = { name: "relay", github: "acme/relay", path: "/Users/ada/code/relay" };
  const notes: Place = { name: "notes", path: "/Users/ada/notes" };

  const adopt = (studio: "online" | "asleep" | "offline") => {
    const devices = [deviceOf(STUDIO, studio), CLOUD];
    adoptDevices(devices, devices);
    adoptProjects([relay, notes]);
  };

  it("offers the Mac and one Cloud, never a list of Cloud computers", () => {
    adopt("online");
    // Two places, however many computers are behind Cloud.
    expect(DEVICES.map((d) => d.name)).toEqual(["Studio", "Cloud"]);
    expect(computerRows().map((r) => [r.name, r.icon])).toEqual([
      ["Studio", "computer-this-mac"],
      ["Cloud", "computer-cloud"],
    ]);
    expect(deviceByLabel("Cloud")).toBe(CLOUD);
    expect(deviceById(CLOUD.id)).toBe(CLOUD);
    expect(deviceByLabel("Studio")?.id).toBe("live:c-1");
  });

  it("starts on the Mac while it answers, and says why a project cannot start somewhere", () => {
    adopt("online");
    const [studio] = startDevices();
    expect(blocked(relay, studio!)).toBeNull();
    expect(blocked(relay, CLOUD)).toBeNull();
    // A folder that is on no GitHub is the Mac's alone.
    expect(blocked(notes, studio!)).toBeNull();
    expect(blocked(notes, CLOUD)).toBe("Cloud needs this project on GitHub.");
    expect(settleOn(notes, CLOUD)).toBe(studio);
    expect(searchNote()).toBeNull();
    // Nothing is suggested that the phone was not told of.
    expect(candidates()).toEqual([]);
  });

  it("starts in Cloud while the Mac is away: nothing queues a new chat for a Mac that sleeps", () => {
    adopt("asleep");
    const [studio] = startDevices();
    expect(blocked(relay, studio!)).toBe("Studio is asleep");
    expect(settleOn(relay, studio!)).toBe(CLOUD);
    // A folder only on the Mac can start nowhere until the Mac is back.
    expect(settleOn(notes, studio!)).toBe(studio);
    // The Mac's own row says it is asleep: no second line over the list says so again.
    expect(searchNote()).toBeNull();
    adopt("offline");
    expect(blocked(relay, startDevices()[0]!)).toBe("Studio is offline");
  });

  it("keeps a project added from the phone when the computer's are read again, and gives the scripted ones back", () => {
    adopt("online");
    const added = addProject({ name: "site", github: "acme/site" });
    // No folder is made up for it: only the Mac says where a clone lands.
    expect(added).toEqual({ name: "site", github: "acme/site", path: undefined, added: true });
    adoptProjects([relay]);
    expect(projects.get().map((p) => p.name)).toEqual(["relay", "site"]);
    leave();
    expect(projects.get().map((p) => p.name)).toContain("caveman-code");
    expect(candidates().length).toBeGreaterThan(0);
    expect(startDevices()).toBe(DEVICES);
  });
});
