/**
 * Every diagnostic `check` can report, in one table: its stable code, its
 * severity, and what it guards (the README lists this table; a test keeps
 * them in step). The message itself is written where the rule fires, and
 * always says what to do.
 *
 * @module rules
 */
export const RULES = {
  // The file
  "yaml-syntax": { severity: "error", about: "The file is not valid YAML 1.2 (or an agent's frontmatter is not)." },
  "hidden-character": { severity: "error", about: "Invisible Unicode format characters (bidi controls, zero-width, tags) anywhere in .caveman/; they can hide instructions." },
  "file-unrecognized": { severity: "error", about: "A file in .caveman/automations, .caveman/local/automations or .caveman/agents that is not loaded (wrong extension or a subfolder). Nothing is skipped silently." },
  "unknown-key": { severity: "error", about: "A key the format does not have; suggests the closest one." },
  "reserved-key": { severity: "error", about: "A key kept for a later version (delegate, uses, a step's budget, optimize, concurrency, file and webhook outputs)." },
  "missing-key": { severity: "error", about: "A required key is absent (steps, a GitHub trigger's event, an output's from)." },
  "invalid-value": { severity: "error", about: "A value of the wrong type or shape." },
  "version-unsupported": { severity: "error", about: "version is not 1." },
  "name-invalid": { severity: "error", about: "An automation (its file name) or step name is not lowercase letters, digits, - and _ (never two _ in a row), starting with a letter, at most 40 characters." },

  // Steps
  "steps-empty": { severity: "error", about: "The file has no steps." },
  "step-agent-or-prompt": { severity: "error", about: "A step needs exactly one of agent, prompt, run (a command) or wait (a timer)." },
  "step-key-unused": { severity: "warning", about: "A key that does nothing on this kind of step: a model on a run or wait step, checks or decides on a wait step." },
  "agent-unknown": { severity: "error", about: "A step or agent check names an agent that is in no agents folder and is not built in; suggests close names." },
  "if-unknown-step": { severity: "error", about: "if names a step that does not exist." },
  "if-not-earlier": { severity: "error", about: "if names this step or a later one; steps run in file order." },
  "if-not-a-need": { severity: "error", about: "In a graph (a file with needs), if names a step that is not among this step's needs, or theirs." },
  "if-failed-never-runs": { severity: "warning", about: "In a graph, a failure handler (if: { <step>: failed }) can never run: it waits for a step that needs <step> and is skipped when <step> fails (it does not test that failure), or for a step that runs only when another step fails, a failure that skips the handler." },
  "needs-unknown-step": { severity: "error", about: "needs names a step that does not exist, or this step itself." },
  "needs-cycle": { severity: "error", about: "needs go round in a circle, so none of those steps could ever start." },
  "if-unknown-value": { severity: "error", about: "if tests a value the step's agent does not decide (or failed)." },
  "if-no-decides": { severity: "error", about: "if tests a decision of a step that declares no decides (in its agent's file, or on a prompt or run step); only failed can be tested." },
  "step-decides-agent": { severity: "error", about: "decides on a step that has an agent; an agent's decides live in its file, and decides on a step is for prompt and run steps." },
  "model-invalid": { severity: "error", about: "model (a step's, or an agent file's) is not auto, fast, base, frontier, haiku, sonnet, opus or provider/model; an agent file may also say inherit." },
  "model-alias": { severity: "warning", about: "model is a Claude alias; a class works on every engine." },
  "model-auto-no-computer": { severity: "warning", about: "model: auto on a computer: none step; Caveman Auto is trained on coding work." },
  "effort-invalid": { severity: "error", about: "effort is not minimal, low, medium, high, xhigh or max." },
  "escalate-not-class": { severity: "error", about: "escalate is not a class (fast, base, frontier) or a ladder of { model, engine, effort } rungs." },
  "escalate-without-retries": { severity: "warning", about: "escalate does nothing when retries is 0." },
  "computer-invalid": { severity: "error", about: "computer is not none, code, readonly or full." },
  "retries-range": { severity: "error", about: "retries is not a whole number from 0 to 3." },
  "timeout-invalid": { severity: "error", about: "timeout is not a duration like 30m." },
  "timeout-too-long": { severity: "error", about: "timeout is longer than 2h, the most a whole run may take in v1." },
  "check-invalid": { severity: "error", about: "A check is not a command or { agent: <name> }." },
  "checks-need-computer": { severity: "error", about: "Command checks on a computer: none step; they need a checkout." },
  "check-agent-decides": { severity: "error", about: "An agent check's agent must decide exactly approve and request_changes." },
  "engine-unavailable": { severity: "warning", about: "A step's engine is not available where this check ran." },
  "parallel-range": { severity: "error", about: "parallel is not a whole number from 2 to 4." },
  "parallel-needs-check": { severity: "error", about: "A parallel step has no check, so nothing cheap can tell its attempts apart." },
  "pick-without-parallel": { severity: "warning", about: "pick on a step without parallel; a single attempt has nothing to pick from." },
  "approve-timeout-too-long": { severity: "error", about: "approve.timeout is longer than 14 days." },
  "wait-invalid": { severity: "error", about: "wait is not a duration like 30m, or is longer than 168h (a week)." },
  "outcome-iterations-range": { severity: "error", about: "outcome.max_iterations is not a whole number from 1 to 5." },
  "outcome-not-agent": { severity: "error", about: "outcome on a run or wait step: there is no agent to send the grader's feedback to." },

  // Triggers
  "github-event-unknown": { severity: "error", about: "A GitHub event Caveman does not watch in v1: a real one says it is not watched yet and lists the ones that are; a typo gets the closest." },
  "github-filter-mismatch": { severity: "error", about: "A GitHub filter that none of the trigger's events carry (paths on issues, mention outside issue_comment.created)." },
  "github-label-never-matches": { severity: "warning", about: "label on a trigger that also listens to push or workflow_run.completed: those carry no label, so they never fire." },
  "github-actors-any": { severity: "error", about: "actors: any where the run would happen on This Mac (target code); outsiders' text never runs there." },
  "github-actors-invalid": { severity: "error", about: "actors is not any or a list of owner, member, collaborator." },
  "schedule-shape": { severity: "error", about: "A schedule needs one of at, every, once or cron; weekdays and monthdays go with at, and once takes no start, until or count." },
  "schedule-at-invalid": { severity: "error", about: "at is not a quoted 24-hour time like \"09:00\"." },
  "schedule-timezone-missing": { severity: "error", about: "A schedule with at, once, cron, start or until has no timezone." },
  "schedule-timezone-invalid": { severity: "error", about: "timezone is not an IANA time zone." },
  "schedule-every-invalid": { severity: "error", about: "every is not a duration of at least 5m." },
  "schedule-weekdays-invalid": { severity: "error", about: "weekdays has a value that is not mon to sun." },
  "schedule-monthdays-invalid": { severity: "error", about: "monthdays has a value that is not 1 to 31 or last." },
  "schedule-date-invalid": { severity: "error", about: "once, start or until is not a real date (and time), or until is before start." },
  "schedule-start-missing": { severity: "error", about: "every 2d or 2w with at has no start to count from." },
  "schedule-cron-invalid": { severity: "error", about: "cron is not a five-field cron expression." },
  "schedule-count-invalid": { severity: "error", about: "count is not a whole number of at least 1." },
  "webhook-not-served": { severity: "error", about: "A webhook trigger where it would run in Caveman Code (target code), which does not serve file webhooks yet." },
  "trigger-needs-cloud": { severity: "error", about: "A Slack, Linear or Jira trigger, or a GitHub event only Cloud hears, on a file that runs on This Mac; set host: cloud." },
  "host-me-cloud": { severity: "error", about: "host: cloud on a Me file (.caveman/local/automations), which lives only on this Mac; move it to .caveman/automations/." },
  "trigger-not-served": { severity: "warning", about: "A trigger kind the environment this check ran in does not serve." },

  // Budget and outputs
  "budget-invalid": { severity: "error", about: "budget is not a positive amount ($6, 6, \"$1.50\") or { usd, tokens, turns }." },
  "output-invalid": { severity: "error", about: "An output is not <step>.<field> or { from: <step> }." },
  "output-unknown-step": { severity: "error", about: "An output's source step does not exist." },
  "output-unknown-field": { severity: "error", about: "An output reads a field that is not summary and not in the agent's returns schema." },
  "pull-request-needs-full": { severity: "error", about: "github.pull_request reads a step that is not computer: full, so it has no changes to propose." },
  "comment-needs-github": { severity: "warning", about: "github.comment without a GitHub trigger: a scheduled run has no issue or pull request to comment on, and a run by hand posts only when run on one." },
  "chief-never-news": { severity: "warning", about: "chief reads a step that never decides news, so its runs only update the routine's row and never wake the Chief." },
  "output-needs-cloud": { severity: "error", about: "slack.message, linear.comment or jira.comment on a file that runs on This Mac; only Cloud posts them (host: cloud)." },
  "output-needs-trigger": { severity: "error", about: "linear.comment without on.linear, jira.comment without on.jira, or slack.message with neither on.slack nor a channel: there is nothing to reply to." },
  "outsider-approval": { severity: "warning", about: "A Cloud file that can start from text anyone may write (Slack, Linear, Jira, a webhook, or GitHub with actors: any): each step that can write (a full computer, or one whose output goes anywhere but the thread or issue the text came from) waits for the owner's approval before it runs." },

  // Agent files
  "agent-name-invalid": { severity: "error", about: "An agent's name is not letters, digits, - and _ (at most 64), so it cannot load." },
  "agent-unknown-key": { severity: "warning", about: "A frontmatter key neither Caveman nor Claude Code reads; suggests the closest." },
  "agent-key-not-applied": { severity: "warning", about: "skills, mcp or secrets: reserved, and not applied yet." },
  "agent-effort-unknown": { severity: "warning", about: "An agent file's effort is not minimal, low, medium, high, xhigh or max; the agent runs at the engine's default effort." },
  "agent-role-unknown": { severity: "warning", about: "role is not implementation, research, review, design, test or general." },
  "agent-computer-invalid": { severity: "warning", about: "An agent file's computer is not none, code, readonly or full; the agent gets the host's default." },
  "custom-tool-invalid": { severity: "error", about: "A tools entry that is an object is not a custom tool: type custom, a name of letters, digits, _ and - not starting with mcp__, a text description and an object input_schema." },
  "mcp-server-invalid": { severity: "warning", about: "An mcpServers entry is neither a command (a local server) nor type http with a url; that server is left out." },
  "engine-unknown": { severity: "error", about: "engine is not caveman, claude-agent, codex, cursor, opencode, muse, grok, pi, antigravity or acp:<id>." },
  "decides-invalid": { severity: "error", about: "A decides value is not lowercase letters, digits, - and _, starting with a letter." },
  "decides-reserved": { severity: "error", about: "decides uses failed, succeeded, skipped or cancelled, which the runtime owns." },
  "returns-missing": { severity: "error", about: "returns names a JSON Schema file that is not next to the agent." },
  "returns-invalid": { severity: "error", about: "returns is not a path to a .json file holding an object schema with properties." },
} as const satisfies Record<string, { readonly severity: "error" | "warning"; readonly about: string }>;

export type RuleCode = keyof typeof RULES;
