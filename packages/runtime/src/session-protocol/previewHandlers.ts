// A chat's preview, end to end: its agent registers how to serve what it built (register_preview, on the shared /mcp,
// any engine), the workspace carries it (Workspace.preview: the Open preview chip in the chat's Chief's message and
// board), and workspace.preview.open serves it from the chat's worktree (previews.ts) for the person's browser.
//
// The port is the chat's own: the one its computer.toml [run].ports gave it, else one allocated for the preview from
// the runtime's range when the preview is registered. Either way it is in caveman_sp_ports, so it is freed when the
// chat is archived, and the address stays the same each time it opens.
import type { Params, Result, Workspace, WorkspacePreview } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { readComputerConfig } from "./lifecycle.ts";
import { makePreviewServers, PreviewStartError, type PreviewServers } from "./previews.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";
import { childEnv } from "./workspaceIsolation.ts";

/** A register_preview the runtime refuses: the message is what the agent reads. */
export class PreviewRegisterError extends Schema.TaggedError<PreviewRegisterError>()(
  "PreviewRegisterError",
  { message: Schema.String },
) {}

export interface PreviewRegistration {
  readonly command: string;
  readonly path?: string | undefined;
  readonly port?: number | undefined;
}
export interface PreviewRegistered {
  readonly port: number;
  readonly url: string;
}
type RegisterTool = (
  threadId: string,
  input: PreviewRegistration,
) => Effect.Effect<PreviewRegistered, PreviewRegisterError>;

/** register_preview's way into the route that owns chats (as SetupChats is the setup tools'). The last bind wins. */
export class ChatPreviews extends Context.Service<
  ChatPreviews,
  {
    readonly register: RegisterTool;
    readonly bind: (tools: { readonly register: RegisterTool }) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/ChatPreviews") {}

export const layerChatPreviews = Layer.sync(ChatPreviews, () => {
  let bound: RegisterTool | undefined;
  return ChatPreviews.of({
    register: (threadId, input) =>
      bound
        ? bound(threadId, input)
        : Effect.fail(
            new PreviewRegisterError({ message: "Previews aren't running on this runtime yet." }),
          ),
    bind: (tools) => Effect.sync(() => void (bound = tools.register)),
  });
});

const COMMAND_MAX = 500;
const PATH_MAX = 500;

/** What register_preview takes, cleaned, or why not. */
export function previewOf(input: PreviewRegistration, at: string): WorkspacePreview | string {
  const command = input.command.trim();
  if (!command)
    return "Give the command that serves the app from this checkout, such as `pnpm vite --port {port} --strictPort`.";
  if (command.length > COMMAND_MAX) return `The command is over ${COMMAND_MAX} characters.`;
  if (/[\r\n]/.test(command)) return "The command is one line; join steps with &&.";
  const path = (input.path ?? "/").trim() || "/";
  if (!path.startsWith("/") || path.length > PATH_MAX || /\s/.test(path))
    return "The path is the address after the host, from /: /, /settings, /?demo=1.";
  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
  )
    return "The port is a whole number from 1 to 65535.";
  return {
    command,
    path,
    ...(input.port === undefined ? {} : { port: input.port }),
    registered_at: at,
  };
}

/**
 * The port a chat's preview serves on: its fixed one, else the first of its [run].ports (CAVEMAN_PORT), else its
 * `preview` port; undefined when it has none of them yet.
 */
export function previewPort(
  workspace: Pick<Workspace, "ports" | "preview">,
  runPorts: ReadonlyArray<string> = [],
): number | undefined {
  if (workspace.preview?.port !== undefined) return workspace.preview.port;
  const ports = workspace.ports ?? {};
  for (const name of runPorts) if (ports[name] !== undefined) return ports[name];
  return ports.preview ?? Object.values(ports)[0];
}

const fromRecord = (record: WorkspaceRecord) =>
  record.internal.worktreePath ? safeConfig(record.internal.worktreePath) : null;
const safeConfig = (worktree: string) => {
  try {
    return readComputerConfig(worktree);
  } catch {
    return null;
  }
};

export interface PreviewDeps<E> {
  readonly store: SessionStore["Service"];
  readonly stateDir: string;
  /** Writes a record change (handlers.ts update). */
  readonly update: (
    record: WorkspaceRecord,
    change: (record: WorkspaceRecord) => WorkspaceRecord,
  ) => Effect.Effect<WorkspaceRecord, unknown>;
  readonly recordByWorkspace: (workspaceId: string) => Effect.Effect<WorkspaceRecord, E>;
  readonly allocatePorts: (
    workspaceId: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<Record<string, number>, unknown>;
  /** The runtime's owner (the person on this Mac, or their own Cloud account through the relay). */
  readonly ownerOnly: (principal: string | undefined) => boolean;
  /** The protocol's refusal (handlers.ts fail). */
  readonly fail: (reason: string, message: string) => Effect.Effect<never, E>;
  /** Servers for tests: a stub, or one with short timeouts. */
  readonly servers?: PreviewServers;
}

export const makePreviewHandlers = <E>(deps: PreviewDeps<E>) =>
  Effect.gen(function* () {
    const { store, fail } = deps;
    const servers = deps.servers ?? makePreviewServers({ stateDir: deps.stateDir });
    // Servers a killed runtime left running: stopped before anything else starts one.
    const reaped = yield* Effect.promise(() => servers.reapOrphans());
    if (reaped > 0)
      yield* Effect.logInfo(
        `previews: stopped ${reaped} preview server(s) a previous runtime left running`,
      );
    const sweep = setInterval(() => void servers.sweep().catch(() => undefined), 60_000);
    sweep.unref?.();
    // The runtime stops (the app quit, an update): every server goes with it, as a whole process group.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        clearInterval(sweep);
        return servers.stopAll();
      }),
    );

    const register: RegisterTool = (threadId, input) =>
      Effect.gen(function* () {
        const refuse = (message: string) => Effect.fail(new PreviewRegisterError({ message }));
        const record = yield* store.getByThread(threadId);
        if (record === undefined || record.workspace.kind !== undefined)
          return yield* refuse("register_preview works in a chat with a checkout.");
        if (record.workspace.status === "archived") return yield* refuse("This chat is archived.");
        if (!record.workspace.root_path || !record.internal.worktreePath)
          return yield* refuse(
            "Previews open on This Mac; this chat's computer is not it. Say in your answer how to run it.",
          );
        const preview = previewOf(input, new Date().toISOString());
        if (typeof preview === "string") return yield* refuse(preview);
        const config = fromRecord(record);
        let port = previewPort({ ...record.workspace, preview }, config?.run.ports ?? []);
        let ports = record.workspace.ports;
        if (port === undefined) {
          const given = yield* deps
            .allocatePorts(record.workspace.id, ["preview"])
            .pipe(Effect.orElseSucceed(() => ({}) as Record<string, number>));
          port = given.preview;
          if (port === undefined)
            return yield* refuse("No free port is left in the runtime's range.");
          ports = { ...ports, preview: port };
        }
        const old = record.workspace.preview;
        // Another command or port: the server the old one started goes, and the next open starts the new one.
        if (old && (old.command !== preview.command || old.port !== preview.port))
          yield* Effect.promise(() => servers.stop(record.workspace.id));
        // Never bumps updated_at: a chip appearing never reorders a list.
        const next = yield* deps
          .update(record, (current) => ({
            ...current,
            workspace: { ...current.workspace, ...(ports ? { ports } : {}), preview },
          }))
          .pipe(
            Effect.mapError(
              () => new PreviewRegisterError({ message: "Could not save the preview." }),
            ),
          );
        yield* store.publishWorkspace(next.workspace);
        return { port, url: `http://localhost:${port}${preview.path}` };
      });
    yield* (yield* ChatPreviews).bind({ register });

    const handlers = {
      "workspace.preview.open": (
        p: Params<"workspace.preview.open">,
        ctx: { readonly principal?: string | undefined },
      ) =>
        Effect.gen(function* () {
          if (!deps.ownerOnly(ctx.principal))
            return yield* fail(
              "forbidden",
              "A chat's preview runs a command: only this computer's owner opens it.",
            );
          const record = yield* deps.recordByWorkspace(p.workspace_id);
          const preview = record.workspace.preview;
          if (preview === undefined)
            return yield* fail("not_found", "This chat registered no preview.");
          const cwd = record.internal.worktreePath;
          if (!record.workspace.root_path || !cwd)
            return yield* fail("unsupported", "Previews open on This Mac only.");
          const config = fromRecord(record);
          const port = previewPort(record.workspace, config?.run.ports ?? []);
          if (port === undefined)
            return yield* fail(
              "invalid_state",
              "This chat has no port for its preview: its agent registers it again.",
            );
          const env = yield* childEnv(store, record, { computer: config });
          return yield* Effect.tryPromise({
            try: () =>
              servers.open({
                workspaceId: record.workspace.id,
                cwd,
                command: preview.command,
                path: preview.path,
                port,
                env,
              }),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              fail(
                "invalid_state",
                error instanceof PreviewStartError
                  ? error.message
                  : `Could not start the preview: ${String(error)}`,
              ),
            ),
          );
        }) satisfies Effect.Effect<Result<"workspace.preview.open">, E>,
      "workspace.preview.stop": (
        p: Params<"workspace.preview.stop">,
        ctx: { readonly principal?: string | undefined },
      ) =>
        Effect.gen(function* () {
          if (!deps.ownerOnly(ctx.principal))
            return yield* fail("forbidden", "Only this computer's owner stops a chat's preview.");
          yield* deps.recordByWorkspace(p.workspace_id);
          yield* Effect.promise(() => servers.stop(p.workspace_id));
          return {};
        }) satisfies Effect.Effect<Result<"workspace.preview.stop">, E>,
    };
    /** The chat is archived: its server goes before its worktree does. */
    const stopFor = (workspaceId: string) => Effect.promise(() => servers.stop(workspaceId));
    return { handlers, stopFor };
  });
