import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const displays = new EventEmitter();
  const state = {
    cursor: { x: 0, y: 0 },
    display: {
      internal: true,
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      workArea: { x: 0, y: 33, width: 1728, height: 1084 },
    },
  };
  class FakeContents extends EventEmitter {
    readonly sent: Array<[string, unknown]> = [];
    loadURL() {
      return Promise.resolve();
    }
    send(channel: string, payload?: unknown) {
      this.sent.push([channel, payload]);
    }
    setWindowOpenHandler() {}
  }
  class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    readonly webContents = new FakeContents();
    readonly options: Record<string, unknown>;
    visible = false;
    destroyed = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    /** Clicks go through the whole window. */
    ignoring = false;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      FakeWindow.all.push(this);
    }
    loadURL() {
      return this.webContents.loadURL();
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents(ignore: boolean) {
      this.ignoring = ignore;
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
  }
  return { FakeWindow, state, displays };
});

vi.mock("electron", () => ({
  BrowserWindow: fake.FakeWindow,
  Menu: {},
  screen: {
    on: (event: string, handler: (...args: unknown[]) => void) => fake.displays.on(event, handler),
    getPrimaryDisplay: () => fake.state.display,
    getCursorScreenPoint: () => fake.state.cursor,
  },
}));
const {
  guessedNotch,
  hardwareNotchOf,
  notchAction,
  notchFrame,
  NotchWindow,
  NOTCH_HEIGHT,
  NOTCH_WIDTH,
  pointInside,
} = await import("../src/notch.ts");
const { NOTCH_AWAY_CHANNEL, NOTCH_STATE_CHANNEL } = await import("../src/ipc.ts");

type Fake = InstanceType<typeof fake.FakeWindow>;
const MACBOOK = { width: 185, height: 32 };
const open = (
  measure: () => Promise<{ width: number; height: number } | null | undefined> = async () =>
    MACBOOK,
) => {
  const logs: string[] = [];
  const notch = new NotchWindow(
    "caveman-code://app/notch.html",
    "/notch-preload.cjs",
    (line) => logs.push(line),
    () => undefined,
    measure,
  );
  return { notch, logs, win: () => notch.window as unknown as Fake };
};
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("where the notch sits", () => {
  it("hangs from the top edge of the screen, over the menu bar, centred", () => {
    expect(notchFrame({ x: 0, y: 0, width: 1728, height: 1117 })).toEqual({
      x: 644,
      y: 0,
      width: NOTCH_WIDTH,
      height: NOTCH_HEIGHT,
    });
    // A main display that is not at the origin's corner (a second one to the left of it).
    expect(notchFrame({ x: -1920, y: 40, width: 1920, height: 1080 })).toMatchObject({
      x: -1920 + 740,
      y: 40,
    });
  });

  it("reads the screen's own notch from what AppKit measures", () => {
    // A 16-inch MacBook Pro: the strips beside the notch leave 185 points of the screen's 1728.
    expect(
      hardwareNotchOf(JSON.stringify({ width: 1728, top: 32, left: 771.5, right: 771.5 })),
    ).toEqual(MACBOOK);
    // An external display: no safe area, no strips.
    expect(hardwareNotchOf(JSON.stringify({ width: 2560, top: 0, left: 0, right: 0 }))).toBeNull();
    expect(hardwareNotchOf("execution error")).toBeNull();
    expect(hardwareNotchOf(JSON.stringify({ width: 1728, top: 32 }))).toBeNull();
  });

  it("guesses a notch nobody could measure from a built-in display's tall menu bar, on the wide side", () => {
    const display = {
      internal: true,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 38, width: 1512, height: 944 },
    };
    expect(guessedNotch(display)).toEqual({ width: 204, height: 37 });
    expect(guessedNotch({ ...display, internal: false })).toBeNull();
    expect(guessedNotch({ ...display, workArea: { ...display.workArea, y: 25 } })).toBeNull();
  });
});

describe("what the notch's page may ask for", () => {
  it("takes an open, a key press, a page of the card and a hide, and drops everything else", () => {
    expect(notchAction({ type: "open" })).toEqual({ type: "open" });
    expect(notchAction({ type: "open", id: "w1", extra: 1 })).toEqual({ type: "open", id: "w1" });
    expect(notchAction({ type: "press", id: "w1", key: "ship" })).toEqual({
      type: "press",
      id: "w1",
      key: "ship",
    });
    expect(notchAction({ type: "show", id: "w2" })).toEqual({ type: "show", id: "w2" });
    expect(notchAction({ type: "hide" })).toEqual({ type: "hide" });
    for (const bad of [
      null,
      "open",
      {},
      { type: "quit" },
      { type: "open", id: 7 },
      { type: "press", id: "w1" },
      { type: "show" },
      { type: "press", id: "", key: "ship" },
      { type: "press", id: "w1", key: "x".repeat(201) },
    ])
      expect(notchAction(bad)).toBeNull();
  });
});

describe("the notch window", () => {
  it("shows once the app says what it shows, on the measured notch, and goes when the app says nothing", async () => {
    const { notch, win, logs } = open();
    expect(notch.window).toBeNull();
    notch.feed({ agents: [] });
    // Never shown, and its page never told, before the screen's notch is measured: it would draw the wrong shape.
    expect([win().visible, win().webContents.sent.length]).toEqual([false, 0]);
    await settled();
    expect(win().visible).toBe(true);
    expect(win().bounds).toEqual({ x: 644, y: 0, width: NOTCH_WIDTH, height: NOTCH_HEIGHT });
    expect(win().webContents.sent.at(-1)).toEqual([
      NOTCH_STATE_CHANNEL,
      { state: { agents: [] }, hardware: MACBOOK, bar: 33 },
    ]);
    // A clear panel that never takes the keys, and lets clicks through until the page says the pointer is on its shape.
    expect(win().options).toMatchObject({
      transparent: true,
      focusable: false,
      type: "panel",
      frame: false,
    });
    // The app's zoom (⌘+) never reaches it: the shape is drawn to the point against the screen's notch.
    expect((win().options.webPreferences as { zoomMode?: string }).zoomMode).toBe("isolated");
    expect(win().ignoring).toBe(true);
    notch.feed(null);
    expect(win().visible).toBe(false);
    expect(logs).toEqual(["notch: shown (the screen's notch is 185x32)", "notch: put away"]);
  });

  it("guesses the screen's notch when it could not be measured, and says so", async () => {
    const { notch, win, logs } = open(async () => undefined);
    notch.feed({ agents: [] });
    await settled();
    expect(win().webContents.sent.at(-1)?.[1]).toMatchObject({
      hardware: { width: 204, height: 32 },
    });
    expect(logs[0]).toBe("notch: shown (the screen's notch is 204x32, guessed)");
  });

  it("tells its page again once the page listens, and every time what it shows changes", async () => {
    const { notch, win } = open();
    notch.feed({ agents: [] });
    await settled();
    const before = win().webContents.sent.length;
    notch.ready();
    notch.feed({ agents: [{ id: "w1" }] });
    expect(
      win()
        .webContents.sent.slice(before)
        .map(([, payload]) => (payload as { state: unknown }).state),
    ).toEqual([{ agents: [] }, { agents: [{ id: "w1" }] }]);
  });

  it("takes clicks only while the pointer is on its shape, and notices a pointer that left without a last move", async () => {
    vi.useFakeTimers();
    try {
      const { notch, win } = open();
      notch.feed({ agents: [] });
      await vi.advanceTimersByTimeAsync(0);
      fake.state.cursor = { x: 864, y: 10 };
      notch.over(true);
      expect(win().ignoring).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      // Still over the window: the page hears every move itself.
      expect(win().webContents.sent.some(([channel]) => channel === NOTCH_AWAY_CHANNEL)).toBe(
        false,
      );
      // A flick off the window: no event reaches the page, so main says it, and clicks go through again.
      fake.state.cursor = { x: 100, y: 600 };
      await vi.advanceTimersByTimeAsync(250);
      expect(
        win().webContents.sent.filter(([channel]) => channel === NOTCH_AWAY_CHANNEL),
      ).toHaveLength(1);
      expect(win().ignoring).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        win().webContents.sent.filter(([channel]) => channel === NOTCH_AWAY_CHANNEL),
      ).toHaveLength(1);
      notch.over(true);
      notch.over(false);
      expect(win().ignoring).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("places itself once per burst of display changes, and only tells its page when the work area moved alone", async () => {
    vi.useFakeTimers();
    try {
      let measured = 0;
      const { notch, win } = open(async () => (measured++, MACBOOK));
      notch.feed({ agents: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(measured).toBe(1);
      // A Dock sliding out and back: the work area moves many times a second, the screen itself does not.
      const told = win().webContents.sent.length;
      for (let i = 0; i < 30; i++)
        fake.displays.emit("display-metrics-changed", {}, fake.state.display, ["workArea"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect([measured, win().webContents.sent.length - told]).toEqual([1, 1]);
      // A display plugged in: measured again, once.
      for (let i = 0; i < 5; i++)
        fake.displays.emit("display-metrics-changed", {}, fake.state.display, [
          "bounds",
          "workArea",
        ]);
      fake.displays.emit("display-added");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(measured).toBe(2);
    } finally {
      fake.displays.removeAllListeners();
      vi.useRealTimers();
    }
  });

  it("answers only its own page", async () => {
    const { notch, win } = open();
    notch.feed({ agents: [] });
    await settled();
    expect(notch.owns(win().webContents as never)).toBe(true);
    expect(notch.owns({} as never)).toBe(false);
  });

  it("comes back by itself after its page died, placed and showing, with what it showed", async () => {
    vi.useFakeTimers();
    try {
      const { notch, win, logs } = open();
      notch.feed({ agents: [{ id: "w1" }] });
      await vi.advanceTimersByTimeAsync(0);
      const first = win();
      first.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
      expect([first.destroyed, notch.window]).toEqual([true, null]);
      // No word from the app is needed: a moment later a new window stands where the old one did.
      await vi.advanceTimersByTimeAsync(1_000);
      const second = win();
      expect(second).not.toBe(first);
      expect([second.visible, second.bounds]).toEqual([
        true,
        { x: 644, y: 0, width: NOTCH_WIDTH, height: NOTCH_HEIGHT },
      ]);
      expect(second.webContents.sent.at(-1)?.[1]).toMatchObject({
        state: { agents: [{ id: "w1" }] },
      });
      expect(logs).toContain("notch: page gone (crashed, exit 5): reload");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a window the app's next word makes after a death is placed and shown too", async () => {
    vi.useFakeTimers();
    try {
      const { notch, win } = open();
      notch.feed({ agents: [] });
      await vi.advanceTimersByTimeAsync(0);
      const first = win();
      first.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
      // The app speaks before the recovery's own moment: this word makes the window, and it shows.
      notch.feed({ agents: [{ id: "w1" }] });
      await vi.advanceTimersByTimeAsync(0);
      const second = win();
      expect([second === first, second.visible]).toEqual([false, true]);
      // The recovery's moment then finds a window and makes no other.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(win()).toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops making windows for a page that keeps dying, until the notch is put away and shown again", async () => {
    vi.useFakeTimers();
    try {
      const { notch, win, logs } = open();
      notch.feed({ agents: [] });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        win().webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(logs.at(-1)).toBe("notch: page gone (crashed, exit 5): give-up");
      expect(notch.window).toBeNull();
      notch.feed({ agents: [{ id: "w1" }] });
      expect(notch.window).toBeNull();
      // Settings > General, off and on: one more try.
      notch.feed(null);
      notch.feed({ agents: [] });
      expect(notch.window).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the pointer watch", () => {
  it("counts a point on the window's left and top edges as inside, and one on its right and bottom as out", () => {
    const r = { x: 644, y: 0, width: 440, height: 560 };
    expect(pointInside({ x: 644, y: 0 }, r)).toBe(true);
    expect(pointInside({ x: 1083, y: 559 }, r)).toBe(true);
    expect(pointInside({ x: 1084, y: 10 }, r)).toBe(false);
    expect(pointInside({ x: 700, y: 560 }, r)).toBe(false);
  });
});
