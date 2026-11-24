import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, it, vi } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import { claudeToolName, matches, hookLaunch, makeHookRunner } from "./hooks.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { containHook, type LaunchPolicy } from "./resolve.ts";
import { spaceIdFor } from "./spaces.ts";
import { makeSpaceRepo } from "./testing.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-hooks-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** One script per event, in Claude Code's hook protocol. */
const GUARD = [
  "#!/bin/sh",
  'input=$(cat)',
  'case "$input" in *\'"rm \'*) echo "no rm here" >&2; exit 2;; esac',
  "exit 0",
].join("\n");
const POST = '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"lint clean"}}\'\n';
const START = '#!/bin/sh\ncat >/dev/null\necho "On call: ana"\n';
const STOP = '#!/bin/sh\ninput=$(cat)\ncase "$input" in *\'"stop_hook_active":true\'*) exit 0;; esac\necho \'{"decision":"block","reason":"run the tests"}\'\n';
const PROMPT = '#!/bin/sh\ninput=$(cat)\ncase "$input" in *\'"prompt":"deploy\'*) echo "no deploys from chat" >&2; exit 2;; esac\necho "Repo: shop"\n';
const FAILED = '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"retry with --force"}}\'\n';

const layer = () =>
  PluginRegistry.layerSessionPlugins.pipe(
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-hooks-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("the runtime's hook set", () => {
  it("matches like Claude Code and speaks its tool names", () => {
    expect(matches(undefined, "Bash")).toBe(true);
    expect(matches("*", "Read")).toBe(true);
    expect(matches("Edit|Write", "Write")).toBe(true);
    expect(matches("Edit|Write", "WriteFile")).toBe(false);
    expect(matches("mcp__linear__.*", "mcp__linear__list_issues")).toBe(true);
    expect(matches("(", "(")).toBe(true);
    expect(claudeToolName("bash")).toBe("Bash");
    expect(claudeToolName("edit_file")).toBe("Edit");
    expect(claudeToolName("mcp__x__y")).toBe("mcp__x__y");
  });

  it("runs a trusted plugin's command hooks, contained, for the Caveman engine; an untrusted plugin's never", async () => {
    const [bare, commit] = makeSpaceRepo(path.join(tmp, "hooks-repo"), {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "guard" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/guard.sh" }] }],
          PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/post.sh" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/start.sh" }, { type: "prompt", prompt: "needs a model" }] }],
          Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/stop.sh" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/prompt.sh" }] }],
          PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/failed.sh" }] }],
        },
      }),
      "guard.sh": GUARD,
      "post.sh": POST,
      "start.sh": START,
      "stop.sh": STOP,
      "prompt.sh": PROMPT,
      "failed.sh": FAILED,
    });
    // The hook scripts must be executable in the checkout.
    const plugin = "guard@space"; // a space migrates to a marketplace named after its repository
    const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const sessions = yield* SessionPlugins;
        yield* settings.updateSettings({ plugins: { spaces: [{ url: bare, commit, enabled: true }] } });
        const untrusted = yield* sessions.caveman!(ThreadId.make("h-untrusted"), cwd);
        // A bare id (no digest of the files trusted) is not trust.
        yield* settings.updateSettings({ plugins: { trusted: [plugin] } });
        const bareId = yield* sessions.caveman!(ThreadId.make("h-bare-id"), cwd);
        yield* (yield* PluginRegistry.PluginRegistry).setTrusted(plugin, true);
        const trusted = yield* sessions.caveman!(ThreadId.make("h-trusted"), cwd);
        const hooks = trusted.hooks!;
        const codexResumed = yield* sessions.codex(ThreadId.make("h-codex"), "resume");
        return {
          untrusted: untrusted.hooks,
          bareId: bareId.hooks,
          pre: [
            yield* Effect.promise(() => hooks.preToolUse("bash", { command: "rm -rf build" })),
            yield* Effect.promise(() => hooks.preToolUse("bash", { command: "ls" })),
            yield* Effect.promise(() => hooks.preToolUse("read_file", { path: "rm x" })),
          ],
          post: [
            yield* Effect.promise(() => hooks.postToolUse("edit_file", { path: "a.ts" }, "edited")),
            yield* Effect.promise(() => hooks.postToolUse("read_file", { path: "a.ts" }, "text")),
          ],
          start: yield* Effect.promise(() => hooks.sessionStart("startup")),
          stop: [yield* Effect.promise(() => hooks.stop(false)), yield* Effect.promise(() => hooks.stop(true))],
          prompt: [yield* Effect.promise(() => hooks.userPromptSubmit!("deploy to prod")), yield* Effect.promise(() => hooks.userPromptSubmit!("fix the cart"))],
          failed: [
            yield* Effect.promise(() => hooks.postToolUseFailure!("bash", { command: "make" }, "exit 2")),
            yield* Effect.promise(() => hooks.postToolUseFailure!("read_file", { path: "a.ts" }, "missing")),
          ],
          codex: (yield* sessions.codex(ThreadId.make("h-codex"), "startup")).developerInstructions,
          codexResumed: codexResumed.developerInstructions,
          codexCompacted: yield* Effect.promise(() => codexResumed.afterCompaction?.() ?? Promise.resolve(undefined)),
        };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.untrusted).toBeUndefined();
    expect(out.bareId).toBeUndefined();
    expect(out.pre).toEqual(["no rm here", undefined, undefined]);
    expect(out.post).toEqual(["lint clean", undefined]);
    expect(out.start).toBe("On call: ana");
    expect(out.stop).toEqual(["run the tests", undefined]);
    // UserPromptSubmit: exit 2 refuses the prompt with stderr; stdout goes with it as context.
    expect(out.prompt).toEqual([{ block: "no deploys from chat" }, { context: "Repo: shop" }]);
    // PostToolUseFailure, matched like Claude Code: only the failed Bash call gets the note.
    expect(out.failed).toEqual(["retry with --force", undefined]);
    // Codex gets the SessionStart text the runtime ran for it as its thread loaded, and again after a compaction.
    expect(out.codex).toContain("# SessionStart hooks\n\nOn call: ana");
    expect(out.codexResumed).toContain("# SessionStart hooks\n\nOn call: ana");
    expect(out.codexCompacted).toBe("On call: ana");
  });
});

/** A runner for SessionStart hooks contained as a bundle's are (resolve.ts containHook, through the launcher). */
const sessionStartRunner = (entries: ReadonlyArray<{ readonly matcher?: string; readonly command: string; readonly timeout?: number }>, policy: LaunchPolicy) => {
  const root = fs.mkdtempSync(path.join(tmp, "plugin-"));
  return makeHookRunner(
    {
      plugins: [{ id: "starter@space", root }],
      skills: [],
      commands: [],
      agents: [],
      hooks: entries.map(({ matcher, command, timeout }) => ({
        plugin: "starter@space",
        event: "SessionStart",
        ...(matcher === undefined ? {} : { matcher }),
        hook: containHook({ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }, root, policy)!,
      })),
      mcpServers: {},
      rules: [],
      hookPolicy: policy,
    },
    { sessionId: "s1", cwd: root },
  )!;
};
const uncontained: LaunchPolicy = { keep: ["PATH", "HOME"], deny: [], read: [], sandbox: "none" };

describe.skipIf(process.platform === "win32")("SessionStart matchers", () => {
  it("run only the hooks whose matcher fits how the session started, was resumed or was compacted, like Claude Code", async () => {
    const hooks = sessionStartRunner(
      [
        { matcher: "startup", command: "cat >/dev/null; echo 'startup text'" },
        { matcher: "clear", command: "cat >/dev/null; echo 'clear-only text'" },
        { matcher: "compact", command: "cat >/dev/null; echo 'compact-only reminder'" },
        { matcher: "resume|compact", command: "cat >/dev/null; echo 'resume text'" },
        { command: "cat >/dev/null; echo 'every start'" },
      ],
      uncontained,
    );
    expect(await hooks.sessionStart("startup")).toBe("startup text\n\nevery start");
    expect(await hooks.sessionStart("resume")).toBe("resume text\n\nevery start");
    expect(await hooks.sessionStart("compact")).toBe("compact-only reminder\n\nresume text\n\nevery start");
  });

  it("tell a hook the source on stdin, as Claude Code does", async () => {
    // The event's JSON without its braces, so it reads as text rather than as a hook's JSON answer.
    const hooks = sessionStartRunner([{ command: "tr -d '{}'" }], uncontained);
    expect(await hooks.sessionStart("resume")).toContain('"hook_event_name":"SessionStart","source":"resume"');
  });
});

describe.skipIf(process.platform === "win32")("a hook's timeout", () => {
  const timed = async (run: () => Promise<string | undefined>) => {
    const started = Date.now();
    const said = await run();
    return { said, inTime: Date.now() - started < 3000 };
  };
  // A sleep no other process runs, so ps can tell whether the hook's own one is left.
  const lingering = (seconds: string) =>
    (spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).stdout ?? "").split("\n").filter((line) => line.trim() === `sleep ${seconds}`);

  it("bounds the wait for a hook that runs past it, and its late words are not used", async () => {
    const hooks = sessionStartRunner([{ command: "sleep 8; echo late", timeout: 1 }], uncontained);
    expect(await timed(() => hooks.sessionStart("startup"))).toEqual({ said: undefined, inTime: true });
  }, 30_000);

  it("bounds the wait for a hook that ignores SIGTERM", async () => {
    const hooks = sessionStartRunner([{ command: "trap '' TERM; sleep 8; echo late", timeout: 1 }], uncontained);
    expect(await timed(() => hooks.sessionStart("startup"))).toEqual({ said: undefined, inTime: true });
  }, 30_000);

  it("bounds the wait for a hook whose background process holds its output (npm run dev &), and stops that process", async () => {
    const hooks = sessionStartRunner([{ command: "sleep 8.37 & echo started", timeout: 1 }], uncontained);
    expect(await timed(() => hooks.sessionStart("startup"))).toEqual({ said: "started", inTime: true });
    expect(lingering("8.37")).toEqual([]);
  }, 30_000);

  it.runIf(process.platform === "darwin")("bounds the wait under sandbox-exec, the macOS default", async () => {
    const policy: LaunchPolicy = { keep: ["PATH", "HOME"], deny: [path.join(tmp, "denied")], read: [], sandbox: "macos" };
    const hooks = sessionStartRunner([{ command: "sleep 8.41; echo late", timeout: 1 }], policy);
    expect(await timed(() => hooks.sessionStart("startup"))).toEqual({ said: undefined, inTime: true });
    expect(lingering("8.41")).toEqual([]);
  }, 30_000);

  it("ends a PreToolUse hook still running when its tool call is stopped, and runs no hook after it", async () => {
    const root = fs.mkdtempSync(path.join(tmp, "stopped-"));
    const started = path.join(root, "started");
    const after = path.join(root, "after");
    const hook = (command: string) => ({ plugin: "guard@space", event: "PreToolUse", hook: { type: "command", command, timeout: 20 } });
    const hooks = makeHookRunner(
      {
        plugins: [{ id: "guard@space", root }],
        skills: [],
        commands: [],
        agents: [],
        hooks: [hook(`cat >/dev/null; sleep 20.53 & touch ${started}; sleep 20.59`), hook(`touch ${after}`)],
        mcpServers: {},
        rules: [],
        hookPolicy: uncontained,
      },
      { sessionId: "s1", cwd: root },
    )!;
    const stop = new AbortController();
    const said = hooks.preToolUse("bash", { command: "make test" }, stop.signal);
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000 });
    expect(await timed(() => (stop.abort(), said))).toEqual({ said: undefined, inTime: true });
    expect([...lingering("20.53"), ...lingering("20.59")]).toEqual([]);
    expect(fs.existsSync(after)).toBe(false);
  }, 30_000);

  it("ends what hooks started, running or left in the background, when the runtime exits", () => {
    // A runtime of its own (node runs hooks.ts as it is): one SessionStart hook leaves a process behind, one Stop hook is
    // still running when it exits.
    const root = fs.mkdtempSync(path.join(tmp, "exiting-"));
    const bundle = {
      plugins: [{ id: "bg@space", root }],
      skills: [],
      commands: [],
      agents: [],
      hooks: [
        { plugin: "bg@space", event: "SessionStart", hook: { type: "command", command: "sleep 9.17 >/dev/null 2>&1 & echo left" } },
        { plugin: "bg@space", event: "Stop", hook: { type: "command", command: "sleep 9.19" } },
      ],
      mcpServers: {},
      rules: [],
      hookPolicy: uncontained,
    };
    const script = [
      `const { makeHookRunner } = await import(${JSON.stringify(path.join(import.meta.dirname, "hooks.ts"))});`,
      `const hooks = makeHookRunner(${JSON.stringify(bundle)}, { sessionId: "s1", cwd: ${JSON.stringify(root)} });`,
      "process.stdout.write(String(await hooks.sessionStart(\"startup\")));",
      "void hooks.stop(false);",
      "setTimeout(() => process.exit(0), 500);",
    ].join("\n");
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
    expect({ said: ran.stdout, status: ran.status }).toEqual({ said: "left", status: 0 });
    expect([...lingering("9.17"), ...lingering("9.19")]).toEqual([]);
  }, 30_000);
});

// Skipped on Windows: a Cloud computer is Linux, and its tools channel a Unix socket.
describe.skipIf(process.platform === "win32")("hooks on a Cloud computer", () => {
  it("run in the tools container through its exec channel, with the hook's environment and directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-hook-tools-"));
    const socket = path.join(dir, "tools.sock");
    // TOOLS_SIDE marks a process the tools container started; this (runtime) process has none.
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(socket) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const launch = hookLaunch('echo "${TOOLS_SIDE:-runtime}:$HOOK_VAR:$(pwd -P)"', { ...process.env, HOOK_VAR: "v" } as Record<string, string>, dir, socket);
      expect(launch.args.slice(0, 4)).toEqual(["--disable-sigusr1", TOOLS_EXEC, "exec", "--socket"]);
      const out = execFileSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, encoding: "utf8" });
      expect(out.trim()).toBe(`yes:v:${fs.realpathSync(dir)}`);
      // Off a Cloud computer: the shell, here.
      expect(hookLaunch("true", {}, dir, undefined)).toMatchObject({ command: "/bin/sh", args: ["-c", "true"], cwd: dir });
    } finally {
      tools.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
