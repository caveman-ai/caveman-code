// Session mailbox storage (docs/ §3.4). The local backend keeps
// messages and claims in the runtime's SQLite, for one runtime's tree. A
// Cloud backend (Caveman Cloud /v1/code mailbox) provides the same service
// when the tree spans computers; handlers.ts never knows which one it has.
import type { MailMessage as MailMessageSchema } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SessionStore } from "./store.ts";

type MailMessage = typeof MailMessageSchema.Type;

export interface Claim {
  readonly path: string;
  readonly workspace_id: string;
}

export class MailboxBackend extends Context.Service<
  MailboxBackend,
  {
    readonly send: (message: MailMessage) => Effect.Effect<MailMessage>;
    /** Messages to a workspace after `afterId` (all without it), oldest first. Never consumes. */
    readonly list: (toWorkspaceId: string, afterId?: string) => Effect.Effect<ReadonlyArray<MailMessage>>;
    readonly get: (id: string) => Effect.Effect<MailMessage | undefined>;
    /** Grants the paths nobody else holds; returns the caller's claims and the others' conflicting ones. */
    readonly claim: (
      workspaceId: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly claims: ReadonlyArray<Claim>; readonly conflicts: ReadonlyArray<Claim> }>;
    readonly release: (workspaceId: string, paths?: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("caveman/session-protocol/MailboxBackend") {}

export const layerLocal = Layer.effect(
  MailboxBackend,
  Effect.gen(function* () {
    const { sql } = yield* SessionStore;
    const decode = (rows: ReadonlyArray<{ message: string }>) => rows.map((row) => JSON.parse(row.message) as MailMessage);
    return MailboxBackend.of({
      send: (message) =>
        sql`INSERT OR IGNORE INTO caveman_sp_mail (id, to_workspace_id, message)
            VALUES (${message.id}, ${message.to_workspace_id}, ${JSON.stringify(message)})`.pipe(
          Effect.as(message),
          Effect.orDie,
        ),
      list: (to, afterId) =>
        (afterId === undefined
          ? sql<{ message: string }>`SELECT message FROM caveman_sp_mail WHERE to_workspace_id = ${to} ORDER BY seq`
          : sql<{ message: string }>`SELECT message FROM caveman_sp_mail WHERE to_workspace_id = ${to}
              AND seq > COALESCE((SELECT seq FROM caveman_sp_mail WHERE id = ${afterId}), 0) ORDER BY seq`
        ).pipe(Effect.map(decode), Effect.orDie),
      get: (id) =>
        sql<{ message: string }>`SELECT message FROM caveman_sp_mail WHERE id = ${id}`.pipe(
          Effect.map((rows) => decode(rows)[0]),
          Effect.orDie,
        ),
      claim: (workspaceId, paths) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const conflicts: Array<Claim> = [];
            for (const path of paths) {
              const others = yield* sql<Claim>`SELECT path, workspace_id FROM caveman_sp_claims
                WHERE path = ${path} AND workspace_id != ${workspaceId}`;
              if (others.length > 0) conflicts.push(...others);
              else yield* sql`INSERT OR IGNORE INTO caveman_sp_claims (path, workspace_id) VALUES (${path}, ${workspaceId})`;
            }
            const claims = yield* sql<Claim>`SELECT path, workspace_id FROM caveman_sp_claims WHERE workspace_id = ${workspaceId} ORDER BY path`;
            return { claims, conflicts };
          }),
        ).pipe(Effect.orDie),
      release: (workspaceId, paths) =>
        Effect.gen(function* () {
          const held = (yield* sql<Claim>`SELECT path, workspace_id FROM caveman_sp_claims WHERE workspace_id = ${workspaceId}`).map((c) => c.path);
          const released = paths === undefined ? held : held.filter((p) => paths.includes(p));
          for (const path of released) yield* sql`DELETE FROM caveman_sp_claims WHERE path = ${path} AND workspace_id = ${workspaceId}`;
          return released;
        }).pipe(Effect.orDie),
    });
  }),
);
