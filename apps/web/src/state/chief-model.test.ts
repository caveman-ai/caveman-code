import { describe, expect, it } from "vitest";
import { acceleratorFrom, arrivedJustNow, awayLine, briefLine, chiefCards, chiefModelSetting, chiefPickerEngines, chiefPickerValue, DEFAULT_CAPTURE_SHORTCUT, formatAccelerator, FRESH_MS, itemNote, moveItem, projectWaitsOnYou, queuedNotes, queueItems, snapshotOf, trayEdit, trayEntry, trayMove, suggestedSettled, suggestedStatus, unsortedCount, withoutChief, type ChiefItem, type SuggestedChat } from "./chief-model.ts";
import { chatStatus, foldersForSidebar, type WorkspaceView } from "./model.ts";
import type { ToolItem } from "./transcript-model.ts";

const item = (id: string, over: Partial<ChiefItem> = {}): ChiefItem => ({
  id,
  text: id,
  state: "queued",
  rank: 1,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: [],
  created_at: "2026-10-17T09:00:00Z",
  updated_at: "2026-10-17T09:00:00Z",
  ...over,
});
const ids = (items: ReadonlyArray<ChiefItem>) => queueItems(items).map((i) => i.id);

describe("the Queue", () => {
  const board = [
    item("c", { rank: 3 }),
    item("a", { rank: 1 }),
    item("pinned", { rank: 2, pinned: true }),
    item("started", { rank: 0, state: "started" }),
    item("dropped", { rank: 0, state: "dropped" }),
    item("new", { rank: 4, state: "unsorted" }),
  ];

  it("holds what is captured but not started, in rank order", () => {
    expect(ids(board)).toEqual(["a", "pinned", "c", "new"]);
    expect(unsortedCount(board)).toBe(1);
  });

  it("moves a note in the tray without sliding the notes it hides between yours", () => {
    // Queue order: q1, hidden unsorted u1, q2, hidden Suggested s1, q3, hidden u2. The tray shows q1, q2, q3.
    const board = [
      item("q1", { rank: 1 }),
      item("u1", { rank: 2, state: "unsorted" }),
      item("q2", { rank: 3 }),
      item("s1", { rank: 4, state: "proposed" }),
      item("q3", { rank: 5 }),
      item("u2", { rank: 6, state: "unsorted" }),
    ];
    const after = (id: string, before: string | null) => ids(moveItem(board, id, trayMove(board, id, before)));
    // q1 down one (the tray says: before q3): right after q2, s1 still after it.
    expect(after("q1", "q3")).toEqual(["u1", "q2", "q1", "s1", "q3", "u2"]);
    // q1 to the tray's end: right after q3, not past the hidden u2.
    expect(after("q1", null)).toEqual(["u1", "q2", "s1", "q3", "q1", "u2"]);
    // q3 up one (before q2): right after q1, so the hidden u1 now follows it.
    expect(after("q3", "q2")).toEqual(["q1", "q3", "u1", "q2", "s1", "u2"]);
    // q3 to the top: before q1.
    expect(after("q3", "q1")).toEqual(["q3", "q1", "u1", "q2", "s1", "u2"]);
  });

  it("names an image-only note by its images in the tray, and never saves that label as its words", () => {
    const image = { id: "img-1", name: "shot.png", mimeType: "image/png", size: 10 } as unknown as NonNullable<ChiefItem["attachments"]>[number];
    const only = item("only", { text: "", attachments: [image] });
    expect(trayEntry(only, [])).toEqual({ id: "only", text: "1 image" });
    expect(trayEdit(only, "1 image")).toBeNull();
    expect(trayEdit(only, "crop the header")).toBe("crop the header");
    const both = item("both", { text: "fix this", attachments: [image, image] });
    expect(trayEntry(both, [])).toEqual({ id: "both", text: "fix this", status: "2 images" });
    expect(trayEdit(both, "fix this")).toBeNull();
  });

  it("keeps the notes you queued in the box's tray, in order, while other work runs, held ones too", () => {
    const busy = [...board, item("suggested", { rank: 0, state: "proposed" }), item("working", { rank: 0, state: "started", workspace_ids: ["w1"] })];
    expect(queuedNotes(busy).map((i) => i.id)).toEqual(["a", "pinned", "c"]);
    // Held back by a limit or a time: still in the tray, saying why.
    const full = item("full", { rank: 5, state: "blocked", blocked_on: { kind: "capacity" } });
    const later = item("later", { rank: 6, state: "scheduled", not_before: "2026-10-17T15:00:00Z" });
    expect(queuedNotes([...busy, full, later]).map((i) => i.id)).toEqual(["a", "pinned", "c", "full", "later"]);
    // One the Chief asked you about is on the strip (it waits on you), never in the tray as well.
    const asked = item("asked", { rank: 7, state: "blocked", blocked_on: { kind: "you", reason: "Postgres or SQLite?" }, asked: { question: "Postgres or SQLite?", recommended: "SQLite", asked_at: "2026-10-17T09:00:00Z" } });
    expect(queuedNotes([...busy, asked]).map((i) => i.id)).not.toContain("asked");
    expect(itemNote(full, [])).toBe("Waits for a free chat");
    expect(itemNote(later, [], new Date("2026-10-17T09:00:00Z"))).toMatch(/^Starts /);
    expect(queuedNotes(moveItem(busy, "c", "a")).map((i) => i.id)).toEqual(["c", "a", "pinned"]);
  });

  it("moves an item where you drop it, pins it, and leaves every other rank alone", () => {
    const moved = moveItem(board, "new", "a");
    expect(ids(moved)).toEqual(["new", "a", "pinned", "c"]);
    expect(moved.find((i) => i.id === "new")?.pinned).toBe(true);
    // A pinned item keeps its place: nothing else was re-ranked.
    for (const i of board.filter((x) => x.id !== "new")) expect(moved.find((m) => m.id === i.id)).toEqual(i);
    expect(ids(moveItem(board, "a", null))).toEqual(["pinned", "c", "new", "a"]);
    expect(ids(moveItem(board, "c", "pinned"))).toEqual(["a", "c", "pinned", "new"]);
  });

  it("says what a blocked or scheduled item waits on", () => {
    const now = new Date("2026-10-17T08:00:00");
    const rail = item("rail", { title: "Chief rail UI" });
    expect(itemNote(item("x", { state: "blocked", blocked_on: { kind: "item", item_id: "rail" } }), [rail], now)).toBe("After Chief rail UI");
    expect(itemNote(item("x", { state: "blocked", blocked_on: { kind: "capacity" } }), [], now)).toBe("Waits for a free chat");
    expect(itemNote(item("x", { state: "unsorted" }), [], now)).toBe("Not sorted yet");
    expect(itemNote(item("x", { state: "queued" }), [], now)).toBeNull();
    expect(itemNote(item("x", { state: "scheduled", not_before: new Date("2026-10-17T09:00:00").toISOString() }), [], now)).toMatch(/^Starts at 9:00/);
  });
});

const w = (id: string, over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  title: id,
  repo: "app",
  repoRef: { path: "/repos/app" },
  branch: null,
  state: "working",
  asleep: false,
  detail: null,
  engine: { id: "caveman", label: "Caveman" },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: `s-${id}`,
  projectId: null,
  createdAt: "2026-10-17T08:00:00Z",
  updatedAt: "2026-10-17T08:00:00Z",
  unread: false,
  ...over,
});

describe("the Chief is never a chat", () => {
  it("leaves the Chief's thread out of every list", () => {
    const list: Array<{ id: string; kind?: string }> = [{ id: "a" }, { id: "chief", kind: "chief" }, { id: "b" }];
    expect(withoutChief(list).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("while you were away", () => {
  const before = snapshotOf([w("a"), w("b"), w("c"), w("d", { state: "needs_input" })], new Date("2026-10-17T09:00:00Z"));

  it("counts what finished, what needs you and what failed since you left", () => {
    const now = [
      w("a", { state: "completed" }),
      w("b", { state: "completed" }),
      w("c", { state: "failed" }),
      w("d", { state: "needs_input" }), // was already waiting: not news
      w("e", { state: "needs_input", createdAt: "2026-10-17T09:30:00Z" }),
    ];
    expect(awayLine(before, now)).toBe("While you were away: 2 done, 1 needs you, 1 failed, 1 started");
  });

  it("says nothing when nothing moved, or on a first visit", () => {
    expect(awayLine(before, [w("a"), w("b"), w("c"), w("d", { state: "needs_input" })])).toBeNull();
    expect(awayLine(null, [w("a", { state: "completed" })])).toBeNull();
  });
});

describe("Chief cards", () => {
  // The Caveman engine gives a declared tool's answer back as text: JSON for objects, plain words otherwise.
  const tool = (id: string, name: string, input: unknown, answer: unknown, status: ToolItem["status"] = "done"): ToolItem => ({
    kind: "tool",
    id,
    verb: "Ran",
    subject: name,
    parts: [{ action: "mcp", subject: name }],
    command: null,
    status,
    startedAt: "2026-10-17T09:00:00Z",
    finishedAt: null,
    added: null,
    removed: null,
    output: "",
    name,
    input,
    result: answer === null ? null : typeof answer === "string" ? answer : JSON.stringify(answer),
    icon: "other",
  });

  it("shows a started chat, folds proposals into one Suggested list, and keeps queue edits to one line", () => {
    const cards = chiefCards([
      tool("1", "chat_start", { title: "Renumber 0391", project_ids: ["p-cloud"] }, { state: "started", item_id: "i1", chats: [{ workspace_id: "ws1", title: "Renumber 0391", project_id: "p-cloud" }] }),
      tool("2", "mcp__chief__chat_start", { title: "Bench Codex", project_ids: ["p-app"] }, { state: "proposed", item_id: "i2", reason: "two chats" }),
      tool("3", "chat_start", { title: "Bench Claude", project_ids: ["p-app"] }, { state: "proposed", item_id: "i3" }),
      tool("4", "queue_add", { title: "dark mode for runs" }, {}),
      tool("5", "remember", { text: "never push agent-sdk origin", quote: "never push agent-sdk origin" }, { id: "n1", vid: "v1" }),
      tool("6", "ask", { question: "Which repo?", recommended: "Caveman Cloud" }, null, "running"),
    ]);
    expect(cards.map((c) => c.kind)).toEqual(["started", "suggested", "line", "remembered", "ask"]);
    expect(cards[0]).toMatchObject({ chats: [{ workspaceId: "ws1", title: "Renumber 0391" }], projects: ["p-cloud"] });
    expect(cards[1]).toMatchObject({ chats: [{ itemId: "i2", title: "Bench Codex" }, { itemId: "i3", title: "Bench Claude" }] });
    expect(cards[2]).toMatchObject({ text: "Queued “dark mode for runs”" });
    expect(cards[3]).toMatchObject({ noteId: "n1", vid: "v1", failed: false });
    expect(cards[4]).toMatchObject({ question: "Which repo?", recommended: "Caveman Cloud" });
  });

  it("Smart View: a quiet line for what opened beside the person; what the rules held back shows nothing", () => {
    const cards = chiefCards([
      tool("1", "view_open", { kind: "pr", project_id: "p", number: 7 }, { opened: true, id: "pr:p#7", said: "…" }),
      tool("2", "view_open", { kind: "chat", workspace_id: "ws1" }, { opened: true, id: "chat:ws1" }),
      tool("3", "view_open", { kind: "web", url: "http://localhost:5173/" }, { opened: false, said: "You opened something moments ago" }),
      tool("4", "view_open", { kind: "image", url: "https://x.dev/a.png" }, { opened: false, smart_view: "off" }),
      tool("5", "view_list", {}, { smart_view: "on", open: [] }),
      tool("6", "view_close", { id: "pr:p#7" }, { closed: true }),
    ]);
    expect(cards).toMatchObject([
      { kind: "line", tool: "view_open", text: "Opened #7 beside you" },
      { kind: "line", tool: "view_open", text: "Opened beside you:", workspaceId: "ws1" },
      { kind: "line", tool: "view_close", text: "Tidied up beside you" },
    ]);
  });

  it("reads the same answers when they come back as Claude Code's content blocks (the Chief on a Claude plan)", () => {
    const blocks = (answer: unknown) => [{ type: "text", text: JSON.stringify(answer) }];
    const cards = chiefCards([
      { ...tool("1", "mcp__chief__chat_start", { title: "Renumber 0391", project_ids: ["p-cloud"] }, null), result: blocks({ state: "started", item_id: "i1", chats: [{ workspace_id: "ws1", title: "Renumber 0391", project_id: "p-cloud" }] }) },
      { ...tool("2", "mcp__chief__remember", { text: "never push agent-sdk origin" }, null), result: { content: blocks({ id: "n1", vid: "v1" }) } },
    ]);
    expect(cards.map((c) => c.kind)).toEqual(["started", "remembered"]);
    expect(cards[0]).toMatchObject({ chats: [{ workspaceId: "ws1", title: "Renumber 0391" }] });
    expect(cards[1]).toMatchObject({ noteId: "n1", vid: "v1", failed: false });
  });

  it("reads the same answers when they come back as Codex's dynamic tool content items (the Chief on Codex)", () => {
    const items = (answer: unknown) => [{ type: "inputText", text: typeof answer === "string" ? answer : JSON.stringify(answer) }];
    const cards = chiefCards([
      { ...tool("1", "chat_start", { title: "Renumber 0391", project_ids: ["p-cloud"] }, null), result: items({ state: "started", item_id: "i1", chats: [{ workspace_id: "ws1", title: "Renumber 0391", project_id: "p-cloud" }] }) },
      { ...tool("2", "remember", { text: "never push agent-sdk origin" }, null), result: items({ id: "n1", vid: "v1" }) },
      { ...tool("3", "remember", { text: "x" }, null), result: items("Memory is off for this Chief.") },
    ]);
    expect(cards.map((c) => c.kind)).toEqual(["started", "remembered", "remembered"]);
    expect(cards[0]).toMatchObject({ chats: [{ workspaceId: "ws1", title: "Renumber 0391" }] });
    expect(cards[1]).toMatchObject({ noteId: "n1", vid: "v1", failed: false });
    expect(cards[2]).toMatchObject({ failed: true, reason: "Memory is off for this Chief." });
  });

  it("carries what the inline Suggested card shows: the brief's first line, a guessed project, and the runtime's reason", () => {
    const [card] = chiefCards([
      tool(
        "1",
        "chat_start",
        { title: "Bench Codex", project_ids: ["p-app"], guess: true, brief: "# Goal\nRun the TB4 bench on the Codex arm. Done when the table is in the report.\nStart at bench/run.ts." },
        { state: "proposed", item_id: "i1", reason: "The project is a guess, so the person confirms it (Suggested chats)." },
      ),
    ]);
    expect(card).toMatchObject({
      kind: "suggested",
      at: "2026-10-17T09:00:00Z",
      chats: [{ itemId: "i1", title: "Bench Codex", projects: ["p-app"], guess: true, brief: "Run the TB4 bench on the Codex arm.", reason: "The project is a guess, so the person confirms it (Suggested chats)." }],
    });
    expect(chiefCards([tool("2", "chat_start", { title: "B", project_ids: ["p"] }, { state: "proposed", item_id: "i2" })])[0]).toMatchObject({ chats: [{ guess: false, brief: null, reason: null }] });
  });

  it("says when a start was refused or is waiting for room, and never claims a note it could not save", () => {
    const cards = chiefCards([
      tool("1", "chat_start", { title: "A" }, { state: "blocked", item_id: "i1", reason: "capacity" }),
      tool("2", "chat_start", { title: "B" }, "No project p9: pick one from the project list.", "failed"),
      tool("3", "remember", { text: "x" }, 'Not the person\'s words: "x" is not verbatim in any note they typed.', "failed"),
      tool("4", "queue_update", { title: "C" }, "No item i9 on the board.", "failed"),
      tool("5", "queue_update", { title: "C" }, { ok: true }),
    ]);
    expect(cards.map((c) => (c.kind === "line" ? c.text : c.kind))).toEqual([
      "Queued “A”: no free chat yet",
      "Could not start “B”: No project p9: pick one from the project list.",
      "remembered",
      "Could not update “C”",
      "Updated “C”",
    ]);
    expect(cards[2]).toMatchObject({ failed: true, reason: 'Not the person\'s words: "x" is not verbatim in any note they typed.' });
  });
});

describe("the Suggested card", () => {
  const chat = (itemId: string | null): SuggestedChat => ({ itemId, title: "Bench", projects: ["p"], brief: null, guess: false, reason: null });

  it("reads the board, so the card and the Queue row are one item in one state", () => {
    const board = [item("waits", { state: "proposed" }), item("started", { state: "started" }), item("gone", { state: "dropped" }), item("back", { state: "queued" })];
    expect(suggestedStatus(chat("waits"), board)).toBe("waiting");
    // Start from the card or the Queue: the item moves and both show it started.
    expect(suggestedStatus(chat("waits"), board.map((i) => (i.id === "waits" ? { ...i, state: "started" as const } : i)))).toBe("started");
    // Dismiss from the card or Drop in the Queue: both show it dismissed.
    expect(suggestedStatus(chat("waits"), board.map((i) => (i.id === "waits" ? { ...i, state: "dropped" as const } : i)))).toBe("dismissed");
    expect(suggestedStatus(chat("started"), board)).toBe("started");
    expect(suggestedStatus(chat("gone"), board)).toBe("dismissed");
    expect(suggestedStatus(chat("back"), board)).toBe("gone");
    expect(suggestedStatus(chat("missing"), board)).toBe("gone");
    expect(suggestedStatus(chat(null), board)).toBe("gone");
  });

  it("leaves the page once every chat on it is started, dismissed or back in the Queue", () => {
    const board = [item("a", { state: "proposed" }), item("b", { state: "proposed" })];
    expect(suggestedSettled([chat("a"), chat("b")], board)).toBe(false);
    // One started: the other still waits, so the card stays.
    expect(suggestedSettled([chat("a"), chat("b")], board.map((i) => (i.id === "a" ? { ...i, state: "started" as const } : i)))).toBe(false);
    // Start all, or start one and dismiss the other: nothing waits, the card goes.
    expect(suggestedSettled([chat("a"), chat("b")], board.map((i) => ({ ...i, state: "started" as const })))).toBe(true);
    expect(suggestedSettled([chat("a"), chat("b")], board.map((i) => ({ ...i, state: i.id === "a" ? ("started" as const) : ("dropped" as const) })))).toBe(true);
    // Taken back into the Queue, or gone from the board: the Queue holds it, the card has nothing to do.
    expect(suggestedSettled([chat("a")], [item("a", { state: "queued" })])).toBe(true);
    expect(suggestedSettled([chat("missing")], board)).toBe(true);
  });

  it("shows the brief's first sentence, short, without markdown furniture", () => {
    expect(briefLine("# Goal\n- Renumber the migration. Then bump the README.")).toBe("Renumber the migration.");
    expect(briefLine("Goal: ship it\nDone when: tests pass")).toBe("Goal: ship it");
    expect(briefLine(`${"x".repeat(200)}`, 20)).toBe(`${"x".repeat(19)}…`);
    expect(briefLine("  \n\n")).toBeNull();
    expect(briefLine(null)).toBeNull();
  });

  it("is fresh only just after it lands, never for the page's own history", () => {
    const now = Date.parse("2026-10-17T09:00:30Z");
    expect(arrivedJustNow("2026-10-17T09:00:10Z", now)).toBe(true);
    expect(arrivedJustNow(new Date(now - FRESH_MS).toISOString(), now)).toBe(false);
    expect(arrivedJustNow("2026-10-17T08:00:00Z", now)).toBe(false);
    expect(arrivedJustNow("2026-10-17T09:01:00Z", now)).toBe(false);
    expect(arrivedJustNow(null, now)).toBe(false);
  });
});

describe("the capture shortcut", () => {
  const press = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("records a chord as an Electron accelerator, never a bare key", () => {
    expect(acceleratorFrom(press("Space", { ctrlKey: true, altKey: true }), true)).toBe("Control+Alt+Space");
    expect(acceleratorFrom(press("KeyK", { metaKey: true, shiftKey: true }), true)).toBe("Shift+Command+K");
    expect(acceleratorFrom(press("Digit1", { altKey: true }), true)).toBe("Alt+1");
    expect(acceleratorFrom(press("KeyK"), true)).toBeNull();
    expect(acceleratorFrom(press("KeyK", { shiftKey: true }), true)).toBeNull();
    expect(acceleratorFrom(press("ShiftLeft", { shiftKey: true, ctrlKey: true }), true)).toBeNull();
    // The Windows key is Super off the Mac: Electron's Command does nothing there.
    expect(acceleratorFrom(press("Space", { ctrlKey: true, altKey: true }), false)).toBe("Control+Alt+Space");
    expect(acceleratorFrom(press("KeyK", { metaKey: true, shiftKey: true }), false)).toBe("Shift+Super+K");
  });
  it("shows it the way a Mac does, and the way Windows does", () => {
    expect(formatAccelerator(DEFAULT_CAPTURE_SHORTCUT, true)).toBe("⌃⌥Space");
    expect(formatAccelerator("Shift+Command+K", true)).toBe("⇧⌘K");
    expect(formatAccelerator(DEFAULT_CAPTURE_SHORTCUT, false)).toBe("Ctrl+Alt+Space");
    expect(formatAccelerator("Shift+Super+K", false)).toBe("Shift+Win+K");
    expect(formatAccelerator("CommandOrControl+Shift+Space", false)).toBe("Ctrl+Shift+Space");
  });
});

describe("the Chief's model picker", () => {
  const engines = [
    { id: "caveman", label: "Caveman", models: [{ id: "auto", label: "Auto", efforts: [] }, { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "high"] }] },
    { id: "claude-agent", label: "Claude Agent", models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["high"] }] },
    { id: "codex", label: "Codex", models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", efforts: [] }] },
  ];
  const options = [
    { engine: "caveman", models: ["auto", "anthropic/claude-sonnet-5-5", "deepseek/deepseek-v4"] },
    { engine: "claude-agent", models: ["claude-opus-5-5"], label: "Plan · via Claude Code", hint: "Claude models only. Counts against your Claude plan's limits." },
  ];

  it("offers only what the runtime says is connected, a Claude plan with its quiet label and tooltip", () => {
    const picker = chiefPickerEngines(options, engines);
    expect(picker.map((e) => [e.id, e.label, e.models.map((m) => m.id)])).toEqual([
      ["caveman", "Caveman", ["auto", "anthropic/claude-sonnet-5-5", "deepseek/deepseek-v4"]],
      ["claude-agent", "Plan · via Claude Code", ["claude-opus-5-5"]],
    ]);
    expect(picker[1]!.hint).toContain("Claude models only");
    // Codex is offered only once the runtime lists one of its logins.
    expect(picker.some((e) => e.id === "codex")).toBe(false);
  });

  it("a Codex login and a Claude API key are sections of their own, under their engine's name while each has one", () => {
    const withLogins = [
      options[0]!,
      { engine: "claude-agent", models: ["claude-opus-5-5"], account_id: "claudeAgent-account-5e6f7a8b" },
      { engine: "codex", models: ["caveman-auto", "gpt-6-astra"], account_id: "codex" },
    ];
    const logins = engines.map((e) =>
      e.id === "claude-agent" ? { ...e, auth: { accounts: [{ id: "claudeAgent-account-5e6f7a8b", label: "Anthropic API key" }] } } : e.id === "codex" ? { ...e, auth: { accounts: [{ id: "codex", label: "me@example.com" }] } } : e,
    );
    const picker = chiefPickerEngines(withLogins, logins);
    expect(picker.map((e) => [e.id, e.harness, e.label, e.account])).toEqual([
      ["caveman", undefined, "Caveman", undefined],
      ["claude-agent#claudeAgent-account-5e6f7a8b", "claude-agent", "Claude Agent", undefined],
      ["codex#codex", "codex", "Codex", undefined],
    ]);
    const setting = chiefModelSetting(picker[2]!.id, "gpt-6-astra", "high");
    expect(setting).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high", account_id: "codex" });
    expect(chiefPickerValue(setting, picker)).toEqual({ engine: "codex#codex", model: "gpt-6-astra" });
  });

  it("shows the pick while it is offered, else Auto; Auto is stored as no pick", () => {
    const picker = chiefPickerEngines(options, engines);
    expect(chiefPickerValue(null, picker)).toEqual({ engine: "caveman", model: "auto" });
    expect(chiefPickerValue({ engine: "claude-agent", model: "claude-opus-5-5" }, picker)).toEqual({ engine: "claude-agent", model: "claude-opus-5-5" });
    expect(chiefPickerValue({ engine: "caveman", model: "openai/gpt-6-luna" }, picker)).toEqual({ engine: "caveman", model: "auto" });
    expect(chiefModelSetting("caveman", "auto")).toBeNull();
    expect(chiefModelSetting("claude-agent", "claude-opus-5-5", "high")).toEqual({ engine: "claude-agent", model: "claude-opus-5-5", effort: "high" });
  });

  it("two Claude plans are two sections, each under its login's name, and a pick names its login", () => {
    const hint = "Claude models only. Counts against your Claude plan's limits.";
    const two = [
      options[0]!,
      { engine: "claude-agent", models: ["claude-opus-5-5"], label: "Plan · via Claude Code", hint, account_id: "claudeAgent:default", tag: "CA" },
      { engine: "claude-agent", models: ["claude-opus-5-5"], label: "Plan · via Claude Code", hint, account_id: "claudeAgent-account-1a2b3c4d", tag: "CM" },
    ];
    const logins = engines.map((e) => (e.id === "claude-agent" ? { ...e, auth: { accounts: [{ id: "claudeAgent:default", label: "Work" }, { id: "claudeAgent-account-1a2b3c4d", label: "Personal" }] } } : e));
    const picker = chiefPickerEngines(two, logins);
    expect(picker.map((e) => [e.id, e.harness, e.account])).toEqual([
      ["caveman", undefined, undefined],
      ["claude-agent#claudeAgent:default", "claude-agent", "Work"],
      ["claude-agent#claudeAgent-account-1a2b3c4d", "claude-agent", "Personal"],
    ]);
    const setting = chiefModelSetting(picker[2]!.id, "claude-opus-5-5");
    expect(setting).toEqual({ engine: "claude-agent", model: "claude-opus-5-5", account_id: "claudeAgent-account-1a2b3c4d" });
    expect(chiefPickerValue(setting, picker)).toEqual({ engine: "claude-agent#claudeAgent-account-1a2b3c4d", model: "claude-opus-5-5" });
    // A pick from before logins were named shows in the first Claude section; one on a login that is gone, Auto.
    expect(chiefPickerValue({ engine: "claude-agent", model: "claude-opus-5-5" }, picker)?.engine).toBe("claude-agent#claudeAgent:default");
    expect(chiefPickerValue({ engine: "claude-agent", model: "claude-opus-5-5", account_id: "claudeAgent-account-gone" }, picker)).toEqual({ engine: "caveman", model: "auto" });
  });
});

describe("vendor marks in the model picker", () => {
  it("names the vendor of every model it can tell, the engine's tile otherwise", async () => {
    const { modelVendor } = await import("@caveman-app/ui/components/model-picker");
    expect(modelVendor("claude-agent", "claude-opus-5-5")).toBe("claude");
    expect(modelVendor("codex", "gpt-6-astra")).toBe("openai");
    expect(modelVendor("caveman", "anthropic/claude-sonnet-5-5")).toBe("claude");
    expect(modelVendor("caveman", "caveman/anthropic/claude-haiku-5-5")).toBe("claude");
    expect(modelVendor("caveman", "chatgpt/openai/gpt-6-luna")).toBe("openai");
    expect(modelVendor("caveman", "deepseek/deepseek-v4")).toBe("deepseek");
    expect(modelVendor("caveman", "google/gemini-4-argon")).toBe("gemini");
    expect(modelVendor("caveman", "openai~2/gpt-6-luna")).toBe("openai");
    expect(modelVendor("caveman", "openrouter/moonshotai/kimi-k3")).toBe("moonshot");
    expect(modelVendor("caveman", "together/qwen-3.8")).toBeUndefined();
    expect(modelVendor("caveman", "constructor/x")).toBeUndefined();
    expect(modelVendor("caveman", "auto")).toBeUndefined();
  });
});

describe("a project waits on you", () => {
  const at = "2026-11-15T09:00:00.000Z";
  const chat = (id: string, over: Partial<WorkspaceView> = {}) =>
    ({ id, title: id, repo: "app", repoRef: { path: "/app" }, branch: null, state: "completed", asleep: false, detail: null, engine: { id: "caveman", label: "Caveman" }, computer: { kind: "this_mac", label: "This Mac" }, parentId: null, sessionId: null, projectId: "p-app", createdAt: at, updatedAt: at, unread: false, ...over }) as WorkspaceView;
  const waits = (chats: WorkspaceView[]) => projectWaitsOnYou(foldersForSidebar([{ id: "p-app", name: "app", path: "/app" }], chats)[0]!.rows, (w) => chatStatus(w));
  const asks = { ask: { kind: "approval" as const, prompt: "Run pnpm test" }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false };

  it("while a chat of it, or a builder under one, asks something", () => {
    expect(waits([chat("a"), chat("b", { state: "working" })])).toBe(false);
    expect(waits([chat("a", { state: "needs_input" })])).toBe(true);
    expect(waits([chat("lead"), chat("b", { parentId: "lead", state: "working", activity: asks })])).toBe(true);
  });
});
