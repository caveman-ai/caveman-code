// A web tab Cloud serves is put on another computer in place (a chat started in Cloud, New chat on a Mac; never a
// person's pick of a machine, state/cloud.ts chooseRuntime): the real RuntimeProvider talks to the new
// computer from then on, and what it shows is that computer's. Only the relay connections are fakes: each computer's
// runtime answers as server.ts does, and its client's close() refuses what is still out, as the real client's does.
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
    location: {
      href: "https://cloud.test/code/",
      protocol: "https:",
      host: "cloud.test",
      hostname: "cloud.test",
      pathname: "/code/",
      search: "",
      hash: "",
      origin: "https://cloud.test",
    },
    history: { replaceState: () => undefined },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    // Nobody is signed in to Cloud here: no chat list, only the picked computer's runtime.
    fetch: async () => new Response("{}", { status: 401 }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(globalThis, { window: globalThis });
  return { localStorage };
});

/** Each computer's runtime, by runtime id: what it answers, and the reads and saves it has not answered yet. */
const computers = vi.hoisted(() => ({
  state: new Map<
    string,
    { settings: Record<string, unknown>; engines: unknown[]; projects: unknown[] }
  >(),
  /** Runtimes whose reads wait for the test (a relay link still connecting). */
  slow: new Set<string>(),
  /** Runtimes whose project.list alone waits for the test (it can answer after the other reads of a poll). */
  slowProjects: new Set<string>(),
  waiting: [] as Array<() => void>,
  holdSaves: false,
}));

vi.mock("./sync/kv.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/kv.ts")>();
  return { ...real, indexedDbKv: () => real.memoryKv() };
});

const fakeRelay = vi.hoisted(
  () => (url: string, _token: unknown, onState?: (state: string) => void) => {
    const id = decodeURIComponent(url.split("/").pop()!);
    const pending = new Set<(e: Error) => void>();
    // Calls made before the socket opens go out once it has, after it said "open".
    let open = false;
    const unsent: Array<() => void> = [];
    const answer = <T>(value: () => T, wait: boolean): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        pending.add(reject);
        const go = () => {
          pending.delete(reject);
          resolve(value());
        };
        if (wait) computers.waiting.push(go);
        else if (!open) unsent.push(go);
        else go();
      });
    const runtime = () => computers.state.get(id)!;
    const read = <T>(value: () => T) => answer(value, computers.slow.has(id));
    setTimeout(() => {
      open = true;
      onState?.("open");
      for (const go of unsent.splice(0)) go();
    }, 0);
    return {
      call: (method: string, params: { settings?: Record<string, unknown> }) => {
        switch (method) {
          case "workspace.list":
            return read(() => ({ workspaces: [] }));
          case "engine.list":
            return read(() => ({ engines: runtime().engines }));
          case "settings.get":
            return read(() => structuredClone(runtime().settings));
          case "project.list":
            return answer(
              () => ({ projects: runtime().projects }),
              computers.slow.has(id) || computers.slowProjects.has(id),
            );
          case "settings.set":
            if (computers.holdSaves) return answer(() => structuredClone(runtime().settings), true);
            runtime().settings = { ...runtime().settings, ...params.settings };
            return Promise.resolve(structuredClone(runtime().settings));
          default:
            return new Promise(() => undefined);
        }
      },
      attach: () => new Promise(() => undefined),
      on: () => () => undefined,
      hello: () => undefined,
      onHello: () => () => undefined,
      close: () => {
        for (const reject of [...pending]) reject(new Error("client closed"));
        pending.clear();
      },
    };
  },
);
vi.mock("@caveman-app/session-protocol/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@caveman-app/session-protocol/client")>()),
  connect: fakeRelay,
}));
vi.mock("@caveman-app/session-protocol/direct", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@caveman-app/session-protocol/direct")>()),
  connectDirect: fakeRelay,
}));

const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
Object.assign(globalThis, { document });
const { RuntimeProvider, useRuntime, CLOUD_HOSTED } = await import("./runtime.tsx");
const { chooseRuntime } = await import("./cloud.ts");
const { useSaveSettings } = await import("../routes/settings/rows.tsx");
type Value = ReturnType<typeof useRuntime>;

const computer = (id: string, name: string) => ({
  id,
  name,
  computer_id: `c-${id}`,
  computer_name: name,
  computer_driver: "fly",
  last_seen_at: null,
});
const A = computer("rt-A", "api-box");
const B = computer("rt-B", "web-box");
const settingsOf = (theme: string, favorite_models: string[]) =>
  ({
    theme,
    default_engine: "caveman",
    default_computer_id: "this-mac",
    engines: {},
    notifications: { needs_input: true, turn_done: true },
    favorite_models,
  }) as unknown as Settings;
const A_SETTINGS = settingsOf("dark", ["caveman/a-model"]);
const B_SETTINGS = settingsOf("light", ["caveman/b-model"]);

let unmount: (() => Promise<void>) | null = null;
beforeEach(() => {
  dom.localStorage.clear();
  computers.state.set("rt-A", {
    settings: structuredClone(A_SETTINGS) as never,
    engines: [{ id: "caveman", label: "Caveman on api-box" }],
    projects: [{ id: "p-a", name: "api" }],
  });
  computers.state.set("rt-B", {
    settings: structuredClone(B_SETTINGS) as never,
    engines: [{ id: "caveman", label: "Caveman on web-box" }],
    projects: [{ id: "p-b", name: "web" }],
  });
  computers.slow.clear();
  computers.slowProjects.clear();
  computers.waiting.length = 0;
  computers.holdSaves = false;
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

/** A Settings control's save (useSaveSettings): a failure shows in the header every Settings section shares. */
let saveFromSettings: ReturnType<typeof useSaveSettings>;

/** The provider mounted on computer A, connected. */
async function onA() {
  chooseRuntime(localStorage, A);
  const latest: { value: Value | null } = { value: null };
  const Probe = () => ((latest.value = useRuntime()), (saveFromSettings = useSaveSettings()), null);
  const root = createRoot(document.getElementById("root") as unknown as Element);
  await act(async () => root.render(createElement(RuntimeProvider, null, createElement(Probe))));
  unmount = () => act(async () => root.unmount());
  for (let i = 0; i < 10 && latest.value?.status !== "connected"; i++) await settle();
  expect(latest.value?.settings).toEqual(A_SETTINGS);
  return () => latest.value!;
}

test("while a computer picked in place connects, nothing on screen is the last computer's: no Settings, engines or projects", async () => {
  expect(CLOUD_HOSTED).toBe(true);
  const now = await onA();
  // B's relay link is still connecting: its runtime has answered nothing yet.
  computers.slow.add("rt-B");
  await act(async () => chooseRuntime(localStorage, B));
  await settle();
  expect(now().status).toBe("connecting");
  expect({ settings: now().settings, engines: now().engines, projects: now().projects }).toEqual({
    settings: null,
    engines: [],
    projects: [],
  });

  await act(async () => {
    for (const go of computers.waiting.splice(0)) go();
  });
  await settle();
  expect(now().settings).toEqual(B_SETTINGS);
  expect(now().engines).toEqual([{ id: "caveman", label: "Caveman on web-box" }]);
});

test("a save still out on the last computer when another is picked does not hold back the new computer's Settings", async () => {
  const now = await onA();
  // Settings > Models: a star, saved to A; A has not answered when the person picks B.
  computers.holdSaves = true;
  let saving!: Promise<string>;
  await act(async () => {
    saving = now().saveSettings!({
      favorite_models: [...now().settings!.favorite_models!, "caveman/another"],
    } as never).then(
      () => "saved",
      (e: unknown) => (e as Error).message,
    );
  });
  computers.holdSaves = false;
  await act(async () => chooseRuntime(localStorage, B));
  expect(await saving).toBe("client closed");
  await settle();
  // B's first poll is taken: its Settings now, not one catch-up poll (10 s) later.
  expect(now().status).toBe("connected");
  expect(now().settings).toEqual(B_SETTINGS);
});

test("a save that failed on the last computer is not shown as failing on the one picked after it", async () => {
  const now = await onA();
  await act(async () =>
    now().setSettingsSaveError!(
      "Couldn't save that change: the disk is full. It's back to what was saved.",
    ),
  );
  await act(async () => chooseRuntime(localStorage, B));
  await settle();
  expect(now().settingsSaveError).toBeNull();
});

test("a save still out on the last computer when another is picked says nothing on the new computer's Settings", async () => {
  const now = await onA();
  computers.holdSaves = true;
  let saving!: Promise<void>;
  await act(async () => {
    saving = saveFromSettings({
      favorite_models: [...now().settings!.favorite_models!, "caveman/another"],
    } as never);
  });
  computers.holdSaves = false;
  await act(async () => chooseRuntime(localStorage, B));
  await saving;
  await settle();
  expect(now().settings).toEqual(B_SETTINGS);
  expect(now().settingsSaveError).toBeNull();
});

test("a poll of the last computer that settles after another is picked puts nothing of that computer on screen", async () => {
  const now = await onA();
  // A poll of A is out: A has answered its workspaces, engines and Settings, not yet its projects.
  computers.slowProjects.add("rt-A");
  let polling!: Promise<void>;
  await act(async () => {
    polling = now().refresh();
  });
  // The pick closes A's client, which refuses the projects read; a poll reads a refused project.list as none.
  computers.slow.add("rt-B");
  await act(async () => chooseRuntime(localStorage, B));
  await act(async () => polling);
  await settle();
  expect(now().status).toBe("connecting");
  expect({ settings: now().settings, engines: now().engines, projects: now().projects }).toEqual({
    settings: null,
    engines: [],
    projects: [],
  });

  await act(async () => {
    for (const go of computers.waiting.splice(0)) go();
  });
  await settle();
  expect(now().settings).toEqual(B_SETTINGS);
});
