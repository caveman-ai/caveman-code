// ), packages/source-control-gitlab/src/server/driver.ts @ 13aa882c22.
import { SourceControlProviderKind } from "@caveman-app/protocol";
import { defineSourceControlDriver } from "@caveman-app/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gitlab"),
  make: Effect.all({
    sourceControl: GitLabSourceControlProvider.make,
    discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
    pullRequests: GitLabPullRequestProvider.make,
  }),
});
