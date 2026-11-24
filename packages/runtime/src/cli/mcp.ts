// `caveman-code mcp [--name <label>] [--at-most read|supervised]`: the stdio MCP server any agent on this computer runs
// to operate Caveman Code as an outside agent (docs/ §2). cli/code.ts loads it
// lazily, so plain `caveman-code` stays fast. Stdout is MCP's alone: the first import sends console output to stderr.
import "../outsideAgent/stdout.ts";

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";

import { Bridge } from "../outsideAgent/bridge.ts";
import { RuntimeLink } from "../outsideAgent/connection.ts";
import { runServer } from "../outsideAgent/server.ts";
import { bundledIn, codeHome, desktopApp, liveRuntime } from "./code.ts";

export const MCP_USAGE = "usage: caveman-code mcp [--name <label>] [--at-most read|supervised]";

export interface McpFlags {
  readonly name?: string | undefined;
  readonly atMost?: "read" | "supervised" | undefined;
}

/** The flags, or what was wrong with them. */
export function parseMcpFlags(argv: ReadonlyArray<string>): McpFlags | { readonly error: string } {
  let name: string | undefined;
  let atMost: "read" | "supervised" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--name") {
      name = value()?.trim();
      if (!name) return { error: "--name needs a label" };
    } else if (flag === "--at-most") {
      const level = value();
      if (level !== "read" && level !== "supervised") return { error: "--at-most takes read or supervised" };
      atMost = level;
    } else return { error: `unknown argument ${arg}` };
  }
  return { name, atMost };
}

/**
 * The app to open, hidden, when no runtime runs: the one this command was bundled in, else the installed one; only
 * on a Mac and for the home that app shows (desktopApp). Elsewhere nothing starts.
 */
export function appToOpen(home: string, entry: string): string | undefined {
  const own = bundledIn(entry);
  if (own !== undefined && fs.existsSync(own)) {
    const ownApp = desktopApp(home, { platform: process.platform, userHome: os.userInfo().homedir, installed: [own] });
    if (ownApp !== undefined) return ownApp;
  }
  return desktopApp(home);
}

const openHidden = (app: string) => {
  // -g: no focus; -j: launched hidden. The app owns the runtime, as it does for `caveman-code`.
  const child = spawn("/usr/bin/open", ["-g", "-j", "-a", app], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
};

/** `bin.mjs code mcp ...`, from cli/code.ts. Resolves when the MCP client goes away. */
export async function runMcpCommand(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(`${MCP_USAGE}\n`);
    return;
  }
  const flags = parseMcpFlags(argv);
  if ("error" in flags) {
    process.stderr.write(`caveman-code mcp: ${flags.error}\n${MCP_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const home = codeHome();
  const entry = (() => {
    try {
      return fs.realpathSync(path.resolve(process.argv[1] ?? ""));
    } catch {
      return "";
    }
  })();
  const link = new RuntimeLink({
    home,
    agentId: randomUUID(),
    atMost: flags.atMost,
    app: appToOpen(home, entry),
    find: liveRuntime,
    openApp: openHidden,
  });
  link.prefetch();
  const bridge = new Bridge({ link, name: flags.name, cwd: process.cwd() });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    link.close();
    // The session client's timers and the server's fibers would keep the process: the client is gone, so are we.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  const exit = await Effect.runPromiseExit(runServer(bridge));
  if (exit._tag === "Failure" && !stopping) {
    process.stderr.write(`caveman-code mcp: the MCP server stopped: ${String(exit.cause)}\n`);
    process.exitCode = 1;
  }
  stop();
}
