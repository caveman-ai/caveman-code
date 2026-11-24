---
name: automations
description: Write Caveman Code automations, YAML files in .caveman/ that run agents as steps on a schedule, on a GitHub event, or by hand. Use when someone asks for an automation, a recurring job, or "every time X happens, do Y".
---

# Automations

An automation is a YAML file that runs agents as steps. You write the files with your own edit tools, then check, explain and show them. Nothing runs until someone runs it or a trigger fires.

## Workflow

1. Ask only what you cannot infer: what starts it, what it should produce, and whether it is the person's own (Me) or the project's.
2. Start from a template when one fits: `automation_templates` lists them, `automation_templates { id }` returns the files to adapt.
3. Write the files:
   - Project: `.caveman/automations/<name>.yaml`. Shared through git; its triggers use the default branch's copy, so they start once it merges, and the person turns it on in Caveman Code.
   - Me: `.caveman/local/automations/<name>.yaml`. The person's own, ignored by git. A Me file you write stays off until they turn it on in Caveman Code (or save it there); one git tracks never loads.
   - Agents, for either: `.caveman/agents/<name>.md`.
4. Call `automation_check`. Fix every error, then check again until it is clean. Each problem names its line and says what to do.
5. Call `automation_explain { name }`: the model each step resolves to, the computer, checks, budget and worst case.
6. Answer with an automation card (below). Run it only when asked: `automation_run { name, inputs }`, with `subject: "github:<owner>/<repo>#<n>"` to run it on one issue or pull request of this repo. Its outputs wait for the person unless they ask you to apply them.

Without these tools, the same commands run in a shell: `caveman-runtime automation check`, `automation explain <name> [step]`, `automation run <name> [--input k=v] [--issue N | --pr N] [--wait]`. One agent on one task: `caveman-runtime agent run <agent> "<task>" --wait`.

## A complete example

`.caveman/automations/issue-to-pr.yaml`:

```yaml
# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json
version: 1
description: Turn issues labelled caveman into reviewed draft pull requests

on:
  github: { event: issues.labeled, label: caveman }

budget: $6

steps:
  triage:
    agent: issue-triage           # decides implement or needs_info
    model: fast
  implement:
    if: { triage: implement }
    agent: builder
    model: base
    escalate: frontier            # attempts 2 and 3 move up a class
    computer: full
    checks:
      - pnpm test
      - agent: reviewer           # request_changes fails the attempt; its findings go to the next one
    retries: 2
  ask:
    if: { triage: needs_info }
    prompt: Ask the issue's author, in one short comment, for what is missing.
    model: fast

outputs:
  github.pull_request: { from: implement, draft: true }
  github.comment: ask.summary
```

`.caveman/agents/issue-triage.md`:

```md
---
description: Decides whether an issue is ready to implement or needs more information
decides: [implement, needs_info]
---
Read the issue in the data blocks and the code it points at. Decide implement when the change and its test are clear; decide needs_info when a good engineer would have to ask first.
End with `decision: implement` or `decision: needs_info`.
```

The smallest automation, a Me digest:

```yaml
on: { schedule: { at: "09:00", timezone: Europe/Amsterdam, weekdays: [mon, tue, wed, thu, fri] } }
steps:
  digest:
    prompt: Summarise yesterday's merged PRs and flag anything risky.
    model: fast
```

## Keys

| Where | Key | Meaning |
|---|---|---|
| top | `description` | One line: what it does. |
| top | `host` | `this-mac` (default: Caveman Code on the computer with the repo) or `cloud` (Caveman Cloud fires it on its own computers, after `caveman-runtime apply`). |
| top | `on` | `github`, `schedule`; with `host: cloud` also `webhook: {}`, `slack: { mention: true, channels? }`, `linear: { events?, labels?, team? }`, `jira: { events?, labels?, project? }`. Absent: by hand only. |
| top | `inputs` | Values a manual run asks for: `issue: { description: Issue number, required: true }`. |
| top | `budget` | The most one run may spend, every step and attempt: `$6` or `{ usd: 6, tokens: 2000000, turns: 200 }`. Always set one. |
| top | `outputs` | `github.comment: <step>.summary` (one comment, edited by later runs); `github.pull_request: { from: <step>, draft: true }`; with `host: cloud` also `slack.message` (a thread reply, or `{ from, channel: "#ops" }`), `linear.comment`, `jira.comment`. Only the runtime writes them. |
| step | `agent`, `prompt`, `run` or `wait` | Exactly one: an agent's name, instructions inline (a prompt step may set its own `decides`), a command with no model (`run: pnpm build`), or a timer (`wait: 30m`, at most `168h`). |
| step | `needs` | `[triage]`: start once these succeeded. Any `needs` makes the file a graph: ready steps run side by side (4 at most; `computer: full` steps take turns). |
| step | `parallel`, `pick` | `parallel: 2` to `4` attempts at once, each in its own copy, with at least one check; `pick: first` (first to pass) or `best` (a reviewer picks among those that passed). |
| step | `approve` | `{ by: owner }` or `{ by: members }`: after the step succeeds the run waits for a person (72h by default, `timeout` up to `336h`). When the text that started a run is anyone's (Slack, Linear, Jira, a webhook, GitHub `actors: any`), each step with `computer: full`, a pull request, or a post anywhere but the thread or issue the text came from also waits for the owner before it runs; a reply in that same place does not. |
| step | `outcome` | `{ rubric: <what done means>, max_iterations: 2 }`: a separate grader scores the work after the checks and sends it back with feedback. |
| step | `if` | `{ triage: implement }`: run only when that earlier step decided this (or `failed`). All keys must hold. |
| step | `model` | `fast`, `base`, `frontier` (a class: works on every engine), `auto` (coding steps), or a pin like `anthropic/claude-sonnet-5-5`. |
| step | `escalate` | The class attempts 2 and later use, or a ladder `[{ model: frontier }, { engine: codex, model: frontier }]` (one rung per failed attempt). Needs `retries`. |
| step | `computer` | `none` (no checkout), `readonly` (default: a copy, thrown away), `full` (a worktree on a branch; the runtime commits). |
| step | `checks` | Commands (`pnpm test`) and `{ agent: reviewer }`, run by the runtime after the agent; the first failure fails the attempt. |
| step | `retries`, `timeout`, `effort` | `0` to `3`; `30m` (default 30m with full, 10m otherwise, at most 4h); `low` to `max`. |
| `on.github` | `event` | `issues.opened`, `issues.labeled`, `pull_request.opened`, `pull_request.synchronize`, `issue_comment.created`, `push`, `workflow_run.completed`; with `host: cloud` also `pull_request.labeled`, `pull_request.closed` (`merged: true`) and `check_suite.completed`; one or a list. |
| `on.github` | filters | `label`, `paths` (globs; pushes and PRs), `branches`, `mention: true` (comments to @caveman), `conclusion: failure` (CI runs). |
| `on.schedule` | | `at: "09:00"` with `timezone` (IANA, required) and optional `weekdays`; or `every: 6h` (at least `5m`). |

## Agents

Frontmatter, then the instructions. Keys: `description`, `engine` (`caveman`, `claude-agent`, `codex`, ...; absent: the new-chat default), `model`, `effort`, `tools`, `decides`, `returns` (a JSON Schema file next to it), `role`. Claude Code's `.claude/agents/*.md` load unchanged. Built in: `investigator`, `builder`, `reviewer` (decides approve or request_changes), `tester`, `scout`; a file of the same name replaces one. An agent that decides ends its last message with `decision: <value>`; `failed`, `succeeded`, `skipped` and `cancelled` are taken.

## Rules that catch people

- Without `needs`, steps run one at a time, in file order. A step whose `if` does not hold is skipped, and the steps after it still run. With `needs`, a step's `if` may only test its needs (or theirs).
- Slack, Linear and Jira only reach Caveman Cloud: their triggers and outputs need `host: cloud`, and a Me file can never be `host: cloud`.
- `if` can only test an earlier step that decides: its agent's `decides`, or a prompt step's own.
- `github.pull_request` needs its step on `computer: full`. Command checks need a checkout (not `none`).
- An agent check must decide exactly `approve` and `request_changes`.
- GitHub triggers fire for owners, members and collaborators only; never write `actors: any`. For `issues.labeled` that is whoever added the label: labelling vouches for an issue, even one an outsider wrote, and its text still reaches steps only as data. Fork pull requests, and comments on them, never fire. `webhook` triggers are served by Caveman Cloud only (`host: cloud`).
- Trigger text reaches a step as data after its instructions, never as instructions. Write prompts that read "the issue in the data blocks".
- Prefer classes over pins. Asked to keep it cheap: `fast` for triage and summaries, `base` to build, `escalate: frontier` once with `retries: 1` or `2`, a command check before any agent check, and always a `budget`.
- Names (files, steps and decisions): lowercase letters, digits, `-` and `_`, starting with a letter, at most 40 characters.

## The automation card

End with this, filled in from `automation_explain`: its first line is `<name> · <scope>` and the path, the second the description (the card's title); `triggers`, `runs on` and `budget` fill line 2; each step's `model` row is already class first, `fast (claude-haiku-5-5)`; `computer`, `checks`, `runs if` and `outputs` fill the rest.

```
**Turn issues labelled caveman into reviewed draft pull requests** · Project · .caveman/automations/issue-to-pr.yaml
Starts: issue labelled caveman · Runs on: This Mac · Budget: $6.00 per run
1. triage: issue-triage, fast (claude-haiku-5-5), no changes
2. implement, if triage decided implement: builder, base then frontier, full checkout, checks pnpm test + reviewer
3. ask, if triage decided needs_info: prompt, fast
Writes: a draft pull request, or one comment
Next: commit it and open a PR; once it merges, turn it on in Automations.
```

For a Me automation the last line is "Next: turn it on in Automations; a Me file stays off until you do."
