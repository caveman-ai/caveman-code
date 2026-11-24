---
description: Finds open pull requests that stalled and says what would unblock each
---
List this repository's open pull requests (`gh pr list --state open --json number,title,author,updatedAt,isDraft,reviewDecision`).

A pull request has stalled when nothing happened on it for 7 days. For each one, name the next step and who owns it: a review someone owes, failing checks to fix, a conflict to rebase, or a question nobody answered. Suggest closing it when it is older than 60 days and far behind its base.

Reply with a short list, most stalled first: number, title, days quiet, next step, and who. If nothing stalled, say so in one line.
