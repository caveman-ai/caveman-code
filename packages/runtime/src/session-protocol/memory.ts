// The Session Protocol's memory.* methods on the runtime's Memory service
// (memory/MemoryService.ts). Every change goes through the commit path as the
// user: what the user writes is Told. A runtime without memory answers
// `unsupported`.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { Memory } from "../memory/MemoryService.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

type MemoryMethod =
  | "memory.status"
  | "memory.list"
  | "memory.history"
  | "memory.put"
  | "memory.forget"
  | "memory.undo"
  | "memory.pin"
  | "memory.keep"
  | "memory.erase"
  | "memory.import";

const refused = (error: Error) =>
  new ProtocolError({ reason: /^No note/.test(error.message) ? "not_found" : /off$/.test(error.message) ? "invalid_state" : "invalid_params", message: error.message });

export const makeMemoryHandlers = (
  memory: Option.Option<Memory["Service"]>,
  /** A project's root folder, for its repository's notes. */
  projectRoot: (projectId: string) => Effect.Effect<string | undefined>,
): { readonly [M in MemoryMethod]: Handler<M> } => {
  const api = <A, E extends Error>(use: (api: Memory["Service"]["api"]) => Effect.Effect<A, E>): Effect.Effect<A, ProtocolError> =>
    Option.isNone(memory)
      ? Effect.fail(new ProtocolError({ reason: "unsupported", message: "This runtime has no memory" }))
      : use(memory.value.api).pipe(Effect.mapError((error) => (error instanceof ProtocolError ? error : refused(error))));
  const rootOf = (projectId: string | undefined) => (projectId === undefined ? Effect.succeed(undefined) : projectRoot(projectId));
  return {
    "memory.status": () => api((m) => m.status),
    "memory.list": (p) =>
      api((m) =>
        rootOf(p.project_id).pipe(
          Effect.flatMap((root) => m.list({ ...(p.query === undefined ? {} : { query: p.query }), ...(root === undefined ? {} : { repo_path: root }) })),
          Effect.map((notes) => ({ notes: [...notes] })),
        ),
      ),
    "memory.history": (p) => api((m) => m.history(p.id).pipe(Effect.map((versions) => ({ versions: [...versions] })))),
    "memory.put": (p) =>
      api((m) =>
        rootOf(p.project_id).pipe(
          Effect.flatMap((root) =>
            m.put({
              text: p.text,
              scope: p.scope,
              ...(p.id === undefined ? {} : { id: p.id }),
              ...(p.name === undefined ? {} : { name: p.name }),
              ...(root === undefined ? {} : { repo_path: root }),
            }),
          ),
        ),
      ),
    "memory.forget": (p) => api((m) => m.forget(p.id).pipe(Effect.as({}))),
    "memory.undo": (p) => api((m) => m.undo(p.id).pipe(Effect.map((note) => ({ note })))),
    "memory.pin": (p) => api((m) => m.pin(p.id, p.pinned)),
    "memory.keep": (p) => api((m) => m.keep(p.id)),
    "memory.erase": (p) => api((m) => m.erase(p.id).pipe(Effect.as({}))),
    "memory.import": () => api((m) => m.importClaude),
  };
};
