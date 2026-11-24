import { ProviderInstanceId, type PullRequestReviewGuide } from "@caveman-app/protocol";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PullRequestReviewGuides from "./PullRequestReviewGuides.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = PullRequestReviewGuides.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const key = { host: "github.com", repository: "acme/widgets", number: 7 };
const base = {
  headSha: "abc1234",
  generatedAt: "2026-10-19T00:00:00.000Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  stops: [],
} satisfies PullRequestReviewGuide;

describe("PullRequestReviewGuideRepository", () => {
  it.effect("keeps a guide's overview and before/after through a round trip", () =>
    Effect.gen(function* () {
      const guides = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
      const guide: PullRequestReviewGuide = {
        ...base,
        overview: "Merge gate blocks red CI.",
        beforeAfter: {
          title: "Merge on a Ready row",
          rows: [
            { op: " ", depth: 0, text: "Merge pressed" },
            { op: "+", depth: 1, text: "red CI → refuse", stop: 1 },
          ],
        },
      };
      yield* guides.put(key, guide);
      assert.deepStrictEqual(Option.getOrNull(yield* guides.get(key)), guide);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a guide stored before either field existed", () =>
    Effect.gen(function* () {
      const guides = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
      yield* guides.put(key, base);
      assert.deepStrictEqual(Option.getOrNull(yield* guides.get(key)), base);
    }).pipe(Effect.provide(layer)),
  );
});
