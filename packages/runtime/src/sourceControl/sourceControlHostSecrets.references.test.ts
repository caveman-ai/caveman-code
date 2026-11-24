// Source control credentials that name a secret provider reference (upstream #27746, #27756): GitHub's per-host
// token and Bitbucket's two tokens are found by their schemas, kept as written when the literals around them move to
// the secret store, never redacted for clients (a reference is not a secret) and resolved only for their own host.
import {
  DEFAULT_SERVER_SETTINGS,
  SecretProviderId,
  type ServerSettings,
} from "@caveman-app/protocol";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { SecretResolver } from "../secrets/SecretResolver.ts";
import { mapSettingsSecrets } from "../settingsSecrets.ts";
import {
  collectSourceControlHostSecretReferences,
  resolveSourceControlHostSecrets,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControlHostSecrets.ts";

const ref = { provider: SecretProviderId.make("work"), reference: "op://Dev/GitHub/token" };
const bitbucketRef = {
  provider: SecretProviderId.make("work"),
  reference: "op://Dev/Bitbucket/token",
};
const hosts = {
  github: { tokens: { "github.com": ref, "ghe.acme.test": "ghp_literal_0123456789" } },
  bitbucket: { accessToken: bitbucketRef, email: "", apiToken: "" },
};

const resolver = {
  read: (references: ReadonlyArray<{ readonly reference: string }>) =>
    Effect.succeed(
      references.map((r) =>
        r.reference === "op://Dev/GitHub/token"
          ? "ghp_resolved_0123456789"
          : "bb_resolved_0123456789",
      ),
    ),
} as unknown as SecretResolver["Service"];

describe("source control host secret references", () => {
  it("finds every reference by the hosts' own schemas", () => {
    assert.deepStrictEqual(collectSourceControlHostSecretReferences(hosts), [ref, bitbucketRef]);
  });

  it.effect("resolves one host kind only, leaving the literal beside it", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "github");
      assert.deepStrictEqual(resolved.github!.tokens, {
        "github.com": "ghp_resolved_0123456789",
        "ghe.acme.test": "ghp_literal_0123456789",
      });
      assert.deepStrictEqual(resolved.bitbucket, hosts.bitbucket);
    }),
  );

  it("a reference stays as written when the literals beside it go to the secret store", () => {
    assert.deepStrictEqual(writeSecretFieldValues(hosts.github.tokens, [["ghe.acme.test", ""]]), {
      "github.com": ref,
      "ghe.acme.test": "",
    });
    const stored: Array<string> = [];
    const settings = mapSettingsSecrets(
      { ...DEFAULT_SERVER_SETTINGS, sourceControlHosts: hosts } as ServerSettings,
      (secret) => {
        stored.push(secret.secretName);
        return { value: "", redacted: secret.value.length > 0 };
      },
    );
    // Only literals go to the store (an empty one is visited too, to clear it); both references stay in the settings.
    assert.include(
      stored,
      sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost: "ghe.acme.test" }),
    );
    assert.notInclude(
      stored,
      sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost: "github.com" }),
    );
    assert.notInclude(
      stored,
      sourceControlHostSecretName({ kind: "bitbucket", field: "accessToken", serverHost: null }),
    );
    assert.deepStrictEqual(
      (settings.sourceControlHosts.github!.tokens as Record<string, unknown>)["github.com"],
      ref,
    );
    assert.deepStrictEqual(settings.sourceControlHosts.bitbucket!.accessToken, bitbucketRef);
  });
});
