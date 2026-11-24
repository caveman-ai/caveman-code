// ), apps/server/src/claudeHistoryWorker.ts @ ab3a3cd1.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ForkSessionResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const { agentId, limit, ...sessionOptions } = options;
  const { forkSession, getSessionMessages, getSubagentMessages } = await loadClaudeAgentSdk();
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, sessionOptions)
      : method === "forkSession"
        ? await forkSession(sessionId, sessionOptions).then(async (forked) => {
            // The SDK remaps copied UUIDs: the fork's inherited head, before its first run appends.
            const headMessageId = await getSessionMessages(forked.sessionId, sessionOptions.dir === undefined ? {} : { dir: sessionOptions.dir })
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : method === "getSubagentMessages" && agentId !== undefined
          ? await getSubagentMessages(sessionId, agentId, { ...(sessionOptions.dir === undefined ? {} : { dir: sessionOptions.dir }), ...(limit === undefined ? {} : { limit }) })
          : (() => {
              throw new Error("Unknown Claude history operation.");
            })();
  process.stdout.write(JSON.stringify(result));
}

/** The worker's entry beside this module: claude-history-worker.mjs in the bundle (dist/), claude-history-worker.ts in the source tree. */
export function claudeHistoryWorkerEntry(): string | undefined {
  for (const name of ["claude-history-worker.mjs", "claude-history-worker.ts"]) {
    const entry = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(entry)) return entry;
  }
  return undefined;
}

/**
 * The config dir a Claude login keeps its sessions in, when it is not this process's own: a further login's
 * CLAUDE_CONFIG_DIR (relative to `cwd`). The Agent SDK's session helpers read only this process's, so such a
 * login's history must go through the worker. Undefined for the person's own login.
 */
export function otherClaudeConfigDir(configDir: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (configDir === undefined || configDir.trim() === "") return undefined;
  const resolved = path.resolve(cwd ?? process.cwd(), configDir.trim());
  const own = path.resolve(env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"));
  return resolved === own ? undefined : resolved;
}

/** One history operation run by the worker with `configDir` as its CLAUDE_CONFIG_DIR, so a further login's sessions are the ones read. */
function inConfigDir(method: string, sessionId: string, options: Record<string, unknown>, configDir: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const entry = claudeHistoryWorkerEntry();
    if (entry === undefined) return reject(new Error("The Claude history worker is missing beside the runtime."));
    const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    const args = ["--no-warnings", entry, method, sessionId, JSON.stringify(defined)];
    execFile(process.execPath, args, { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim().split("\n").findLast((line) => line.startsWith("Error")) ?? error.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (cause) {
        reject(new Error(`The Claude history worker answered something unreadable: ${(cause as Error).message}`));
      }
    });
  });
}

/** forkSession in a further login's config dir. */
export async function forkSessionInConfigDir(
  sessionId: string,
  options: { readonly dir?: string; readonly upToMessageId?: string },
  configDir: string,
): Promise<ForkSessionResult & { readonly headMessageId?: string }> {
  const result = (await inConfigDir("forkSession", sessionId, { dir: options.dir, upToMessageId: options.upToMessageId }, configDir)) as ForkSessionResult & {
    readonly headMessageId?: string;
  };
  if (typeof result?.sessionId !== "string") throw new Error("The Claude history worker answered without a session id.");
  return result;
}

/** getSubagentMessages in a further login's config dir. */
export async function subagentMessagesInConfigDir(
  sessionId: string,
  agentId: string,
  options: { readonly dir?: string; readonly limit?: number },
  configDir: string,
): Promise<ReadonlyArray<SessionMessage>> {
  const result = await inConfigDir("getSubagentMessages", sessionId, { agentId, dir: options.dir, limit: options.limit }, configDir);
  if (!Array.isArray(result)) throw new Error("The Claude history worker answered without messages.");
  return result as ReadonlyArray<SessionMessage>;
}
