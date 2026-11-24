// The real ServerBrowser on the real headless shell, for what only Chromium shows.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vitest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { ensureTestBrowser, TEST_BROWSER_HOME } from "../session-protocol/testHarness.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

// The headless shell is about 100 MB: without it (fresh CI, offline) this is BLOCKED, never a hang.
const haveBrowser =
  process.env.CAVEMAN_TEST_BROWSER === "1" || NodeFS.existsSync(TEST_BROWSER_HOME);
if (!haveBrowser) {
  console.warn(
    `BLOCKED: no headless shell in ${TEST_BROWSER_HOME}; set CAVEMAN_TEST_BROWSER=1 to install it there, or CAVEMAN_TEST_BROWSER_HOME to an installed one`,
  );
}

const scope = {
  environmentId: EnvironmentId.make("server-browser-chrome-test"),
  thread: {
    threadId: ThreadId.make("server-browser-chrome-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "server-browser-chrome",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const layerWith = (executable: string) =>
  ServerBrowser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Broker.layer,
        Manager.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(scope.environmentId),
          getDescriptor: Effect.die("unused descriptor"),
        }),
        Layer.succeed(PreviewBrowser.PreviewBrowser, {
          executable: Effect.succeed(executable),
          installed: Effect.die("unused"),
        } as never),
        Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
          available: false,
          awaitAttached: () => Effect.succeed(false),
          detached: Stream.empty,
          attached: Stream.empty,
          isAttached: () => Effect.succeed(false),
          endpoint: () => Effect.die("no desktop"),
          pointer: () => Effect.void,
        } as never),
      ).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "server-browser-chrome-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

/** Serves on 127.0.0.1; a page from one server framing another is a cross-site frame. */
const serve = (handle: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(handle);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  ).pipe(Effect.map((server) => (server.address() as AddressInfo).port));

it.live.skipIf(!haveBrowser)(
  "a download a frame in its own process starts stops at the size limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transfer = { sent: 0, ended: Promise.withResolvers<"stopped" | "finished">() };
        // A 2 GiB file by its length, sent slowly: Chromium's first report already says it is past the limit.
        const frame = yield* serve((request, response) => {
          if (request.url === "/file.bin") {
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-disposition": 'attachment; filename="file.bin"',
              "content-length": String(2 * 1024 * 1024 * 1024),
            });
            const chunk = Buffer.alloc(64 * 1024, 7);
            const timer = setInterval(() => {
              transfer.sent += chunk.length;
              response.write(chunk);
              if (transfer.sent >= 32 * 1024 * 1024) {
                clearInterval(timer);
                transfer.ended.resolve("finished");
                response.destroy();
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
            `<a id="file" href="/file.bin" download>file</a><script>document.getElementById("file").click()</script>`,
          );
        });
        const site = yield* serve((_, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<iframe src="http://localhost:${frame}/"></iframe>`);
        });

        const broker = yield* Broker.PreviewAutomationBroker;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        yield* broker.invoke({
          scope,
          tabId: PreviewTabId.make(opened.tabId!),
          operation: "navigate",
          input: { url: `http://127.0.0.1:${site}/` },
        });
        const ended = yield* Effect.promise(() => transfer.ended.promise).pipe(
          Effect.timeout("20 seconds"),
        );
        expect({ ended, sentUnder: transfer.sent < 32 * 1024 * 1024 }).toEqual({
          ended: "stopped",
          sentUnder: true,
        });
      }),
    ).pipe(
      Effect.provide(Layer.unwrap(Effect.promise(ensureTestBrowser).pipe(Effect.map(layerWith)))),
    ),
  120_000,
);

it.live.skipIf(!haveBrowser)(
  "a page's window.open without a click opens no tab on the headless shell, and a click's still does",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A sign-in button in a cross-site frame in its own process, as an identity provider's is.
        const frame = yield* serve((request, response) => {
          response.writeHead(200, { "content-type": "text/html", "origin-agent-cluster": "?1" });
          if (request.url !== "/") return void response.end("popup");
          response.end(
            `<button style="position: fixed; inset: 0" onclick="const popup = window.open('/sign-in'); ` +
              `setInterval(() => parent.postMessage(popup.closed, '*'), 20)">Sign in with</button>`,
          );
        });
        // An ad script's loop as the page loads, and a sign-in button of the page's own.
        const site = yield* serve((request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          if (request.url !== "/") return void response.end("popup");
          response.end(
            `<script>window.loaded = [0, 1, 2].map(() => window.open("/ad")); ` +
              `addEventListener("message", (event) => { window.framed = event.data })</script>` +
              `<button id="sign-in" onclick="window.clicked = window.open('/sign-in')">Sign in</button>` +
              `<iframe src="http://localhost:${frame}/" style="position: absolute; left: 0; top: 100px; width: 200px; height: 60px; border: 0"></iframe>`,
          );
        });
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        yield* broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: `http://127.0.0.1:${site}/` },
        });
        // The agent's clicks arrive as input, as a person's do.
        yield* broker.invoke({ scope, tabId, operation: "click", input: { selector: "#sign-in" } });
        yield* broker.invoke({ scope, tabId, operation: "click", input: { x: 100, y: 130 } });
        const tabs = manager
          .list({ threadId: scope.thread.threadId })
          .pipe(Effect.map(({ sessions }) => sessions.length));
        const closed = broker.invoke<{
          readonly loaded: number;
          readonly clicked: boolean;
          readonly framed: boolean | null;
        }>({
          scope,
          tabId,
          operation: "evaluate",
          input: {
            expression:
              "({ loaded: window.loaded.filter((popup) => popup.closed).length, clicked: window.clicked.closed, framed: window.framed ?? null })",
          },
        });
        // The headless shell has no popup blocker: each window.open gets a window, which becomes a tab or closes.
        yield* Effect.gen(function* () {
          while (true) {
            const { loaded, clicked, framed } = yield* closed;
            // The frame reports its popup to the page within moments of the click.
            const settled = (yield* tabs) - 1 + loaded + Number(clicked) + Number(framed === true);
            if (framed !== null && settled >= 3 + 2) return;
            yield* Effect.sleep("20 millis");
          }
        }).pipe(Effect.timeout("20 seconds"));
        expect({ tabs: yield* tabs, ...(yield* closed) }).toEqual({
          tabs: 3,
          loaded: 3,
          clicked: false,
          framed: false,
        });
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.tabs?.filter((tab) => tab.openerTabId === tabId)).toHaveLength(2);
      }),
    ).pipe(
      Effect.provide(Layer.unwrap(Effect.promise(ensureTestBrowser).pipe(Effect.map(layerWith)))),
    ),
  120_000,
);
