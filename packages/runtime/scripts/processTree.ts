// Stopping a runtime a build script or smoke started, with everything it started (PLAN interface 1): its
// stdin ends, which starts the runtime's own graceful shutdown; after the grace period win32 ends the whole
// tree with `taskkill /T /F` (Node can only end one process outright there), and elsewhere the child, spawned
// `detached` so it leads its own process group, gets SIGTERM and then SIGKILL as a group.
import { spawnSync, type ChildProcess } from "node:child_process";

const exited = (child: ChildProcess, ms: number): Promise<boolean> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        const timer = setTimeout(() => (child.off("exit", done), resolve(false)), ms);
        const done = () => (clearTimeout(timer), resolve(true));
        child.once("exit", done);
      });

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is gone already.
  }
};

/** Stops `child` and its descendants; resolves once `child` exited, or after twice the grace if it never does. */
export async function stopTree(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.stdin?.end();
    if (await exited(child, graceMs)) return;
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.stdin?.end();
    signalGroup(child.pid, "SIGTERM");
    if (await exited(child, graceMs)) return;
    signalGroup(child.pid, "SIGKILL");
  }
  await exited(child, graceMs);
}
