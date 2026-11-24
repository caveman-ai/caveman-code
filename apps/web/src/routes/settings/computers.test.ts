import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { livesHere, RuntimeContext, thisComputerName, type RuntimeContextValue } from "../../state/runtime.tsx";
import type { CloudComputerRow, EngineDescriptor } from "@caveman-app/session-protocol";
import { chatsOnComputer, CLOUD_FAILED, CLOUD_HELD_UP } from "../../state/cloud.ts";
import { cloudComputersView, failedView, readChatsOnComputer } from "../../state/useCloudComputers.ts";
import { ComputersList, ComputersSettings, LidList } from "./Computers.tsx";
import { cloudChanges, cloudRow, deleteWords, macRows, UNREACHABLE } from "./computers-model.ts";
import { lidLines, lidMoves, lidMovesWrite, lidSummaryKey, type LidChatFacts, type LidSummary } from "./lid-summary.ts";

const NOW = new Date("2026-11-10T12:00:00Z");
const row = (id: string, name: string, desired_state: CloudComputerRow["desired_state"], observed_state: CloudComputerRow["observed_state"], over: Partial<CloudComputerRow> = {}): CloudComputerRow => ({
  id,
  name,
  driver: "boat",
  size: "4cpu-16gb",
  desired_state,
  observed_state,
  observed_reason: "",
  updated_at: "2026-11-03T00:00:00Z",
  ...over,
});
const chatOn = (id: string, computer: WorkspaceView["computer"], over: Partial<WorkspaceView> = {}) => ({ id, title: id, computer, state: "completed", projectId: null, repo: "", sessionId: id, ...over }) as WorkspaceView;
const CLOUD = (id: string) => ({ kind: "caveman_cloud" as const, label: "Cloud", id });
const HERE = { kind: "this_mac" as const, label: THIS_COMPUTER, id: "this-mac" };
const PROJECTS = [
  { id: "p-acme", name: "acme" },
  { id: "p-docs", name: "docs-site" },
];
const ready = (...computers: CloudComputerRow[]) => cloudComputersView({ available: true, computers });

// ----------------------------------------------------------------- Macs

test("this Mac comes first with its own chats, then each other Mac by its own name, online or asleep as Caveman says", () => {
  const workspaces = [
    chatOn("a", HERE),
    chatOn("b", HERE, { state: "working" }),
    chatOn("gone", HERE, { state: "archived" }),
    chatOn("step", HERE, { automationStep: true }),
    chatOn("s1", { kind: "laptop", label: "Studio" }),
    chatOn("s2", { kind: "laptop", label: "Studio" }),
    chatOn("c1", CLOUD("c-acme")),
  ];
  const listed = [
    { runtime_id: "rt-mine", name: "Ada's MacBook", online: true },
    { runtime_id: "rt-studio", name: "Studio", online: false },
    { runtime_id: "rt-mini", name: "Mini", online: true },
  ];
  expect(macRows({ here: THIS_COMPUTER, workspaces, lives: livesHere, listed, ownRuntimeId: "rt-mine" })).toEqual([
    { key: "here", name: THIS_COMPUTER, chats: 2, state: { label: "Online", tone: "ok" } },
    { key: "mac:Mini", name: "Mini", chats: 0, state: { label: "Online", tone: "ok" } },
    { key: "mac:Studio", name: "Studio", chats: 2, state: { label: "Asleep", tone: "idle" } },
  ]);
  // Signed out of Caveman, another Mac is known only by the chats this window lists on it: no state is made up.
  expect(macRows({ here: THIS_COMPUTER, workspaces, lives: livesHere })[1]).toEqual({ key: "mac:Studio", name: "Studio", chats: 2 });
  // The web is on no Mac: every Mac goes by its own name.
  expect(macRows({ here: null, workspaces: [], lives: livesHere, listed }).map((m) => m.name)).toEqual(["Ada's MacBook", "Mini", "Studio"]);
});

test("this computer is named by the chats that live on it, never by one it let go to another Mac", () => {
  const moved = chatOn("w-moved", { kind: "this_mac", label: "Mac B", id: "computer-b" });
  expect(thisComputerName([moved, chatOn("w-here", HERE)])).toBe(THIS_COMPUTER);
  expect(thisComputerName([moved])).toBe(THIS_COMPUTER);
  expect(macRows({ here: THIS_COMPUTER, workspaces: [moved, chatOn("w-here", HERE)], lives: livesHere }).map((m) => [m.name, m.chats])).toEqual([
    [THIS_COMPUTER, 1],
    ["Mac B", 1],
  ]);
});

// ----------------------------------------------------------------- Cloud

test("Cloud is one row: how many chats run there, how many projects are running, and the share of this month's plan", () => {
  const workspaces = [chatOn("1", CLOUD("c-acme"), { projectId: "p-acme" }), chatOn("2", CLOUD("c-acme"), { projectId: "p-acme" }), chatOn("3", CLOUD("c-acme"), { projectId: "p-acme" }), chatOn("4", CLOUD("c-docs"), { projectId: "p-docs" })];
  const out = cloudRow({ view: ready(row("c-acme", "acme-web", "running", "running"), row("c-docs", "box-a", "suspended", "suspended")), workspaces, projects: PROJECTS, usage: { pct: 12.9 }, now: NOW });
  expect(out.chats).toBe(4);
  expect(out.state).toEqual({ label: "1 running · 12% of this month's plan", tone: "ok" });
  // One line per project, by the project's name: never a machine's name, a size, a CPU or a GB.
  expect(out.projects).toEqual([
    { id: "c-acme", name: "acme", chats: 3, state: { label: "Running", tone: "ok" } },
    { id: "c-docs", name: "docs-site", chats: 1, state: { label: "Asleep", tone: "idle" } },
  ]);
  expect(JSON.stringify(out)).not.toMatch(/acme-web|box-a|4cpu|CPU|GB/);
  // A project this window has no chat of goes by its repository, else by Cloud's own word for it.
  expect(cloudRow({ view: ready(row("c-x", "landing", "suspended", "suspended")), workspaces: [chatOn("9", CLOUD("c-x"), { repo: "acme/landing-page" })], projects: [] }).projects[0]?.name).toBe("landing-page");
  expect(cloudRow({ view: ready(row("c-x", "landing", "suspended", "suspended")), workspaces: [], projects: [] }).projects[0]?.name).toBe("landing");
});

test("Cloud's one state: a start that failed or is held up first, then running, waking, paused by the plan, asleep", () => {
  const state = (...computers: CloudComputerRow[]) => cloudRow({ view: ready(...computers), workspaces: [], projects: [], usage: { pct: 40, resetsAt: "2026-12-01T12:00:00Z" }, now: NOW }).state;
  expect(state()).toEqual({ label: "Asleep · 40% of this month's plan", tone: "idle" });
  expect(state(row("a", "a", "running", "suspended"), row("b", "b", "suspended", "suspended")).label).toBe("Waking… · 40% of this month's plan");
  expect(state(row("a", "a", "running", "starting", { observed_reason: "booting" })).label).toBe("Waking… · 40% of this month's plan");
  // Put to sleep: asleep from the moment it was asked, never "Going to sleep" or "Stopped".
  expect(state(row("a", "a", "suspended", "running")).label).toBe("Asleep · 40% of this month's plan");
  expect(state(row("a", "a", "stopped", "stopped")).label).toBe("Asleep · 40% of this month's plan");
  // Nothing pays for its time: paused until the plan starts over, with no button to press.
  expect(state(row("a", "a", "suspended", "suspended", { sleep_reason: "usage" }))).toEqual({ label: "Paused until Dec 1 · plan used up", tone: "idle" });
  // A start that is held up, and one Cloud gave up on: our sentence, and the service's own words only as the detail.
  expect(state(row("a", "a", "running", "pending", { observed_reason: "no host has room for 4 CPU, 16 GB" }), row("b", "b", "running", "running"))).toEqual({ label: CLOUD_HELD_UP, tone: "warn", detail: "no host has room for 4 CPU, 16 GB" });
  expect(state(row("a", "a", "running", "failed", { observed_reason: "image pull failed" }))).toEqual({ label: CLOUD_FAILED, tone: "bad", detail: "image pull failed" });
  expect(CLOUD_HELD_UP).toBe("Cloud couldn't start. Trying again.");
  expect(CLOUD_FAILED).toBe("Cloud couldn't start. Send a message to try again.");
});

test("before Cloud's list is read, signed out, turned off or unreachable, the row says so in a few words", () => {
  const at = (view: Parameters<typeof cloudRow>[0]["view"]) => cloudRow({ view, workspaces: [chatOn("1", CLOUD("c"))], projects: [] });
  expect(at({ state: "loading" }).state.label).toBe("Loading…");
  expect(at({ state: "signed_out" })).toMatchObject({ state: { label: "Not signed in" }, action: "sign_in", chats: 1 });
  expect(at({ state: "off" }).state.label).toBe("Turned off by your admin");
  expect(at({ state: "error", error: "Caveman had a problem. Try again." }).state).toEqual({ label: UNREACHABLE, tone: "warn", detail: "Caveman had a problem. Try again." });
});

// m-20: one failed poll replaced every row with an error (and unmounted an open dialog).
test("a failed poll keeps the last good list under one line that says Caveman can't be reached (m-20)", () => {
  const good = ready(row("c1", "acme", "running", "running"));
  const after = failedView(good, "Caveman had a problem. Try again.");
  expect(after).toEqual({ state: "ready", computers: [row("c1", "acme", "running", "running")], error: "Caveman had a problem. Try again." });
  const out = cloudRow({ view: after, workspaces: [], projects: [] });
  expect(out.state.label).toBe(UNREACHABLE);
  expect(out.projects.map((p) => p.state.label)).toEqual(["Running"]);
  expect(failedView({ state: "loading" }, "down")).toEqual({ state: "error", error: "down" });
  expect(cloudComputersView({ available: true, computers: [] })).not.toHaveProperty("error");
});

const list = (props: Partial<Parameters<typeof ComputersList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ComputersList, {
        macs: macRows({ here: THIS_COMPUTER, workspaces: [chatOn("a", HERE)], lives: livesHere }),
        cloud: cloudRow({ view: ready(row("c-acme", "acme-web", "running", "running"), row("c-bad", "box-b", "running", "failed", { observed_reason: "image pull failed" })), workspaces: [chatOn("1", CLOUD("c-acme"), { projectId: "p-acme" }), chatOn("2", CLOUD("c-bad"), { projectId: "p-docs" })], projects: PROJECTS }),
        known: () => [],
        onDelete: async () => undefined,
        ...props,
      }),
    ),
  );

test("the screen is one flat list: no machine name, size, Sleep, Wake or Open, and a failed start's reason only behind a click", () => {
  const html = list({ open: true });
  expect(html).toContain(THIS_COMPUTER);
  expect(html).toContain("1 chat");
  expect(html).toContain("Online");
  expect(html).toContain(">Cloud");
  expect(html).toContain("acme");
  for (const never of ["acme-web", "box-b", "CPU", " GB", ">Sleep<", ">Wake<", ">Open<", "Each Cloud computer", "workspace", "updates when it next wakes", "lost this computer"]) expect(html).not.toContain(never);
  // The service's own words are not on the page until Details is pressed.
  expect(html).toContain(CLOUD_FAILED.replace("'", "&#x27;"));
  expect(html).not.toContain("image pull failed");
  expect(html).toContain(">Details<");
  // Delete is in each project's menu, named for a screen reader by the project.
  expect(html).toContain('aria-label="acme in Cloud: options"');
  // Closed, Cloud is one row.
  expect(list()).not.toContain("in Cloud: options");
  // Signed out, its one button signs in; nothing else is offered.
  const out = list({ cloud: cloudRow({ view: { state: "signed_out" }, workspaces: [], projects: [] }) });
  expect(out).toContain('href="/settings/account"');
  expect(out).toContain("Not signed in");
});

test("the state dot pulses only without reduced motion", () => {
  expect(list({ cloud: cloudRow({ view: ready(row("c", "c", "running", "suspended")), workspaces: [], projects: [] }) })).toContain("animate-pulse motion-reduce:animate-none");
});

// Asleep, waking and gone are heard as they happen, not only seen.
test("what changed in Cloud between two polls is one line for a screen reader; the first list says nothing (a11y)", () => {
  const project = (id: string, name: string, label: string) => ({ id, name, chats: 0, state: { label, tone: "idle" as const } });
  const before = new Map([
    ["c1", { name: "acme", label: "Running" }],
    ["c2", { name: "docs-site", label: "Asleep" }],
    ["c3", { name: "landing", label: "Running" }],
  ]);
  expect(cloudChanges(null, [project("c1", "acme", "Running")])).toBe("");
  expect(cloudChanges(before, [project("c1", "acme", "Asleep"), project("c2", "docs-site", "Waking…")])).toBe("acme: Asleep. docs-site: Waking…. landing: Deleted.");
  expect(cloudChanges(new Map([["c1", { name: "acme", label: "Running" }]]), [project("c1", "acme", "Running")])).toBe("");
});

// ----------------------------------------------------------------- delete

const listed = (computerId: string, active: Parameters<typeof chatsOnComputer>[1], archived: Parameters<typeof chatsOnComputer>[2] = []) => ({ state: "listed" as const, ...chatsOnComputer(computerId, active, archived) });
const chat = (session_id: string, computer_id: string, title: string, kind: "chat" | "chief" | "builder" | "setup" | "automation" = "chat", archived = false) => ({ session_id, computer_id, title, kind, archived });

test("deleting a project from Cloud asks once: the chats it archives, by name, and that uncommitted work there is lost", () => {
  const words = deleteWords("acme", listed("c1", [chat("s1", "c1", "Fix login"), chat("s2", "c1", "Refactor auth"), chat("s3", "c2", "Elsewhere")]));
  expect(words).toEqual({ title: "Delete acme from Cloud?", description: "Archives 2 chats: Fix login, Refactor auth. Uncommitted work there is lost. Chat history is kept.", confirm: "Delete", waiting: false });
  // More than three are counted, not listed out.
  expect(deleteWords("acme", listed("c1", [1, 2, 3, 4, 5].map((n) => chat(`s${n}`, "c1", `Chat ${n}`)))).description).toContain("Archives 5 chats: Chat 1, Chat 2, Chat 3 and 2 more.");
});

// A-7: deleting destroys the disk, and with it the uncommitted work archived chats keep there for Restore.
test("the question never says nothing is there: archived chats that lose their work are named, and a list that can't be read says so (A-7)", () => {
  expect(deleteWords("acme", listed("c1", [], [chat("s1", "c1", "Old spike", "chat", true)])).description).toBe("Old spike is archived and loses its uncommitted work. Uncommitted work there is lost. Chat history is kept.");
  expect(deleteWords("acme", { state: "unlisted", why: "Caveman had a problem. Try again." }, ["Fix login"]).description).toBe("Couldn't list its chats. Archives 1 chat: Fix login. Uncommitted work there is lost. Chat history is kept.");
  // While Cloud's lists are read, Delete waits.
  expect(deleteWords("acme", { state: "loading" })).toMatchObject({ description: "Looking for its chats…", waiting: true });
});

test("the question reads every kind of chat from both of Cloud's lists (A-7)", async () => {
  const asked: Array<boolean | undefined> = [];
  const api = {
    list: async (archived?: boolean) => {
      asked.push(archived);
      return { chats: archived ? [chat("s2", "c1", "Spike", "chat", true)] : [chat("s1", "c1", "Chief", "chief")], runtimes: [], seq: 1 } as never;
    },
  };
  expect(await readChatsOnComputer(api, "c1")).toEqual({ state: "listed", on: [{ title: "Chief", kind: "chief" }], archived: [{ title: "Spike", kind: "chat" }] });
  expect(asked.sort()).toEqual([false, true]);
});

// ----------------------------------------------------------------- when this Mac sleeps

const summary: LidSummary = {
  chats: [
    { session_id: "s-moves", outcome: "continues", reason: "It continues on a Cloud computer", gaps: [] },
    { session_id: "s-gaps", outcome: "continues_with_gaps", reason: "It continues on a Cloud computer", gaps: ["leaves .env on this Mac"] },
    { session_id: "s-big", outcome: "pauses", reason: "Its uncommitted changes are 12 MiB, more than a move carries", fix: "Commit and push the large files, or keep it on this Mac.", gaps: [] },
    { session_id: "s-claude", outcome: "pauses", reason: "Claude Agent needs a login on Cloud computers", fix: "Connect your Claude plan or an Anthropic API key in Settings > Models & keys.", gaps: [] },
    { session_id: "s-codex", outcome: "pauses", reason: "Codex chats stay on this Mac when the lid closes (Settings, Computers)", fix: "Turn on moving Codex chats when the lid closes (Settings, Computers).", gaps: [] },
    { session_id: "s-folder", outcome: "stays", reason: "This chat's repository isn't on GitHub, so a Cloud computer can't check it out", fix: "Push the repository to GitHub to have its chats continue on Cloud.", gaps: [] },
    { session_id: "s-two", outcome: "continues", reason: "It continues on a Cloud computer", gaps: [] },
    { session_id: "s-new", outcome: "pauses", reason: "Something the page has never heard of", gaps: [] },
  ],
};
const CLAUDE = { id: "claude-agent", label: "Claude Agent" };
const facts: Record<string, LidChatFacts> = {
  "s-moves": { title: "Fix login", engine: { id: "caveman", label: "Caveman" } },
  "s-gaps": { title: "Env chat", engine: { id: "caveman", label: "Caveman" } },
  "s-big": { title: "Dataset import", engine: { id: "caveman", label: "Caveman" } },
  "s-claude": { title: "Tidy docs", engine: CLAUDE },
  "s-codex": { title: "Port tests", engine: { id: "codex", label: "Codex" } },
  "s-folder": { title: "Fix webhook retries", engine: CLAUDE, folder: true },
  "s-two": { title: "Rename billing", engine: CLAUDE, sources: [{}, {}] },
  "s-new": { title: "Odd one", engine: CLAUDE },
};

test("only chats that will not carry on are listed, each with why in six words or fewer and its fix", () => {
  const lines = lidLines(summary, (id) => facts[id]);
  expect(lines.map((l) => [l.title, `${l.what} · ${l.why}`, l.fix?.kind])).toEqual([
    ["Dataset import", "Pauses · uncommitted files too large", undefined],
    ["Tidy docs", "Pauses · Claude isn't connected", "connect"],
    ["Port tests", "Pauses · Codex chats turned off", "agents_on"],
    ["Fix webhook retries", "Stays here · folder project", undefined],
    // The lid keeps a chat in several repositories whatever the summary says (the runtime's move check).
    ["Rename billing", "Stays here · works in 2 repositories", undefined],
    ["Odd one", "Pauses · can't run in Cloud yet", undefined],
  ]);
  for (const line of lines) expect(line.why.split(/\s+/).length).toBeLessThanOrEqual(6);
  // A chat that carries on, with or without something left behind, is not an exception.
  expect(lines.some((l) => l.title === "Fix login" || l.title === "Env chat")).toBe(false);
  // The runtime's own sentence is kept for a hover, whole.
  expect(lines[0]?.detail).toBe("Its uncommitted changes are 12 MiB, more than a move carries. Commit and push the large files, or keep it on this Mac.");
  expect(lidLines({ chats: [summary.chats[0]!] }, (id) => facts[id])).toEqual([]);
});

const engineOf = (id: string, everywhere?: "available"): EngineDescriptor => ({ id, label: id, auth: { state: "signed_in", accounts: [], ...(everywhere ? { everywhere } : {}) } }) as unknown as EngineDescriptor;
const lid = (settings: Parameters<typeof lidMoves>[0], lines = lidLines(summary, (id) => facts[id]), engines: ReadonlyArray<EngineDescriptor> = [engineOf("claude-agent", "available")]) =>
  renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      { value: { client: null, engines, workspaces: [], settings: null, refresh: async () => undefined } as unknown as RuntimeContextValue },
      createElement(MemoryRouter, null, createElement(LidList, { settings, lines, engines, onSave: () => undefined })),
    ),
  );

test("the lid setting is one dropdown, off until chosen: no all-clear, no exceptions and no Keep on while it is off", () => {
  for (const settings of [{}, { sync_chats: false, move_to_cloud: true }, { sync_chats: true, move_to_cloud: false }]) {
    const html = lid(settings);
    expect(html).toContain(`When ${thisComputer} sleeps`);
    expect(html).toContain("Pause them");
    expect(html).not.toContain("Keep chats going in Cloud<");
    for (const never of ["Tidy docs", "Every chat here continues", "Keep on", "Turn off", "Not set up", "Move Claude Agent and Codex chats too", "sealed with", "copy"]) expect(html).not.toContain(never);
  }
});

test("on, it lists the exceptions with their buttons; with none it says nothing more", () => {
  const html = lid({ sync_chats: true, move_to_cloud: true });
  expect(html).toContain("Keep chats going in Cloud");
  expect(html).toContain("Pauses · Claude isn&#x27;t connected");
  expect(html).toContain(">Connect Claude<");
  expect(html).toContain("Stays here · folder project");
  // The choice that was a switch: said only where it was once turned off, with the button that turns it back on.
  expect(html).toContain("Pauses · Codex chats turned off");
  expect(html).toContain(">Turn on<");
  expect(html).not.toContain("Move Claude Agent and Codex chats too");
  // Where this window can't start a plan's sign-in, the button goes to where it is made, never to a dead end.
  expect(lid({ sync_chats: true }, undefined, [engineOf("claude-agent")])).toContain('href="/settings/models"');
  const none = lid({ sync_chats: true }, []);
  expect(none).toContain("Keep chats going in Cloud");
  expect(none).not.toMatch(/Every chat|continues|Pauses|Stays/);
});

// C1: the dropdown says what the runtime does. Chats keep going only while they are saved (sync_chats, or
// move_to_cloud until sync was answered) and the lid's own setting is not off.
test("the dropdown reads off when chats aren't saved, whatever the lid's own setting says; on writes both, off only the lid's", () => {
  expect(lidMoves({ sync_chats: false, move_to_cloud: true })).toBe("off");
  expect(lidMoves({ sync_chats: true, move_to_cloud: false })).toBe("off");
  expect(lidMoves({ move_to_cloud: false })).toBe("off");
  expect(lidMoves({ sync_chats: false })).toBe("off");
  expect(lidMoves({ sync_chats: true })).toBe("on");
  expect(lidMoves({ move_to_cloud: true })).toBe("on");
  expect(lidMoves({ sync_chats: true, move_to_cloud: true })).toBe("on");
  expect(lidMoves({})).toBe("unset");
  expect(lidMovesWrite(true)).toEqual({ move_to_cloud: true, sync_chats: true });
  expect(lidMovesWrite(false)).toEqual({ move_to_cloud: false });
});

test("the lid summary is read again when a chat starts or stops working or moves, not only when the list's length changes (m-18)", () => {
  const settings = { sync_chats: true, move_to_cloud: true, move_other_engines: true };
  const one = (state: string, updatedAt: string, kind = "this_mac") => ({ sessionId: "s1", state, updatedAt, computer: { kind } });
  const idle = lidSummaryKey(settings, [one("idle", "2026-11-03T01:00:00Z")]);
  expect(lidSummaryKey(settings, [one("working", "2026-11-03T01:00:05Z")])).not.toBe(idle);
  expect(lidSummaryKey(settings, [one("parked", "2026-11-03T01:00:09Z", "caveman_cloud")])).not.toBe(idle);
  expect(lidSummaryKey({ ...settings, move_to_cloud: false }, [one("idle", "2026-11-03T01:00:00Z")])).not.toBe(idle);
  const two = [one("idle", "a"), { ...one("working", "b"), sessionId: "s2" }];
  expect(lidSummaryKey(settings, [...two].reverse())).toBe(lidSummaryKey(settings, two));
});

// ----------------------------------------------------------------- the page

test("Settings > Computers counts this Mac's own chats and names another Mac by its name, with no heading or paragraph", () => {
  const moved = chatOn("w-moved", { kind: "this_mac", label: "Mac B", id: "computer-b" });
  const html = renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      { value: { client: null, engines: [], projects: [], workspaces: [moved, chatOn("w-studio", { kind: "laptop", label: "Studio" }), chatOn("w-1", HERE), chatOn("w-2", HERE)], settings: null, refresh: async () => undefined } as unknown as RuntimeContextValue },
      createElement(MemoryRouter, null, createElement(ComputersSettings)),
    ),
  );
  expect(html).toContain(THIS_COMPUTER);
  expect(html).toContain("2 chats");
  expect(html).toContain("Studio");
  expect(html).toContain("Mac B");
  expect(html).not.toMatch(/<h[23]|<p class/);
  expect(html).not.toContain("workspace");
});

test("no row says a computer updates when it next wakes, or that its disk was lost", () => {
  const html = list({ open: true, cloud: cloudRow({ view: ready({ ...row("c1", "acme-web", "running", "running"), disk_lost_at: new Date(Date.now() - 3_600_000).toISOString(), disk_lost_reason: "volume not found", runtime_outdated: true }), workspaces: [], projects: [] }) });
  expect(html).not.toMatch(/lost|volume not found|updates when/);
  expect(html).toContain("Running");
});
