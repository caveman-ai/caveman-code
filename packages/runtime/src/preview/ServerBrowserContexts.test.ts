// ), apps/server/src/preview/ServerBrowserContexts.test.ts @ ab3a3cd1.
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@caveman-app/protocol";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn<(prefix: string) => Promise<string>>(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  toolsRun: vi.fn<(socket: string, cwd: string, argv: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>>(),
  toolsExec: vi.fn(async (_request: { readonly command: string; readonly args: ReadonlyArray<string>; readonly timeoutMs: number }) => ({ code: 0 })),
  runBytes: vi.fn<(socket: string | undefined, cwd: string, argv: ReadonlyArray<string>) => Promise<{ code: number; stdout: Buffer; stderr: string }>>(),
  stat: vi.fn<(path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>>(),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({
  mkdir: launches.mkdir,
  rm: launches.rm,
  mkdtemp: launches.mkdtemp,
  writeFile: launches.writeFile,
  stat: launches.stat,
}));
// The tools container's exec channel: setting up answers with Chrome's downloads directory there.
vi.mock("../cloudLink/tools.ts", async (original) => ({
  ...(await original<typeof import("../cloudLink/tools.ts")>()),
  toolsRun: launches.toolsRun,
  toolsExecutionBackend: () => ({ exec: launches.toolsExec }),
  runBytes: launches.runBytes,
}));

/** The browser's own CDP session: it reports each download's progress and cancels one in the context holding it. */
const makeBrowserSession = () => {
  const events = new NodeEvents.EventEmitter();
  /** Contexts Playwright opened, and the one each download arrives in (the default one if unlisted). */
  const contextIds: Array<string> = [];
  const owners = new Map<string, string>();
  const canceled: Array<string> = [];
  return {
    contextIds,
    owners,
    canceled,
    on: vi.fn((event: string, listener: (...args: Array<any>) => void) => events.on(event, listener)),
    progress: (guid: string, receivedBytes: number, totalBytes = 0, state = "inProgress") =>
      events.emit("Browser.downloadProgress", { guid, receivedBytes, totalBytes, state }),
    send: vi.fn(async (method: string, params?: { guid?: string; browserContextId?: string }) => {
      if (method === "Target.createBrowserContext") return { browserContextId: "watch" };
      if (method === "Target.getBrowserContexts") return { browserContextIds: ["watch", ...contextIds] };
      if (method === "Browser.cancelDownload") {
        if (owners.get(params!.guid!) !== params!.browserContextId) throw new Error("No download item found");
        canceled.push(params!.guid!);
      }
      return {};
    }),
  };
};

interface FakeBrowser {
  readonly session: ReturnType<typeof makeBrowserSession>;
  readonly close: () => Promise<void>;
}

// A persistent context comes with a browser of its own.
const makeContext = (browser: FakeBrowser = makeBrowser()) => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    browser: () => browser,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

function makeBrowser(): FakeBrowser & {
  readonly contexts: Array<ReturnType<typeof makeContext>>;
  readonly newContext: () => Promise<BrowserContext>;
} {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  const session = makeBrowserSession();
  const browser = {
    contexts,
    session,
    newBrowserCDPSession: vi.fn(async () => session),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext(browser);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
  return browser;
}

const DOWNLOAD_MAX_BYTES = 1024;
const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
  downloadMaxBytes: DOWNLOAD_MAX_BYTES,
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
  launches.mkdtemp.mockReset().mockImplementation(async (prefix) => `${prefix}test`);
  launches.writeFile.mockClear();
  launches.toolsExec.mockClear();
  launches.toolsRun.mockReset().mockImplementation(async (_socket, _cwd, argv) => ({
    code: 0,
    stdout: argv.join(" ").includes("caveman-browser-downloads") ? "/tmp/caveman-browser-downloads" : "",
    stderr: "",
  }));
  // A file read in tools: its path, then " in tools".
  launches.runBytes.mockReset().mockImplementation(async (_socket, _cwd, argv) => ({
    code: 0,
    stdout: Buffer.from(`${argv[4]} in tools`),
    stderr: "",
  }));
  launches.stat.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
});

/** What the runtime container finds at a path. */
const found = (kind: "file" | "folder") => ({ isDirectory: () => kind === "folder", isFile: () => kind === "file" });
/** What tools answers for the kinds of the paths to upload, a line each. */
const inTools = (...kinds: ReadonlyArray<"f" | "d" | "-">) =>
  launches.toolsRun.mockResolvedValueOnce({ code: 0, stdout: kinds.map((kind) => `${kind}\n`).join(""), stderr: "" });

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      NodePath.join("/test/profiles", "work%2Fteam"),
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith(NodePath.join("/test/profiles", "work%2Fteam"), { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith(NodePath.join("/test/profiles", "work%2Fteam"), {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith(NodePath.join("/test/profiles", "never-opened"), {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    // Launching starts by resolving the executable; record whether storage was gone by then.
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it.each([
    ["here", undefined],
    ["on a Cloud computer", "127.0.0.1:7777"],
  ] as const)("keeps Chrome's popup blocker on for agents and people %s", async (_, tools) => {
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({ ...options(), tools });
    await pool.contextFor("default", "agent");
    await pool.contextFor("default");
    // Playwright turns it off by default; a page could then open tabs in a loop without a click.
    for (const launched of [launches.launch.mock.calls[0]?.[0], launches.persistent.mock.calls[0]?.[1]]) {
      expect(launched?.ignoreDefaultArgs).toEqual(expect.arrayContaining(["--disable-popup-blocking"]));
    }
    await pool.close();
  });

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { CAVEMAN_CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("starts Chrome on a Cloud computer once a failed first setup has passed, for agents and people", async () => {
    // The runtime's tmp is full for the first launch only.
    launches.mkdtemp.mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" }),
    );
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    await expect(pool.contextFor("default", "agent-a")).rejects.toThrow("ENOSPC");
    const later = await Promise.allSettled([pool.contextFor("default", "agent-b"), pool.contextFor("default")]);
    expect(later.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(launches.launch).toHaveBeenCalledOnce();
    expect(launches.persistent).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("removes the directory each failed setup on a Cloud computer made, so retries leave none behind", async () => {
    let made = 0;
    launches.mkdtemp.mockImplementation(async (prefix) => `${prefix}${++made}`);
    const home = (attempt: number) => `${NodePath.join(NodeOS.tmpdir(), "caveman-tools-chrome-")}${attempt}`;
    // The first setup cannot write the wrapper; the second gets no downloads directory in tools.
    launches.writeFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC: no space left on device, open"), { code: "ENOSPC" }),
    );
    launches.toolsRun.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "mkdir: No space left on device" });
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    await expect(pool.contextFor("default", "agent-a")).rejects.toThrow("ENOSPC");
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith(home(1), { recursive: true, force: true });
    await expect(pool.contextFor("default", "agent-a")).rejects.toThrow("No space left");
    expect(launches.rm).toHaveBeenLastCalledWith(home(2), { recursive: true, force: true });
    await pool.contextFor("default", "agent-a");
    // The setup that passed keeps its directory while the browser runs.
    expect(launches.rm).toHaveBeenCalledTimes(2);
    await pool.close();
    expect(launches.rm).toHaveBeenLastCalledWith(home(3), { recursive: true, force: true });
  });

  it("has Chrome on a Cloud computer download into an emptied directory in tools, for agents and people", async () => {
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    await pool.contextFor("default", "agent");
    await pool.contextFor("default");
    // Playwright's own downloads directory is in the runtime's temp directory, which Chrome in tools cannot reach.
    expect(launches.launch.mock.calls[0]?.[0]).toMatchObject({ downloadsPath: "/tmp/caveman-browser-downloads" });
    expect(launches.persistent.mock.calls[0]?.[1]).toMatchObject({ downloadsPath: "/tmp/caveman-browser-downloads" });
    // Set up once, emptying what an earlier runtime left there.
    expect(launches.toolsRun).toHaveBeenCalledExactlyOnceWith("127.0.0.1:7777", "/", ["sh", "-c", expect.stringContaining("rm -rf")]);
  });

  it("closes the browser on a Cloud computer without reaching tools, which may be stopping with the pod", async () => {
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    await pool.contextFor("default", "agent");
    launches.toolsRun.mockClear();
    await pool.close();
    expect(launches.toolsRun).not.toHaveBeenCalled();
    expect(launches.toolsExec).not.toHaveBeenCalled();
  });

  it("uploads paths as they are on a Cloud computer where the runtime sees them too, folders and 50 MB on", async () => {
    // The workspace, which both containers mount: Chrome in tools opens the paths itself.
    launches.stat.mockImplementation(async (path) => found(path === "/workspace/site" ? "folder" : "file"));
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    inTools("f", "f");
    expect(await pool.inputFiles(["/workspace/video.mp4", "/workspace/notes.md"])).toEqual(["/workspace/video.mp4", "/workspace/notes.md"]);
    inTools("d");
    expect(await pool.inputFiles(["/workspace/site"])).toEqual(["/workspace/site"]);
    expect(launches.toolsRun).toHaveBeenLastCalledWith("127.0.0.1:7777", "/", ["sh", "-c", expect.any(String), "sh", "/workspace/site"]);
    // Their contents never cross the exec channel, so no 50 MB limit.
    expect(launches.runBytes).not.toHaveBeenCalled();
    // Off a Cloud computer Chrome shares the runtime's disk.
    launches.toolsRun.mockClear();
    expect(await new ServerBrowserContexts(options()).inputFiles(["/tmp/report.txt"])).toEqual(["/tmp/report.txt"]);
    expect(launches.toolsRun).not.toHaveBeenCalled();
  });

  it("hands over the contents of files only tools has on a Cloud computer, up to 50 MB, and no folder", async () => {
    launches.stat.mockImplementation(async (path) => {
      if (path.startsWith("/workspace/")) return found("file");
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const pool = new ServerBrowserContexts({ ...options(), tools: "127.0.0.1:7777" });
    // One file in tools' own /tmp sends them all as contents: Playwright takes paths or contents, not both.
    inTools("f", "f");
    expect(await pool.inputFiles(["/tmp/report.txt", "/workspace/notes.md"])).toEqual([
      { name: "report.txt", mimeType: "", buffer: Buffer.from("/tmp/report.txt in tools") },
      { name: "notes.md", mimeType: "", buffer: Buffer.from("/workspace/notes.md in tools") },
    ]);
    inTools("d");
    await expect(pool.inputFiles(["/tmp/site"])).rejects.toThrow("/tmp/site is a folder outside the workspace");
    // Nothing in tools is nothing to upload, whatever the runtime has at that path.
    inTools("-");
    await expect(pool.inputFiles(["/workspace/gone.txt"])).rejects.toThrow("No file to upload at /workspace/gone.txt.");
    // Each read is bounded by what is left of 50 MB.
    const megabytes = (count: number) => count * 1024 * 1024;
    launches.runBytes.mockClear().mockImplementation(async (_socket, _cwd, argv) => ({
      code: 0,
      stdout: Buffer.alloc(Math.min(Number(argv[5]), megabytes(30))),
      stderr: "",
    }));
    inTools("f", "f");
    await expect(pool.inputFiles(["/tmp/a.bin", "/tmp/b.bin"])).rejects.toThrow("50 MB or more");
    expect(launches.runBytes.mock.calls.map(([, , argv]) => argv[5])).toEqual([String(megabytes(50)), String(megabytes(20))]);
  });

  it("evicts a closed context without closing other agents or relaunching chromium", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const a = await pool.contextFor("default", "agent-a");
    const b = await pool.contextFor("default", "agent-b");
    await a.close();
    expect(onContextClose).toHaveBeenCalledWith(a);
    expect(await pool.contextFor("default", "agent-a")).not.toBe(a);
    expect(await pool.contextFor("default", "agent-b")).toBe(b);
    expect(browser.close).not.toHaveBeenCalled();
    expect(launches.launch).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });

  it("stops a download while it arrives, from any page or frame of any context, once Chromium reports it past the limit", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("default", "agent");
    const session = browser.session;
    // Download events come only to a session that set a context's behavior: its own, so the tabs' stay as they were.
    expect(session.send).toHaveBeenCalledWith("Target.createBrowserContext", { disposeOnDetach: true });
    expect(session.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "deny",
      browserContextId: "watch",
      eventsEnabled: true,
    });
    session.contextIds.push("agent-context");
    session.owners.set("endless", "agent-context");
    session.progress("endless", DOWNLOAD_MAX_BYTES);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session.send).not.toHaveBeenCalledWith("Browser.cancelDownload", expect.anything());
    session.progress("endless", DOWNLOAD_MAX_BYTES + 1);
    await vi.waitFor(() => expect(session.canceled).toEqual(["endless"]));
    // Reports that were already on their way change nothing.
    session.progress("endless", DOWNLOAD_MAX_BYTES + 2);
    session.progress("endless", DOWNLOAD_MAX_BYTES + 2, 0, "canceled");
    // A file whose length is past the limit stops at its first report.
    session.owners.set("huge", "agent-context");
    session.progress("huge", 0, 5 * DOWNLOAD_MAX_BYTES);
    await vi.waitFor(() => expect(session.canceled).toEqual(["endless", "huge"]));

    // A human profile runs in a browser of its own, watched the same way; its downloads are in its default context.
    const human = makeContext();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    await pool.contextFor("work");
    const own = human.browser().session;
    own.progress("profile", DOWNLOAD_MAX_BYTES + 1);
    await vi.waitFor(() => expect(own.canceled).toEqual(["profile"]));
    await pool.close();
  });

  it("stops the download that takes all those arriving at once, in every browser, past the limit", async () => {
    const browser = makeBrowser();
    const human = makeContext();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("default", "agent");
    await pool.contextFor("work");
    const shared = browser.session;
    const own = human.browser().session;
    const half = DOWNLOAD_MAX_BYTES / 2;
    shared.progress("a", half);
    own.progress("b", half);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...shared.canceled, ...own.canceled]).toEqual([]);
    shared.progress("a", half + 1);
    await vi.waitFor(() => expect(shared.canceled).toEqual(["a"]));
    // The one stopped no longer counts; the other goes on to the limit by itself.
    own.progress("b", DOWNLOAD_MAX_BYTES);
    // A finished download no longer counts either, nor does one in a browser that ended.
    own.progress("b", DOWNLOAD_MAX_BYTES, DOWNLOAD_MAX_BYTES, "completed");
    own.progress("d", half);
    await human.browser().close();
    shared.progress("c", DOWNLOAD_MAX_BYTES);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shared.canceled).toEqual(["a"]);
    expect(own.canceled).toEqual([]);
    await pool.close();
  });
});
