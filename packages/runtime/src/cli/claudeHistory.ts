// ), apps/server/src/cli/claudeHistory.ts @ ab3a3cd1.
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/**
 * Hosts the Claude history worker inside the CLI executable. The npm bundle
 * runs it as a sibling `claudeHistoryWorker.mjs` under the host Node; the
 * single-executable has no Node to run a script with, so the adapter invokes
 * this hidden subcommand on its own executable instead. The worker loads only
 * when this command runs, so other commands never pay for it.
 */
export const claudeHistoryCommand = Command.make("__claude-history", {
  method: Argument.String("method"),
  sessionId: Argument.String("session-id"),
  options: Argument.String("options").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ method, sessionId, options }) =>
    // Two effects, so an interrupt during the import never starts the worker.
    Effect.promise(() => import("../claudeHistoryWorker.ts")).pipe(
      Effect.flatMap(({ runClaudeHistoryWorker }) =>
        Effect.promise(() =>
          runClaudeHistoryWorker(
            method,
            sessionId,
            options._tag === "Some" ? options.value : undefined,
          ),
        ),
      ),
    ),
  ),
);
