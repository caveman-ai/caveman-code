// Settings > Secret providers end to end below the wire: the Session Protocol handlers on the runtime's real settings
// file and secret store, the real 1Password driver against a fake `op`. What is checked above all: a value read from
// 1Password and a service account's token never reach a reply, the settings file or the secret store's plain files;
// only references do.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@caveman-app/protocol";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { OUTSIDE_SECRET_MANAGER } from "../cloudLink/credentialRule.ts";
import { cloudComputerUnderRule } from "../cloudLink/credentialRule.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeDriver } from "../secrets/OnePasswordSecretProvider.ts";
import * as SecretProviderTokens from "../secrets/SecretProviderTokens.ts";
import { layerWith as resolverWith, SecretResolver } from "../secrets/SecretResolver.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { resolveSourceControlHostSecrets } from "../sourceControl/sourceControlHostSecrets.ts";
import { makeSecretProviderHandlers, secretProviderIdFromName } from "./secretProviders.ts";

const GITHUB_TOKEN = ("gh" + "p_resolvedFrom1PasswordToken0123456789");
const CURSOR_KEY = "crsr_resolvedFrom1PasswordKey0123456789";
const SERVICE_TOKEN = "ops_eyJ0b2tlbiI6InNlcnZpY2UtYWNjb3VudC0wMTIzNDU2Nzg5In0.fake";

/** A fake `op` that answers `whoami`, `read` and `inject` from a fixed vault. */
const fakeOp = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-fake-op-"));
  const binary = NodePath.join(dir, "op");
  const secrets = {
    "op://Dev/GitHub/token": GITHUB_TOKEN,
    "op://Dev/Cursor/credential": CURSOR_KEY,
  };
  NodeFS.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("fs");
const secrets = ${JSON.stringify(secrets)};
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
if (command === "whoami") { process.stdout.write("URL: https://my.1password.com\\n"); process.exit(0); }
if (command === "read") {
  const ref = args[args.length - 1];
  if (Object.hasOwn(secrets, ref)) { process.stdout.write(secrets[ref]); process.exit(0); }
  process.stderr.write("[ERROR] could not read secret: isn't an item in the vault"); process.exit(1);
}
if (command === "inject") {
  const file = args[args.indexOf("-i") + 1];
  process.stdout.write(fs.readFileSync(file, "utf8").replace(/\\{\\{ (op:\\/\\/[^}]+?) \\}\\}/g, (_, r) => secrets[r] ?? "") + "\\n");
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  return binary;
};

const layer = () => {
  const settings = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "caveman-secret-providers-test-" }),
      ),
    ),
  );
  const resolver = Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      return resolverWith({
        drivers: [makeDriver({ binary: fakeOp() })],
        secretProviders: service.getSettings.pipe(
          Effect.map((s) => s.secretProviders),
          Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
        ),
      });
    }),
  );
  return resolver.pipe(
    Layer.provideMerge(SecretProviderTokens.layer),
    Layer.provideMerge(settings),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );
};

/** Every file under the runtime's state directory, as text. */
const stateFiles = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const out: Array<string> = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(NodeFS.readFileSync(full).toString("latin1"));
    }
  };
  walk(config.stateDir);
  return out.join("\n");
});

const assertNoValue = (text: string) => {
  for (const value of [GITHUB_TOKEN, CURSOR_KEY, SERVICE_TOKEN]) assert.notInclude(text, value);
};

it.effect(
  "connects 1Password, points a GitHub token and an engine key at it, and never keeps a value",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const resolver = yield* SecretResolver;
      // An engine account that takes a key, as engine.account.add makes one.
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("cursor"),
        instance: {
          driver: ProviderDriverKind.make("cursor"),
          enabled: true,
          environment: [
            { name: "CURSOR_API_KEY", value: "pasted-key-0123456789abcdef", sensitive: true },
          ],
        },
      });
      const { handlers } = yield* makeSecretProviderHandlers;
      const call = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(Effect.tap((reply) => Effect.sync(() => assertNoValue(JSON.stringify(reply)))));

      const empty = yield* call(handlers["secret_provider.list"]({} as never, undefined as never));
      assert.deepStrictEqual(empty.providers, []);
      assert.isTrue(empty.slots.some((s) => s.label === "GitHub token · github.com"));
      assert.isTrue(empty.slots.some((s) => s.label === "Cursor · CURSOR_API_KEY" && s.has_value));

      const saved = yield* call(
        handlers["secret_provider.save"](
          { request_id: "r1", label: "Work 1Password", account: "my.1password.com" } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(saved.providers, [
        {
          id: "work-1password",
          kind: "one_password",
          label: "Work 1Password",
          supported: true,
          account: "my.1password.com",
        },
      ]);

      // An account op would take as a flag is refused.
      const flag = yield* Effect.flip(
        handlers["secret_provider.save"](
          { request_id: "r2", label: "Bad", account: "--help" } as never,
          undefined as never,
        ),
      );
      assert.strictEqual(flag.reason, "invalid_params");

      const signedIn = yield* call(
        handlers["secret_provider.check"](
          { request_id: "r3", id: "work-1password" } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(signedIn, { ok: true, message: "Work 1Password is signed in." });
      const readable = yield* call(
        handlers["secret_provider.check"](
          { request_id: "r4", id: "work-1password", reference: "op://Dev/GitHub/token" } as never,
          undefined as never,
        ),
      );
      assert.isTrue(readable.ok);
      const missing = yield* call(
        handlers["secret_provider.check"](
          { request_id: "r5", id: "work-1password", reference: "op://Dev/Nope/token" } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(missing, {
        ok: false,
        message: "Work 1Password has no such vault, item or field.",
      });

      // Not a reference, an unknown provider: refused before anything is stored.
      const pasted = yield* Effect.flip(
        handlers["secret_slot.set"](
          {
            request_id: "r6",
            target: {
              kind: "source_control",
              host: "github",
              field: "tokens",
              server_host: "github.com",
            },
            ref: { provider: "work-1password", reference: "ghp_pasted" },
          } as never,
          undefined as never,
        ),
      );
      assert.strictEqual(pasted.reason, "invalid_params");
      const unknown = yield* Effect.flip(
        handlers["secret_slot.set"](
          {
            request_id: "r7",
            target: {
              kind: "source_control",
              host: "github",
              field: "tokens",
              server_host: "github.com",
            },
            ref: { provider: "nope", reference: "op://Dev/GitHub/token" },
          } as never,
          undefined as never,
        ),
      );
      assert.strictEqual(unknown.reason, "not_found");

      const github = yield* call(
        handlers["secret_slot.set"](
          {
            request_id: "r8",
            target: {
              kind: "source_control",
              host: "github",
              field: "tokens",
              server_host: "github.com",
            },
            ref: { provider: "work-1password", reference: "op://Dev/GitHub/token" },
          } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(
        github.slots.find((s) => s.label === "GitHub token · github.com")?.ref,
        { provider: "work-1password", reference: "op://Dev/GitHub/token" },
      );
      const cursor = yield* call(
        handlers["secret_slot.set"](
          {
            request_id: "r9",
            target: { kind: "engine_env", instance_id: "cursor", name: "CURSOR_API_KEY" },
            ref: { provider: "work-1password", reference: "op://Dev/Cursor/credential" },
          } as never,
          undefined as never,
        ),
      );
      const cursorSlot = cursor.slots.find((s) => s.label === "Cursor · CURSOR_API_KEY")!;
      assert.deepStrictEqual(cursorSlot.ref, {
        provider: "work-1password",
        reference: "op://Dev/Cursor/credential",
      });
      // The pasted key is gone with it.
      assert.isFalse(cursorSlot.has_value);

      // Claude Agent's settings never take one.
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("claudeAgent"),
        instance: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
      });
      const claude = yield* Effect.flip(
        handlers["secret_slot.set"](
          {
            request_id: "r10",
            target: { kind: "engine_env", instance_id: "claudeAgent", name: "ANTHROPIC_API_KEY" },
            ref: { provider: "work-1password", reference: "op://Dev/Cursor/credential" },
          } as never,
          undefined as never,
        ),
      );
      assert.strictEqual(claude.reason, "invalid_params");

      // Used: the host credential resolves at use time, from memory only.
      const now = yield* settings.getSettings;
      const hosts = yield* resolveSourceControlHostSecrets(
        resolver,
        now.sourceControlHosts,
        "github",
      );
      assert.strictEqual(
        (hosts.github!.tokens as Record<string, string>)["github.com"],
        GITHUB_TOKEN,
      );
      const [key] = yield* resolver.read([
        now.providerInstances[ProviderInstanceId.make("cursor")]!.environment![0]!.value as never,
      ]);
      assert.strictEqual(key, CURSOR_KEY);

      // A service account: the token goes in once and is never in a reply, the settings file or a plain file.
      const ci = yield* call(
        handlers["secret_provider.save"](
          {
            request_id: "r11",
            label: "CI",
            service_account: true,
            service_account_token: SERVICE_TOKEN,
          } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(
        ci.providers.find((p) => p.id === "ci"),
        {
          id: "ci",
          kind: "one_password",
          label: "CI",
          supported: true,
          service_account: true,
          has_token: true,
        },
      );

      // The settings file holds providers and references, never a value; nothing in the state directory does.
      const config = yield* ServerConfig.ServerConfig;
      const file = NodeFS.readFileSync(config.settingsPath, "utf8");
      assert.include(file, "op://Dev/GitHub/token");
      assert.include(file, "op://Dev/Cursor/credential");
      assertNoValue(file);
      assertNoValue(yield* stateFiles);

      const removed = yield* call(
        handlers["secret_provider.remove"](
          { request_id: "r12", id: "ci" } as never,
          undefined as never,
        ),
      );
      assert.isFalse(removed.providers.some((p) => p.id === "ci"));
      assert.isFalse(yield* (yield* SecretProviderTokens.SecretProviderTokens).has("ci"));
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "on a Cloud computer that keeps nothing of its person's, no secret manager is connected and no setting points at one; what an earlier run connected is still listed, taken off and removed",
  () => {
    // The rule comes on while the computer runs (Cloud refuses a credential route): what was connected before stays to be removed.
    const computer = cloudComputerUnderRule(false);
    return Effect.gen(function* () {
      const { handlers } = yield* makeSecretProviderHandlers;
      const github = {
        kind: "source_control",
        host: "github",
        field: "tokens",
        server_host: "github.com",
      };
      yield* handlers["secret_provider.save"](
        { request_id: "r1", label: "Work 1Password", account: "my.1password.com" } as never,
        undefined as never,
      );
      yield* handlers["secret_slot.set"](
        {
          request_id: "r2",
          target: github,
          ref: { provider: "work-1password", reference: "op://Dev/GitHub/token" },
        } as never,
        undefined as never,
      );
      computer.turnOn();

      // A service account's token, an app sign-in, an edit of the one that is there: none is taken.
      for (const params of [
        {
          request_id: "r3",
          label: "CI",
          service_account: true,
          service_account_token: SERVICE_TOKEN,
        },
        { request_id: "r4", label: "Home", account: "you@example.com" },
        { request_id: "r5", id: "work-1password", label: "Work", account: "my.1password.com" },
      ]) {
        const refused = yield* Effect.flip(
          handlers["secret_provider.save"](params as never, undefined as never),
        );
        assert.deepStrictEqual(
          { reason: refused.reason, message: refused.message },
          { reason: "unsupported", message: OUTSIDE_SECRET_MANAGER },
        );
      }
      // Nor is a setting pointed at one: its value would be read into this computer.
      const pointed = yield* Effect.flip(
        handlers["secret_slot.set"](
          {
            request_id: "r6",
            target: { kind: "source_control", host: "bitbucket", field: "accessToken" },
            ref: { provider: "work-1password", reference: "op://Dev/GitHub/token" },
          } as never,
          undefined as never,
        ),
      );
      assert.deepStrictEqual(
        { reason: pointed.reason, message: pointed.message },
        { reason: "unsupported", message: OUTSIDE_SECRET_MANAGER },
      );
      assert.isFalse(yield* (yield* SecretProviderTokens.SecretProviderTokens).has("ci"));
      assertNoValue(yield* stateFiles);

      // What was there is still listed, and goes: the setting off it, then the provider.
      const listed = yield* handlers["secret_provider.list"]({} as never, undefined as never);
      assert.deepStrictEqual(
        listed.providers.map((p) => p.id),
        ["work-1password"],
      );
      assert.deepStrictEqual(
        listed.slots.find((s) => s.label === "GitHub token · github.com")?.ref,
        { provider: "work-1password", reference: "op://Dev/GitHub/token" },
      );
      const off = yield* handlers["secret_slot.set"](
        { request_id: "r7", target: github, ref: null } as never,
        undefined as never,
      );
      assert.isUndefined(off.slots.find((s) => s.label === "GitHub token · github.com")?.ref);
      const removed = yield* handlers["secret_provider.remove"](
        { request_id: "r8", id: "work-1password" } as never,
        undefined as never,
      );
      assert.deepStrictEqual(removed.providers, []);
    }).pipe(Effect.provide(computer.layer), Effect.provide(layer()));
  },
);

it("names a provider by a slug of its name, or not at all", () => {
  assert.strictEqual(secretProviderIdFromName("1Password"), "1password");
  assert.strictEqual(secretProviderIdFromName("Work · Vault!"), "work-vault");
  assert.strictEqual(secretProviderIdFromName("···"), undefined);
});
