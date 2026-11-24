import { afterEach, expect, test, vi } from "vitest";
import type { SessionEvent } from "@caveman-app/session-protocol";
import { SessionModel } from "../../state/transcript.ts";
import { markCleared, readCleared, saveCleared, sectionKey, sinceCleared } from "./sections.ts";

const at = "2026-11-15T12:00:00.000Z";
const model = () => {
  const model = new SessionModel();
  const emit = (type: SessionEvent["type"], id: string, payload: unknown, when = at) =>
    model.apply({
      type,
      item_id: id,
      payload,
      at: when,
      session_id: "s",
      cursor: model.lastCursor + 2,
    } as SessionEvent);
  return { model, emit };
};
afterEach(() => vi.unstubAllGlobals());

const storage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
};

test("event cursors retain a new user inserted before an earlier loose notice", () => {
  storage();
  const { model: m, emit } = model();
  emit("notification", "notice", { level: "info", title: "Old notice" });
  const mark = markCleared("scope", m.snapshot().items, m.lastCursor, at);
  emit("message.done", "user", { role: "user", text: "Fresh request" });
  expect(m.snapshot().items.map((i) => i.id)).toEqual(["user", "notice"]);
  expect(sinceCleared(m.snapshot().items, mark, m).map((i) => i.id)).toEqual(["user"]);
});

test("live reply remains visible through completion while earlier messages stay hidden", () => {
  storage();
  const { model: m, emit } = model();
  emit("message.done", "old", { role: "assistant", text: "Old reply" });
  emit("message.delta", "live", { text: "Reply begins" });
  const mark = markCleared("scope", m.snapshot().items, m.lastCursor, at);
  emit("message.delta", "live", { text: " and continues" });
  emit("message.done", "live", { role: "assistant", text: "Reply begins and continues" });
  expect(sinceCleared(m.snapshot().items, mark, m).map((i) => i.id)).toEqual(["live"]);
  expect(readCleared("scope")).toEqual(mark);
});

test("clocks and removal of the last item cannot reveal old rows or hide new ones", () => {
  storage();
  const { model: m, emit } = model();
  emit("message.done", "old", { role: "assistant", text: "Old reply" }, "2026-11-15T12:01:00.000Z");
  const oldCursor = m.lastCursor;
  emit("notification", "removed", { level: "info", title: "Notice" });
  const mark = markCleared("scope", m.snapshot().items, m.lastCursor, at);
  emit("session.restored", "restore", { at: oldCursor });
  emit(
    "message.done",
    "new",
    { role: "assistant", text: "Fresh reply" },
    "2026-11-15T11:59:00.000Z",
  );
  expect(sinceCleared(m.snapshot().items, mark, m).map((i) => i.id)).toEqual(["restore", "new"]);
  expect(sinceCleared(m.snapshot().items, null, m)).toBe(m.snapshot().items);
});

test("runtime, Chief, session and epoch scope the saved mark without storing credentials", () => {
  storage();
  const a = sectionKey("ws://runtime.test/a", "chief", "session")!;
  const b = sectionKey("ws://runtime.test/b", "chief", "session")!;
  const mark = markCleared(a, [], 0, at, 1);
  expect(readCleared(a)).toEqual(mark);
  expect(readCleared(b)).toBeNull();
  expect(readCleared(a, 2)).toBeNull();
  expect(readCleared(a, undefined)).toEqual(mark);
  expect(sectionKey(null, "chief", "session")).toBeNull();
  expect(
    sectionKey("ws://person:secret@runtime.test/a?token=hidden#secret", "chief", "session"),
  ).toBe(a);
});

test("bad or unavailable storage does not stop clearing the mounted view", () => {
  const store = storage();
  store.set("caveman.chief.cleared.v2.scope", '{"at":"bad date","cursor":0,"live":[]}');
  expect(readCleared("scope")).toBeNull();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  });
  expect(readCleared("scope")).toBeNull();
  expect(markCleared("scope", [], 0, at)).toEqual({ at, cursor: 0, live: [] });
});

test("old epoch-in-key marks remain readable before epoch metadata arrives", () => {
  const store = storage();
  const scope = sectionKey("ws://runtime.test/a", "chief", "session")!;
  const mark = { at, cursor: 10, live: [] };
  store.set(`caveman.chief.cleared.v2.${scope.slice(0, -1)},1]`, JSON.stringify(mark));
  expect(readCleared(scope)).toEqual({ ...mark, epoch: 1 });
  expect(readCleared(scope, 1)).toEqual({ ...mark, epoch: 1 });
  expect(readCleared(scope, 2)).toBeNull();
});

test("legacy marks work without epochs and can bind to the first known journal", () => {
  storage();
  const mark = markCleared("scope", [], 4, at);
  expect(readCleared("scope")).toEqual(mark);
  saveCleared("scope", { ...mark, epoch: 1 });
  expect(readCleared("scope")).toEqual({ ...mark, epoch: 1 });
  expect(readCleared("scope", 2)).toBeNull();
});
