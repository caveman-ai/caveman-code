---
name: release-health
description: Check whether a release introduced new errors or regressions in Sentry, comparing new and regressed issues and error volume with the previous release. Use after a deploy or when asked if a release is healthy.
---

# Check release health

1. Identify the release: the one the user names, else the newest release of this project (match it to `git describe` or the deploy).
2. List issues first seen in that release and issues marked regressed in it.
3. Compare error volume and affected users with the previous release over the same window since deploy.
4. For each new issue, point at the commit in the release most likely to have caused it, using the stack trace's in-app frames.
5. Report in this order: verdict (healthy, watch, roll back), the evidence, and the issues to fix first.
