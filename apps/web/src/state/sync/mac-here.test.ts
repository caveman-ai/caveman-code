// The person's Mac as a browser window stands with it (web-window.ts macHere), the one next step it names (macNext)
// and the three steps to it (macSteps): a window with no computer behind it says where the Mac is, never nothing.
import { expect, test } from "vitest";
import { runtime } from "./fakes.test-support.ts";
import {
  DOWNLOAD_URL,
  macHere,
  macNext,
  macSteps,
  webSteps,
  type MacAnswer,
  type WebWindow,
} from "./web-window.ts";
import type { RuntimeState } from "./wire.ts";

const list = (...all: RuntimeState[]) => ({ runtimes: new Map(all.map((r) => [r.runtime_id, r])) });
const mac = (id: string, over: Partial<RuntimeState> = {}) =>
  runtime(id, { kind: "laptop", name: id, online: true, ...over });
const nobody = () => undefined;
const never = () => false;
const said = (answers: Record<string, MacAnswer>) => (id: string) => answers[id];

test("no Mac signed in: the download is the step, and none of the three is done", () => {
  for (const runtimes of [null, list(), list(runtime("box", { kind: "cloud" }))]) {
    const here = macHere(runtimes, nobody, never);
    expect(here).toEqual({ kind: "none" });
    expect(macNext(here, true)?.action).toEqual({ kind: "download", label: "Download for Mac" });
    expect(macSteps(here).map((s) => s.done)).toEqual([false, false, false]);
  }
  expect(DOWNLOAD_URL).toBe("https://caveman.so/download");
});

test("no Mac signed in, on a computer that is not a Mac: it says the app is Mac only today and the web works, and offers no download", () => {
  const next = macNext({ kind: "none" }, false);
  expect(next).toEqual({
    title: "The desktop app is Mac only today",
    line: "The desktop app is Mac only today. The web app works now.",
    action: null,
  });
  // The Mac's own steps (open it, allow this browser) do not depend on what this browser runs on.
  expect(macNext({ kind: "asleep", name: "Studio" }, false)?.title).toBe(
    "Open Caveman Code on Studio",
  );
});

test("a Mac that is not on line is named, with nothing for this browser to press", () => {
  const here = macHere(list(mac("Studio", { online: false })), nobody, () => true);
  expect(here).toEqual({ kind: "asleep", name: "Studio" });
  expect(macNext(here)).toMatchObject({ title: "Open Caveman Code on Studio", action: null });
  expect(macSteps(here)).toEqual([
    { id: "get", label: "Get Caveman Code for Mac", done: true },
    { id: "open", label: "Open it on Studio", done: false },
    { id: "allow", label: "Allow this browser", done: false },
  ]);
  // A Mac removed in Cloud is no Mac.
  expect(macHere(list(mac("Old", { computer_state: "deleted" })), nobody, never)).toEqual({
    kind: "none",
  });
});

test("on line and never asked: connecting is the step, to that Mac", () => {
  const studio = mac("Studio");
  const here = macHere(list(studio), nobody, never);
  expect(here).toEqual({
    kind: "ask",
    name: "Studio",
    place: { kind: "mac", name: "Studio", runtimeId: "Studio", computerId: studio.computer_id },
  });
  expect(macNext(here)?.action).toMatchObject({ kind: "connect", label: "Connect to Studio" });
  expect(macSteps(here).map((s) => s.done)).toEqual([true, true, false]);
});

test("the Mac's screen is asking: what to do there, with this browser's own code", () => {
  const here = macHere(
    list(mac("Studio")),
    said({ Studio: { status: "pending", code: "TQ4-K9P" } }),
    never,
  );
  expect(here).toEqual({ kind: "waiting", name: "Studio", code: "TQ4-K9P" });
  expect(macNext(here)).toMatchObject({
    line: "On Studio, choose Allow, and check it shows TQ4-K9P. You only do this once.",
    action: null,
  });
  expect(
    macNext(macHere(list(mac("Studio")), said({ Studio: { status: "pending" } }), never))?.line,
  ).toBe("On Studio, choose Allow. You only do this once.");
});

test("refused, it says how to undo that; let in, nothing is left to do", () => {
  const refused = macHere(list(mac("Studio")), said({ Studio: { status: "refused" } }), () => true);
  expect(refused).toEqual({ kind: "refused", name: "Studio" });
  expect(macNext(refused)?.action).toBeNull();
  const ready = macHere(list(mac("Studio")), nobody, () => true);
  expect(ready).toEqual({ kind: "ready", name: "Studio" });
  expect(macNext(ready)).toBeNull();
  expect(macSteps(ready).every((s) => s.done)).toBe(true);
});

test("with several Macs on line, the one furthest along is the one spoken of", () => {
  const macs = list(mac("Air"), mac("Studio"), mac("Mini", { online: false }));
  // One let this browser in: the window is as good as on it, whatever the other says.
  expect(macHere(macs, said({ Air: { status: "refused" } }), (id) => id === "Studio")).toEqual({
    kind: "ready",
    name: "Studio",
  });
  // One is asking now: that question comes before connecting to another.
  expect(macHere(macs, said({ Air: { status: "pending", code: "AAA" } }), never)).toMatchObject({
    kind: "waiting",
    name: "Air",
  });
  // A refusal on one Mac does not hide another that was never asked.
  expect(macHere(macs, said({ Air: { status: "refused" } }), never)).toMatchObject({
    kind: "ask",
    name: "Studio",
  });
});

test("Macs Cloud has never heard from are spoken of, and never break the window", () => {
  // A Mac signed in during its first run has no link yet (it runs once sync or Remote control is on): Cloud's list
  // says last_seen_at null for it, ordered last_seen_at DESC NULLS LAST, then by id. Two of them on one account threw
  // here, above every error screen, and the window drew nothing (0.1.5, signed in on a second Mac).
  const fresh = (id: string) => mac(id, { online: false, last_seen_at: null });
  expect(macHere(list(fresh("Air"), fresh("Mini")), nobody, never)).toEqual({
    kind: "asleep",
    name: "Air",
  });
  // One heard from comes first; the never heard from after it, whatever the order they arrive in.
  const heard = mac("Studio", { online: false, last_seen_at: "2026-11-16T11:00:00.000Z" });
  expect(macHere(list(fresh("Air"), heard, fresh("Mini")), nobody, never)).toEqual({
    kind: "asleep",
    name: "Studio",
  });
  expect(macHere(list(heard, fresh("Air"), fresh("Mini")), nobody, never)).toEqual({
    kind: "asleep",
    name: "Studio",
  });
  // On line, it is the one to connect to.
  expect(macHere(list(fresh("Air"), mac("Studio"), fresh("Mini")), nobody, never)).toMatchObject({
    kind: "ask",
    name: "Studio",
  });
});

const app = (nothingYet: boolean): WebWindow => ({ kind: "app", failed: false, nothingYet });

test("off a Mac with no Mac of theirs: the web app's steps, never the Mac's", () => {
  const none = { kind: "none" } as const;
  expect(webSteps(none, app(true), "on", null, false)).toEqual([
    { id: "chat", label: "Start a chat in Cloud", done: false },
  ]);
  // Chats exist: the step is done. Cloud says there is no plan: choosing one comes first.
  expect(webSteps(none, app(false), "on", null, false)?.map((s) => s.done)).toEqual([true]);
  expect(webSteps(none, app(true), "on", true, false)?.map((s) => [s.id, s.label, s.done])).toEqual(
    [
      ["plan", "Choose a plan", false],
      ["chat", "Start a chat in Cloud", false],
    ],
  );
  // A plan is only offered when Cloud says the account has none; unknown is not offered.
  expect(webSteps(none, app(true), "on", false, false)?.map((s) => s.id)).toEqual(["chat"]);
  // Cloud off: nothing here can be done, so nothing is offered.
  expect(webSteps(none, app(true), "off", true, false)).toEqual([]);
  expect(webSteps(none, { kind: "loading" }, "on", null, false)).toEqual([]);
  for (const s of webSteps(none, app(true), "on", true, false) ?? [])
    expect(s.label).not.toMatch(/mac/i);
});

test("on a Mac, or with a Mac of theirs signed in: the Mac steps apply", () => {
  expect(webSteps({ kind: "none" }, app(true), "on", null, true)).toBeNull();
  expect(
    webSteps({ kind: "asleep", name: "Ada's MacBook" }, app(true), "on", null, false),
  ).toBeNull();
  expect(
    webSteps({ kind: "waiting", name: "Ada's MacBook" }, app(true), "on", true, false),
  ).toBeNull();
});
