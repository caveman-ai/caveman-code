// The notch in Chromium, under a real pointer: what a press does when the notch opened by itself, or its card changed,
// while the pointer was at work elsewhere (docs/, "A click it did not earn"; guard.ts). The mouse
// goes to a place and presses there, aiming at nothing: what is under it takes the press, as it would a person's.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { commands } from "vitest/browser";
import type { ChatStatus, ChatStatusId } from "../state/model.ts";
import "../styles.css";
import { ARM_MS } from "./guard.ts";
import type { NotchAgent, NotchCard, NotchState } from "./model.ts";
import "./notch.css";
import { Notch, type NotchBridge, type NotchFeedState } from "./Notch.tsx";

const status = (id: ChatStatusId, label: string, action = false): ChatStatus => ({
  id,
  label,
  detail: null,
  action,
  since: null,
  progress: null,
  agents: 0,
});
const WORKING: NotchAgent = {
  id: "w1",
  title: "Port the theme page",
  status: status("working", "Working"),
};
const ALLOW = "ask\ta1\t0";
/** Chat B asks to run a command: the computer-use ask's own three options, the widest first. */
const ASKS: NotchCard = {
  id: "c2",
  title: "Clean up the build cache",
  status: status("approve", "Approve", true),
  line: "Allow Claude Agent to use Finder?",
  command: null,
  image: null,
  ask: "a1",
  trouble: null,
  index: 0,
  count: 1,
  prev: null,
  next: null,
  keys: [
    { id: ALLOW, label: "Always allow", tone: "lit" },
    { id: "ask\ta1\t1", label: "Allow in this chat", tone: "card" },
    { id: "ask\ta1\t2", label: "Deny", tone: "card" },
  ],
};
/** Chat A finished, with work to land. Its keys stand where the ask's do: one line of text over each. */
const FINISHED: NotchCard = {
  id: "c1",
  title: "Redesign the settings page",
  status: status("done", "Finished"),
  line: "4 files changed on the settings page.",
  command: null,
  image: null,
  ask: null,
  trouble: null,
  index: 0,
  count: 1,
  prev: null,
  next: null,
  keys: [
    { id: "ship", label: "Ship it", tone: "lit" },
    { id: "later", label: "Later", tone: "card" },
  ],
};
const row = (card: NotchCard): NotchAgent => ({
  id: card.id,
  title: card.title,
  status: card.status,
});
/** What the app says: the card's chat first, then the others. A wait in `unseen` that was not there before opens the notch. */
const word = (
  card: NotchCard | null,
  unseen: string[] = [],
  others: NotchAgent[] = [WORKING],
): NotchState => ({ agents: [...(card ? [row(card)] : []), ...others], card, unseen });

interface Shown {
  readonly host: HTMLElement;
  /** What the notch asked the shell to do, in order. */
  readonly acts: unknown[];
  readonly say: (state: NotchState) => void;
  readonly isOpen: () => boolean;
  /** The open notch's body takes the pointer. */
  readonly takes: () => boolean;
  /** The button under a place, by what it says. */
  readonly under: (at: { x: number; y: number }) => string | null;
  readonly unmount: () => void;
}

/** The notch in a window of its own size, against the page's top left corner, as the desktop shell holds it. */
async function show(): Promise<Shown> {
  const host = document.createElement("div");
  host.style.cssText = "position: fixed; top: 0; left: 0; width: 440px; height: 560px";
  document.body.append(host);
  const acts: unknown[] = [];
  let tell: ((feed: NotchFeedState) => void) | null = null;
  const bridge: NotchBridge = {
    onState: (handler) => {
      tell = handler;
    },
    onAway: () => undefined,
    act: (action) => acts.push(action),
    over: () => undefined,
    menu: () => undefined,
  };
  const root = createRoot(host);
  root.render(<Notch bridge={bridge} />);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
    host.remove();
  };
  onTestFinished(unmount);
  await expect.poll(() => tell !== null).toBe(true);
  return {
    host,
    acts,
    say: (state) => tell!({ state, hardware: { width: 185, height: 32 }, bar: 33 }),
    isOpen: () => host.querySelector(".notch")?.hasAttribute("data-open") === true,
    takes: () => host.querySelector(".notch-open")?.hasAttribute("inert") === false,
    // By where it stands, not by what the page would hit: a body that takes no pointer is not hit at all.
    under: (at) =>
      [...host.querySelectorAll(".notch-open button")].find((button) => {
        const box = button.getBoundingClientRect();
        return at.x >= box.left && at.x < box.right && at.y >= box.top && at.y < box.bottom;
      })?.textContent ?? null,
    unmount,
  };
}

/** Where a key stands once `state` shows: the middle of it. The body is laid out even while the notch is shut. */
async function whereIs(state: NotchState, label: string): Promise<{ x: number; y: number }> {
  const notch = await show();
  notch.say(state);
  const key = () => [...notch.host.querySelectorAll("button")].find((b) => b.textContent === label);
  await expect.poll(() => (key()?.getBoundingClientRect().width ?? 0) > 0).toBe(true);
  const box = key()!.getBoundingClientRect();
  notch.unmount();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

let pointer: { x: number; y: number } | null = null;
const track = (e: MouseEvent) => {
  pointer = { x: e.clientX, y: e.clientY };
};
/** Moves the mouse, and checks the page saw it arrive at that very place. */
async function pointTo(at: { x: number; y: number }) {
  await commands.pointerTo(at.x, at.y);
  await expect.poll(() => pointer).toEqual(at);
}
/** The clock the notch judges a press by, moved by hand: a press lands exactly as long after a change as the test says. */
let clock = 0;
const later = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  pointer = null;
  window.addEventListener("mousemove", track);
});
afterEach(() => {
  window.removeEventListener("mousemove", track);
  vi.restoreAllMocks();
});

test("a notch that opens by itself under a resting pointer takes no press there, however long the pointer rests", async () => {
  const key = await whereIs(word(ASKS, ["c2:1"]), "Always allow");
  const notch = await show();
  notch.say(word(null));
  // The pointer rests near the top of the screen, on another app's window: a browser's address bar, say.
  await pointTo(key);
  later(5_000);
  // A chat in the background asks. The notch opens, and its widest key is under the pointer.
  notch.say(word(ASKS, ["c2:1"]));
  await expect.poll(notch.isOpen).toBe(true);
  await expect.poll(() => notch.under(key)).toBe("Always allow");
  // The click that was meant for the address bar.
  await commands.press();
  expect(notch.acts).toEqual([]);
  // Nor a minute later: the pointer has not moved, so nobody pointed at this key.
  later(60_000);
  await commands.press();
  expect(notch.acts).toEqual([]);
  expect(notch.isOpen()).toBe(true);
  // The person moves the pointer on the key, and presses: theirs.
  await pointTo({ x: key.x + 24, y: key.y });
  await expect.poll(notch.takes).toBe(true);
  expect(notch.under(pointer!)).toBe("Always allow");
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c2", key: ALLOW }]);
});

test("a pointer the page had lost track of, found on a key, has not been moved there", async () => {
  const key = await whereIs(word(ASKS, ["c2:1"]), "Always allow");
  const notch = await show();
  notch.say(word(null));
  // The page last heard the pointer here, under where the notch opens.
  await pointTo({ x: 300, y: 60 });
  notch.say(word(ASKS, ["c2:1"]));
  await expect.poll(notch.isOpen).toBe(true);
  later(60_000);
  // Another app dragged it to the key meanwhile, which the page never hears. It hears one move, at the key, when the
  // window starts taking the mouse: the pointer rests there, and the click was meant for what the notch covers.
  await commands.pointerTo(key.x, key.y, 1);
  await expect.poll(() => pointer).toEqual(key);
  await commands.press();
  expect(notch.acts).toEqual([]);
  // The person moves it on the key: theirs.
  await pointTo({ x: key.x + 24, y: key.y });
  await expect.poll(notch.takes).toBe(true);
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c2", key: ALLOW }]);
});

test("in its first moments it takes no press even from a pointer that came to it", async () => {
  const key = await whereIs(word(ASKS, ["c2:1"]), "Always allow");
  const notch = await show();
  notch.say(word(null));
  later(5_000);
  notch.say(word(ASKS, ["c2:1"]));
  await expect.poll(notch.isOpen).toBe(true);
  // A pointer already on its way to something on that spot arrives and presses, before anyone could have read the card.
  await pointTo(key);
  later(ARM_MS - 1);
  await commands.press();
  expect(notch.acts).toEqual([]);
  // Once there was time to see it, a press counts: the pointer did come to the key.
  later(100);
  await pointTo({ x: key.x + 1, y: key.y });
  await expect.poll(notch.takes).toBe(true);
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c2", key: ALLOW }]);
});

test("a card that changes under the pointer takes no press until the pointer moves again", async () => {
  const key = await whereIs(word(ASKS, ["c2:1"], [row(FINISHED), WORKING]), "Always allow");
  const notch = await show();
  notch.say(word(FINISHED));
  later(5_000);
  // The person points at the notch, it opens, and they go to Ship it.
  await pointTo({ x: 220, y: 16 });
  later(200);
  await expect.poll(notch.isOpen).toBe(true);
  await pointTo(key);
  await expect.poll(notch.takes).toBe(true);
  expect(notch.under(key)).toBe("Ship it");
  // Another chat asks: an ask comes before a finished turn, so its card takes the place, its keys where Ship it was.
  notch.say(word(ASKS, ["c2:1"], [row(FINISHED), WORKING]));
  await expect.poll(() => notch.under(key)).toBe("Always allow");
  // The press that was meant for Ship it.
  await commands.press();
  later(60_000);
  await commands.press();
  expect(notch.acts).toEqual([]);
  // The ask's own keys arrive a moment after its card (the chat's session had to be read): a change like any other.
  await pointTo({ x: key.x + 24, y: key.y });
  await expect.poll(notch.takes).toBe(true);
  notch.say(word({ ...ASKS, keys: [...ASKS.keys].reverse() }, ["c2:1"], [row(FINISHED), WORKING]));
  await expect.poll(() => notch.under(pointer!)).toBe("Deny");
  await commands.press();
  expect(notch.acts).toEqual([]);
  // Seen, and the pointer moved to a key: answered.
  later(ARM_MS);
  await pointTo({ x: key.x, y: key.y });
  await expect.poll(notch.takes).toBe(true);
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c2", key: "ask\ta1\t2" }]);
});

test("a person who points at the notch and presses a key is served at once", async () => {
  const key = await whereIs(word(FINISHED), "Ship it");
  const notch = await show();
  notch.say(word(FINISHED));
  later(5_000);
  await pointTo({ x: 220, y: 16 });
  later(200);
  await expect.poll(notch.isOpen).toBe(true);
  await pointTo(key);
  await expect.poll(notch.takes).toBe(true);
  // The shape morphs open on its clip-path: until the clip reaches the key, a press there lands on nothing.
  await expect
    .poll(() => document.elementFromPoint(key.x, key.y)?.closest("button")?.textContent)
    .toBe("Ship it");
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c1", key: "ship" }]);
  // Anything done on it folds it.
  await expect.poll(notch.isOpen).toBe(false);
});

test("the open notch is the card alone: no row for the other chats, and nothing to open to without a card", async () => {
  const notch = await show();
  notch.say(word(null, [], [WORKING]));
  later(5_000);
  await pointTo({ x: 220, y: 16 });
  later(200);
  // Pointed at with only chats at work: it stays its band, their mark in the ear.
  await new Promise((r) => setTimeout(r, 200));
  expect(notch.isOpen()).toBe(false);
  // A chat finishes: pointed at, the notch shows its card and no row for the chat still at work.
  notch.say(word(FINISHED, [], [WORKING]));
  await expect.poll(notch.isOpen).toBe(true);
  expect(notch.host.querySelector(".notch-open")?.textContent).not.toContain(WORKING.title);
});

/** Chat C asks a question; the card pages, so its arrows stand beside it. */
const QUESTION: NotchCard = {
  id: "c3",
  title: "Add sign in with GitHub",
  status: status("answer", "Answer", true),
  line: "Where should the callback live?",
  command: null,
  image: null,
  ask: "q1",
  trouble: null,
  index: 1,
  count: 2,
  prev: "c1",
  next: null,
  keys: [
    { id: "ask\tq1\t0", label: "api.caveman.so", tone: "lit" },
    { id: "ask\tq1\t1", label: "app.caveman.so", tone: "card" },
  ],
};

/** The same chat asked something new: another ask, other choices, standing where the first one's stood. */
const QUESTION_2: NotchCard = {
  ...QUESTION,
  line: "Allow it to delete the old callback?",
  ask: "q2",
  keys: [
    { id: "ask\tq2\tdel", label: "Delete it", tone: "lit" },
    { id: "ask\tq2\tkeep", label: "Keep it", tone: "card" },
  ],
};
/** The chat the arrows page from: finished, first of two that wait. */
const FIRST_OF_TWO: NotchCard = { ...FINISHED, index: 0, count: 2, next: "c3" };

/** The middle of what is drawn under `label`, by where it stands, once it is drawn. */
async function middleOf(host: HTMLElement, label: string): Promise<{ x: number; y: number }> {
  const find = () =>
    [...host.querySelectorAll<HTMLElement>(".notch-open button")].find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    );
  await expect.poll(() => find() !== undefined).toBe(true);
  const box = find()!.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}
/** Until the open shape's clip reaches `at` and the control there takes the mouse, a press there lands on nothing. */
async function reachable(at: { x: number; y: number }, label: string) {
  await expect
    .poll(() => {
      const b = document.elementFromPoint(at.x, at.y)?.closest("button");
      return b?.getAttribute("aria-label") ?? b?.textContent;
    })
    .toBe(label);
}
/** The person points at the notch, it opens on `first`, and they page to the next chat with the card's arrow. */
async function pagedFrom(notch: Shown, first: NotchCard): Promise<{ x: number; y: number }> {
  notch.say(word(first));
  later(5_000);
  await pointTo({ x: 220, y: 16 });
  later(200);
  await expect.poll(notch.isOpen).toBe(true);
  const arrow = await middleOf(notch.host, "Next chat");
  await pointTo(arrow);
  await expect.poll(notch.takes).toBe(true);
  await reachable(arrow, "Next chat");
  await commands.press();
  expect(notch.acts).toEqual([{ type: "show", id: first.next }]);
  return arrow;
}
/** Two presses, a minute apart, from a pointer that has not moved: neither may reach the app. */
async function restingPresses(notch: Shown, before: number) {
  await commands.press();
  later(60_000);
  await commands.press();
  expect(notch.acts).toHaveLength(before);
}

test("a paged card's first ask, loading under a pointer on its placeholder key, takes no click", async () => {
  const notch = await show();
  await pagedFrom(notch, FIRST_OF_TWO);
  // The chat's session is still loading: one key that opens it stands where its choices will.
  notch.say(word({ ...QUESTION, ask: null, keys: [{ id: "open", label: "Answer", tone: "lit" }] }));
  later(ARM_MS);
  const placeholder = await middleOf(notch.host, "Answer");
  const on = { x: placeholder.x - 80, y: placeholder.y };
  await pointTo(on);
  await expect.poll(notch.takes).toBe(true);
  expect(notch.under(on)).toBe("Answer");
  // The question loads: a choice nobody has read now stands under the resting pointer.
  notch.say(word(QUESTION));
  await expect.poll(() => notch.under(on)).toBe("api.caveman.so");
  await restingPresses(notch, 1);
});

test("a paged card left for another chat and come back to with a new ask takes no click", async () => {
  const notch = await show();
  await pagedFrom(notch, FIRST_OF_TWO);
  notch.say(word(QUESTION));
  later(ARM_MS);
  const key = await middleOf(notch.host, "api.caveman.so");
  await pointTo(key);
  await expect.poll(notch.takes).toBe(true);
  // A chat that asks comes first for a moment; the person moves over its card and rests on that spot again.
  notch.say(word(ASKS, [], [{ id: "c3", title: QUESTION.title, status: QUESTION.status }]));
  await expect.poll(() => notch.under(key)).not.toBe("api.caveman.so");
  later(ARM_MS);
  await pointTo({ x: key.x + 30, y: key.y });
  await pointTo(key);
  await expect.poll(notch.takes).toBe(true);
  const before = notch.acts.length;
  // The paged chat is back on the card, asking something else, under the resting pointer.
  notch.say(word(QUESTION_2));
  await expect.poll(() => notch.under(key)).toBe("Delete it");
  await restingPresses(notch, before);
});

test("arrows that go when the waits drop to one leave no click for the key that comes under them", async () => {
  // The person pages to a question with no line, whose keys stand level with where the arrow was.
  const paged: NotchCard = { ...QUESTION, line: null, index: 1, count: 2, prev: "c1", next: null };
  const notch = await show();
  const arrow = await pagedFrom(notch, FIRST_OF_TWO);
  notch.say(word(paged));
  await expect.poll(() => notch.under(arrow)).toBe("");
  later(ARM_MS);
  // The other wait was answered elsewhere: no arrows, the margins close, and a key reaches where the arrow stood.
  notch.say(word({ ...paged, index: 0, count: 1, prev: null }));
  await expect.poll(() => notch.under(arrow)).toBe("app.caveman.so");
  await restingPresses(notch, 1);
});

test("the same ask with its choices in another order takes no click, and a key answers with the choice it showed", async () => {
  const notch = await show();
  notch.say(word(QUESTION));
  later(5_000);
  await pointTo({ x: 220, y: 16 });
  later(200);
  await expect.poll(notch.isOpen).toBe(true);
  const key = await middleOf(notch.host, "api.caveman.so");
  await pointTo(key);
  await expect.poll(notch.takes).toBe(true);
  notch.say(word({ ...QUESTION, keys: [...QUESTION.keys].reverse() }));
  await expect.poll(() => notch.under(key)).toBe("app.caveman.so");
  await restingPresses(notch, 0);
  // Moved and seen: the key under the pointer is the one pressed, carrying its own choice.
  later(ARM_MS);
  await pointTo({ x: key.x + 24, y: key.y });
  await reachable({ x: key.x + 24, y: key.y }, "app.caveman.so");
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c3", key: QUESTION.keys[1]!.id }]);
});

test("the keyboard, an assistive technology or a finger reach a key once the card has been there long enough", async () => {
  const notch = await show();
  notch.say(word(null));
  await pointTo({ x: 30, y: 400 });
  // It opens by itself; nothing has moved the mouse since.
  notch.say(word(QUESTION, ["c3:1"]));
  await expect.poll(notch.isOpen).toBe(true);
  const key = () =>
    [...notch.host.querySelectorAll<HTMLButtonElement>(".notch-open button")].find(
      (b) => b.textContent === "app.caveman.so",
    )!;
  // Pressed with no pointer (Enter, VoiceOver's press) the moment it appears: too soon to have been read.
  key().click();
  expect(notch.acts).toEqual([]);
  later(ARM_MS);
  await expect.poll(notch.takes).toBe(true);
  key().click();
  expect(notch.acts).toEqual([{ type: "press", id: "c3", key: QUESTION.keys[1]!.id }]);
  // A finger on a key, once it has been seen: the key takes no mouse, so the tap lands on the body, which presses it.
  notch.say(word(QUESTION_2, ["c3:2"]));
  await expect.poll(notch.isOpen).toBe(true);
  const at = await middleOf(notch.host, "Delete it");
  // A contact goes where the page's own hit-testing sends it, as a finger's would: to what is under it, not to the
  // body. Each tap is its own contact, down then up.
  let contacts = 10;
  const touch = (type: "pointerdown" | "pointerup", pointerType: string, pointerId: number) =>
    document.elementFromPoint(at.x, at.y)!.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType,
        pointerId,
        clientX: at.x,
        clientY: at.y,
      }),
    );
  const tap = (pointerType: string) => {
    contacts += 1;
    touch("pointerdown", pointerType, contacts);
    touch("pointerup", pointerType, contacts);
  };
  const body = notch.host.querySelector<HTMLElement>(".notch-open")!;
  await expect.poll(() => body.hasAttribute("data-notch-held")).toBe(true);
  tap("touch");
  expect(notch.acts).toHaveLength(1);
  later(ARM_MS);
  await expect.poll(notch.takes).toBe(true);
  // Held, the keys take no mouse, and the body under them stays live and undimmed to take a finger.
  expect(document.elementFromPoint(at.x, at.y)?.closest("button")).toBeNull();
  expect(document.elementFromPoint(at.x, at.y)?.closest(".notch-open")).toBe(body);
  expect(getComputedStyle(body).pointerEvents).not.toBe("none");
  await expect.poll(() => getComputedStyle(body).opacity).toBe("1");
  // A mouse is not a finger: it must have moved.
  tap("mouse");
  expect(notch.acts).toHaveLength(1);
  tap("touch");
  expect(notch.acts.at(-1)).toEqual({ type: "press", id: "c3", key: QUESTION_2.keys[0]!.id });
  // The card changes again, another ask under the pen: unseen, it takes no tap; seen, the pen presses what it shows.
  notch.say(word(QUESTION, ["c3:3"]));
  await expect.poll(() => notch.under(at)).toBe("api.caveman.so");
  await expect.poll(() => body.hasAttribute("data-notch-held")).toBe(true);
  const presses = notch.acts.length;
  tap("pen");
  expect(notch.acts).toHaveLength(presses);
  later(ARM_MS);
  await expect.poll(notch.takes).toBe(true);
  // A pen already down when the card changed again, lifted once the new card has settled: it landed on what was there
  // before, so it presses nothing that came after.
  const pressed = notch.acts.length;
  contacts += 1;
  const held = contacts;
  touch("pointerdown", "pen", held);
  notch.say(word({ ...QUESTION, keys: [...QUESTION.keys].reverse() }, ["c3:4"]));
  await expect.poll(() => notch.under(at)).toBe("app.caveman.so");
  later(ARM_MS);
  await expect.poll(notch.takes).toBe(true);
  touch("pointerup", "pen", held);
  expect(notch.acts).toHaveLength(pressed);
  // A pen that comes down on the card as it stands, seen, presses what it shows.
  tap("pen");
  expect(notch.acts.at(-1)).toEqual({ type: "press", id: "c3", key: QUESTION.keys[1]!.id });
});

test("a press that did not go through brings the card back, saying so, with its keys to try again", async () => {
  const notch = await show();
  notch.say(word(QUESTION));
  later(5_000);
  expect(notch.isOpen()).toBe(false);
  const trouble = { text: "Not connected to this chat's computer.", n: 1 };
  notch.say(word({ ...QUESTION, trouble }));
  await expect.poll(notch.isOpen).toBe(true);
  expect(notch.host.querySelector('[role="alert"]')?.textContent).toBe(trouble.text);
  expect(notch.host.querySelector(".notch-open")?.textContent).toContain("api.caveman.so");
  // The person tries again: the press folds it, and it fails the same way. The card comes back again.
  const key = notch.host.querySelector<HTMLElement>(
    ".notch-open button + div button, .notch-open .mt-3 button",
  )!;
  const box = key.getBoundingClientRect();
  const at = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  later(ARM_MS);
  await pointTo({ x: at.x - 30, y: at.y });
  await pointTo(at);
  await expect.poll(notch.takes).toBe(true);
  await expect
    .poll(() => document.elementFromPoint(at.x, at.y)?.closest("button")?.textContent)
    .toBe("api.caveman.so");
  await commands.press();
  expect(notch.acts).toEqual([{ type: "press", id: "c3", key: "ask\tq1\t0" }]);
  await expect.poll(notch.isOpen).toBe(false);
  notch.say(word({ ...QUESTION, trouble: { ...trouble, n: 2 } }));
  await expect.poll(notch.isOpen).toBe(true);
  expect(notch.host.querySelector('[role="alert"]')?.textContent).toBe(trouble.text);
});

test("a failure and a new wait in one word: the notch opens for both, and the companion waves for the wait", async () => {
  const notch = await show();
  notch.say(word(QUESTION));
  await expect
    .poll(() => notch.host.querySelector(".notch-ear")?.firstElementChild ?? null)
    .not.toBeNull();
  const companion = notch.host.querySelector(".notch-ear")!.firstElementChild;
  later(5_000);
  expect(notch.isOpen()).toBe(false);
  notch.say(
    word({ ...QUESTION, trouble: { text: "Not connected to this chat's computer.", n: 1 } }, [
      "c9:1",
    ]),
  );
  await expect.poll(notch.isOpen).toBe(true);
  // A new wait waves again: the companion is drawn anew (Notch.tsx `waves`), not swallowed by the failure.
  await expect
    .poll(() => notch.host.querySelector(".notch-ear")!.firstElementChild !== companion)
    .toBe(true);
  expect(notch.host.querySelector('[role="alert"]')?.textContent).toBe(
    "Not connected to this chat's computer.",
  );
});
