// ), apps/server/src/preview/ServerBrowserContexts.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@caveman-app/protocol";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession, Download } from "playwright-core";

import { runBytes, toolsCommand, toolsRun, toolsToFile } from "../cloudLink/tools.ts";
import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** The shared headless browser's executable, installing it on first use. */
  readonly executable: () => Promise<string>;
  /** Replaces a failed launch's error with the host setup it is missing, if any. */
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  /**
   * The most a download may write while it arrives, and all downloads arriving at once together. Chromium writes
   * them to the temp volume until they end.
   */
  readonly downloadMaxBytes: number;
  /**
   * A Cloud computer's tools exec channel. Chrome then runs in the tools container as the agent's
   * uid, never beside the runtime's Cloud key, with its profiles under the tools home. Playwright
   * launches it as it would here, over its DevTools pipe, which the exec channel carries as stdin
   * and stdout: no DevTools port, so nothing else in the pod can reach it.
   */
  readonly tools?: string | undefined;
}

/** A file's contents for Playwright to hand a page. */
export interface InputFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/** Under the tools home: the shared browser's throwaway profile, and people's profiles (kept on the volume). */
const TOOLS_SHARED_PROFILE = ".cache/caveman-browser/shared";
const TOOLS_PROFILES = ".config/caveman-browser/profiles";
/**
 * Chrome in tools, as the wrapper below starts it: `$1` its profile under the tools home, `$2` non-empty to empty
 * it first, `$3` the executable, then Playwright's arguments with its own --user-data-dir (a directory here) left
 * out. Saving passwords is off in the profile. The pipe's fds 3 and 4 are the channel's stdin and stdout there.
 */
const TOOLS_CHROME = [
  'd="$HOME/$1"; fresh=$2; chrome=$3; shift 3',
  'for a; do shift; case $a in --user-data-dir=*) ;; *) set -- "$@" "$a" ;; esac; done',
  '[ -z "$fresh" ] || rm -rf -- "$d"',
  // One Chrome per profile at a time (contextFor caches it), so a lock left in the profile is stale.
  'mkdir -p -- "$d/Default" && rm -f -- "$d/SingletonLock" "$d/SingletonSocket" "$d/SingletonCookie" || exit 1',
  'n=/usr/bin/node; [ -x "$n" ] || n=node',
  `"$n" -e '${[
    'const fs = require("fs"), file = process.argv[1]; let prefs = {}',
    'try { prefs = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}',
    "prefs.credentials_enable_service = false; prefs.credentials_enable_autosignin = false",
    "prefs.profile = { ...prefs.profile, password_manager_enabled: false }",
    "fs.writeFileSync(file, JSON.stringify(prefs))",
  ].join("; ")}' "$d/Default/Preferences" || exit 1`,
  'exec "$chrome" "$@" --user-data-dir="$d" 3<&0 4>&1 >/dev/null',
].join("\n");

/**
 * Chrome's downloads directory in tools, whose temp directory is not the runtime's. Setting up empties what an earlier
 * runtime left there (one runs per computer), so closing need not reach tools, which may be gone while the pod stops.
 */
const TOOLS_DOWNLOADS = 'd="${TMPDIR:-/tmp}/caveman-browser-downloads"; rm -rf -- "$d" && mkdir -m 700 -- "$d" && printf %s "$d"';

/** What each path is in tools, a line each: `f` a file, `d` a folder, `-` neither or nothing. */
const TOOLS_KINDS = 'for p; do if [ -d "$p" ]; then echo d; elif [ -f "$p" ]; then echo f; else echo -; fi; done';

/** The most Playwright hands a page as files' contents rather than their paths: 50 MB in all. */
const INPUT_FILES_MAX_BYTES = 50 * 1024 * 1024;

/** One shell word. */
const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/**
 * The headless shell's identity as the Chrome it is built from: its user agent
 * without `HeadlessChrome`, and client hints whose brands agree with it. Sites
 * block a user agent that disagrees with `Sec-CH-UA`, so both change together.
 */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  // Chrome's GREASE brand and order for this major version, as the shell reports them.
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    // Chrome reduces its user agent to the major version.
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

/**
 * Presents a headless page as plain Chrome. Applies to the page, its frames,
 * and its workers; a popup gets its own call once it becomes a tab.
 */
export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

/** Persistent human profiles keep their storage; isolated agents share a browser, never a context. */
export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profile clears in progress; a context for that profile opens after its storage is gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  /** Each browser's watch on its downloads, ready before any of its pages opens. */
  private readonly downloadWatches = new WeakMap<Browser, Promise<void>>();
  /** What each download still arriving has written so far, by Chromium's guid, across every browser here. */
  private readonly arriving = new Map<string, number>();
  /**
   * On a Cloud computer: the script here Playwright starts as Chrome, an empty directory to name as its profile, and
   * Chrome's downloads directory in tools.
   */
  private toolsChrome: Promise<{ readonly file: string; readonly profile: string; readonly downloads: string }> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      // People drive these tabs, so they must not announce automation (navigator.webdriver).
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      // Playwright turns Chrome's popup blocker off; a page could then open tabs in a loop without a click.
      ignoreDefaultArgs: ["--enable-automation", "--disable-popup-blocking"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  /**
   * Launch options for the image's Chrome in the tools container, with its profile `dir` under the tools home
   * (`fresh`: emptied first). Playwright starts a script here as the executable: it runs the exec channel's
   * client with the DevTools pipe as its stdin and stdout. It ends with the browser, as Chrome would here.
   */
  private async inTools<O extends { readonly executablePath: string; readonly env: NodeJS.ProcessEnv; readonly args: ReadonlyArray<string>; readonly ignoreDefaultArgs: ReadonlyArray<string> }>(tools: string, options: O, dir: string, fresh: boolean) {
    if (!this.toolsChrome) {
      const setup = (async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "caveman-tools-chrome-"));
        try {
          const file = NodePath.join(home, "chrome");
          const routed = toolsCommand(tools, "sh", ["-c", TOOLS_CHROME, "sh"], "/", {}, {});
          const env = Object.entries(routed.env).map(([name, value]) => `export ${name}=${word(value)}\n`).join("");
          const command = [routed.command, ...routed.args].map(word).join(" ");
          await NodeFSP.writeFile(file, `#!/bin/sh\n${env}exec ${command} "$CAVEMAN_TOOLS_PROFILE" "$CAVEMAN_TOOLS_FRESH" "$CAVEMAN_TOOLS_CHROME" "$@" <&3 >&4 3<&- 4>&-\n`, { mode: 0o700 });
          await NodeFSP.mkdir(NodePath.join(home, "profile"), { mode: 0o700 });
          const made = await toolsRun(tools, "/", ["sh", "-c", TOOLS_DOWNLOADS]);
          const downloads = made.stdout;
          if (made.code !== 0 || !downloads.startsWith("/")) throw new Error(`no downloads directory in the tools container: ${made.stderr.trim().slice(0, 300)}`);
          return { file, profile: NodePath.join(home, "profile"), downloads };
        } catch (cause) {
          await NodeFSP.rm(home, { recursive: true, force: true }).catch(constVoid);
          throw cause;
        }
      })();
      this.toolsChrome = setup;
      // A later launch sets it up again, as sharedBrowser launches again.
      void setup.catch(() => {
        if (this.toolsChrome === setup) this.toolsChrome = undefined;
      });
    }
    const wrapper = await this.toolsChrome;
    return {
      profile: wrapper.profile,
      options: {
        ...options,
        executablePath: wrapper.file,
        downloadsPath: wrapper.downloads,
        env: { ...options.env, CAVEMAN_TOOLS_PROFILE: dir, CAVEMAN_TOOLS_FRESH: fresh ? "1" : "", CAVEMAN_TOOLS_CHROME: options.executablePath },
        // The agent can read this profile: it saves no passwords, so no store for them.
        ignoreDefaultArgs: [...options.ignoreDefaultArgs, "--password-store=basic"],
        // A window the tabs' 1280x800 fits, so setting their viewport resizes nothing (a capture right after a resize fails).
        args: [...options.args, "--window-size=1280,800"],
      },
    };
  }

  private sharedBrowser() {
    if (!this.browser) {
      const tools = this.options.tools;
      const launched = this.launchOptions().then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, async () => chromium.launch(tools ? (await this.inTools(tools, options, TOOLS_SHARED_PROFILE, true)).options : options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        await this.watchDownloads(browser).catch(async (cause: unknown) => {
          await browser.close().catch(constVoid);
          throw cause;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        const browser = context.browser();
        if (!browser) throw new Error("The preview browser's context has no browser.");
        await this.watchDownloads(browser).catch(async (cause: unknown) => {
          await context.close().catch(constVoid);
          throw cause;
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const tools = this.options.tools;
    const options = await this.launchOptions();
    const { chromium } = loadPlaywright();
    if (tools) {
      // Its storage is in tools; Playwright gets an empty directory here to name.
      const { profile, options: launched } = await this.inTools(tools, options, this.toolsProfile(profileId), false);
      return this.launch(options, () => chromium.launchPersistentContext(profile, { ...launched, ...contextOptions }));
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  /**
   * Stops a download while it arrives once Chromium reports it past the limit (its length, or what it wrote), or once
   * it takes everything arriving at once past it. A page's frames download through the browser too, those in a
   * process of their own included, so only the browser's own session hears them all. Chromium reports each download
   * about twice a second.
   */
  private watchDownloads(browser: Browser) {
    const watching = this.downloadWatches.get(browser);
    if (watching) return watching;
    const watch = (async () => {
      const limit = this.options.downloadMaxBytes;
      const session = await browser.newBrowserCDPSession();
      // Download events go only to a session that set a context's download behavior. Setting it on a context of
      // its own leaves the tabs' contexts as Playwright set them.
      const { browserContextId } = await session.send("Target.createBrowserContext", { disposeOnDetach: true });
      await session.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId, eventsEnabled: true });
      const seen = new Set<string>();
      const stopped = new Set<string>();
      const cancel = async (guid: string) => {
        // Chromium looks a download up in its own context, which its events do not name.
        const { browserContextIds } = await session.send("Target.getBrowserContexts");
        await Promise.allSettled(
          [undefined, ...browserContextIds].map((id) =>
            session.send("Browser.cancelDownload", id === undefined ? { guid } : { guid, browserContextId: id }),
          ),
        );
      };
      session.on("Browser.downloadProgress", ({ guid, receivedBytes, totalBytes, state }) => {
        if (state !== "inProgress") {
          this.arriving.delete(guid);
          seen.delete(guid);
          stopped.delete(guid);
          return;
        }
        if (stopped.has(guid)) return;
        seen.add(guid);
        this.arriving.set(guid, receivedBytes);
        let together = 0;
        for (const bytes of this.arriving.values()) together += bytes;
        if (Math.max(receivedBytes, totalBytes) <= limit && together <= limit) return;
        stopped.add(guid);
        this.arriving.delete(guid);
        void cancel(guid).catch(constVoid);
      });
      // A browser that ended reports nothing more about its downloads.
      browser.on("disconnected", () => {
        for (const guid of seen) this.arriving.delete(guid);
      });
    })();
    this.downloadWatches.set(browser, watch);
    void watch.catch(() => {
      if (this.downloadWatches.get(browser) === watch) this.downloadWatches.delete(browser);
    });
    return watch;
  }

  private profileName(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded;
  }

  private profileDirectory(profileId: string) {
    return NodePath.join(this.options.profilesDir, this.profileName(profileId));
  }

  /** A profile's directory under the tools home. */
  private toolsProfile(profileId: string) {
    return `${TOOLS_PROFILES}/${this.profileName(profileId)}`;
  }

  /** A throwaway page in the shared browser, for work that must not touch a tab's own storage. */
  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  /**
   * Drives a page the desktop app renders, through the CDP endpoint its relay
   * serves. The page keeps the desktop's storage, size, and window.
   */
  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** A finished download's size where Chrome wrote it: in tools on a Cloud computer, which this disk does not hold. */
  async downloadSize(download: Download): Promise<number> {
    const tools = this.options.tools;
    if (!tools) return (await NodeFSP.stat(await download.path())).size;
    const stat = await toolsRun(tools, "/", ["stat", "-c", "%s", "--", await download.path()]);
    const size = Number(stat.stdout.trim());
    if (stat.code !== 0 || !Number.isSafeInteger(size)) throw new Error(`could not size the download in the tools container: ${stat.stderr.trim().slice(0, 300)}`);
    return size;
  }

  /**
   * Copies a finished download to `target` here. On a Cloud computer Chrome wrote it in tools, where Playwright,
   * running here, cannot copy it from, so it crosses the exec channel.
   */
  async saveDownload(download: Download, target: string) {
    const tools = this.options.tools;
    if (!tools) return download.saveAs(target);
    const copied = await toolsToFile(tools, "/", ["cat", "--", await download.path()], target);
    if (copied.code !== 0) throw new Error(`could not copy the download from the tools container: ${copied.stderr.trim().slice(0, 300)}`);
  }

  /** Removes a download's file where Chrome wrote it. */
  async deleteDownload(download: Download) {
    const tools = this.options.tools;
    if (!tools) return download.delete();
    if (await download.failure()) return;
    const removed = await toolsRun(tools, "/", ["rm", "-f", "--", await download.path()]);
    if (removed.code !== 0) throw new Error(`could not remove the download in the tools container: ${removed.stderr.trim().slice(0, 300)}`);
  }

  /**
   * An agent's files to upload, as Playwright hands them to a page. On a Cloud computer the paths are the tools
   * container's, where Chrome opens them itself, but Playwright first checks here that each is a file or a folder.
   * Where this container has the same kind at every path, as in the workspace both mount, the paths go as they are,
   * and Chrome reads tools' files even where this container's differ. Otherwise the files' contents cross the exec
   * channel, as Playwright sends files to a browser on another machine (and as much of them).
   */
  async inputFiles(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string> | ReadonlyArray<InputFile>> {
    const tools = this.options.tools;
    if (!tools || paths.length === 0) return [...paths];
    const listed = await toolsRun(tools, "/", ["sh", "-c", TOOLS_KINDS, "sh", ...paths]);
    if (listed.code !== 0) throw new Error(`could not find the files to upload in the tools container: ${listed.stderr.trim().slice(0, 300)}`);
    const there = listed.stdout.split("\n");
    const missing = paths.find((_, index) => there[index] !== "f" && there[index] !== "d");
    if (missing !== undefined) throw new Error(`No file to upload at ${missing}.`);
    const here = await Promise.all(
      paths.map((path) => NodeFSP.stat(path).then((stats) => (stats.isDirectory() ? "d" : stats.isFile() ? "f" : "-"), () => "-")),
    );
    if (here.every((kind, index) => kind === there[index])) return [...paths];
    const folder = paths.find((_, index) => there[index] === "d");
    if (folder !== undefined) throw new Error(`${folder} is a folder outside the workspace, which a Cloud computer's browser cannot take: upload its files, or a folder in the workspace.`);
    const files: Array<InputFile> = [];
    let room = INPUT_FILES_MAX_BYTES;
    for (const path of paths) {
      const read = await runBytes(tools, "/", ["sh", "-c", '[ -f "$1" ] || exit 66; exec head -c "$2" -- "$1"', "sh", path, String(room)]);
      if (read.code === 66) throw new Error(`No file to upload at ${path}.`);
      if (read.code !== 0) throw new Error(`could not read ${path} in the tools container: ${read.stderr.trim().slice(0, 300)}`);
      if (read.stdout.length >= room) throw new Error("The files to upload come to 50 MB or more, the most a Cloud computer's browser takes from outside the workspace.");
      room -= read.stdout.length;
      // No type: Playwright types it by its name, as it does a path.
      files.push({ name: NodePath.posix.basename(path), mimeType: "", buffer: read.stdout });
    }
    return files;
  }

  /** Closes a human profile's persistent context, ending its tabs, then deletes its storage. */
  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      const tools = this.options.tools;
      if (tools) await toolsRun(tools, "/", ["sh", "-c", 'rm -rf -- "$HOME/$1"', "sh", this.toolsProfile(profileId)]);
      else await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
    const wrapper = await this.toolsChrome?.catch(() => undefined);
    if (wrapper) await NodeFSP.rm(NodePath.dirname(wrapper.file), { recursive: true, force: true });
  }
}
