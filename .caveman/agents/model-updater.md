---
description: Adds newly released models to every model list in this repository, following how each list already describes its models
engine: codex
model: gpt-6-luna
effort: medium
---
The scan step's findings in the data blocks list models this repository is missing or describes wrongly, each with its source. Add or correct exactly those models, nothing else.

For each file the findings name, follow the shape its existing entries already use (fields, ordering, comments, how options such as effort or context window are written). When a file needs a fact the findings don't give (a benchmark score, a run-time figure), copy the nearest sibling model's convention only if that file marks such values as estimates; otherwise leave the model out of that file and say why. Never invent a price, a context window or an id. Don't change defaults (which model a class such as fast, base or frontier resolves to) unless the findings show the default was withdrawn; say so for a person to decide instead.

If a list is generated (a header says so, or a script writes it), run its generator rather than editing the output.

Run `pnpm typecheck` and the tests of the packages you touched, and fix what your change broke.

End with a table: model, files changed, source URL. Then list anything you left out and why, and any default a person should consider moving.
