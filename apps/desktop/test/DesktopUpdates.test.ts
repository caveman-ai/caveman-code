import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// electron's autoUpdater is Squirrel.Mac; electron-updater's runs the check and the download.
const fake = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const feeds: Record<string, { version: string; releaseNotes?: string }> = {};
  let feed = "";
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn((options: { url: string }) => void (feed = options.url)),
    checkForUpdates: vi.fn(async () => {
      const latest = feeds[feed];
      if (latest) updater.emit("update-available", latest);
      else updater.emit("update-not-available", {});
    }),
    downloadUpdate: vi.fn(async (_token?: { cancelled: boolean }) => []),
    quitAndInstall: vi.fn(),
    autoInstallOnAppQuit: false,
    autoDownload: true,
    allowDowngrade: true,
    disableDifferentialDownload: false,
    logger: {} as unknown,
  });
  const app = Object.assign(new EventEmitter(), {
    getVersion: (): string => "0.1.0",
    isPackaged: true,
    runningUnderARM64Translation: false,
  });
  return { app, squirrel: new EventEmitter(), updater, feeds, feedNow: () => feed };
});
vi.mock("electron", () => ({ app: fake.app, autoUpdater: fake.squirrel }));
vi.mock("electron-updater", () => ({
  autoUpdater: fake.updater,
  CancellationToken: class {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  },
}));
const { redact, Updates, updateDisabledReason, CHANNEL_FILE, INSTALL_RECORD_FILE } =
  await import("../src/updates/DesktopUpdates.ts");
const { app, squirrel, updater, feeds } = fake;

const MAC = "https://download.caveman.so/code/mac";
const WIN = "https://download.caveman.so/code/win";

describe("update errors", () => {
  it("keep the first line and drop anything token-shaped", () => {
    const gho = `gho_${"a".repeat(36)}`;
    expect(
      redact(new Error(`HttpError: 404 for ${gho}\nheaders: {"authorization":"token ${gho}"}`)),
    ).toBe("HttpError: 404 for <token>");
    expect(redact(`authorization: Bearer github_pat_${"b".repeat(30)}`)).not.toContain(
      "github_pat_",
    );
    expect(redact("token=abc123 failed")).toBe("token=<redacted> failed");
  });
});

describe("why updates are off", () => {
  it("names development, the smoke test and a build with no feed", () => {
    expect(updateDisabledReason({ packaged: false, smoke: false, feed: MAC })).toMatch(
      /development/,
    );
    expect(updateDisabledReason({ packaged: true, smoke: true, feed: MAC })).toMatch(/smoke/);
    expect(updateDisabledReason({ packaged: true, smoke: false, feed: undefined })).toMatch(
      /no update feed/,
    );
    expect(updateDisabledReason({ packaged: true, smoke: false, feed: MAC })).toBeNull();
  });
});

describe("updates", () => {
  const resourcesPath = process.resourcesPath;
  const platform = process.platform;
  const onPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value, configurable: true });
  let version = "0.1.0";
  app.getVersion = () => version;
  const withFeed = (url: string) => {
    const resources = mkdtempSync(join(tmpdir(), "caveman-updates-"));
    writeFileSync(join(resources, "app-update.yml"), `provider: generic\nurl: ${url}\n`);
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
  };
  const fresh = (data = mkdtempSync(join(tmpdir(), "caveman-updates-data-"))) => {
    const lines: string[] = [];
    const updates = new Updates((line) => lines.push(line), data);
    return { updates, data, lines };
  };
  beforeEach(() => {
    version = "0.1.0";
    for (const key of Object.keys(feeds)) delete feeds[key];
    updater.removeAllListeners();
    squirrel.removeAllListeners();
    app.removeAllListeners();
    updater.checkForUpdates.mockClear();
    updater.downloadUpdate.mockClear();
    updater.quitAndInstall.mockClear();
    updater.setFeedURL.mockClear();
  });
  afterAll(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "resourcesPath", { value: resourcesPath, configurable: true });
    onPlatform(platform);
  });

  it("reads the stable feed in app-update.yml with no login, downloads only after judging, offers a restart only once Squirrel.Mac accepts it, and never checks twice", async () => {
    vi.useFakeTimers();
    onPlatform("darwin");
    withFeed(MAC);
    feeds[MAC] = { version: "0.2.0", releaseNotes: "- The Chief queues chats\n- Faster start" };
    const { updates } = fresh();
    updates.start(false);
    expect(updates.current).toMatchObject({
      status: "idle",
      channel: "stable",
      buildChannel: "stable",
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({ provider: "generic", url: MAC });

    expect(await updates.check()).toMatchObject({
      status: "downloading",
      next: "0.2.0",
      percent: 0,
    });
    expect(updates.current.notes).toEqual([
      { version: "0.2.0", items: ["The Chief queues chats", "Faster start"], releasedAt: null },
    ]);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect((await updates.check()).status).toBe("downloading");
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit("download-progress", { percent: 42.7 });
    expect(updates.current.percent).toBe(42);

    // electron-updater says downloaded before Squirrel.Mac has checked the signature.
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(updates.current.status).toBe("downloading");
    expect(await updates.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    squirrel.emit("update-downloaded");
    expect(updates.current).toMatchObject({ status: "ready", next: "0.2.0", percent: 100 });
    expect((await updates.check()).status).toBe("ready");
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(await updates.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("follows the Nightly feed beside the stable one, and keeps the channel picked across starts", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    feeds[MAC] = { version: "0.2.0" };
    feeds[`https://download.caveman.so/code/nightly/mac`] = {
      version: "0.2.1-nightly.20261109.7",
      releaseNotes: "- fix(desktop): channels",
    };
    const first = fresh();
    first.updates.start(false);
    expect(await first.updates.setChannel("nightly")).toMatchObject({
      status: "downloading",
      channel: "nightly",
      next: "0.2.1-nightly.20261109.7",
    });
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://download.caveman.so/code/nightly/mac",
    });
    expect(first.updates.current.notes).toEqual([
      {
        version: "0.2.1-nightly.20261109.7",
        items: ["fix(desktop): channels"],
        releasedAt: "2026-11-09",
      },
    ]);
    expect(JSON.parse(readFileSync(join(first.data, CHANNEL_FILE), "utf8"))).toEqual({
      channel: "nightly",
    });
    expect(first.lines).toContain("updates: downloading on nightly 0.2.1-nightly.20261109.7 0%");

    // The next start reads it before anything checks.
    updater.removeAllListeners();
    const second = fresh(first.data);
    second.updates.start(false);
    expect(second.updates.current.channel).toBe("nightly");
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://download.caveman.so/code/nightly/mac",
    });
  });

  it("switched back to Stable, a nightly build stays until a newer stable ships: never an older build", async () => {
    onPlatform("darwin");
    version = "0.2.1-nightly.20261109.7";
    withFeed(MAC);
    feeds[MAC] = { version: "0.2.0" };
    const { updates, lines } = fresh();
    updates.start(false);
    // A nightly build follows Nightly until someone picks Stable.
    expect(updates.current).toMatchObject({ channel: "nightly", buildChannel: "nightly" });
    expect(await updates.setChannel("stable")).toMatchObject({
      status: "current",
      channel: "stable",
      buildChannel: "nightly",
      next: null,
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(lines).toContain(
      "updates: not offering 0.2.0: not a newer stable build than 0.2.1-nightly.20261109.7",
    );
    // 0.2.1 itself is newer than its nightlies: that one installs.
    feeds[MAC] = { version: "0.2.1" };
    expect(await updates.check()).toMatchObject({ status: "downloading", next: "0.2.1" });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("switched to Stable mid-download, cancels the nightly and installs nothing from it", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    const nightly = "https://download.caveman.so/code/nightly/mac";
    feeds[nightly] = { version: "0.2.1-nightly.20261109.7" };
    feeds[MAC] = { version: "0.1.0" };
    let token: { cancelled: boolean } | undefined;
    updater.downloadUpdate.mockImplementationOnce(async (given?: { cancelled: boolean }) => {
      token = given;
      await new Promise((resolve) => setImmediate(resolve));
      if (given?.cancelled) throw new Error("cancelled");
      return [];
    });
    const { updates } = fresh();
    updates.start(false);
    expect(await updates.setChannel("nightly")).toMatchObject({ status: "downloading" });
    expect(await updates.setChannel("stable")).toMatchObject({
      status: "current",
      channel: "stable",
      next: null,
      failed: null,
    });
    expect(token?.cancelled).toBe(true);
  });

  it("on Windows keeps an installer the channel picked would not offer from installing at quit", async () => {
    onPlatform("win32");
    withFeed(WIN);
    const nightly = "https://download.caveman.so/code/nightly/win";
    feeds[nightly] = { version: "0.2.1-nightly.20261109.7" };
    const { updates } = fresh();
    updates.start(false);
    await updates.setChannel("nightly");
    updater.emit("update-downloaded", { version: "0.2.1-nightly.20261109.7" });
    expect(updates.current).toMatchObject({ status: "ready" });
    // Back to Stable: the nightly installer stays on disk but never runs at quit.
    expect((await updates.setChannel("stable")).status).toBe("current");
    app.emit("quit");
    expect(updater.autoInstallOnAppQuit).toBe(false);
    // Picked again, Nightly offers it again.
    feeds[nightly] = { version: "0.2.1-nightly.20261109.7" };
    await updates.setChannel("nightly");
    app.emit("quit");
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("on macOS says a nightly Squirrel.Mac already took installs at quit, after a switch to Stable", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    feeds["https://download.caveman.so/code/nightly/mac"] = { version: "0.2.1-nightly.20261109.7" };
    const { updates } = fresh();
    updates.start(false);
    await updates.setChannel("nightly");
    squirrel.emit("update-downloaded");
    expect(updates.current).toMatchObject({ status: "ready", message: null });
    expect(await updates.setChannel("stable")).toMatchObject({
      status: "ready",
      channel: "stable",
      next: "0.2.1-nightly.20261109.7",
      message: "0.2.1-nightly.20261109.7 was already downloaded and installs when you quit.",
    });
  });

  it("never downloads a build from the other channel, even when the feed names one", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    feeds[MAC] = { version: "0.3.0-nightly.20261110.1" };
    const { updates } = fresh();
    updates.start(false);
    expect(await updates.check()).toMatchObject({ status: "current", next: null });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("checks the new channel again when it changed during a check", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    feeds["https://download.caveman.so/code/nightly/mac"] = { version: "0.2.0-nightly.20261109.1" };
    const { updates } = fresh();
    updates.start(false);
    let release!: () => void;
    updater.checkForUpdates.mockImplementationOnce(async () => {
      await new Promise<void>((done) => (release = done));
      updater.emit("update-not-available", {});
    });
    const checking = updates.check();
    expect(updates.current.status).toBe("checking");
    expect((await updates.setChannel("nightly")).status).toBe("checking");
    release();
    expect(await checking).toMatchObject({
      status: "downloading",
      channel: "nightly",
      next: "0.2.0-nightly.20261109.1",
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("says what failed: the check, then the download, and checks again after", async () => {
    onPlatform("darwin");
    withFeed(MAC);
    const { updates } = fresh();
    updates.start(false);
    updater.checkForUpdates.mockImplementationOnce(async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED\nstack");
    });
    expect(await updates.check()).toMatchObject({
      status: "error",
      failed: "check",
      message: "net::ERR_INTERNET_DISCONNECTED",
    });
    feeds[MAC] = { version: "0.2.0" };
    updater.downloadUpdate.mockImplementationOnce(async () => {
      throw new Error("sha512 checksum mismatch");
    });
    await updates.check();
    await new Promise((r) => setImmediate(r));
    expect(updates.current).toMatchObject({
      status: "error",
      failed: "download",
      next: "0.2.0",
      message: "sha512 checksum mismatch",
    });
    expect((await updates.check()).status).toBe("downloading");
  });

  it("on Windows offers a restart once electron-updater has the installer (NSIS has no Squirrel step), which runs silently and reopens the app", async () => {
    onPlatform("win32");
    withFeed(WIN);
    feeds[WIN] = { version: "0.2.0" };
    const { updates } = fresh();
    updates.start(false);
    expect(await updates.check()).toMatchObject({ status: "downloading", next: "0.2.0" });
    expect(await updates.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(updates.current).toMatchObject({ status: "ready", next: "0.2.0" });
    updater.quitAndInstall.mockImplementationOnce(
      () => void setImmediate(() => squirrel.emit("before-quit-for-update")),
    );
    expect(await updates.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("tells main when the updater quits the app to install, so its before-quit lets the quit through", () => {
    withFeed(MAC);
    const { updates } = fresh();
    const onQuit = vi.fn();
    updates.onQuitForUpdate = onQuit;
    updates.start(false);
    expect(onQuit).not.toHaveBeenCalled();
    squirrel.emit("before-quit-for-update");
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("on Windows never installs while a runtime it did not start runs, and keeps the update ready for later", async () => {
    onPlatform("win32");
    withFeed(WIN);
    feeds[WIN] = { version: "0.2.0" };
    const { updates, data } = fresh();
    let attached = true;
    updates.installBlocked = () =>
      attached ? "Quit caveman-code in your terminal to update." : undefined;
    updates.start(false);
    await updates.check();
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(updates.current).toMatchObject({
      status: "ready",
      next: "0.2.0",
      message: "Quit caveman-code in your terminal to update.",
    });
    expect(await updates.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    // Install on quit: electron-updater reads the flag in its own `quit` listener, added after this one.
    updater.autoInstallOnAppQuit = true;
    app.emit("quit");
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(existsSync(join(data, INSTALL_RECORD_FILE))).toBe(false);

    attached = false;
    expect(updates.current).toMatchObject({
      status: "ready",
      next: "0.2.0",
      version: "0.1.0",
      message: null,
    });
    app.emit("quit");
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(JSON.parse(readFileSync(join(data, INSTALL_RECORD_FILE), "utf8"))).toEqual({
      from: "0.1.0",
      to: "0.2.0",
    });
    // The installer started: electron-updater quits on the next turn.
    updater.quitAndInstall.mockImplementationOnce(
      () => void setImmediate(() => squirrel.emit("before-quit-for-update")),
    );
    expect(await updates.install()).toBe(true);
    // No installer to run: electron-updater emits an error and stays open, and so must the app.
    updater.quitAndInstall.mockImplementationOnce(
      () =>
        void updater.emit(
          "error",
          new Error("No update filepath provided, can't quit and install"),
        ),
    );
    expect(await updates.install()).toBe(false);
    expect(updates.current).toMatchObject({
      status: "ready",
      failed: "install",
      message: "No update filepath provided, can't quit and install",
    });
    expect(existsSync(join(data, INSTALL_RECORD_FILE))).toBe(false);
  });

  it("says when the last install did not take, and forgets one that did", () => {
    onPlatform("darwin");
    withFeed(MAC);
    const data = mkdtempSync(join(tmpdir(), "caveman-updates-data-"));
    writeFileSync(join(data, INSTALL_RECORD_FILE), JSON.stringify({ from: "0.1.0", to: "0.2.0" }));
    const { updates, lines } = fresh(data);
    updates.start(false);
    expect(updates.current.notApplied).toBe("0.2.0");
    expect(lines).toContain("updates: the install of 0.2.0 did not take; this is still 0.1.0");
    version = "0.2.0";
    const after = fresh(data);
    after.updates.start(false);
    expect(after.updates.current.notApplied).toBeNull();
    expect(existsSync(join(data, INSTALL_RECORD_FILE))).toBe(false);
  });

  it("is off, and says why, in a build without a feed", async () => {
    Object.defineProperty(process, "resourcesPath", {
      value: mkdtempSync(join(tmpdir(), "caveman-updates-")),
      configurable: true,
    });
    const { updates } = fresh();
    updates.start(false);
    expect(updates.current).toMatchObject({
      status: "disabled",
      message: "This build was made on this computer and has no update feed.",
    });
    expect((await updates.check()).status).toBe("disabled");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    // The channel is still kept for when it is on.
    expect((await updates.setChannel("nightly")).channel).toBe("nightly");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
