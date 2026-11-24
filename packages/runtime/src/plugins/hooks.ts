/**
 * The runtime's hook set: trusted plugins' PreToolUse, PostToolUse,
 * PostToolUseFailure, SessionStart, UserPromptSubmit and Stop `command` hooks, run by the runtime for an engine
 * without hooks of its own (the Caveman engine), in Claude Code's protocol:
 * the event as JSON on stdin; exit 2 blocks with stderr as the reason; or
 * JSON on stdout (`hookSpecificOutput.permissionDecision`, `decision:
 * "block"`, `additionalContext`, `continue: false`). Each command already
 * starts through the containing launcher (resolve.ts `containHook`). Claude
 * Agent runs its plugin hooks natively. `prompt` and `agent` hooks need a
 * model and are left out here.
 *
 * @module plugins/hooks
 */
import { spawn } from "node:child_process";

import { withoutRuntimeEnv } from "@caveman-app/engine-core/server/instanceEnvironment";
import { posixShellCommand } from "@caveman-app/shared/posixShell";
import type { RuntimeHooks } from "@caveman-app/engine-core/server/SessionPlugins";

import { toolsCommand, toolsSocket } from "../cloudLink/tools.ts";
import type { PluginBundle } from "./resolve.ts";

/** The Caveman engine's tools under Claude Code's names, so a plugin's matchers mean the same everywhere. */
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  grep: "Grep",
  glob: "Glob",
  load_skill: "Skill",
  explore: "Task",
};
export const claudeToolName = (tool: string) => CLAUDE_NAMES[tool] ?? tool;

const DEFAULT_TIMEOUT_S = 60;
/** The events the runtime runs for the Caveman engine (the web's Hooks tab lists the same, routes/plugins/model.ts). */
export const RUNTIME_HOOK_EVENTS: ReadonlyArray<string> = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "UserPromptSubmit", "Stop"];
const MAX_OUTPUT = 64 * 1024;

/** Claude Code's matcher: empty or `*` matches every tool, otherwise an anchored regex (or the exact name). */
export function matches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `/bin/sh -c command` here (Git Bash on Windows: posixShellCommand, which throws when it is missing), or on a
 * Cloud computer in the tools container through its exec channel (never beside runtime.key; cloudLink/tools.ts),
 * where `env` crosses as what it adds to the runtime's own.
 */
export function hookLaunch(command: string, env: Record<string, string>, cwd: string, socket = toolsSocket()) {
  if (socket === undefined) return { ...posixShellCommand(command), cwd, env };
  const routed = toolsCommand(socket, "/bin/sh", ["-c", command], cwd, env);
  return { command: routed.command, args: routed.args, cwd: "/", env: { ...(process.env as Record<string, string>), ...routed.env } };
}

const signalGroup = (group: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
};
/**
 * Hooks' process groups that may still hold a process (one running, or one it left in the background). The runtime's
 * own group, which the desktop signals at quit, no longer holds them, so the runtime ends them as it exits.
 */
const hookGroups = new Set<number>();
let endsHookGroups = false;
const remember = (group: number) => {
  for (const known of hookGroups) if (!signalGroup(known, 0)) hookGroups.delete(known);
  hookGroups.add(group);
  if (endsHookGroups) return;
  endsHookGroups = true;
  process.once("exit", () => hookGroups.forEach((known) => signalGroup(known, "SIGKILL")));
};

function runCommand(command: string, input: unknown, env: Record<string, string>, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    let launch: ReturnType<typeof hookLaunch>;
    try {
      launch = hookLaunch(command, env, cwd);
    } catch (error) {
      return resolve({ code: null, stdout: "", stderr: (error as Error).message });
    }
    // Its own process group, so the deadline reaches everything the hook started, not only the launcher.
    const group = process.platform !== "win32";
    const child = spawn(launch.command, [...launch.args], { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: group, windowsHide: true });
    if (group && child.pid !== undefined) remember(child.pid);
    let stdout = "";
    let stderr = "";
    let exited: number | null = null;
    const finish = (outcome: Outcome) => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", end);
      resolve(outcome);
    };
    // 'close' waits for every holder of the hook's output (a process it backgrounded) and a hook may ignore SIGTERM:
    // at the deadline, or when the call it guards is stopped, the whole group is killed and the hook has said what it
    // said by then.
    const end = () => {
      if (group && child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: exited, stdout, stderr });
    };
    const deadline = setTimeout(end, timeoutS * 1000);
    signal?.addEventListener("abort", end, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_OUTPUT)));
    child.on("exit", (code) => (exited = code));
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

/** What one hook said: a block with its reason, text for the model, or nothing. */
function verdict(outcome: Outcome): { readonly block?: string; readonly context?: string } {
  if (outcome.code === 2) return { block: outcome.stderr.trim() || "blocked by a hook" };
  if (outcome.code !== 0) return {};
  const text = outcome.stdout.trim();
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = text.startsWith("{") ? JSON.parse(text) : undefined;
    json = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    json = undefined;
  }
  if (json === undefined) return text === "" ? {} : { context: text };
  const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const reason = String(specific.permissionDecisionReason ?? json.reason ?? json.stopReason ?? "blocked by a hook");
  // `ask` needs a person the runtime cannot reach mid-call: refused, with the hook's reason.
  if (specific.permissionDecision === "deny" || specific.permissionDecision === "ask") return { block: reason };
  if (json.decision === "block" || json.continue === false) return { block: reason };
  return typeof specific.additionalContext === "string" && specific.additionalContext !== "" ? { context: specific.additionalContext } : {};
}

/**
 * The hook set for one thread's bundle (already only trusted plugins'
 * hooks), or undefined when it has none the runtime runs.
 */
export function makeHookRunner(bundle: PluginBundle, context: { readonly sessionId: string; readonly cwd: string }): RuntimeHooks | undefined {
  const runnable = bundle.hooks.filter(
    (h) => RUNTIME_HOOK_EVENTS.includes(h.event) && h.hook.type === "command" && typeof h.hook.command === "string",
  );
  if (runnable.length === 0) return undefined;
  const roots = new Map(bundle.plugins.map((p) => [p.id, p.root]));
  const base = withoutRuntimeEnv(process.env) as Record<string, string>;
  /** `matched`: what the event's matchers test, a tool's name or how the session started; undefined for events without matchers. */
  const run = async (event: string, matched: string | undefined, payload: Record<string, unknown>, signal?: AbortSignal) => {
    const out: Array<ReturnType<typeof verdict>> = [];
    for (const hook of runnable) {
      if (signal?.aborted) break;
      if (hook.event !== event || (matched !== undefined && !matches(hook.matcher, matched))) continue;
      const outcome = await runCommand(
        String(hook.hook.command),
        { session_id: context.sessionId, cwd: context.cwd, hook_event_name: event, ...payload },
        { ...base, CLAUDE_PROJECT_DIR: context.cwd, CLAUDE_PLUGIN_ROOT: roots.get(hook.plugin) ?? "" },
        context.cwd,
        typeof hook.hook.timeout === "number" ? hook.hook.timeout : DEFAULT_TIMEOUT_S,
        signal,
      );
      const said = verdict(outcome);
      out.push(said);
      // The first refusal decides; later hooks of a refused call never run.
      if (said.block !== undefined && event === "PreToolUse") break;
    }
    return out;
  };
  const toolInput = (input: unknown) => {
    const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return typeof fields.path === "string" && fields.file_path === undefined ? { ...fields, file_path: fields.path } : fields;
  };
  const joined = (texts: ReadonlyArray<string | undefined>) => {
    const kept = texts.filter((t): t is string => t !== undefined && t !== "");
    return kept.length === 0 ? undefined : kept.join("\n\n");
  };
  return {
    preToolUse: async (tool, input, signal) => {
      const name = claudeToolName(tool);
      return (await run("PreToolUse", name, { tool_name: name, tool_input: toolInput(input) }, signal)).find((v) => v.block !== undefined)?.block;
    },
    postToolUse: async (tool, input, output) => {
      const name = claudeToolName(tool);
      const said = await run("PostToolUse", name, { tool_name: name, tool_input: toolInput(input), tool_response: output });
      return joined(said.map((v) => v.block ?? v.context));
    },
    sessionStart: async (source) => joined((await run("SessionStart", source, { source })).map((v) => v.context)),
    stop: async (again) => (await run("Stop", undefined, { stop_hook_active: again })).find((v) => v.block !== undefined)?.block,
    // Claude Code's: exit 2 or `decision: "block"` refuses the prompt with its reason; stdout or additionalContext rides along.
    userPromptSubmit: async (prompt) => {
      const said = await run("UserPromptSubmit", undefined, { prompt });
      const block = said.find((v) => v.block !== undefined)?.block;
      const context = joined(said.map((v) => v.context));
      return { ...(block === undefined ? {} : { block }), ...(context === undefined ? {} : { context }) };
    },
    postToolUseFailure: async (tool, input, error) => {
      const name = claudeToolName(tool);
      const said = await run("PostToolUseFailure", name, { tool_name: name, tool_input: toolInput(input), error });
      return joined(said.map((v) => v.block ?? v.context));
    },
  };
}

/**
 * A hook set with one more source of PostToolUse notes (memory's pushes, memory/MemoryPush.ts):
 * both notes reach the model, the plugins' first. Without plugin hooks, the note source alone.
 */
export function withPostToolUseNote(hooks: RuntimeHooks | undefined, note: RuntimeHooks["postToolUse"] | undefined): RuntimeHooks | undefined {
  if (note === undefined) return hooks;
  return {
    preToolUse: hooks?.preToolUse ?? (async () => undefined),
    postToolUse: async (tool, input, output) => {
      const texts = [await hooks?.postToolUse(tool, input, output), await note(tool, input, output)].filter((t): t is string => t !== undefined && t !== "");
      return texts.length === 0 ? undefined : texts.join("\n\n");
    },
    sessionStart: hooks?.sessionStart ?? (async () => undefined),
    stop: hooks?.stop ?? (async () => undefined),
    ...(hooks?.userPromptSubmit === undefined ? {} : { userPromptSubmit: hooks.userPromptSubmit }),
    ...(hooks?.postToolUseFailure === undefined ? {} : { postToolUseFailure: hooks.postToolUseFailure }),
  };
}
