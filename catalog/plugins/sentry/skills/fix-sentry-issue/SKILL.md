---
name: fix-sentry-issue
description: Investigate a Sentry issue by reading its stack trace, events, tags and breadcrumbs, then reproduce and fix it in this repository with a regression test. Use when given a Sentry issue link or ID, or asked to fix the top errors.
---

# Fix a Sentry issue

1. Get the issue (link, short ID, or the project's top unresolved issues by events or users affected).
2. Read the latest event: exception, full stack trace, breadcrumbs, request data and tags (release, environment, browser or OS). Compare two or three events to see what they share.
3. Map the in-app frames to files in this checkout. Check the release tag against `git log` to make sure you read the code that actually ran.
4. Write a failing test that reproduces the error, then fix the root cause, not the line that threw.
5. Report: the cause, the fix, the test, and the releases affected. Resolve the issue in Sentry only if the user asks, preferably as resolved in the next release.
