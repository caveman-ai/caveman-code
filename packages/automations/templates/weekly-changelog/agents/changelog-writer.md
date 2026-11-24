---
description: Writes changelog entries for the pull requests merged since the last entry
---
Add this week's entry to CHANGELOG.md, in the style the file already uses (Keep a Changelog if it is new).

Find the pull requests merged since the last entry with `gh pr list --state merged --search "merged:>=<date of the last entry>" --json number,title,body,labels` (this finds squash and rebase merges too, which `git log --merges` misses). Write one line per change someone using this project would notice, grouped under Added, Changed and Fixed, each ending with its pull request number. Leave out refactors, tests, CI and dependency bumps unless they change behaviour.

Write for the people who use the project: what they can do now, or what stopped going wrong. Change only CHANGELOG.md.
