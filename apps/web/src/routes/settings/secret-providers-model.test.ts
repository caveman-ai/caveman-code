import type { SecretProviderInfo, SecretSlot } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import {
  groupSlots,
  providerLine,
  referenceProblem,
  slotKey,
  slotLine,
} from "./secret-providers-model.ts";

const app: SecretProviderInfo = {
  id: "work",
  kind: "one_password",
  label: "Work 1Password",
  supported: true,
  account: "my.1password.com",
};
const service: SecretProviderInfo = {
  id: "ci",
  kind: "one_password",
  label: "CI",
  supported: true,
  service_account: true,
  has_token: true,
};

test("a provider says how it signs in, never a token", () => {
  expect(providerLine(app)).toBe(
    "Through the 1Password app on this computer, account my.1password.com.",
  );
  expect(providerLine(service)).toContain("token is stored encrypted");
  expect(providerLine({ ...service, has_token: false })).toBe(
    "1Password service account. Add its token.",
  );
  expect(providerLine({ ...app, supported: false })).toContain("can't read");
});

test("a key or token row says where it reads from", () => {
  const cursor: SecretSlot = {
    target: { kind: "engine_env", instance_id: "cursor", name: "CURSOR_API_KEY" },
    label: "Cursor · CURSOR_API_KEY",
    group: "engine",
    has_value: false,
  };
  expect(slotLine(cursor, [app])).toBe("Not set.");
  expect(slotLine({ ...cursor, has_value: true }, [app])).toBe(
    "A pasted value is stored on this computer.",
  );
  expect(
    slotLine({ ...cursor, ref: { provider: "work", reference: "op://Dev/Cursor/key" } }, [app]),
  ).toBe("Read from Work 1Password when it is used.");
  expect(
    slotLine({ ...cursor, ref: { provider: "gone", reference: "op://Dev/Cursor/key" } }, [app]),
  ).toContain("was removed");
});

test("only 1Password reference syntax is offered to the runtime", () => {
  expect(referenceProblem("")).toBeNull();
  expect(referenceProblem("op://Dev/Cursor/credential")).toBeNull();
  expect(referenceProblem("op://Dev/Cursor/Section/credential")).toBeNull();
  expect(referenceProblem("sk-live-123")).toContain("op://vault/item/field");
  expect(referenceProblem("op://Dev/{{x}}/f")).not.toBeNull();
  expect(referenceProblem("op://Dev\n/Cursor/f")).not.toBeNull();
});

test("rows group engines before source control, each by label", () => {
  const slot = (label: string, group: SecretSlot["group"]): SecretSlot => ({
    target:
      group === "engine"
        ? { kind: "engine_env", instance_id: label, name: "K" }
        : { kind: "source_control", host: "github", field: "tokens", server_host: label },
    label,
    group,
    has_value: false,
  });
  const groups = groupSlots([
    slot("b", "source_control"),
    slot("z", "engine"),
    slot("a", "engine"),
  ]);
  expect(groups.map((g) => [g.title, g.slots.map((s) => s.label)])).toEqual([
    ["Engine keys", ["a", "z"]],
    ["Source control tokens", ["b"]],
  ]);
  expect(slotKey(groups[1]!.slots[0]!.target)).toBe("host:github:tokens:b");
});
