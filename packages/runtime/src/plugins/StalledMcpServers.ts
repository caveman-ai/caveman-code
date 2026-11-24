/**
 * MCP servers that did not connect when Claude Agent started them. Claude Code holds a session's first turn until
 * each of its servers connects or gives up after 30 s, so one that never answers (a server that needs another app
 * running, a command waiting on input) would cost every chat's start those 30 s. A start that times out on one
 * records it here, and the chat that waited says why. Later starts leave it out, each chat saying so once, until the
 * first of:
 * - its skip runs out: a day after it stalled, doubling with each stall in a row, at most a week (skippedUntil);
 * - a check outside Claude Code finds it answering after its first stall (StalledMcpServersCheck): a slow first
 *   download, a loaded machine or a network blip passes;
 * - a start adds it and it connects, or fails at once (a changed command, arguments or URL is tried again at once);
 * - the person retries it in Plugins > MCP servers (mcp.retry).
 * A timeout while it is left out (a start planned before it stalled, a live CLI sending its servers again) is the
 * same stall, not another in a row.
 * Kept in the session store, so a restart does not pay for it again. A launch is kept as a hash only: a URL or an
 * argument can hold a secret.
 *
 * @module plugins/StalledMcpServers
 */
import { createHash } from "node:crypto";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { DraftEvent } from "../session-protocol/projector.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { containedCommand } from "./resolve.ts";

export interface StalledServer {
  /** Its key: a personal server's name, a plugin's `<plugin>__<server>` (resolve.ts mcpServerKey). */
  readonly server: string;
  /** A hash of its launch (serverLaunch): another launch is tried again. */
  readonly launch: string;
  /** When it last stalled. Claude Code's own words are not kept: an error text can echo a server's headers. */
  readonly at: string;
  /** Its stalls in a row: each doubles how long it is left out. */
  readonly stalls: number;
  /** A check outside Claude Code found it answering after its first stall: starts have it again. */
  readonly answered?: true;
}

export class StalledMcpServers extends Context.Service<
  StalledMcpServers,
  {
    /** Every server that stalled and was not registered since; leftOut says which a start leaves out now. */
    readonly list: Effect.Effect<ReadonlyArray<StalledServer>>;
    /**
     * After a start or a live CLI registered `servers` (Claude Code's reply, by name): those whose `errors` entry is a
     * connect timeout are left out of later starts, and `threadId`'s chat, which waited for them, is told; those it
     * `added` without one are forgotten. One a live CLI already had is not added again, and says nothing about it now.
     */
    readonly record: (
      threadId: string,
      servers: Readonly<Record<string, McpServerConfig>>,
      result: { readonly added: ReadonlyArray<string>; readonly errors: Readonly<Record<string, string>> },
    ) => Effect.Effect<void>;
    /** Tells `threadId`'s chat, once for each, which servers its start left out. */
    readonly tellLeftOut: (threadId: string, servers: ReadonlyArray<string>) => Effect.Effect<void>;
    /** A check outside Claude Code found the server answering after `stall`: starts have it again, unless it was retried since. */
    readonly answered: (stall: StalledServer) => Effect.Effect<void>;
    /** Tried again at the next start. */
    readonly retry: (server: string) => Effect.Effect<void>;
    /**
     * Each first stall, for the check outside Claude Code (StalledMcpServersCheck). Not a stall in a row: a server that
     * answered a check and stalled again was not predicted by it.
     */
    readonly stalls: Stream.Stream<StalledServer>;
  }
>()("caveman/plugins/StalledMcpServers") {}

const KV_KEY = "mcp.stalled";
const DAY_MS = 24 * 60 * 60_000;

/** Claude Code's error for a server that did not connect in time: `MCP server "x" connection timed out after 30000ms`. */
export const isConnectTimeout = (error: string) => /timed out/i.test(error);

/**
 * What starts a server, as a hash: its own command and arguments (a contained one's without the launcher's
 * per-session policy), or its URL. Never its env or headers, and never the launch itself, which can hold a secret.
 */
export const serverLaunch = (config: McpServerConfig): string => {
  const c = config as { readonly type?: string; readonly command?: string; readonly args?: ReadonlyArray<string>; readonly url?: string; readonly name?: string };
  const own = c.args === undefined ? undefined : containedCommand(c.args);
  const launch = JSON.stringify([c.type ?? "stdio", ...(own ?? [c.command ?? c.url ?? c.name ?? "", ...(c.args ?? [])])]);
  return createHash("sha256").update(launch).digest("hex").slice(0, 32);
};

/** When a stalled server is tried again on its own: a day after its stall, doubling with each stall in a row, at most a week. */
export const skippedUntil = (s: StalledServer): number => Date.parse(s.at) + Math.min(DAY_MS * 2 ** (s.stalls - 1), 7 * DAY_MS);

/** Whether a start leaves `s` out at `now`. */
export const skipping = (s: StalledServer, now: number) => s.answered !== true && now < skippedUntil(s);

/** Which of `names` (the person's servers in `servers`) a start leaves out now: each stalled with the launch it has now. */
export function leftOut(
  servers: Readonly<Record<string, McpServerConfig>>,
  stalled: ReadonlyArray<StalledServer>,
  names: ReadonlyArray<string>,
  now = Date.now(),
): ReadonlyArray<string> {
  return names.filter((name) => {
    const config = servers[name];
    return config !== undefined && stalled.some((s) => s.server === name && s.launch === serverLaunch(config) && skipping(s, now));
  });
}

/** `servers` without `names`. */
export const without = <S>(servers: Readonly<Record<string, S>>, names: ReadonlyArray<string>): Record<string, S> =>
  Object.fromEntries(Object.entries(servers).filter(([name]) => !names.includes(name)));

/** `plugin__server` as a person reads it: "server (plugin)". */
const shown = (key: string) => {
  const at = key.indexOf("__");
  return at <= 0 ? key : `${key.slice(at + 2)} (${key.slice(0, at)})`;
};

const parse = (raw: string | undefined): Array<StalledServer> => {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (s): s is StalledServer =>
            typeof s === "object" &&
            s !== null &&
            ["server", "launch", "at"].every((k) => typeof (s as Record<string, unknown>)[k] === "string") &&
            Number.isInteger((s as Record<string, unknown>).stalls) &&
            ((s as Record<string, unknown>).stalls as number) >= 1,
        )
      : [];
  } catch {
    return [];
  }
};

export const layer = Layer.effect(
  StalledMcpServers,
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const writes = yield* Semaphore.make(1);
    const stalls = yield* PubSub.unbounded<StalledServer>();
    let stalled = parse(yield* store.kvGet(KV_KEY));
    // What starts read changes only once the store has it: a failed write changes nothing.
    const save = (next: Array<StalledServer>) =>
      Effect.suspend(() => store.kvSet(KV_KEY, JSON.stringify(next))).pipe(Effect.andThen(Effect.sync(() => void (stalled = next))));
    // ponytail: one small entry per chat and server for the runtime's lifetime.
    const told = new Set<string>();
    const tell = (threadId: string, servers: ReadonlyArray<string>, waited: boolean) => {
      const fresh = servers.filter((server) => !told.has(`${threadId}\0${server}`));
      if (fresh.length === 0) return Effect.void;
      for (const server of fresh) told.add(`${threadId}\0${server}`);
      return store.getByThread(threadId).pipe(
        Effect.flatMap((record) => {
          if (record === undefined) return Effect.void;
          const names = fresh.map(shown).join(", ");
          const one = fresh.length === 1;
          const it = one ? "it" : "them";
          const retry = `Retry in Plugins > MCP servers to try ${it} in the next chat.`;
          const payload = waited
            ? {
                level: "warning",
                title: `${names} did not connect within 30 seconds, so this chat waited for ${it}`,
                body: `New chats leave ${it} out for a while and try ${it} again on their own. ${retry}`,
              }
            : {
                level: "info",
                title: `Left out ${names}`,
                body: `${one ? "It" : "They"} did not connect within 30 seconds when an earlier chat started. ${retry}`,
              };
          const event = { at: new Date().toISOString(), type: "notification", payload } as DraftEvent;
          return store.append(record.session.id, () => Effect.succeed({ events: [event], value: undefined }));
        }),
        Effect.asVoid,
        // Not told after all: the chat's next start or registration tells it.
        Effect.onError(() => Effect.sync(() => fresh.forEach((server) => told.delete(`${threadId}\0${server}`)))),
      );
    };

    return StalledMcpServers.of({
      list: Effect.sync(() => stalled),
      record: (threadId, servers, { added, errors }) =>
        writes
          .withPermits(1)(
            Effect.gen(function* () {
              const timedOut = Object.keys(errors).filter((server) => servers[server] !== undefined && isConnectTimeout(errors[server]!));
              // Added without a timeout (connected, or failed at once): it costs a start nothing.
              const registered = added.filter((server) => servers[server] !== undefined && !timedOut.includes(server));
              if (timedOut.length === 0 && !stalled.some((s) => registered.includes(s.server))) return { timedOut, first: [] };
              const now = Date.now();
              const at = new Date(now).toISOString();
              const next = stalled.filter((s) => !registered.includes(s.server) && !timedOut.includes(s.server));
              const first: Array<StalledServer> = [];
              for (const server of timedOut) {
                const launch = serverLaunch(servers[server]!);
                const before = stalled.find((s) => s.server === server && s.launch === launch);
                // Still left out: the same stall, waited for by a start planned before it or a live CLI.
                if (before !== undefined && skipping(before, now)) {
                  next.push(before);
                  continue;
                }
                const stall = { server, launch, at, stalls: (before?.stalls ?? 0) + 1 };
                next.push(stall);
                if (stall.stalls === 1) first.push(stall);
              }
              yield* save(next);
              return { timedOut, first };
            }),
          )
          .pipe(
            Effect.tap(({ first }) => Effect.forEach(first, (stall) => PubSub.publish(stalls, stall), { discard: true })),
            Effect.flatMap(({ timedOut }) => tell(threadId, timedOut, true)),
            Effect.catchCause((cause) => Effect.logWarning("Stalled MCP servers not recorded", cause)),
          ),
      tellLeftOut: (threadId, servers) =>
        tell(threadId, servers, false).pipe(Effect.catchCause((cause) => Effect.logWarning("Left-out MCP servers not told", cause))),
      answered: (stall) =>
        writes.withPermits(1)(
          Effect.suspend(() => {
            // Only the first stall it checked: one retried and stalled again since gets its own check, and one in a row
            // was not predicted by a check.
            const checked = (s: StalledServer) => s.server === stall.server && s.at === stall.at && s.stalls === 1 && s.answered !== true;
            return stalled.some(checked) ? save(stalled.map((s) => (checked(s) ? { ...s, answered: true as const } : s))) : Effect.void;
          }),
        ),
      retry: (server) =>
        writes.withPermits(1)(Effect.suspend(() => (stalled.some((s) => s.server === server) ? save(stalled.filter((s) => s.server !== server)) : Effect.void))),
      stalls: Stream.fromPubSub(stalls),
    });
  }),
);
