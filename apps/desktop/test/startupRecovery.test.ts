import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const windows: Array<
    InstanceType<typeof EventEmitter> & {
      loaded: string[];
      visible: boolean;
      hide(): void;
      isDestroyed(): boolean;
      webContents: InstanceType<typeof EventEmitter> & { setWindowOpenHandler: () => void };
    }
  > = [];
  class BrowserWindow extends EventEmitter {
    loaded: string[] = [];
    destroyed = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => undefined });
    constructor() {
      super();
      windows.push(this as never);
    }
    loadURL(url: string) {
      this.loaded.push(url);
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    close() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    windows,
    BrowserWindow,
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => "") },
  };
});
vi.mock("electron", () => ({
  BrowserWindow: fake.BrowserWindow,
  clipboard: fake.clipboard,
  shell: fake.shell,
  nativeTheme: { shouldUseDarkColors: true },
}));
const {
  downloadUrl,
  failureReport,
  recoveryHtml,
  recoveryOffer,
  StartupRecovery,
  LAST_STARTED_FILE,
} = await import("../src/startupRecovery.ts");
const { initialUpdateState, onCheckStart, onDownloaded, onNoUpdate, onUpdateAvailable } =
  await import("../src/updates/updateMachine.ts");

const AT = "2026-11-09T12:00:00.000Z";
const current = onNoUpdate(initialUpdateState("0.4.2", "stable", null), AT);
const keeps = { kind: "keeps-stopping" as const, detail: "PlatformError: BadResource" };
const refused = {
  kind: "refused-data" as const,
  detail:
    "This database was last used by Caveman Code 0.4.3-nightly.20261109.12 (migration 74); this runtime is 0.4.2 (migration 72).",
};

describe("the startup recovery offer", () => {
  it("prefers a newer build, then a newer one that started here, then the newest download", () => {
    const ready = onDownloaded(onUpdateAvailable(current, "0.4.3", AT), "0.4.3");
    expect(recoveryOffer(keeps, ready, "0.4.1")).toEqual({ kind: "update", version: "0.4.3" });
    expect(
      recoveryOffer(keeps, { ...onUpdateAvailable(current, "0.4.3", AT), percent: 40 }, null),
    ).toEqual({ kind: "downloading", version: "0.4.3", percent: 40 });
    expect(recoveryOffer(keeps, onCheckStart(current, AT), "0.4.1")).toEqual({ kind: "checking" });
    // Never back to an older build: the runtime that keeps stopping has usually migrated the data already.
    expect(recoveryOffer(keeps, current, "0.4.1")).toEqual({ kind: "download" });
    expect(recoveryOffer(keeps, current, "0.4.3")).toEqual({ kind: "reinstall", version: "0.4.3" });
    expect(recoveryOffer(keeps, current, "0.4.2")).toEqual({ kind: "download" });
    expect(recoveryOffer(keeps, current, null)).toEqual({ kind: "download" });
  });

  it("never offers going back when the data is newer, and never an install that already failed to take", () => {
    expect(recoveryOffer(refused, current, "0.4.1")).toEqual({ kind: "download" });
    const ready = {
      ...onDownloaded(onUpdateAvailable(current, "0.4.3", AT), "0.4.3"),
      notApplied: "0.4.3",
    };
    expect(recoveryOffer(refused, ready, null)).toEqual({ kind: "download" });
  });

  it("links the channel's newest installer, or one version's", () => {
    expect(downloadUrl("stable", "darwin", "arm64")).toBe(
      "https://download.caveman.so/code/mac/Caveman-Code-arm64.dmg",
    );
    expect(downloadUrl("nightly", "darwin", "x64")).toBe(
      "https://download.caveman.so/code/nightly/mac/Caveman-Code-x64.dmg",
    );
    expect(downloadUrl("stable", "darwin", "arm64", "0.4.1")).toBe(
      "https://download.caveman.so/code/mac/Caveman-Code-0.4.1-arm64.dmg",
    );
    expect(downloadUrl("stable", "win32", "x64", "0.4.1")).toBe(
      "https://download.caveman.so/code/win/Caveman-Code-Setup-0.4.1-x64.exe",
    );
  });

  it("shows what the runtime said, escaped, says nothing was deleted, and offers no Try again for newer data", () => {
    const html = recoveryHtml({
      appVersion: "0.4.2",
      failure: { ...refused, detail: `${refused.detail} <script>x</script>` },
      offer: { kind: "download" },
      logDir: "/tmp/logs",
    });
    expect(html).toContain("migration 74); this runtime is 0.4.2 (migration 72).");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("Nothing was changed or deleted");
    expect(html).not.toContain("/retry");
    expect(html).toContain("default-src 'none'");
    const keepsHtml = recoveryHtml({
      appVersion: "0.4.2",
      failure: keeps,
      offer: { kind: "reinstall", version: "0.4.3" },
      logDir: "/tmp/logs",
    });
    expect(keepsHtml).toContain("https://startup-recovery.invalid/retry");
    expect(keepsHtml).toContain("Download 0.4.3");
    for (const page of [html, keepsHtml])
      expect(page).toContain("https://startup-recovery.invalid/report");
  });

  it("reports either failure as the runtime's, named for what happened", () => {
    expect(failureReport(keeps)).toEqual({
      surface: "runtime",
      error: {
        name: "RuntimeKeepsStopping",
        message: "The runtime kept stopping while starting: PlatformError: BadResource",
      },
    });
    expect(failureReport({ kind: "keeps-stopping", detail: undefined }).error.message).toBe(
      "The runtime kept stopping while starting.",
    );
    expect(failureReport(refused)).toEqual({
      surface: "runtime",
      error: {
        name: "DatabaseNewerThanRuntime",
        message: `The runtime refused data a newer build wrote: ${refused.detail}`,
      },
    });
  });
});

describe("the startup recovery window", () => {
  const make = (lastStarted?: string) => {
    const dataDir = mkdtempSync(join(tmpdir(), "caveman-recovery-"));
    if (lastStarted) writeFileSync(join(dataDir, LAST_STARTED_FILE), `${lastStarted}\n`);
    let state = current;
    const listeners: Array<(s: typeof state) => void> = [];
    const updates = {
      get current() {
        return state;
      },
      onChange: (listener: (s: typeof state) => void) => (
        listeners.push(listener),
        () => undefined
      ),
      check: vi.fn(async () => state),
    };
    const actions = { install: vi.fn(), retry: vi.fn(), report: vi.fn(), quit: vi.fn() };
    const recovery = new StartupRecovery({
      appVersion: "0.4.2",
      dataDir,
      logDir: "/tmp/logs",
      platform: "darwin",
      arch: "arm64",
      updates,
      log: () => undefined,
      ...actions,
    });
    const setState = (next: typeof state) => {
      state = next;
      for (const listener of listeners) listener(next);
    };
    return { recovery, dataDir, updates, actions, setState };
  };
  const click = (action: string) => {
    const win = fake.windows.at(-1)!;
    const event = { preventDefault: vi.fn() };
    win.webContents.emit("will-navigate", event, `https://startup-recovery.invalid/${action}`);
    expect(event.preventDefault).toHaveBeenCalled();
  };
  const page = () =>
    decodeURIComponent(
      fake.windows
        .at(-1)!
        .loaded.at(-1)!
        .replace(/^data:text\/html;charset=utf-8,/, ""),
    );

  it("opens on a refusal, checks for a newer build, and follows the updater until it can offer it", () => {
    const { recovery, updates, actions, setState } = make("0.4.1");
    recovery.show(refused);
    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(page()).toContain("Download the newest");
    setState(onDownloaded(onUpdateAvailable(current, "0.4.3", AT), "0.4.3"));
    expect(page()).toContain("Restart to 0.4.3");
    click("update");
    expect(actions.install).toHaveBeenCalledTimes(1);
    click("copy");
    expect(fake.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("migration 74"));
    click("quit");
    expect(actions.quit).toHaveBeenCalledTimes(1);
  });

  it("from a nightly build links Nightly's newest, even on Stable, whose newest is older", () => {
    const { recovery, setState } = make();
    setState(onNoUpdate(initialUpdateState("0.4.3-nightly.20261109.12", "stable", null), AT));
    recovery.show(keeps);
    click("download");
    expect(fake.shell.openExternal).toHaveBeenLastCalledWith(
      "https://download.caveman.so/code/nightly/mac/Caveman-Code-arm64.dmg",
    );
  });

  it("offers a newer build that started here before, tries again, and remembers the version once it starts", () => {
    const { recovery, actions, dataDir } = make("0.4.3");
    recovery.show(keeps);
    click("download");
    expect(fake.shell.openExternal).toHaveBeenLastCalledWith(
      "https://download.caveman.so/code/mac/Caveman-Code-0.4.3-arm64.dmg",
    );
    click("logs");
    expect(fake.shell.openPath).toHaveBeenCalledWith("/tmp/logs");
    click("retry");
    expect(actions.retry).toHaveBeenCalledTimes(1);
    expect(fake.windows.at(-1)!.isDestroyed()).toBe(true);
    recovery.started();
    expect(readFileSync(join(dataDir, LAST_STARTED_FILE), "utf8").trim()).toBe("0.4.2");
    expect(recovery.showing).toBeUndefined();
  });

  it("steps aside for a problem report and comes back when it closes, unless the runtime started meanwhile", () => {
    const { recovery, actions } = make();
    recovery.show(keeps);
    const win = fake.windows.at(-1)!;
    win.emit("ready-to-show");
    click("report");
    expect(actions.report).toHaveBeenCalledWith(failureReport(keeps));
    const duringReport = win.visible;
    recovery.reportClosed();
    const afterReport = win.visible;
    // A report closed that this window did not open changes nothing.
    win.hide();
    recovery.reportClosed();
    expect({ duringReport, afterReport, unasked: win.visible }).toEqual({
      duringReport: false,
      afterReport: true,
      unasked: false,
    });
    click("report");
    recovery.started();
    recovery.reportClosed();
    expect({
      showing: recovery.showing,
      closed: win.isDestroyed(),
      windows: fake.windows.at(-1) === win,
    }).toEqual({ showing: undefined, closed: true, windows: true });
  });

  it("looks for a newer build once the updater is up when the runtime refused before it started", () => {
    const { recovery, updates, setState } = make();
    setState(initialUpdateState("0.4.2", "stable", "Updates start once the app has opened."));
    recovery.show(refused);
    expect(updates.check).not.toHaveBeenCalled();
    setState(initialUpdateState("0.4.2", "stable", null));
    expect(updates.check).toHaveBeenCalledTimes(1);
    setState(onCheckStart(current, AT));
    setState(current);
    expect(updates.check).toHaveBeenCalledTimes(1);
  });

  it("ignores anything but its own action links", () => {
    const { recovery, actions } = make();
    recovery.show(keeps);
    const event = { preventDefault: vi.fn() };
    fake.windows
      .at(-1)!
      .webContents.emit("will-navigate", event, "https://startup-recovery.invalid/quit/../update");
    fake.windows.at(-1)!.webContents.emit("will-navigate", event, "https://evil.example/quit");
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(actions.quit).not.toHaveBeenCalled();
    expect(actions.install).not.toHaveBeenCalled();
  });
});
