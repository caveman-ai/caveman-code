// ), packages/source-control-github/src/server/driver.ts @ ab3a3cd1.
import { SourceControlProviderKind } from "@caveman-app/protocol";
/**
 * The GitHub driver: repository operations and discovery through `gh` and git, and pull requests
 * through the GitHub REST and GraphQL APIs.
 *
 * @module source-control-github/server/driver
 */
import { defineSourceControlDriver } from "@caveman-app/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("github"),
  make: Effect.all({
    sourceControl: GitHubSourceControlProvider.make,
    discovery: GitHubSourceControlProvider.makeDiscovery,
    pullRequests: GitHubPullRequestProvider.make,
  }),
});
