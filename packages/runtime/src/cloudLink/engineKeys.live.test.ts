// The installed codex reads what a lane-bound launch hands it (engineKeys.ts withEngineKey) as that lane's login, with
// no model call and no real credential: run only with CAVEMAN_LIVE_CLI_AUTH=1 (CAVEMAN_LIVE_CODEX_BIN, default `codex`).
// codex runs with only PATH from here, a throwaway HOME and CODEX_HOME, and a proxy nothing answers on, so it reads
// nothing of this machine's own login and reaches no provider. `codex login status` only reads CODEX_HOME's auth.json.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { CODEX_VAULT_KEY_STAND_IN, EngineCloudKeys, withEngineKey } from "./engineKeys.ts";
import { FollowedLogins, toolsLoginFiles, type FollowedCloud } from "./engineLogins.ts";

const live = process.env.CAVEMAN_LIVE_CLI_AUTH === "1";
const bin = process.env.CAVEMAN_LIVE_CODEX_BIN ?? "codex";
const unsigned = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;

it.skipIf(!live)("codex reads the plan lane's stand-in as its ChatGPT login, and on the key lane no ChatGPT login is left to outrank the key", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-keys-live-"));
  try {
    const codexHome = path.join(root, "codex-home");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    let lane: "followed_login" | "vault_key" = "followed_login";
    const cloud: FollowedCloud = {
      list: async () => [{ engine: "codex", status: "ready" }],
      lanes: async () => ({ lanes: { codex: lane }, followed: ["codex"], person: "live" }),
      get: async () => ({
        engine: "codex",
        version: 1,
        status: "ready",
        access_token: unsigned({ sub: "fixture", exp: Math.floor(Date.now() / 1000) + 3600 }),
        profile: { auth_mode: "chatgpt", account_id: "acct-fixture", id_claims: { email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-fixture" } } },
        person: "live",
      }),
      refresh: async () => Promise.reject(new Error("no refresh")),
      put: async () => ({ version: 1 }),
      remove: async () => undefined,
    };
    const logins = new FollowedLogins();
    logins.connect({ cloud, files: toolsLoginFiles(undefined), paths: { claude: async () => path.join(home, ".claude", ".credentials.json"), codex: async () => path.join(codexHome, "auth.json") } });
    const keys = { get: () => Effect.succeed(("sk-" + "proj-fixture-not-a-key")), set: () => Effect.void };
    const launch = async () => (await Effect.runPromise(withEngineKey("codex", { CODEX_HOME: codexHome }, logins).pipe(Effect.provideService(EngineCloudKeys, keys)))) ?? {};
    // What `codex login status` says (it writes to stderr), with only the launch's env.
    const status = (env: Record<string, string | undefined>) => {
      const run = spawnSync(bin, ["login", "status"], {
        env: { PATH: process.env.PATH, HOME: home, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", ...env, CODEX_HOME: codexHome },
        encoding: "utf8",
        timeout: 30_000,
      });
      return `${run.stdout}${run.stderr}`.trim();
    };

    const plan = await launch();
    expect(plan.OPENAI_API_KEY).toBeUndefined();
    expect(status(plan)).toMatch(/Logged in using ChatGPT/);

    lane = "vault_key";
    const key = await launch();
    expect([key.OPENAI_API_KEY, key.CODEX_API_KEY]).toEqual([CODEX_VAULT_KEY_STAND_IN, CODEX_VAULT_KEY_STAND_IN]);
    expect(fs.existsSync(path.join(codexHome, "auth.json"))).toBe(false);
    expect(status(key)).toBe("Not logged in");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
