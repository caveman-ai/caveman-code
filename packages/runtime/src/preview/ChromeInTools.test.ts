// Chrome on a Cloud computer runs in the tools container as the agent's uid (Caveman Cloud DESIGN E10):
// the server browser, with its profiles under the tools home, and html_preview's headless Chrome, both
// speaking CDP over their pipe carried on the exec channel's stdin and stdout, with no DevTools port.
// Needs CAVEMAN_TEST_DESKTOP_TOOLS=<host:port>: a tools exec channel, in a container that has the image's
// Chrome at /usr/local/bin/chrome (a kind pod's hostPort will do: a port-forward cannot reach gVisor's network).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";

import { spawnerLayer, toolsRun } from "../cloudLink/tools.ts";
import { captureHtmlScreenshot } from "../htmlRender/headlessChrome.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const socket = process.env.CAVEMAN_TEST_DESKTOP_TOOLS;
const screens = process.env.CAVEMAN_TEST_DESKTOP_SCREENS;
const CHROME = "/usr/local/bin/chrome";
if (!socket) console.warn("BLOCKED: no tools container; set CAVEMAN_TEST_DESKTOP_TOOLS=<host:port> to one with Chrome at /usr/local/bin/chrome");

const chromes = async () => (await toolsRun(socket!, "/", ["sh", "-c", "ps -o user,args | grep '[c]hrome --' || true"])).stdout;
/** What listens on TCP in the tools container's network namespace (the pod's), by process. */
const listening = async () => (await toolsRun(socket!, "/", ["sh", "-c", "netstat -ltnp 2>/dev/null"])).stdout;

test.skipIf(!socket)("the server browser runs in tools as the agent, sandboxed, with its profile in the tools home", { timeout: 180_000 }, async () => {
  const contexts = new ServerBrowserContexts({ profilesDir: "/nowhere/on/the/runtime", executable: async () => CHROME, env: {}, tools: socket!, downloadMaxBytes: 1024 * 1024 * 1024 });
  try {
    const context = await contexts.contextFor("default");
    const page = await context.newPage();
    await page.goto("data:text/html,<title>In tools</title><h1 style='font:48px sans-serif'>Chrome in the tools container</h1>");
    expect(await page.title()).toBe("In tools");
    // Server tabs set their own viewport (ServerBrowser), so the window only has to hold one.
    await page.setViewportSize({ width: 1280, height: 800 });
    if (screens) {
      fs.mkdirSync(screens, { recursive: true });
      await page.screenshot({ path: path.join(screens, "chrome-in-tools.png") });
    }
    // The tools uid runs it, with its sandbox on.
    const running = await chromes();
    expect(running).toMatch(/^\s*tools\s+.*chrome .*--headless/m);
    expect(running).not.toMatch(/^\s*caveman\s/m);
    expect(running).not.toContain("--no-sandbox");
    // CDP rides the exec channel: a pipe, no DevTools port for anything else in the pod, no password store.
    expect(running).toContain("--remote-debugging-pipe");
    expect(running).not.toContain("--remote-debugging-port");
    expect(running).not.toContain("--password-store");
    expect(await listening()).not.toMatch(/chrome/i);
    // It saves no passwords.
    const prefs = await toolsRun(socket!, "/", ["sh", "-c", 'cat "$HOME/.config/caveman-browser/profiles/default/Default/Preferences"']);
    expect(JSON.parse(prefs.stdout)).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false } });
    await page.goto("chrome://sandbox");
    expect(await page.textContent("body")).toMatch(/adequately sandboxed/i);
    // Its profile is on the tools home, so logins survive sleep.
    const profile = await toolsRun(socket!, "/", ["sh", "-c", 'test -d "$HOME/.config/caveman-browser/profiles/default" && echo yes']);
    expect(profile.stdout.trim()).toBe("yes");

    // An agent's isolated context shares a second, throwaway browser.
    const isolated = await contexts.contextFor("default", "agent-1");
    const agentPage = await isolated.newPage();
    await agentPage.goto("data:text/html,<title>Isolated</title>");
    expect(await agentPage.title()).toBe("Isolated");
    expect(await isolated.cookies()).toEqual([]);

    await contexts.clearProfile("default");
    const cleared = await toolsRun(socket!, "/", ["sh", "-c", 'test -d "$HOME/.config/caveman-browser/profiles/default" || echo gone']);
    expect(cleared.stdout.trim()).toBe("gone");
  } finally {
    await contexts.close();
  }
  // Closing the browser ends its Chrome processes in tools.
  const deadline = Date.now() + 10_000;
  while ((await chromes()).trim() !== "" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await chromes()).trim()).toBe("");
});

/** Whether `file` exists in the tools container. */
const inTools = async (file: string) => (await toolsRun(socket!, "/", ["test", "-e", file])).code === 0;

test.skipIf(!socket)("a download in the browser in tools reaches the runtime, from an agent's tab and a person's", { timeout: 180_000 }, async () => {
  const contexts = new ServerBrowserContexts({ profilesDir: "/nowhere/on/the/runtime", executable: async () => CHROME, env: {}, tools: socket!, downloadMaxBytes: 1024 * 1024 * 1024 });
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-in-tools-downloads-"));
  const written: Array<string> = [];
  try {
    for (const [who, context] of [
      ["agent", await contexts.contextFor("default", "agent-1")],
      ["person", await contexts.contextFor("default")],
    ] as const) {
      const page = await context.newPage();
      const body = Buffer.from(`from the ${who}'s tab`).toString("base64");
      await page.setContent(`<a id="file" href="data:text/plain;base64,${body}" download="report.txt">report</a>`);
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#file")]);
      // What ServerBrowser.saveDownload does with it.
      expect(await download.failure()).toBeNull();
      const target = path.join(saved, who);
      await contexts.saveDownload(download, target);
      expect(fs.readFileSync(target, "utf8")).toBe(`from the ${who}'s tab`);
      // Chrome wrote it in tools; once saved, its copy there goes.
      const file = await download.path();
      written.push(file);
      expect(await inTools(file)).toBe(true);
      await contexts.deleteDownload(download);
      expect(await inTools(file)).toBe(false);
    }
  } finally {
    await contexts.close();
    fs.rmSync(saved, { recursive: true, force: true });
  }
  // What a runtime stopped mid-download left in tools goes when the next one's browser starts.
  const downloads = path.posix.dirname(written[0]!);
  expect(written.every((file) => path.posix.dirname(file) === downloads)).toBe(true);
  expect((await toolsRun(socket!, "/", ["sh", "-c", 'mkdir -p -- "$1" && : > "$1/left"', "sh", downloads])).code).toBe(0);
  const next = new ServerBrowserContexts({ profilesDir: "/nowhere/on/the/runtime", executable: async () => CHROME, env: {}, tools: socket!, downloadMaxBytes: 1024 * 1024 * 1024 });
  try {
    await next.contextFor("default", "agent-1");
    expect(await inTools(`${downloads}/left`)).toBe(false);
    expect(await inTools(downloads)).toBe(true);
  } finally {
    await next.close();
  }
});

test.skipIf(!socket)("an agent uploads a file from the tools container to a page in the browser there", { timeout: 180_000 }, async () => {
  // Where an agent on a Cloud computer writes a file: tools' own /tmp, which the runtime does not share.
  const made = await toolsRun(socket!, "/", ["sh", "-c", 'd=$(mktemp -d) && printf "agent report" > "$d/report.txt" && echo "$d"']);
  expect(made.code).toBe(0);
  const dir = made.stdout.trim();
  const contexts = new ServerBrowserContexts({ profilesDir: "/nowhere/on/the/runtime", executable: async () => CHROME, env: {}, tools: socket!, downloadMaxBytes: 1024 * 1024 * 1024 });
  try {
    const page = await (await contexts.contextFor("default", "agent-2")).newPage();
    await page.setContent('<input id="upload" type="file">');
    // What ServerBrowser.uploadFiles does with preview_act upload's paths.
    await page.locator("#upload").setInputFiles(await contexts.inputFiles([`${dir}/report.txt`]));
    // Page-side code as source: the runtime compiles without DOM types.
    const file = await page.evaluate(
      `(async () => { const [chosen] = document.querySelector("#upload").files; return { name: chosen.name, type: chosen.type, text: await chosen.text() }; })()`,
    );
    expect(file).toEqual({ name: "report.txt", type: "text/plain", text: "agent report" });
    // A path that is not a file there fails, naming it.
    await expect(contexts.inputFiles([`${dir}/missing.txt`])).rejects.toThrow(`${dir}/missing.txt`);
  } finally {
    await contexts.close();
    await toolsRun(socket!, "/", ["rm", "-rf", "--", dir]);
  }
});

test.skipIf(!socket)("an agent uploads a big file and a folder at a path the runtime has too, as Chrome in tools reads them", { timeout: 180_000 }, async () => {
  // A path both containers have, as the workspace on a pod. Here each side has its own files there, so what the page
  // gets shows who read them: Chrome in tools, never the runtime.
  const dir = `/tmp/chrome-in-tools-upload-${process.pid}`;
  fs.mkdirSync(`${dir}/site`, { recursive: true });
  fs.writeFileSync(`${dir}/video.bin`, "the runtime's copy");
  fs.writeFileSync(`${dir}/site/runtime.txt`, "the runtime's copy");
  const made = await toolsRun(socket!, "/", ["sh", "-c", 'mkdir -p -- "$1/site" && head -c 62914560 /dev/zero > "$1/video.bin" && printf a > "$1/site/a.txt" && printf b > "$1/site/b.txt"', "sh", dir]);
  expect(made.code).toBe(0);
  const contexts = new ServerBrowserContexts({ profilesDir: "/nowhere/on/the/runtime", executable: async () => CHROME, env: {}, tools: socket!, downloadMaxBytes: 1024 * 1024 * 1024 });
  try {
    const page = await (await contexts.contextFor("default", "agent-3")).newPage();
    await page.setContent('<input id="file" type="file"><input id="folder" type="file" webkitdirectory>');
    // 60 MB: more than the exec channel would carry.
    await page.locator("#file").setInputFiles(await contexts.inputFiles([`${dir}/video.bin`]));
    expect(await page.evaluate(`(() => { const [chosen] = document.querySelector("#file").files; return { name: chosen.name, size: chosen.size }; })()`)).toEqual({ name: "video.bin", size: 62914560 });
    await page.locator("#folder").setInputFiles(await contexts.inputFiles([`${dir}/site`]));
    const files = await page.evaluate(`Promise.all([...document.querySelector("#folder").files].map(async (file) => [file.webkitRelativePath, await file.text()]))`);
    expect(new Map(files as Array<[string, string]>)).toEqual(new Map([["site/a.txt", "a"], ["site/b.txt", "b"]]));
  } finally {
    await contexts.close();
    await toolsRun(socket!, "/", ["rm", "-rf", "--", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!socket)("html_preview's headless Chrome renders in tools over its pipe", { timeout: 120_000 }, async () => {
  const before = process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket!;
  try {
    const shot = await Effect.runPromise(
      captureHtmlScreenshot({
        executable: CHROME,
        noSandbox: false,
        html: "<!doctype html><body style='margin:0;background:#123'><h1 style='color:#fff;font:40px sans-serif'>rendered in tools</h1>",
        width: 480,
        urlFragment: "",
        appearance: "dark",
      }).pipe(Effect.provide(Layer.provideMerge(spawnerLayer(socket!), NodeServices.layer))),
    );
    const png = Buffer.from(shot.png, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(480);
    if (screens) fs.writeFileSync(path.join(screens, "html-preview-in-tools.png"), png);
  } finally {
    if (before === undefined) delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
    else process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = before;
  }
  // Its profile directory went with it.
  expect((await toolsRun(socket!, "/", ["sh", "-c", "ls -d /tmp/t3-html-preview-* 2>/dev/null || true"])).stdout.trim()).toBe("");
});
