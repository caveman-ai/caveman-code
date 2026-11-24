// ServerBrowserContexts on the real headless shell, for what only Chromium shows.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ensureTestBrowser, TEST_BROWSER_HOME } from "../session-protocol/testHarness.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

// The headless shell is about 100 MB: without it (fresh CI, offline) this is BLOCKED, never a hang.
const haveBrowser =
  process.env.CAVEMAN_TEST_BROWSER === "1" || NodeFS.existsSync(TEST_BROWSER_HOME);
if (!haveBrowser) {
  console.warn(
    `BLOCKED: no headless shell in ${TEST_BROWSER_HOME}; set CAVEMAN_TEST_BROWSER=1 to install it there, or CAVEMAN_TEST_BROWSER_HOME to an installed one`,
  );
}

const LIMIT = 8 * 1024 * 1024;
/** Where the test's file stops by itself, so a download nothing stops still ends. */
const FILE_END = 64 * 1024 * 1024;
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "server-browser-contexts-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const serve = async (handle: NodeHttp.RequestListener) => {
  const server = NodeHttp.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
};

describe.skipIf(!haveBrowser)("ServerBrowserContexts on Chromium", () => {
  it.each([
    ["an agent's throwaway context", "default", "agent"],
    ["a person's profile", "work", undefined],
  ] as const)(
    "stops a file with no length that a frame in its own process downloads, in %s, once it passes the limit",
    { timeout: 120_000 },
    async (_, profileId, isolationKey) => {
      const executable = await ensureTestBrowser();
      const transfer = { sent: 0, ended: Promise.withResolvers<"stopped" | "finished">() };
      const frame = await serve((request, response) => {
        if (request.url === "/endless.bin") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="endless.bin"',
          });
          const chunk = Buffer.alloc(256 * 1024, 7);
          const timer = setInterval(() => {
            transfer.sent += chunk.length;
            response.write(chunk);
            if (transfer.sent >= FILE_END) {
              clearInterval(timer);
              transfer.ended.resolve("finished");
              response.end();
            }
          }, 10);
          response.on("close", () => {
            clearInterval(timer);
            transfer.ended.resolve("stopped");
          });
          return;
        }
        // Its own agent cluster puts the frame in a process of its own, as Chrome does for any cross-site frame.
        response.writeHead(200, { "content-type": "text/html", "origin-agent-cluster": "?1" });
        response.end(
          `<a id="file" href="/endless.bin" download>file</a><script>document.getElementById("file").click()</script>`,
        );
      });
      const site = await serve((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<iframe src="http://localhost:${(frame.address() as AddressInfo).port}/"></iframe>`,
        );
      });
      const pool = new ServerBrowserContexts({
        profilesDir: NodePath.join(root, "profiles"),
        executable: async () => executable,
        downloadMaxBytes: LIMIT,
      });
      try {
        const context = await pool.contextFor(profileId, isolationKey);
        const page = await context.newPage();
        const downloaded = page.waitForEvent("download");
        await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
        // The frame has a session of its own only when it runs in its own process.
        const child = page.frames().find((candidate) => candidate !== page.mainFrame());
        expect(
          await context.newCDPSession(child!).then(
            () => true,
            () => false,
          ),
        ).toBe(true);
        const download = await downloaded;
        expect(await download.failure()).toBe("canceled");
        expect(await transfer.ended.promise).toBe("stopped");
        expect(transfer.sent).toBeGreaterThan(LIMIT);
        expect(transfer.sent).toBeLessThan(FILE_END);
      } finally {
        await pool.close();
        frame.closeAllConnections();
        site.closeAllConnections();
        frame.close();
        site.close();
      }
    },
  );
});

/** Chrome for Testing, which a Cloud computer's image carries; the headless shell has no popup blocker to turn on. */
const chrome = process.env.CAVEMAN_TEST_CHROME;
if (!chrome) {
  console.warn(
    "BLOCKED: no Chrome for Testing; set CAVEMAN_TEST_CHROME to its executable, the browser a Cloud computer runs",
  );
}

describe.skipIf(!chrome)("ServerBrowserContexts on the Chrome a Cloud computer runs", () => {
  it.each([
    ["an agent's throwaway context", "default", "agent"],
    ["a person's profile", "work", undefined],
  ] as const)(
    "a page opens a popup only from a click, in %s",
    { timeout: 120_000 },
    async (_, profileId, isolationKey) => {
      const site = await serve((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        if (request.url !== "/") return void response.end("popup");
        // An ad script's loop as the page loads, and a sign-in button.
        response.end(
          `<script>window.opened = Array.from({ length: 5 }, () => window.open("/popup")).filter(Boolean).length</script>` +
            `<button onclick="window.clicked = Boolean(window.open('/popup'))">Sign in</button>`,
        );
      });
      const pool = new ServerBrowserContexts({
        profilesDir: NodePath.join(root, "chrome-profiles"),
        executable: async () => chrome!,
        downloadMaxBytes: LIMIT,
      });
      try {
        const context = await pool.contextFor(profileId, isolationKey);
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
        expect(await page.evaluate("window.opened")).toBe(0);
        // A click comes in as input, as a person's or an agent's does, so the sign-in popup opens.
        const popup = page.waitForEvent("popup");
        await page.click("button");
        await popup;
        expect(await page.evaluate("window.clicked")).toBe(true);
      } finally {
        await pool.close();
        site.closeAllConnections();
        site.close();
      }
    },
  );
});
