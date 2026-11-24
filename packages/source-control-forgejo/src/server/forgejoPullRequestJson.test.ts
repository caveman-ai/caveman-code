// ), packages/source-control-forgejo/src/server/forgejoPullRequestJson.test.ts @ c3cfb5e1e3 (forgejoReview only).
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ForgejoReview, forgejoReview } from "./forgejoPullRequestJson.ts";

const decodeForgejoReview = Schema.decodeSync(ForgejoReview);

describe("forgejoReview", () => {
  it.each([
    ["REQUEST_CHANGES", false, "CHANGES_REQUESTED"],
    ["REQUEST_CHANGES", true, "DISMISSED"],
    ["APPROVED", true, "DISMISSED"],
  ])("reads %s with dismissed %s as %s", (state, dismissed, reviewState) => {
    const mapped = forgejoReview(
      decodeForgejoReview({
        id: 8,
        body: "",
        user: { login: "maria" },
        state,
        dismissed,
        submitted_at: "2026-10-10T19:52:40Z",
        comments_count: 0,
      }),
    );
    assert.strictEqual(mapped.reviewState, reviewState);
  });
});
