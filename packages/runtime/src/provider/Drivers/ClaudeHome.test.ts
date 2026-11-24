// ), apps/server/src/provider/Drivers/ClaudeHome.test.ts @ ab3a3cd1.
import { spawnSync } from "node:child_process";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { envKey } from "@caveman-app/shared/processEnv";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  withoutParentClaudeSession,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude CLI environment", () => {
    it.effect("is the host's, never the runtime's own variables", () =>
      Effect.gen(function* () {
        const saved = process.env.CAVEMAN_CODE_DEV_AUTH_TOKEN;
        process.env.CAVEMAN_CODE_DEV_AUTH_TOKEN = "runtime-dev-token-sentinel";
        try {
          const env = yield* makeClaudeEnvironment(
            { homePath: "" },
            {
              ...process.env,
              HOST_ONLY_VARIABLE: "kept",
              // A user's own Vite project variable stays; only the dev server's URL is the runtime's.
              VITE_API_URL: "https://api.example",
              VITE_DEV_SERVER_URL: "http://dev-server-sentinel",
              CAVEMAN_CODE_OTLP_HEADERS: "authorization=otlp-sentinel",
              CAVEMAN_RUNTIME_ENTRY: "/runtime-entry-sentinel",
              CAVEMAN_CLOUD_LINK_DIR: "/cloud-link-dir-sentinel",
              CAVEMAN_WORKSPACE_ROOT: "/workspace-root-sentinel",
              ELECTRON_RUN_AS_NODE: "1",
            },
          );
          // The SDK spawns the CLI with exactly this env; run a real process with it.
          // Node prints it as /usr/bin/env would; Windows has no /usr/bin/env.
          const seen = spawnSync(process.execPath, ["-e", 'for (const [k, v] of Object.entries(process.env)) console.log(k + "=" + v)'], { env, encoding: "utf8" }).stdout;
          expect(seen).toContain("HOST_ONLY_VARIABLE=kept");
          expect(seen).toContain("VITE_API_URL=https://api.example");
          expect(seen).not.toContain("dev-server-sentinel");
          // Windows keeps the profile's own casing (`Path`).
          expect(seen).toContain(`${envKey(env, "PATH")}=${process.env.PATH}`);
          for (const sentinel of ["runtime-dev-token-sentinel", "otlp-sentinel", "runtime-entry-sentinel", "cloud-link-dir-sentinel", "workspace-root-sentinel", "ELECTRON_RUN_AS_NODE"]) {
            expect(seen).not.toContain(sentinel);
          }
        } finally {
          if (saved === undefined) delete process.env.CAVEMAN_CODE_DEV_AUTH_TOKEN;
          else process.env.CAVEMAN_CODE_DEV_AUTH_TOKEN = saved;
        }
      }),
    );
  });

  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toEqual(
          withoutParentClaudeSession(process.env),
        );

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("drops a parent Claude Code session's variables and keeps the user's config", () =>
      Effect.gen(function* () {
        const parent = {
          PATH: "/usr/bin",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/w/claude",
          CLAUDE_CODE_NO_FLICKER: "1",
          CLAUDECODE: "1",
          CLAUDE_CODE_ENTRYPOINT: "cli",
          CLAUDE_CODE_SESSION_ID: "parent-session",
          CLAUDE_CODE_HOST_SESSION_ID: "host-session",
          CLAUDE_CODE_DESKTOP_APP_VERSION: "1.2.3",
          CLAUDE_AGENT_SDK_VERSION: "0.3.300",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
          CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
          CLAUDE_PID: "123",
          CLAUDE_EFFORT: "xhigh",
          CLAUDE_CODE_INVOKED_SKILLS: "caveman",
          AI_AGENT: "claude-code_2.1.300",
          TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        };
        for (const homePath of ["", "~/.claude-work"]) {
          const env = yield* makeClaudeEnvironment({ homePath }, parent);
          expect(Object.keys(env).filter((name) => !name.startsWith("CLAUDE_CONFIG_DIR"))).toEqual([
            "PATH",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_NO_FLICKER",
          ]);
        }
        const clean = { PATH: "/usr/bin" };
        expect(withoutParentClaudeSession(clean)).toBe(clean);
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
