// Settings as the desktop's RuntimeProvider shows them while saves and polls cross: the real provider (refresh,
// saveSettings, SettingsSaves) on a fake runtime client that answers as server.ts does. Reads and settings.set run side
// by side there (no lane), so a slow workspace.list can answer after a settings.set sent later.
import type { Settings } from "@caveman-app/session-protocol";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const dom = vi.hoisted(() => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const events = new EventTarget();
  Object.assign(globalThis, {
    localStorage,
    location: new URL("file:///Applications/Caveman%20Code.app/index.html"),
    history: { replaceState: () => undefined },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    cavemanDesktop: { runtime: { url: "ws://127.0.0.1:1/runtime", token: "t" } },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(globalThis, { window: globalThis });
  return { localStorage };
});

type Saved = Settings & {
  readonly notifications: { needs_input: boolean; turn_done: boolean };
  readonly inbox_done_on_merge: boolean;
};
const SAVED = {
  theme: "system",
  default_engine: "caveman",
  inbox_done_on_merge: true,
  notifications: { needs_input: true, turn_done: true },
} as unknown as Saved;

const runtime = vi.hoisted(() => ({
  stored: null as unknown as Record<string, unknown>,
  holdLists: false,
  held: [] as Array<() => void>,
  /** settings.set waits for the test to answer it. */
  holdSaves: false,
  saves: [] as Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
}));

vi.mock("@caveman-app/session-protocol/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@caveman-app/session-protocol/client")>();
  const client = {
    call: async (method: string, params: { settings?: Record<string, unknown> }) => {
      switch (method) {
        case "workspace.list":
          if (runtime.holdLists)
            return new Promise((resolve) => runtime.held.push(() => resolve({ workspaces: [] })));
          return { workspaces: [] };
        case "engine.list":
          return { engines: [] };
        case "settings.get":
          // Read when the call arrives.
          return structuredClone(runtime.stored);
        case "project.list":
          return { projects: [] };
        case "settings.set":
          if (runtime.holdSaves)
            return new Promise((resolve, reject) => runtime.saves.push({ resolve, reject }));
          runtime.stored = { ...runtime.stored, ...params.settings };
          return structuredClone(runtime.stored);
        default:
          throw new Error(`not in this fake: ${method}`);
      }
    },
    attach: async () => ({ close: () => undefined }),
    on: () => () => undefined,
    hello: () => undefined,
    onHello: () => () => undefined,
    close: () => undefined,
  };
  return {
    ...real,
    connect: (_url: string, _token: string, onState: (state: string) => void) => {
      setTimeout(() => onState("open"), 0);
      return client;
    },
  };
});

const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
Object.assign(globalThis, { document });
const { RuntimeProvider, useRuntime } = await import("./runtime.tsx");
type Value = ReturnType<typeof useRuntime>;

let unmount: (() => Promise<void>) | null = null;
beforeEach(() => {
  dom.localStorage.clear();
  runtime.stored = structuredClone(SAVED);
  runtime.holdLists = false;
  runtime.holdSaves = false;
  runtime.held.length = 0;
  runtime.saves.length = 0;
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

/** The provider mounted; `shown` holds the Settings each render showed, in order. */
async function mount() {
  const shown: Array<Value["settings"]> = [];
  const latest: { value: Value | null } = { value: null };
  const Probe = () => {
    const value = useRuntime();
    if (shown.at(-1) !== value.settings || shown.length === 0) shown.push(value.settings);
    latest.value = value;
    return null;
  };
  const root = createRoot(document.getElementById("root") as unknown as Element);
  await act(async () => root.render(createElement(RuntimeProvider, null, createElement(Probe))));
  unmount = () => act(async () => root.unmount());
  for (let i = 0; i < 10 && latest.value?.status !== "connected"; i++) await settle();
  expect(latest.value?.status).toBe("connected");
  return { shown, now: () => latest.value! };
}

test("a save confirmed while a poll is out is not undone by that poll's older settings.get", async () => {
  const app = await mount();
  expect(app.now().settings).toEqual(SAVED);

  // A poll goes out (the 10 s tick, or the window's focus as the person clicks back into it): settings.get reads the
  // saved Settings at once; workspace.list is still being answered.
  runtime.holdLists = true;
  let poll!: Promise<void>;
  await act(async () => {
    poll = app.now().refresh();
    await new Promise((r) => setTimeout(r, 0));
  });
  // The person turns "Needs input" off (General.tsx's switch): settings.set answers with it saved.
  await act(async () =>
    app.now().saveSettings!({
      notifications: { ...app.now().settings!.notifications!, needs_input: false },
    } as never),
  );
  expect(runtime.stored).toMatchObject({ notifications: { needs_input: false, turn_done: true } });

  // The poll's slowest read answers: it ends holding the settings.get it read before the save.
  await act(async () => {
    runtime.holdLists = false;
    for (const release of runtime.held.splice(0)) release();
    await poll;
  });
  expect(app.now().settings?.notifications).toEqual({ needs_input: false, turn_done: true });
  // The next switch builds its patch from what is on screen: the runtime keeps both changes.
  await act(async () =>
    app.now().saveSettings!({
      notifications: { ...app.now().settings!.notifications!, turn_done: false },
    } as never),
  );
  expect(runtime.stored).toMatchObject({ notifications: { needs_input: false, turn_done: false } });
});

test("a desktop launched from an up-to-date snapshot shows a save over the saved Settings, and goes back to them when it is refused", async () => {
  // The snapshot the last launch wrote: the Settings the runtime still holds.
  dom.localStorage.setItem(
    "caveman.runtime.snapshot",
    JSON.stringify({ workspaces: [], engines: [], settings: SAVED, projects: [] }),
  );
  const app = await mount();
  expect(app.now().settings).toEqual(SAVED);

  // Settings > General: "Done when its pull request merges" turned off; the runtime has not answered yet.
  runtime.holdSaves = true;
  let saving!: Promise<void>;
  await act(async () => {
    saving = app.now().saveSettings!({ inbox_done_on_merge: false } as never);
  });
  await settle();
  // Shown at once, over the saved Settings, the whole time it is out.
  expect(app.shown.slice(1)).toEqual([{ ...SAVED, inbox_done_on_merge: false }]);

  // The runtime refuses it: the switch is back to what was saved, and Settings never goes blank.
  await act(async () => {
    runtime.saves[0]!.reject(new Error("refused"));
    await saving.catch(() => undefined);
  });
  await settle();
  expect(app.shown.slice(1)).toEqual([{ ...SAVED, inbox_done_on_merge: false }, SAVED]);
});
