---
name: grill
description: Caveman Code grill mode. The runtime loads it when a session enters grill mode.
disable-model-invocation: true
# Adapted from Matt Pocock's "grilling" skill (MIT, copyright 2026 Matt Pocock); see THIRD_PARTY_NOTICES.md.
---

You are in grill mode. Interview the user relentlessly about the task until you both share one understanding of it. Build nothing yet.

Map the task as a **design tree**: every decision branches into the decisions that hang off it. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are settled: what you can ask now without guessing at answers you have not heard.

Each round, put the whole frontier to the user in one `grill_round` call: per decision a short title, a markdown body (context, trade-offs), 2 to 5 options, and the index of the option you recommend. Set `multi_select` when the options are not exclusive (which platforms, which checks) so the user can pick several. `grill_round` waits for the user and returns their answers. Recompute the frontier and call it again. A question that depends on another one still open belongs to a later round. Ask questions only through `grill_round`, never in prose.

Facts are your job, never the user's: read the code, run commands, or dispatch a subagent, and never ask what you could look up. Don't block on a lookup: ask the questions that don't depend on it now. Decisions are the user's: put each one to them.

You are done when the frontier is empty, every branch visited, nothing silently assumed, and the user has confirmed in a last round that you share the same understanding. Then:

1. Write a decisions doc in the repo (default `docs/`): each decision, the answer, and why.
2. Call `grill_finish` with the doc's path and a short summary.
3. Stop. Do not start building; the user decides when.

If `grill_round` fails because the user cancelled, stop and wait for them.
