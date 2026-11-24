// M on the Chief's page: Mission control, except while the call's stage is in the box's place, where M mutes and
// unmutes (the stage's "Mute (M)"). The page is the real ChiefRoute with its call stage and the real call store; only
// the browser's audio, microphone and the voice engine's socket are stand-ins.
import { afterEach, expect, test, vi } from "vitest";
import { mount, press, settle } from "./chief-browser.fixture.ts";
import { act, createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { startCall } from "../call/store.ts";
import { RuntimeFixture } from "../state/runtime.tsx";
import { ChiefRoute } from "./Chief.tsx";

/** The voice engine's cues, as the call store hands them to openEngine. */
const engine: { cue: ((c: { type: string }) => void) | null } = { cue: null };

vi.mock("../call/media.ts", async (orig) => ({
  ...(await orig<typeof import("../call/media.ts")>()),
  microphone: async () => ({ getTracks: () => [] }),
  openMedia: async () => ({
    onFrame: null,
    onPlaying: null,
    play() {},
    flush() {},
    hold() {},
    playing: false,
    drained: async () => undefined,
    levels: () => ({ mic: 0, voice: 0 }),
    bands: (into: Float32Array) => into.fill(0),
    close() {},
  }),
}));
vi.mock("../call/sounds.ts", async (orig) => ({
  ...(await orig<typeof import("../call/sounds.ts")>()),
  CallSounds: class {
    unlock() {}
    ring() {
      return { first: Promise.resolve(), stop() {} };
    }
    tick() {}
    pickUp() {}
    hangUp() {}
  },
}));
vi.mock("../call/engine.ts", async (orig) => ({
  ...(await orig<typeof import("../call/engine.ts")>()),
  openEngine: (_connect: unknown, _media: unknown, on: { cue: (c: { type: string }) => void }) => {
    engine.cue = on.cue;
    return { send() {}, close() {}, setMuted() {} };
  },
}));

(globalThis as Record<string, unknown>).AudioContext = class {
  state = "running";
  resume() {
    return Promise.resolve();
  }
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The home Chief's page on a runtime; `goLive` starts a call from its box and the voice picks up. */
async function chiefPage() {
  /** Each chief.voice.update's muted: what the call told the runtime. */
  const mutes: boolean[] = [];
  // A client per test: the call store is one per client.
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      if (method === "chief.voice.start")
        return Promise.resolve({
          call: { id: "call1", state: "live", muted: false, device: "test" },
          connect: { input_rate: 16_000, output_rate: 24_000 },
        });
      if (method === "chief.voice.update") {
        mutes.push(params.muted as boolean);
        return Promise.resolve({});
      }
      // The rest of the page (its board, chats, spend) stays as it loads.
      return new Promise(() => undefined);
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  };
  const runtime = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
  };
  const page = (value: object) =>
    createElement(
      MemoryRouter,
      { initialEntries: ["/chief"] },
      createElement(RuntimeFixture, {
        value: value as never,
        children: createElement(
          Routes,
          null,
          createElement(Route, { path: "/chief", element: createElement(ChiefRoute) }),
        ),
      }),
    );
  const view = await mount(page(runtime));
  cleanups.push(view.unmount);
  return {
    goLive: async () => {
      await act(async () => void (await startCall(client as never)));
      await settle();
      await act(async () => engine.cue?.({ type: "live" }));
      await settle();
    },
    /** What the page shows: Mission control (its breadcrumb), the call's stage, and what the call sent. */
    seen: () => ({
      mission: [...view.container.querySelectorAll('h1[aria-current="page"]')].some((h) =>
        h.textContent?.includes("Mission control"),
      ),
      stage: view.container.querySelector('section[aria-label^="Call with"]') !== null,
      mutes: [...mutes],
    }),
    /** Something arrives from the runtime (a chat's update): the page draws again. */
    push: () => view.rerender(page({ ...runtime })),
  };
}

test("the first M once a call is live on the Chief's page mutes it", async () => {
  const page = await chiefPage();
  await page.goLive();
  expect(page.seen()).toEqual({ mission: false, stage: true, mutes: [] });
  await press("m");
  expect(page.seen()).toEqual({ mission: false, stage: true, mutes: [true] });
});

test("M mutes and M again unmutes a call on the Chief's page; Mission control stays closed", async () => {
  const page = await chiefPage();
  await page.goLive();
  await page.push();
  await press("m");
  expect(page.seen()).toEqual({ mission: false, stage: true, mutes: [true] });
  await press("m");
  expect(page.seen()).toEqual({ mission: false, stage: true, mutes: [true, false] });
});
