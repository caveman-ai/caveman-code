---
name: verify-ui-change
description: Check a UI change in a real browser by starting the app, opening the affected page, using it as a person would, and reading the page and console for errors. Use after changing frontend code and before calling the change done.
---

# Verify a UI change in the browser

1. Start the app with the repository's dev command if it is not already running, and note the URL. Stop only processes you started.
2. Open the page the change affects.
3. Use the page's accessibility snapshot to find elements; click, type and submit through the change's main path and one error path.
4. After each step, check the page shows what it should and the console has no new errors or failed requests.
5. Take a screenshot of the final state when it helps the user see the result.
6. Report what you exercised, what passed, and anything that broke, with the console message verbatim.
