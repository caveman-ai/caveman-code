/**
 * Checks a server that stalled at a Claude Agent start a little later, outside Claude Code, through the runtime's MCP
 * hub (the check mcp.tools runs). One that answers within the 30 s Claude Code gives it was a passing slow start (a
 * first npx or uvx download, a loaded machine, a network blip): starts have it again (StalledMcpServers.answered).
 * One that does not waits out its skip. The hub's own bound ends the check (PROBE_MS), which also closes a server
 * that never answers: the check is timed, never cut short, so no connection to it is left open.
 *
 * @module plugins/StalledMcpServersCheck
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { McpHub, personalServer } from "./McpHub.ts";
import { StalledMcpServers, type StalledServer } from "./StalledMcpServers.ts";

/** How long after a stall the check runs: a blip has passed, a download has had time to finish. */
export const CHECK_AFTER = "2 minutes";
/** What Claude Code gives a server to connect. */
const CONNECT_WITHIN = Duration.seconds(30);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const stalled = yield* StalledMcpServers;
    const hub = yield* McpHub;
    // One check for each first stall: a stall is published once, and a check only answers for its own.
    const check = (stall: StalledServer) =>
      Effect.sleep(CHECK_AFTER).pipe(
        Effect.andThen(Effect.timed(hub.tools(personalServer(stall.server)))),
        Effect.flatMap(([took]) => (Duration.isLessThanOrEqualTo(took, CONNECT_WITHIN) ? stalled.answered(stall) : Effect.void)),
        // Still not answering: it waits out its skip.
        Effect.catchCause(() => Effect.void),
      );
    yield* stalled.stalls.pipe(
      Stream.runForEach((stall) => Effect.forkScoped(check(stall))),
      Effect.forkScoped,
    );
  }),
);
