// `caveman-runtime agent exec`, from bin.ts before any other CLI module loads: plain Node that owns its exit code
// (0 ended, 1 agent or model error, 2 usage, 3 budget, 4 out of time) and its stdout (the events, when --events -).
import { runAgentExec } from "../agentExec/run.ts";

export async function runAgentExecCommand(argv: ReadonlyArray<string>): Promise<void> {
  // The session decides when it ends, never an empty event loop: without this, a wait nothing else holds open would
  // end the process with Node's own exit 13, outside the contract's codes and before its last event.
  const keepAlive = setInterval(() => undefined, 1 << 30);
  let code: number;
  try {
    code = await runAgentExec(argv);
  } catch (error) {
    // Before the key is read or after the events are closed only (runAgentExec says the rest itself, redacted).
    process.stderr.write(`agent exec: ${error instanceof Error ? error.message : String(error)}\n`);
    code = 1;
  }
  clearInterval(keepAlive);
  // Whatever still holds the event loop (an MCP server's child, a socket) does not hold the exit.
  process.exit(code);
}
