// ), packages/source-control-forgejo/src/server/ForgejoPullRequestProvider.test.ts @ cf4514d19f.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

it.effect("filters listed pull requests by the requested state", () =>
  Effect.gen(function* () {
    // Forgejo answers a `state=closed` query with merged and closed-unmerged rows alike.
    const rows = [true, false].map((merged) => ({
      number: merged ? 1 : 2,
      title: `Pull request ${merged ? 1 : 2}`,
      body: "",
      html_url: `https://forge.example:3000/maria/project/pulls/${merged ? 1 : 2}`,
      user: { login: "maria" },
      state: "closed",
      merged,
      head: { ref: "feature", sha: "head-sha", repo: null },
      base: { ref: "main", sha: "base-sha", repo: null },
      created_at: "2026-10-12T00:00:00Z",
      updated_at: "2026-10-12T00:00:00Z",
      closed_at: "2026-10-13T00:00:00Z",
      merged_at: merged ? "2026-10-13T00:00:00Z" : null,
      labels: [],
    }));
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            const [path, query] = input.path.split("?");
            assert.strictEqual(path, "repos/maria/project/pulls");
            const params = new URLSearchParams(query);
            // A merged list asks Forgejo for closed rows and separates them itself.
            const state = params.get("state");
            assert.ok(state === "closed" || state === "open" || state === "all");
            const page = params.get("page") === "1" && state !== "open" ? rows : [];
            return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(page)));
          },
        }),
      ),
    );
    const input = {
      cwd: "/forgejo",
      repository: "maria/project",
      host: "forge.example:3000",
      involvement: "all" as const,
      viewer: "maria",
      limit: 10,
    };
    const numbers = (state: "open" | "closed" | "merged" | "all") =>
      provider
        .listChangeRequests({ ...input, state })
        .pipe(Effect.map((page) => page.items.map((item) => item.number)));

    assert.deepStrictEqual(yield* numbers("merged"), [1]);
    assert.deepStrictEqual(yield* numbers("closed"), [2]);
    assert.deepStrictEqual(yield* numbers("all"), [1, 2]);
    assert.deepStrictEqual(yield* numbers("open"), []);
  }),
);
