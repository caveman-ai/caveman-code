---
name: review-pull-request
description: Review a GitHub pull request end to end, reading its diff, description, linked issue, review threads and checks, then leave findings. Use when asked to review a PR, check a PR before merge, or answer review comments.
---

# Review a pull request

1. Find the PR. Use the number or URL you were given; otherwise look up the open PR whose head branch is the current branch (`git branch --show-current`).
2. Read the context first: title, description, linked issues, and existing review threads, so you do not repeat a comment someone already made.
3. Read the diff file by file. For each change, open the surrounding code in this checkout rather than judging the hunk alone. Check out the PR branch locally if the change is large.
4. Read the check runs. A failing check is a finding; read its log before guessing at the cause.
5. Write findings as a list, most serious first. Each one gets the file and line, what is wrong, why it matters, and a concrete fix. Mark nits as nits.
6. Ask before you post anything to GitHub. Post line comments on the lines they refer to, plus one summary comment. Never approve or request changes on the user's behalf unless they ask.

Look for: behaviour that changed without a test, error paths, security (injection, secrets, auth checks), migrations that cannot be rolled forward, and public API changes the description does not mention.
