// A Cloud computer's tools and servers containers see the workspace, their own
// home and, read-only at the same paths, the runtime's space checkouts and
// profile skills (the pod mounts them). Nothing they run is copied into a home
// the agent can write: a stdio server starts from the checkout itself. The one
// thing still copied is Claude Agent's plugin copy (`<state>/plugins/claude/
// <copy>`), and only where the pod does not mount it: then it is copied afresh
// once per runtime run, never trusting what a home already holds, under a name
// that changes with its content.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginMcpServer } from "@caveman-app/engine-core/server/SessionPlugins";

import { SANDBOX_LAUNCHER } from "../plugins/resolve.ts";
import { toolsCommand, toolsRun } from "./tools.ts";

const homes = new Map<string, Promise<string>>();
/** The container's $HOME behind `socket`, asked once per socket. */
export const toolsHome = (socket: string) => {
  let home = homes.get(socket);
  if (home === undefined) {
    home = toolsRun(socket, "/", ["sh", "-c", 'printf %s "$HOME"']).then((r) => {
      if (r.code !== 0 || !r.stdout.startsWith("/")) throw new Error(`the tools container has no home (${r.stderr.trim().slice(0, 200)})`);
      return r.stdout;
    });
    homes.set(socket, home);
    home.catch(() => homes.delete(socket));
  }
  return home;
};

const copied = new Map<string, Promise<void>>();
/**
 * Copies `dir` to `target` in the container (tar over the exec channel), replacing whatever is there:
 * the home is the agent's to write, so nothing in it is taken as a finished copy. Once per runtime run.
 * ponytail: the agent's own uid can still change the copy during this run; Claude, which reads it, runs as that uid anyway.
 */
export function copyDir(socket: string, dir: string, target: string): Promise<void> {
  const key = `${socket}\0${dir}\0${target}`;
  let done = copied.get(key);
  if (done === undefined) {
    done = (async () => {
      const script = 'set -e; t="$1"; rm -rf "$t.part"; mkdir -p "$t.part"; tar -x -C "$t.part" -f -; rm -rf "$t"; mv "$t.part" "$t"';
      const routed = toolsCommand(socket, "sh", ["-c", script, "sh", target], "/", {}, {});
      await new Promise<void>((resolve, reject) => {
        const untar = spawn(routed.command, routed.args, { env: { ...process.env, ...routed.env }, stdio: ["pipe", "ignore", "pipe"] });
        const tar = spawn("tar", ["-c", "-C", dir, "."], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        untar.stderr.on("data", (chunk) => (stderr += chunk));
        tar.stdout.pipe(untar.stdin);
        tar.on("error", reject);
        untar.on("error", reject);
        untar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`copying ${dir} to the tools container failed: ${stderr.trim().slice(0, 300)}`))));
      });
    })();
    copied.set(key, done);
    done.catch(() => copied.delete(key));
  }
  return done;
}

const mounts = new Map<string, Promise<boolean>>();
/** `dir` is there in the container and it cannot write it: the pod's read-only mount, not something the agent made. */
const mountedReadOnly = (socket: string, dir: string) => {
  const key = `${socket}\0${dir}`;
  let seen = mounts.get(key);
  if (seen === undefined) {
    seen = toolsRun(socket, "/", ["sh", "-c", '[ -d "$1" ] && [ ! -w "$1" ]', "sh", dir]).then((r) => r.code === 0);
    mounts.set(key, seen);
    seen.catch(() => mounts.delete(key));
  }
  return seen;
};

const stateSpellings = (stateDir: string) => {
  const real = (() => {
    try {
      return fs.realpathSync(stateDir);
    } catch {
      return stateDir;
    }
  })();
  return [...new Set([real, stateDir])];
};

/**
 * A stdio server as it starts in the tools or servers container: from its checkout, which the pod mounts
 * read-only at the same path; the launcher's package cache in that container's home; no denied path from
 * the runtime's state dir (it is not there to deny).
 */
export async function forTools(socket: string, server: Extract<PluginMcpServer, { readonly type: "stdio" }>, stateDir: string) {
  const launcher = server.args.indexOf(SANDBOX_LAUNCHER);
  if (launcher < 0) return server;
  const states = stateSpellings(stateDir);
  const home = await toolsHome(socket);
  const args = server.args.map((arg, i) => {
    if (i !== launcher + 1) return arg;
    const policy = JSON.parse(arg) as Record<string, unknown>;
    const keep = (list: unknown) => (Array.isArray(list) ? list.filter((p) => typeof p === "string" && !states.some((s) => p === s || p.startsWith(`${s}${path.sep}`))) : list);
    return JSON.stringify({ ...policy, deny: keep(policy.deny), read: keep(policy.read), ...(policy.cache === undefined ? {} : { cache: path.posix.join(home, ".cache", "caveman-plugins") }) });
  });
  return { ...server, args };
}

/**
 * Claude Agent's plugin copies (`<state>/plugins/claude/<name>-<key>`, the key a digest of the plugin's
 * root, which for profile skills is their content generation) where Claude runs: as they are when the pod
 * mounts them read-only, else copied into the tools home afresh.
 */
export async function pluginDirsForTools(socket: string, dirs: ReadonlyArray<string>, stateDir: string): Promise<ReadonlyArray<string>> {
  const states = stateSpellings(stateDir);
  return Promise.all(
    dirs.map(async (dir) => {
      const state = states.find((s) => dir.startsWith(`${s}${path.sep}`));
      const rest = state === undefined ? [] : dir.slice(state.length + 1).split(path.sep);
      if (state === undefined || rest[0] !== "plugins" || rest[1] !== "claude" || rest.length < 3) return dir;
      const root = path.join(state, ...rest.slice(0, 3));
      if (await mountedReadOnly(socket, root)) return dir;
      const target = path.posix.join(await toolsHome(socket), ".caveman", ...rest.slice(0, 3));
      await copyDir(socket, root, target);
      return dir.split(root).join(target);
    }),
  );
}
