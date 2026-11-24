---
name: reproduce-ui-bug
description: Reproduce a reported UI bug in a real browser step by step, capture the evidence (console, network, screenshot) and turn the steps into an automated test when the project has a browser test suite. Use when given a frontend bug report.
---

# Reproduce a UI bug

1. Write the report as numbered steps with the expected and actual result.
2. Run them in the browser exactly as written. If it does not reproduce, vary one thing at a time (viewport, signed-in state, data) and note what changes.
3. When it reproduces, capture the console errors, the failing network requests and a screenshot.
4. If the repository has Playwright or another browser test suite, encode the steps as a failing test before fixing.
5. Fix, then rerun both the manual steps and the test.
