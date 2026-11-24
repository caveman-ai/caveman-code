// ), apps/server/src/bin.ts @ ab3a3cd1.
/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import { join } from "node:path";

import { stopCurrentDirectoryExeSearch } from "@caveman-app/shared/exeSearch";
import { isEntrypoint } from "./entrypoint.ts";
import { markStartup } from "./startupTrace.ts";

// Before anything spawns: on Windows a bare `git` or `taskkill` never runs a project folder's own copy (exeSearch.ts).
stopCurrentDirectoryExeSearch();

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  markStartup("Node ready");
 // V8's code cache for the module graph below (upstream desktop compileCache.ts): a warm start skips
  // most of its compile, ~0.5 s of the bundle's. The process's own setting, never inherited by the
  // engines and terminals it spawns. Skipped under AppImage, whose mount path changes per launch, and
  // on Windows, which writes the cache's files slowly and synchronously on the main thread at the first
  // flush or at exit (on a cold windows-2025 runner 4-9 s for the bundle, 20-90 s from source): the
  // runtime answered nothing meanwhile, or a graceful stop outlived the desktop's 5 s grace.
  try {
    if (!process.env.APPIMAGE && process.platform !== "win32") {
      const cacheRoot = process.platform === "linux" ? process.env.XDG_CACHE_HOME || join(NodeOS.homedir(), ".cache") : NodeOS.tmpdir();
      NodeModule.enableCompileCache(join(cacheRoot, "caveman-code", "compile-cache"));
    }
  } catch {}

  // `caveman code` comes as the argument `code`: from the npm package's launcher (scripts/npm-launcher.mjs),
  // the desktop app's `caveman-code` (apps/desktop/src/cli.ts) and a person alike, never from argv[1]'s name.
  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__document-text") {
    // An attached document's text, read in a child process of its own (provider/DocumentText.ts).
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "self-check") {
    // `self-check`: the module graph and every native package load here, then exit (selfCheck.ts). Caveman Cloud's
    // computer image runs it in its release start check; `check` is the automation CLI's.
    const { runSelfCheck } = await import("./selfCheck.ts");
    await runSelfCheck();
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "agent" && process.argv[3] === "exec") {
    // `agent exec`: one agent headless (platform C5, the Agent SDK's local host). Only the engine and the agent
    // loader load, never the server's graph, so its first event comes fast; stdout may be its event channel.
    const { runAgentExecCommand } = await import("./cli/agentExec.ts");
    await runAgentExecCommand(process.argv.slice(4));
  } else if (command === "automation" || command === "agent" || command === "apply" || command === "check" || command === "explain") {
    // `automation check|explain|list|new|run|apply`, `agent run`, and `apply`, `check`, `explain` at the top: the automation package and a Session Protocol
    // client, without the server's module graph, so a check answers in well under a second (cli/automation.ts).
    const { runAutomationCli } = await import("./cli/automation.ts");
    runAutomationCli();
  } else if (command === "code") {
    // `caveman code`: plain Node that owns its signals (see cli/code.ts).
    const { runCodeCommand } = await import("./cli/code.ts");
    await runCodeCommand(process.argv.slice(3));
  } else {
    // Crash reports, where the desktop app or a Caveman Cloud computer passed a DSN (observability/CrashReports.ts):
    // the reporter loads only then.
    if (process.env.CAVEMAN_CRASH_DSN) {
      const { startCrashReports } = await import("./observability/CrashReports.ts");
      startCrashReports();
    }
    // A server (the desktop's `--bootstrap-fd 3`, `start`, `serve`) reads the login shell's PATH
    // while the CLI's module graph loads (os-jank.ts).
    if (command === undefined || command === "start" || command === "serve" || process.argv.includes("--bootstrap-fd")) {
      const { prefetchLoginShellEnvironment } = await import("./os-jank.ts");
      prefetchLoginShellEnvironment();
    }
    const { runCli } = await import("./binCli.ts");
    markStartup("modules loaded");
    runCli();
  }
}
