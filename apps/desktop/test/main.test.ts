// src/main.ts as it runs, under the stand-in Electron in test/fakeElectron.ts, with the real RuntimeSupervisor on the
// fixture runtime. main.ts starts once per process, so the tests share one app and run in order: a link that starts
// the app, the menus, a problem report, the Dock badge, then a logout, last.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeSupervisor } from "../src/runtime.ts";

const started = vi.hoisted(() => [] as RuntimeSupervisor[]);
vi.mock("electron", async () => {
  const { electron } = await import("./fakeElectron.ts");
  return { ...electron, default: electron };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  return { autoUpdater: new EventEmitter() };
});
vi.mock("../src/runtime.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/runtime.ts")>();
  const create = real.RuntimeSupervisor.create.bind(real.RuntimeSupervisor);
  real.RuntimeSupervisor.create = async (...args: Parameters<typeof create>) => {
    const supervisor = await create(...args);
    started.push(supervisor);
    return supervisor;
  };
  return real;
});

const { fake } = await import("./fakeElectron.ts");
const { BADGE_CHANNEL } = await import("../src/ipc.ts");
const { DEFAULT_CAPTURE_SHORTCUT } = await import("../src/capture.ts");

const until = async <T>(
  what: string,
  value: () => T | undefined | null | false,
  ms = 20_000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = value();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  process.env.CAVEMAN_RUNTIME_ENTRY = fileURLToPath(
    new URL("./fixture-runtime.mjs", import.meta.url),
  );
  await import("../src/main.ts");
});
afterAll(async () => {
  await Promise.all(started.map((supervisor) => supervisor.stop()));
});

describe("the desktop app", () => {
  it("opens the page a caveman-code:// link that starts the app points at, once its window has loaded", async () => {
    fake.app.emit("open-url", { preventDefault: () => undefined }, "caveman-code://app/#/chief");
    fake.ready();
    const { webContents } = await until("the window", () => fake.windows[0]);
    webContents.finishLoad();
    expect(webContents.scripts).toEqual([`location.hash = "#/chief"`]);
  });

  it("goes where a menu item says while an iframe in the page is still loading", () => {
    const { webContents } = fake.windows[0]!;
    // An agent's report.html in the side panel (HtmlFileBrowser's iframe), waiting on a slow image.
    webContents.framesLoading = true;
    fake.clickMenu("New Chat");
    fake.clickMenu("What's New");
    webContents.framesLoading = false;
    // A later reload (the runtime moved) applies nothing left over.
    webContents.reload();
    webContents.finishLoad();
    expect(webContents.scripts.slice(1)).toEqual([
      `location.hash = "#/new"`,
      `window.dispatchEvent(new Event("caveman:whats-new"))`,
    ]);
  });

  it("opens a problem report asked for while the page loads once it has, and at once while only an iframe loads", () => {
    const { webContents } = fake.windows[0]!;
    const reports = () =>
      webContents.scripts.filter((script) => script.includes("caveman:report-problem")).length;
    webContents.reload(); // the runtime moved
    fake.clickMenu("Report a Problem…");
    const whileLoading = reports();
    webContents.finishLoad();
    const loaded = reports();
    webContents.framesLoading = true;
    fake.clickMenu("Report a Problem…");
    const whileAnIframeLoads = reports();
    webContents.framesLoading = false;
    expect({ whileLoading, loaded, whileAnIframeLoads }).toEqual({
      whileLoading: 0,
      loaded: 1,
      whileAnIframeLoads: 2,
    });
  });

  it("keeps the Dock badge's count while the Chief's capture panel has focus", async () => {
    const window = fake.windows[0]!;
    // macOS: the window closed (it only hides), and the person works in another app.
    window.hide();
    fake.ipc(BADGE_CHANNEL, 3);
    expect(fake.app.badge).toBe(3);
    const press = await until("the capture shortcut", () =>
      fake.shortcut(DEFAULT_CAPTURE_SHORTCUT),
    );
    press();
    const panelOpen = fake.app.badge;
    fake.ipc(BADGE_CHANNEL, 4); // another chat needs the person while the panel is up
    const fourthNotice = fake.app.badge;
    press(); // the shortcut again hides the panel
    const panelHidden = fake.app.badge;
    fake.app.emit("activate"); // back in the app: its window
    expect({ panelOpen, fourthNotice, panelHidden, backInTheApp: fake.app.badge }).toEqual({
      panelOpen: 3,
      fourthNotice: 4,
      panelHidden: 4,
      backInTheApp: 0,
    });
  });

  it("is still whole after a logout another app cancelled: its runtime runs, and the window closes as before", async () => {
    const supervisor = started[0]!;
    await supervisor.waitReady(10_000);
    const pid = supervisor.pid;
    // Restart, shut down or log out: macOS says so before it asks any app to quit.
    fake.powerMonitor.emit("shutdown", { preventDefault: () => undefined });
    // Then Terminal or an unsaved document cancels it: no quit comes. Time for a runtime told to stop to go.
    await new Promise((r) => setTimeout(r, 1_000));
    const runtime = await supervisor.waitReady(4_000).then(
      () => "answers",
      (error: Error) => `gone: ${error.message}`,
    );
    let prevented = false;
    fake.windows[0]!.emit("close", { preventDefault: () => (prevented = true) });
    // macOS hides the window; elsewhere closing it quits by way of the question before a quit.
    expect({ runtime, samePid: supervisor.pid === pid, windowClosedForGood: !prevented }).toEqual({
      runtime: "answers",
      samePid: true,
      windowClosedForGood: false,
    });
  });

  it("lets the system's quit after its shutdown notice through at once, and stops the runtime", async () => {
    const supervisor = started[0]!;
    let prevented = false;
    fake.app.emit("before-quit", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
    await until("the runtime to stop", () => supervisor.pid === undefined, 10_000);
  });
});
