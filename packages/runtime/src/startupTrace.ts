// How long a runtime the desktop starts takes to come up, in phases: Node's own start, the module graph, the native
// addons it loads, and the server's own work up to listening. One line per phase on stderr, which the desktop keeps
// in its log, so a slow first start on a person's PC (a cold disk, an antivirus reading every new file) can be told
// apart from slow work of ours. For the desktop's runtime (--bootstrap-fd) and a Cloud computer's, whose entrypoint
// sets CAVEMAN_STARTUP_TRACE=1 so a slow wake shows in the pod's log: a terminal's `caveman` prints none.
// Plain Node, loaded first by bin.ts.
import { basename } from "node:path";

const enabled = process.argv.includes("--bootstrap-fd") || process.env.CAVEMAN_STARTUP_TRACE === "1";
let natives: Array<string> = [];

if (enabled) {
  const dlopen = process.dlopen;
  process.dlopen = function (this: NodeJS.Process, ...args: Parameters<typeof process.dlopen>) {
    const started = performance.now();
    try {
      return dlopen.apply(this, args);
    } finally {
      natives.push(`${basename(args[1])} ${Math.round(performance.now() - started)} ms`);
    }
  };
}

/** `startup: <phase> at <ms since the process started> ms`, with the native addons loaded since the last phase. */
export function markStartup(phase: string): void {
  if (!enabled) return;
  const loaded = natives.length === 0 ? "" : ` (native: ${natives.join(", ")})`;
  natives = [];
  process.stderr.write(`startup: ${phase} at ${Math.round(performance.now())} ms${loaded}\n`);
}
