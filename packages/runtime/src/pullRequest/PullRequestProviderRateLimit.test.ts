// ), apps/server/src/pullRequest/PullRequestProviderRateLimit.test.ts @ ab3a3cd1.
import { SourceControlProviderKind } from "@caveman-app/protocol";
import { assert, it } from "@effect/vitest";

import * as AzureDevOpsCli from "@caveman-app/source-control-azure-devops/server/AzureDevOpsCli";
import * as BitbucketApi from "@caveman-app/source-control-bitbucket/server/BitbucketApi";
import * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as SourceControlRateLimit from "@caveman-app/source-control-core/server/SourceControlRateLimit";
import * as GitLabCli from "@caveman-app/source-control-gitlab/server/GitLabCli";
import { azureDevOpsProviderFailure } from "@caveman-app/source-control-azure-devops/server/AzureDevOpsPullRequestProvider";
import { bitbucketProviderFailure } from "@caveman-app/source-control-bitbucket/server/BitbucketPullRequestProvider";
import { gitHubProviderFailure } from "@caveman-app/source-control-github/server/GitHubPullRequestProvider";
import { gitLabProviderFailure } from "@caveman-app/source-control-gitlab/server/GitLabPullRequestProvider";

const cause = new Error("redacted provider failure");

it("classifies rate limits from every pull-request provider", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new GitHubApi.GitHubApiRateLimitError({ host: "github.com", operation: "execute" }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    gitLabProviderFailure(
      new GitLabCli.GitLabCliRateLimitError({
        operation: "execute",
        command: "glab",
        cwd: "/repo",
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    azureDevOpsProviderFailure(
      new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
        operation: "execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 1,
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    bitbucketProviderFailure(
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status: 429,
        responseBodyLength: 0,
        retryAt: 120_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 120_000 },
  );
});

it("keeps GitHub's exact retry time", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        retryAt: 1_786_802_400_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 1_786_802_400_000 },
  );
});
