# ADEMark on Caveman Code

[ADEMark](https://github.com/zqkra/ademark) ranks desktop apps that run coding agents, test by test, on one Mac. These
scripts run its ranked tests on Caveman Code and hold our results to `budgets.json`, so a change that costs us a place
fails before it ships.

They use ADEMark's own pieces from a pinned commit (`harness.ts` `ADEMARK_COMMIT`): its arena repository and AGENTS.md
canary, its replay server (answers the app in place of the model, Track A) and its native sampler (phys_footprint,
CPU and wakeups per process, grouped into app and agents as it groups them). Every run is a scratch home and Electron
profile, never `~/.caveman-code` or the person's app.

## What runs where

| Command | Tests | Needs | Where |
|---|---|---|---|
| `node apps/desktop/scripts/ademark/tokens-check.ts` | B1, B3, B4, and bare `claude` for reference | nothing but the workspace | CI, every pull request (`ADEMark tokens`) |
| `node apps/desktop/scripts/ademark/run.ts` | A1, A3, A4, A5, A6, A7, B1, B3, B4 | the app packaged here (`node apps/desktop/scripts/package.mjs --local`), Bun, Swift, `claude` on PATH | a Mac, by hand, before a release or after a change to startup, streaming or the chat engine |

`run.ts --tests A5,A6 --runs 6 --profile <dir> --check` runs some tests, reuses a seeded profile, and exits 1 over a
budget. Times depend on the Mac, so their budgets hold only on `budgets.json` `machine`; memory, CPU and tokens hold
everywhere.

## How each value maps to ADEMark

| ID | ADEMark | Here |
|---|---|---|
| A1 | launch to typing accepted, after `sudo purge` | launch to the composer holding a typed probe (process-cold; no purge) |
| A3 | New-thread action to typing accepted | a click on New chat to the new composer holding the probe |
| A4 | Enter to `LEDGERMARK` on screen (`replay:hi`) | the same, read from the page |
| A5, A6 | app + agents memory at rest with 5 seeded chats; CPU % of one core | ADEMark's sampler, the same groups and window |
| A7 | p95 of app + agents while 5 chats stream `replay:stream-1..5` | the same |
| B1, B3 | tokens of every request after "hi" and after the read-only prompt, from network capture | the request bodies at a stand-in API: bytes exact, tokens estimated (`trackB.ts` `BYTES_PER_TOKEN`), or the real API's usage with `--real` |
| B4 | the AGENTS.md canary reaches the model | the same, in the request bodies |

Speed is read over CDP instead of from pixels (ADEMark's echo timer needs Screen Recording and Accessibility for its
helper), so a time here is about one frame to 67 ms under ADEMark's for the same app on the same Mac.

## When a budget breaks

Find what grew (each result file lists the heaviest processes and every request), then fix it or raise the budget in
the same pull request and say why. `tokens-check.ts --update` writes the token budgets from a run; the other budgets
are edited by hand from a `run.ts` result on the budget machine. A new Claude Code in the Agent SDK moves every token
number: re-measure with `--update` in the pull request that bumps it.
