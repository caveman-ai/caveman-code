// ), apps/server/src/codexModelOptions.test.ts @ ab3a3cd1.
import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@caveman-app/protocol";
import { createModelSelection } from "@caveman-app/shared/model";

import { getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
