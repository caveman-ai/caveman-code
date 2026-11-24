import { describe, expect, it, vi } from "vitest";

/** Electron's own on a renderer's death: the window and its webContents stay, without a page until one loads. */
const fake = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeContents extends EventEmitter {
    live = false;
    loads = 0;
    loadURL() {
      this.loads += 1;
      this.live = true;
      return Promise.resolve();
    }
    send() {}
    setWindowOpenHandler() {}
  }
  class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    readonly webContents = new FakeContents();
    visible = false;
    destroyed = false;
    constructor() {
      super();
      FakeWindow.all.push(this);
    }
    loadURL() {
      return this.webContents.loadURL();
    }
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    isVisible() {
      return this.visible;
    }
    isFocused() {
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
  return { FakeWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: fake.FakeWindow,
  globalShortcut: {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));
const { CaptureShortcut, CaptureWindow } = await import("../src/capture.ts");

/** A fake globalShortcut: `taken` chords belong to another app. */
function shortcuts(taken: string[]) {
  const held = new Set<string>();
  const shortcut = new CaptureShortcut(
    (a) => {
      if (taken.includes(a) || !/\+/.test(a)) return false;
      held.add(a);
      return true;
    },
    (a) => held.delete(a),
    () => undefined,
    () => undefined,
  );
  return { shortcut, held };
}

describe("the capture shortcut", () => {
  it("binds the chord from settings", () => {
    const { shortcut, held } = shortcuts([]);
    expect(shortcut.bind("Control+Alt+Space")).toEqual({ accelerator: "Control+Alt+Space", registered: true });
    expect([...held]).toEqual(["Control+Alt+Space"]);
  });

  it("keeps the old chord working when the new one is taken", () => {
    const { shortcut, held } = shortcuts(["Alt+Space"]);
    shortcut.bind("Control+Alt+Space");
    expect(shortcut.bind("Alt+Space")).toEqual({ accelerator: "Control+Alt+Space", registered: true });
    expect([...held]).toEqual(["Control+Alt+Space"]);
  });

  it("says which chord it could not have when nothing is bound", () => {
    const { shortcut, held } = shortcuts(["Control+Alt+Space"]);
    expect(shortcut.bind("Control+Alt+Space")).toEqual({ accelerator: "Control+Alt+Space", registered: false });
    expect(held.size).toBe(0);
  });

  it("moves to a free chord and lets the old one go", () => {
    const { shortcut, held } = shortcuts([]);
    shortcut.bind("Control+Alt+Space");
    expect(shortcut.bind("Command+Shift+K")).toEqual({ accelerator: "Command+Shift+K", registered: true });
    expect([...held]).toEqual(["Command+Shift+K"]);
  });
});

describe("the capture window", () => {
  it("opens a live page on the next shortcut after its renderer died", () => {
    const capture = new CaptureWindow("caveman-code://app/capture.html", "/capture-preload.cjs", () => undefined);
    const first = capture.show() as unknown as InstanceType<typeof fake.FakeWindow>;
    capture.hide();
    // Killed by macOS for memory, or crashed: Electron keeps the window, with no page in it.
    first.webContents.live = false;
    first.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    const shown = capture.show() as unknown as InstanceType<typeof fake.FakeWindow>;
    expect({ pageLive: shown.webContents.live, visible: shown.visible, deadWindowLeft: !first.destroyed }).toEqual({
      pageLive: true,
      visible: true,
      deadWindowLeft: false,
    });
  });
});
