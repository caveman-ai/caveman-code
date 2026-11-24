# Model card: the ask classifier (`ask_r4`)

Files in this directory, embedded in routerd by `routerd/localpolicy/askmodel/model.go`:

| file | what |
|---|---|
| `ask_r4.json.gz` | Feature names, text heads and gradient-boosted trees as flat arrays (LightGBM, inference fields only). 2.0 MB. |
| `ask_r4.text.bin` | Hashed tf-idf text models: idf as float32, one-vs-rest logistic weights as float16, 2^17 buckets per block (the ask, the previous ask, the agent's previous reply, ask character n-grams). 21.8 MB. No vocabulary and no text: hashed buckets and numbers only. |
| `ask_r4.calib.json` | Calibration fitted on this model's predictions: class temperature, the P(cheap) map, and `level_risk`, the routing risk. Refit with every retrain. |

An operator directory at `<home>/localpolicy/ask_model/` (`model.json`, `text.bin`, `calib.json`) replaces the embedded model. If it is there and does not load, the rules classify.

## What it answers

For each new human ask, at the moment it arrives:

- **class**: one of the router's eight task classes;
- **level**: xlow, low, medium or high, how much model the work needs;
- **P(cheap)**, **P(big)** (the turn ends as a large one), **P(edit)** (the turn edits a file).

It reads the ask's text, the previous ask, the last 2,000 characters of the agent's previous reply, the turn index, timestamps, the slash flag and counts from earlier asks of the same session (tools, edits, files, errors, failed tests, spawns, output tokens). It does not read the harness name, and nothing about the turn it is labelling.

How the router uses it (`localpolicy.ClassifyAsk`, `BucketFor`): the class labels the ask for the class board and the log. The difficulty bucket is the routed level: the lowest level whose probability of being too low is at most the mode's risk (`level_risk` plus the mode's `level_risk_offset`). The mode does not shift a model label's bucket. A class of `plan_design` or `large_refactor`, a hard cue or a large scope keeps the high bucket as before.

## Training data

139,140 human-typed asks from 517 developers, all from public Hugging Face datasets of real coding-agent sessions with a named licence.

| source | asks | licence |
|---|---|---|
| SWE-chat (`SALT-NLP/SWE-chat`, and its mirror `cfahlgren1/SWE-chat`; Claude Code, Codex) | 94,222 | ODC-BY |
| Session exports by individual developers (DataClaw and native Claude Code, Codex, OpenCode, Cursor, Gemini CLI logs; 25 datasets) | 34,214 | MIT |
| `nmuendler/share-codex`, `trace-commons/agent-traces`, `AlinCiocan/fable-5-claude-code-traces` | 4,643 | CC-BY-4.0 |
| pi coding-agent sessions (pi-share-hf datasets) | 4,463 | MIT (4,399), CC-BY-4.0 (41, `julien-c/pi-sessions`), BSD-3-Clause (16), Apache-2.0 (7) |
| `submit2331/ACT-2.5B` (public preview) | 1,238 | ODC-BY |
| `build-small-hackathon/kicky-ai-codex-trace` and five smaller datasets | 351 | Apache-2.0 |
| `yellowbeeblackbee/claude-traces` | 9 | CC0-1.0 |

- **Never trained on:** the founder's own sessions (evaluation only), sessions with no licence or licence `other` (19,765 asks, evaluation only), datasets withdrawn by their authors, and synthetic or benchmark-generated sessions.
- **Attribution (ODC-BY / CC-BY):** SWE-chat (arXiv 2604.20779, SALT-NLP), `submit2331/ACT-2.5B`, `nmuendler/share-codex`, `trace-commons/agent-traces`, `AlinCiocan/fable-5-claude-code-traces`, `julien-c/pi-sessions`, and the MIT donors (the largest are listed in `docs/research/2026-10-03-ask-classifier/runs/data-*/REPORT.md`).
- **Only human-typed text and trajectory counts are used**, never model outputs as training text. The agent-reply tail is an input feature, hashed.
- **Splits are by developer:** a developer (the connected component of user and repo names across all sources) is in train or in evaluation, never both.

## Labels

- **Class and level:** Claude Sonnet labelled 113,549 train asks with the written rubric (`RUBRIC-final.md` in the research folder); Claude Opus gave a second label on 6,000. A fine-tuned ModernBERT-large teacher supplies soft labels for the 25,591 asks Sonnet did not label and half of the class target elsewhere. The level target is the higher of the two judges where both exist.
- **P(big), P(edit):** what the session actually did after the ask, read from the trace.
- **Evaluation labels** (never trained on): Opus and Sonnet both label every evaluation ask; disagreements are adjudicated.

## Evaluation

Held-back test sets, scored once (2026-10-03). Class / level exact / level QWK:

| asks | rules (`ClassifyTask`) | this model | two judges against each other |
|---|---|---|---|
| Founder, 960 asks, a developer the model never saw | 0.314 / 0.435 / 0.169 | 0.646 / 0.629 / 0.607 | 0.872 / 0.785 / 0.832 |
| Public, 541 asks from held-out developers | n/a | 0.599 / 0.556 / 0.638 | 0.856 / 0.799 / 0.879 |

- **P(big) AUC:** 0.764, 0.810 (public). **P(edit) AUC:** 0.804, 0.807.
- **The bucket rule on dev gold** (`level_risk` 0.40): 6.2% and 9.8% of asks routed below the judges' level on the two public dev sets, 12.4% on the founder's; exact agreement 0.58, 0.57, 0.61. "Always medium" routes 22%, 28% and 41% below.
- **Independent audit** (`runs/r2-audit/REPORT.md` in the research folder): trained on train rows only, reads allowed inputs only, and the Go implementation reproduces the scored predictions byte for byte.
- The Go port in this package matches the research binary on the evaluation asks: 0 label differences on 53,065 of 53,087 (the other 22 hold a reply longer than the 2,000 characters the model reads and are not compared). `TestParityWithTheReferenceBinary` holds it on a fixture.

## Calibration (`ask_r4.calib.json`)

Fitted on public dev gold by `runs/ship/fit_calib.py` in the research folder:

- class probabilities: temperature 0.717 (the label's confidence);
- P(cheap): `sigmoid(1.0066 · logit(p) + 1.3485)`;
- level probabilities: none needed;
- `level_risk`: 0.40, the largest value that routes at most 10% of asks below gold on both public dev sets. It is the risk in `auto`.
- `level_risk_offset`: what the other modes add to it, fitted the same way from their budgets: `auto-max` −0.14 (5% of asks below gold, risk 0.26), `auto-save` +0.14 (20%, risk 0.54). A model directory without both offsets does not load.

## Limits

- **Two careful readers agree with each other on 0.84 of classes and 0.79 of levels.** This model is at about three quarters of that. It is right about the level within one step on 0.93–0.96 of asks.
- **Cheap picks are the weak side.** On the founder's dev asks 27% of asks routed to a cheap bucket were medium or high by the judges (11–12% on public).
- **Short follow-ups** ("yes", "continue", "fix it") are weaker: 0.58 class / 0.54 level on the founder's dev asks, against 0.62 / 0.60 overall.
- **Per-language accuracy is not measured** for this model.
- **Accuracy on live traffic has not been measured.** Parity is on training-format records; the daemon builds its own record from live requests (next section).
- **The labels are judgements** of how much model an ask needs, made from the ask and its context. They are not measured outcomes of running the task on each model.

## Where serving differs from training

The daemon re-derives the model's inputs from live traffic. Where it cannot produce a field as the training data had it, it feeds the value training used for "unknown". Known differences:

- **The agent's previous reply.** OpenCode with the plugin decides at the prompt hook, before the request exists, so the reply is always empty. After a compaction the reply is empty or whatever survived the summary. Messages and chat clients look back 64 messages for it.
- **Session memory.** A daemon restart or a session idle for 6 hours loses the history: the next ask reads as the first one, though its reply tail is still read. Only the last 512 asks of a session are kept. On clients without prompt ids, an ask that repeats the previous one word for word is not a new ask.
- **The ask's text.** Slash commands become their `/name args` line; interrupt and compaction notes are dropped; the Codex IDE wrapper is unwrapped. The training cleaner's other rules (image markers, hook feedback lines, other IDE context, plan-accept and notification turns) are not reproduced, so some asks training dropped are classified live. Codex `$skill` invocations are not marked as slash commands.
- **Earlier asks' work counts.** Subagent work is not rolled into the parent ask. A call whose result never comes back is not counted; on Codex and chat-completions that includes calls whose results arrive with the next ask. OpenCode on its own provider login is counted from the plugin's tool reports when it sends any (the shipped plugin sends none, so those asks have no counts), with files and failed tests unknown. Claude Code and Codex tools are read by their exact names, as most of the training data was; the public Claude Code logs that training read through a wider name map are the exception. Codex's tool errors are the daemon's exit-code reading, not the training regexp. Large tool inputs are read whole where training read a cut, so a very large patch can count more files.

## Retraining

`docs/research/2026-10-03-ask-classifier/runs/r4-tier0/best/retrain.sh` rebuilds the artifact, then `runs/ship/fit_calib.py` refits `calib.json`. The session data is not in git: the scripts expect it in the research workspace's `data/` folder (`README.md` there gives the record schema and the extraction lanes that produce it).
