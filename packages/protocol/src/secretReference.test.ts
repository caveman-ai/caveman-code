// Secret provider settings and references (upstream #25709, #27044, #27115, #27746, #27756): references round-trip
// through the stored shape older builds read, writes take only kinds and configs this build checks, and credential
// fields declare which slots hold one.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";
import { isSecretReference, SecretProviderId } from "./secretReference.ts";
import {
  OnePasswordSecretProviderConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  secretReferencesInSettings,
  settingsSecretLiteral,
  SettingsSecretValue,
  withSettingsSecrets,
} from "./settingsSecretValue.ts";

const ref = { provider: "work", reference: "op://Dev/Cursor/credential" };

describe("secret references", () => {
  it("an environment variable's reference is stored beside an empty value, so older builds still decode it", () => {
    const decoded = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable)({
      name: "CURSOR_API_KEY",
      value: "",
      sensitive: true,
      secret: ref,
    });
    expect(decoded.value).toEqual(ref);
    expect(Schema.encodeSync(ProviderInstanceEnvironmentVariable)(decoded)).toEqual({
      name: "CURSOR_API_KEY",
      value: "",
      sensitive: true,
      secret: ref,
    });
    const plain = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable)({
      name: "A",
      value: "x",
    });
    expect(plain.value).toBe("x");
  });

  it("a reference never holds a line break, and is not a string", () => {
    expect(isSecretReference(ref)).toBe(true);
    expect(isSecretReference({ provider: "work", reference: "op://a\n/b/c" })).toBe(false);
    expect(isSecretReference("op://Dev/Cursor/credential")).toBe(false);
  });

  it("settings keep providers; a write takes only a kind and config this build can check", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      secretProviders: {
        work: { kind: "one_password", label: "Work", config: { account: "my.1password.com" } },
      },
    });
    expect(Object.keys(settings.secretProviders)).toEqual(["work"]);
    const decodePatch = Schema.decodeUnknownExit(ServerSettingsPatch);
    expect(
      decodePatch({
        secretProviders: {
          work: { kind: "one_password", label: "Work", config: { account: "my.1password.com" } },
        },
      })._tag,
    ).toBe("Success");
    expect(
      decodePatch({
        secretProviders: {
          ci: { kind: "one_password", label: "CI", config: { serviceAccount: true } },
        },
      })._tag,
    ).toBe("Success");
    expect(decodePatch({ secretProviders: { work: null } })._tag).toBe("Success");
    // Unknown kind, a flag for an account, both ways of signing in at once.
    expect(
      decodePatch({ secretProviders: { x: { kind: "vault", label: "X", config: {} } } })._tag,
    ).toBe("Failure");
    expect(
      decodePatch({
        secretProviders: { x: { kind: "one_password", label: "X", config: { account: "--help" } } },
      })._tag,
    ).toBe("Failure");
    expect(Schema.is(OnePasswordSecretProviderConfig)({ account: "a", serviceAccount: true })).toBe(
      false,
    );
    expect(Schema.is(OnePasswordSecretProviderConfig)({})).toBe(false);
  });

  it("credential fields say which slots hold a reference, and resolve in place", () => {
    const Host = Schema.Struct({
      accessToken: SettingsSecretValue,
      email: Schema.String,
      tokens: Schema.Record(Schema.String, SettingsSecretValue),
    });
    const host = {
      accessToken: ref,
      email: "a@b.c",
      tokens: { "github.com": ref, "ghe.test": "ghp_literal" },
    };
    const slots = secretReferencesInSettings(Host, host);
    expect(slots.map((s) => [s.field, s.key])).toEqual([
      ["accessToken", undefined],
      ["tokens", "github.com"],
    ]);
    const resolved = withSettingsSecrets(
      host,
      slots.map((s) => ({ ...s, value: "resolved" })),
    );
    expect(resolved).toEqual({
      accessToken: "resolved",
      email: "a@b.c",
      tokens: { "github.com": "resolved", "ghe.test": "ghp_literal" },
    });
    expect(settingsSecretLiteral({ ...ref, provider: SecretProviderId.make("work") })).toBe("");
    expect(settingsSecretLiteral("ghp_literal")).toBe("ghp_literal");
  });
});
