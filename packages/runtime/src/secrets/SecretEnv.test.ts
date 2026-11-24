// SessionPlugins.secretEnv: a thread's repository secrets for its engine process.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ThreadId } from "@caveman-app/protocol";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterAll, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerDenyAll } from "../plugins/CredentialBroker.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as SessionStore from "../session-protocol/store.ts";
import { ProjectSecrets } from "./ProjectSecrets.ts";
import * as ProjectSecretsLive from "./ProjectSecretsLive.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-secret-env-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

const layer = PluginRegistry.layerSessionPlugins.pipe(
  Layer.provideMerge(PluginRegistry.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(layerDenyAll),
  Layer.provideMerge(ServerSettingsModule.layer),
  Layer.provideMerge(ProjectSecretsLive.layer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-secret-env-" }))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it("gives a thread its repository's secrets from its checkout or a worktree of it, and nothing outside git", async () => {
  const repo = path.join(tmp, "widget");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "https://github.com/acme/widget.git");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = path.join(tmp, "widget-wt");
  git(repo, "worktree", "add", "-q", worktree);
  const outside = path.join(tmp, "not-a-repo");
  fs.mkdirSync(outside);

  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const secrets = yield* ProjectSecrets;
      yield* secrets.set(yield* secrets.keyOf({ path: repo }), [
        { name: "CANARY_SECRET", value: Redacted.make("cvs-canary-value-1234567890") },
      ]);
      const plugins = yield* SessionPlugins;
      const read = (cwd: string | undefined) => plugins.secretEnv!(ThreadId.make("thread-secret-env"), cwd);
      return {
        checkout: yield* read(repo),
        worktree: yield* read(worktree),
        outside: yield* read(outside),
        none: yield* read(undefined),
      };
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  expect(out.checkout).toEqual({ CANARY_SECRET: "cvs-canary-value-1234567890" });
  expect(out.worktree).toEqual(out.checkout);
  expect(out.outside).toEqual({});
  expect(out.none).toEqual({});
});

it("names the repository's hidden secrets, never their values, in every engine's env for the commit hooks", async () => {
  const repo = path.join(tmp, "gadget");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "https://github.com/acme/gadget.git");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const env = await Effect.runPromise(
    Effect.gen(function* () {
      const secrets = yield* ProjectSecrets;
      yield* secrets.set(yield* secrets.keyOf({ path: repo }), [
        { name: "DEPLOY_TOKEN", value: Redacted.make("cvs-live-4f9a2b7c1d8e6a3f") },
        // Too plain to hide, and public by name: injected, but never refused in a commit.
        { name: "MODE", value: Redacted.make("development") },
        { name: "NEXT_PUBLIC_URL", value: Redacted.make("https://gadget.example.com/app/path") },
      ]);
      const store = yield* SessionStore.SessionStore;
      yield* store.putWorkspace({
        workspace: { id: "ws-names", created_at: "2026-10-17T00:00:00Z" },
        session: { id: "ses-names" },
        internal: { threadId: "caveman:ws-names", worktreePath: repo, repoPath: repo },
      } as unknown as SessionStore.WorkspaceRecord);
      return yield* (yield* SessionPlugins).env!(ThreadId.make("caveman:ws-names"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  expect(env.CAVEMAN_SECRET_NAMES).toBe("DEPLOY_TOKEN");
  expect(JSON.stringify(env)).not.toContain("cvs-live-4f9a2b7c1d8e6a3f");
});
