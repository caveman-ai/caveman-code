// ), packages/provider-core/src/server/instanceEnvironment.test.ts @ ab3a3cd1.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@caveman-app/shared/HostProcess";

import { mergeProviderInstanceEnvironment, withoutRuntimeEnv } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );
});

describe("withoutRuntimeEnv", () => {
  it("drops the runtime's own variables but keeps the session MCP endpoint it hands an engine", () => {
    const env = withoutRuntimeEnv({
      PATH: "/bin",
      CAVEMAN_CODE_AUTH_TOKEN: "runtime-secret",
      CAVEMAN_RUNTIME_STATE_DIR: "/state",
      CAVEMAN_CODE_MCP_URL: "http://127.0.0.1:1/mcp",
      CAVEMAN_CODE_MCP_BEARER_TOKEN: "session-token",
      CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: "Bearer session-token",
      CAVEMAN_CODE_PI_RUNTIME_MODE: "full-access",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      CAVEMAN_CODE_AUTH_TOKEN: undefined,
      CAVEMAN_RUNTIME_STATE_DIR: undefined,
      CAVEMAN_CODE_MCP_URL: "http://127.0.0.1:1/mcp",
      CAVEMAN_CODE_MCP_BEARER_TOKEN: "session-token",
      CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: "Bearer session-token",
      CAVEMAN_CODE_PI_RUNTIME_MODE: "full-access",
    });
  });
});
