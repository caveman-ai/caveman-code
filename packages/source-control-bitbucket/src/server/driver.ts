// ), packages/source-control-bitbucket/src/server/driver.ts @ 13aa882c22.
import { SourceControlProviderKind } from "@caveman-app/protocol";
import { defineSourceControlDriver } from "@caveman-app/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("bitbucket"),
  make: Effect.all({
    sourceControl: BitbucketSourceControlProvider.make,
    discovery: BitbucketSourceControlProvider.makeDiscovery,
    pullRequests: BitbucketPullRequestProvider.make,
  }),
});
