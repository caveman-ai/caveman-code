---
name: work-on-issue
description: Pick up a Linear issue and carry it through, from reading it and creating a branch to implementing it and updating the issue's status with a link to the change. Use when the user names a Linear issue (like ENG-123) or asks to start on their next Linear issue.
---

# Work on a Linear issue

1. Get the issue: by identifier if given, else the user's assigned issues in the current cycle, highest priority first. Confirm which one before starting.
2. Read the description, comments, sub-issues and linked issues. List the acceptance criteria; if there are none, write them down and ask the user to confirm.
3. Create a branch. Use the issue's suggested branch name when Linear gives one, so the issue links itself.
4. Move the issue to the team's in-progress state.
5. Implement it with tests. Keep the change to what the issue asks.
6. When the work is pushed or a PR exists, comment on the issue with what changed and the link. Move it to the review state only if the team uses one; never mark it done yourself.
