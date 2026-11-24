// Session Protocol v1 route: GET /session/v1 upgrades to the WebSocket the
// clients speak (packages/session-protocol). Mounted beside upstream /ws and /api.
import type * as NodeHttp from "node:http";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";

import { AppProxyLauncher, appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { runRouteLines } from "../router/routeLines.ts";
import { readIdentity } from "../cloudLink/identity.ts";
import * as CloudLink from "../cloudLink/index.ts";
import * as UsageReporter from "../cloudLink/usageReporter.ts";
import * as CloudSync from "../cloudLink/cloudSync.ts";
import { Memory } from "../memory/MemoryService.ts";
import { PluginRegistry } from "../plugins/PluginRegistry.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import * as ChatSearch from "../search/ChatSearch.ts";
import { runProjector } from "./daemon.ts";
import { runPullRequests } from "./pullRequests.ts";
import { runEngineUpdates } from "./engineUpdates.ts";
import * as Grill from "./grill.ts";
import * as ClientTools from "./clientTools.ts";
import * as Mailbox from "./mailbox.ts";
import { makeSessionProtocolServer, SESSION_PROTOCOL_PATH } from "./server.ts";
import * as Store from "./store.ts";

export { selectSubprotocol, SESSION_PROTOCOL_PATH, TOKEN_FILE } from "./server.ts";
export { MailboxBackend } from "./mailbox.ts";
export { CavemanRewriter, SkillWriter } from "./services.ts";
export { Grill, layer as layerGrill } from "./grill.ts";
export { ClientTools, layer as layerClientTools } from "./clientTools.ts";
export { Embedder, makeLocalEmbedder } from "../search/Embedder.ts";
export { Desktop, layer as layerDesktop } from "./desktop.ts";
export { MacDesktop, layer as layerMacDesktop } from "./macDesktop/service.ts";
export { ChiefHost, layer as layerChiefHost } from "../chief/host.ts";
export { SetupChats, layerSetupChats } from "./environments.ts";
export { ChatPreviews, layerChatPreviews } from "./previewHandlers.ts";
export { Builders, layer as layerBuilders } from "./builders.ts";
export { MacMail, layer as layerMacMail } from "./macMail.ts";
export { CloudSchedules, layer as layerCloudSchedules } from "./cloudSchedules.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * No response from the runtime's origin may load in a frame: the side panel's
 * browser runs cross-origin pages that could navigate their frame here. Set
 * on the Node server before any handler writes, so every route, 404 and
 * error carries it. A handler's own CSP (assets: sandbox, SVG, downloads)
 * replaces ours, so `frame-ancestors 'none'` is added to any CSP without
 * one. Because headers are already set here, Node routes writeHead's
 * header object through this setHeader too.
 */
export function denyFraming<T extends NodeHttp.Server>(server: T): T {
  server.prependListener("request", (_request, response) => {
    const setHeader = response.setHeader;
    response.setHeader = (name, value) =>
      setHeader.call(response, name, name.toLowerCase() === "content-security-policy" ? withFrameAncestors(value) : value);
    for (const [name, value] of Object.entries(FRAME_DENY)) response.setHeader(name, value);
  });
  return server;
}
const withFrameAncestors = (value: number | string | ReadonlyArray<string>) => {
  const has = (policy: string) => /frame-ancestors/i.test(policy);
  if (Array.isArray(value)) return value.some(has) ? value : [...value, "frame-ancestors 'none'"];
  const policy = String(value);
  return has(policy) ? value : `${policy.replace(/[;\s]*$/, "")}; frame-ancestors 'none'`;
};
/** Also on refused upgrades, which bypass the request listener (a frame never sends Upgrade). */
const FRAME_DENY = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" };

/**
 * Succeeds once the desktop is gone: it holds our stdin open and never writes it, so EOF (it quit, or died) is the
 * signal to stop. The caller races the server against this, so the server stops as on SIGTERM, through its
 * finalizers (engines, ptys, the proxies, caveman-mcp). Never by signalling ourselves: on Windows
 * `process.kill(process.pid, "SIGTERM")` is TerminateProcess, which runs no finalizer and orphans every child.
 */
export const untilDesktopGone = (stdin: NodeJS.ReadableStream = process.stdin): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const gone = () => resume(Effect.void);
    // A pipe whose writer died ends on POSIX; on Windows a broken pipe can surface as an error or a bare close.
    for (const event of ["end", "close", "error"] as const) stdin.once(event, gone);
    stdin.resume();
    return Effect.sync(() => {
      for (const event of ["end", "close", "error"] as const) stdin.off(event, gone);
    });
  });

const layerState = Layer.mergeAll(Mailbox.layerLocal, Grill.layer, ClientTools.layer, ChatSearch.layer).pipe(Layer.provideMerge(Store.layer));

export const layerRoute = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* makeSessionProtocolServer;
    // A warm pod's runtime starts before its claim (cloudLink/index.ts): it serves and keeps its own store at once,
    // and starts what touches Cloud, git, the workspace or a secret when the claim brings its identity.
    const computer = yield* CloudLink.CloudComputer;
    const warm = computer !== undefined && readIdentity(computer.linkDir) === undefined;
    const afterClaim = yield* CloudLink.afterClaim(computer);
    // First of them: at a claim the link's token and relay go out before the rest starts.
    yield* CloudLink.run(server).pipe(afterClaim, Effect.forkScoped);
    yield* runProjector.pipe(Effect.forkScoped);
    yield* runRouteLines().pipe(Effect.forkScoped);
    // Each chat's pull request on its git host, for the sidebar's pill.
    yield* runPullRequests.pipe(afterClaim, Effect.forkScoped);
    // A Claude Code too old for a current model (Opus 5.5) is updated by its own updater (engineUpdates.ts).
    yield* runEngineUpdates(computer !== undefined).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Engine updates stopped", { cause })),
      Effect.forkScoped,
    );
    // Claude Agent and Codex chats run through the app's own caveman-proxies: started now, brought back when one
    // died (checked every 30 s), stopped with the runtime. Without one, its chats on a chosen model run direct.
    const launchProxy = yield* AppProxyLauncher;
    yield* Effect.addFinalizer(() => Effect.sync(() => (appProxy.stop(true), codexProxy.stop(true))));
    const proxyStates: Record<string, string | undefined> = {};
    yield* Effect.promise(launchProxy).pipe(
      Effect.flatMap((states) =>
        Effect.forEach(
          [["app", "Claude Agent", appProxy], ["codex", "Codex", codexProxy]] as const,
          ([which, engine, proxy]) => {
            const state = states[which];
            const changed = state !== proxyStates[which] && !(state === "running" && proxyStates[which] === "started");
            proxyStates[which] = state;
            if (!changed) return Effect.void;
            return state === "started"
              ? Effect.logInfo(`Started Caveman Code's caveman-proxy for ${engine} (record) at ${proxy.url()}`)
              : Effect.logWarning(`Caveman Code's caveman-proxy for ${engine} is not running (${state}: ${proxy.why() ?? "unknown"}); its chats run direct`);
          },
          { discard: true },
        ),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
      afterClaim,
      Effect.forkScoped,
    );
    // chat.search follows the journal: titles, then every passage, then their vectors on the on-device model. A warm
    // Cloud computer has no chats before its claim, and its model (about 170 MiB loaded) waits for it, then half a
    // minute more, so loading it never competes with the adopt of the chat that moved there.
    const search = (yield* ChatSearch.ChatSearch).run;
    yield* (warm ? Effect.andThen(Effect.sleep("30 seconds"), search) : search).pipe(afterClaim, Effect.forkScoped);
    // Memory follows session events: taint and the turn-end sweep.
    const memory = yield* Effect.serviceOption(Memory);
    if (Option.isSome(memory)) yield* memory.value.run.pipe(Effect.forkScoped);
    // The Chief follows the chats it started: their items move on its board, and it wakes once per quiet spell. It
    // starts once the runtime takes commands (serverRuntimeStartup), so after startup recovery has ended the turns a
    // quit cut off: a note it sends at launch then reaches a live session, never a run whose session died with the
    // old process (T3 refuses that send, and holds the refusal).
    const startup = yield* Effect.serviceOption(ServerRuntimeStartup);
    const commandsReady = Option.isSome(startup) ? startup.value.awaitCommandReady.pipe(Effect.ignore) : Effect.void;
    yield* commandsReady.pipe(Effect.andThen(server.chiefWatch), afterClaim, Effect.forkScoped);
    // Chats that move between This Mac and Cloud computers.
    yield* server.moves.pipe(afterClaim, Effect.forkScoped);
    // Sessions Cloud started here without a person: their mail, and their events and traces out (headless.ts).
    yield* server.headless.pipe(afterClaim, Effect.forkScoped);
    // Done chats archived after the days Settings names (never by default).
    yield* server.archiveDone.pipe(afterClaim, Effect.forkScoped);
    // The person's settings, the same on every computer they use (Caveman Cloud the spec).
    yield* server.settingsSync.pipe(afterClaim, Effect.forkScoped);
    // A Cloud computer's boot steps (bootSteps.ts): on_wake and start for each clone it holds. After the claim, as
    // everything that runs git or touches the workspace: a warm pod's runtime does neither before it.
    yield* server.bootSteps.pipe(afterClaim, Effect.forkScoped);
    // The first Claude Agent turn's plugin pass (~/.agents/skills' digest, the plugin copies: 0.2-0.4 s), done once
    // the runtime answers and its first reads are past, so the first message after launch finds it cached.
    const plugins = yield* Effect.serviceOption(PluginRegistry);
    if (Option.isSome(plugins) && Option.isSome(startup)) {
      yield* startup.value.awaitCommandReady.pipe(
        afterClaim,
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.andThen(plugins.value.session()),
        Effect.flatMap(plugins.value.claudeAgent),
        Effect.ignore,
        Effect.forkScoped,
      );
    }
    yield* UsageReporter.run.pipe(afterClaim, Effect.forkScoped);
    // Settings and skills to Caveman Cloud (This Mac), or from it (a Cloud computer); secrets only where opted in.
    yield* CloudSync.run.pipe(
      Effect.catchCause((cause) => Effect.logError("Caveman Cloud sync stopped", cause)),
      afterClaim,
      Effect.forkScoped,
    );
    yield* Effect.logInfo(`Session Protocol v1 at ${SESSION_PROTOCOL_PATH}`);
    return HttpRouter.add(
      "GET",
      SESSION_PROTOCOL_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!server.authorize(request.headers)) return HttpServerResponse.text("Unauthorized", { status: 401, headers: FRAME_DENY });
        // A client on this computer gets plain frames: deflating a long chat's backlog took longer than the
        // loopback saves. Other clients keep permessage-deflate (server.ts).
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        if (LOOPBACK.has(incoming.socket.remoteAddress ?? "")) delete incoming.headers["sec-websocket-extensions"];
        const socket = yield* request.upgrade;
        // The TCP socket under the WebSocket: what it holds unsent is how far behind the client is (server.ts).
        const raw = incoming.socket;
        yield* server.serve(socket, "local", {
          bytes: () => raw.writableLength,
          drained: Effect.callback<void>((resume) => {
            const cleanup = () => {
              raw.off("drain", done);
              raw.off("close", done);
              clearTimeout(timer);
            };
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              // Effect.callback's cancellation cleanup alone does not run on
              // success: every drain/timer would otherwise retain a close listener.
              cleanup();
              resume(Effect.void);
            };
            raw.once("drain", done);
            raw.once("close", done);
            // Node emits drain only after a write was refused: look again shortly either way.
            const timer = setTimeout(done, 50);
            return Effect.sync(cleanup);
          }),
        });
        return HttpServerResponse.empty();
      }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    );
  }),
).pipe(Layer.provide(layerState));
