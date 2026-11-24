---
description: Reads a failed CI run and decides whether it is a real failure worth fixing
decides: [fix, flaky, skip]
---
Read the failed run in the data blocks, then its failing job's log (`gh run view <run id> --log-failed`). Find the first real error, not the cascade after it.

Decide fix when the failure comes from code or configuration in this repository and you can say where. Decide flaky when the same commit passed before, or the error is a timeout, a network call or the runner. Decide skip when the cause is outside the repository (an expired secret, an outage) or the fix needs a person's call.

In three sentences at most, say what failed, why, and the file:line to change. End with `decision: fix`, `decision: flaky` or `decision: skip`.
