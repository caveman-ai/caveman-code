// Which logs a problem report may carry from this computer, and what it says
// about the app and the computer (docs/). The desktop app
// names its own log folder, version and channel when it starts the runtime
// (CAVEMAN_DESKTOP_LOGS_DIR, CAVEMAN_APP_VERSION, CAVEMAN_BUILD_CHANNEL); a
// runtime `caveman code` started has only its own logs.
import { readdirSync, statSync } from "node:fs";
import { homedir, release, userInfo, version as osVersionName } from "node:os";
import { join } from "node:path";

import type { LogSource, ReportEnvironment } from "@caveman-app/bug-report/node";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";

/** The newest files in `dir` whose names match, newest first. */
function newest(dir: string, match: RegExp, count: number): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => match.test(name))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, count)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Newest and most telling first: the budget (BUG_REPORT_LIMITS.logTotalBytes)
 * goes to them. The provider event logs hold chats and file contents, so they
 * are `code`: sent only when the person opts in. Terminal logs are never sent.
 */
export function logSources(input: {
  readonly runtimeLogsDir: string;
  readonly desktopLogsDir?: string | undefined;
}): LogSource[] {
  const sources: LogSource[] = [];
  const desktop = input.desktopLogsDir;
  if (desktop) {
    // desktop.log holds the desktop's own lines and every runtime stdout and stderr line; desktop.1.log is the one before.
    for (const name of ["desktop.log", "desktop.1.log"])
      sources.push({ name, path: join(desktop, name), code: false });
  }
  sources.push(
    {
      name: "event-loop-stalls.ndjson",
      path: join(input.runtimeLogsDir, "event-loop-stalls.ndjson"),
      code: false,
      maxBytes: 64 * 1024,
    },
    {
      name: "server.trace.ndjson",
      path: join(input.runtimeLogsDir, "server.trace.ndjson"),
      code: false,
      maxBytes: 512 * 1024,
    },
  );
  const providerDir = join(input.runtimeLogsDir, "provider");
  for (const name of newest(providerDir, /^events\..*\.log$/, 2))
    sources.push({
      name: `provider-${name}`,
      path: join(providerDir, name),
      code: true,
      maxBytes: 512 * 1024,
    });
  return sources;
}

export function reportEnvironment(env: NodeJS.ProcessEnv = process.env): ReportEnvironment {
  const platform =
    process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
  let userName = "";
  try {
    userName = userInfo().username;
  } catch {
    // No passwd entry (a container): the home path rule still covers it.
  }
  return {
    appVersion: env.CAVEMAN_APP_VERSION || RUNTIME_VERSION,
    // The desktop says its channel; a runtime the `caveman code` command started is the CLI's.
    buildChannel: env.CAVEMAN_BUILD_CHANNEL || "cli",
    platform,
    osVersion: `${osVersionName()} ${release()}`.trim(),
    arch: process.arch,
    homeDir: homedir(),
    userName,
  };
}
