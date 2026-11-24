---
name: fix-failing-ci
description: Find why a GitHub Actions run failed, reproduce it locally and fix it. Use when CI is red on a branch or pull request, or the user asks why a check failed.
---

# Fix a failing CI run

1. Find the failing run: the latest workflow run for the current branch, or the check named on the PR.
2. Read the failed job's log. Go to the first error, not the last line; later failures are often fallout.
3. Classify it before you touch code:
   - a real failure from this change (test, type, lint): fix the code;
   - an environment difference (versions, missing secret, OS): compare the workflow file with the local setup;
   - a flake (passes on rerun, timing-dependent): say so and show the evidence; do not paper over it with retries.
4. Reproduce locally with the same command the workflow runs. Read the workflow YAML to get it exactly.
5. Fix, rerun the local command, and report what failed, why, and what changed. Push only if the user asked you to.
