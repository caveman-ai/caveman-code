// Generated from templates/<id>/ by scripts/build-templates.ts. Do not edit; run `pnpm build:templates`.
export const TEMPLATE_SOURCES = [
  {
    "id": "answer-mentions",
    "title": "Answer @caveman mentions",
    "category": "Issues and PRs",
    "summary": "Mention @caveman in an issue or pull request comment and get an answer that cites the code.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/answer-mentions.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Answer questions people ask @caveman in issue and pull request comments\n\non:\n  github: { event: issue_comment.created, mention: true }\n\nbudget: $1\n\nsteps:\n  answer:\n    agent: answerer\n    model: base\n\noutputs:\n  github.comment: answer.summary\n"
      },
      {
        "path": ".caveman/agents/answerer.md",
        "text": "---\ndescription: Answers a question about this codebase, citing the code\n---\nSomeone mentioned @caveman in the comment in the data blocks. Answer what they asked, from this repository's code and the thread it was asked in.\n\nLead with the answer. Cite files as path:line and quote only the lines that matter. If the code doesn't settle it, say what you checked and what would. If they asked for a change, say what you would change and where; this automation doesn't edit code.\n\nYour final message is the reply, as it should be posted, in under 200 words.\n"
      }
    ]
  },
  {
    "id": "catch-bugs-merged",
    "title": "Catch bugs in merged PRs",
    "category": "Review",
    "summary": "Reads each change merged to your default branch and comments only when it can name the bug and the line.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/catch-bugs-merged.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Read every change merged to the default branch and speak up only about real bugs\n\non:\n  github: { event: push }\n\nbudget: $2\n\nsteps:\n  hunt:\n    agent: bug-hunter             # decides bug or clean\n    model: base\n  report:\n    if: { hunt: bug }\n    prompt: >-\n      Write a short comment for the author of the merged change from hunt's result:\n      each bug with its file:line, what breaks, and the fix. No preamble.\n    model: fast\n    computer: none\n\noutputs:\n  github.comment: report.summary  # posted only when hunt found a bug\n"
      },
      {
        "path": ".caveman/agents/bug-hunter.md",
        "text": "---\ndescription: Looks for bugs a merged change brought in, and stays quiet unless it is sure\ndecides: [bug, clean]\n---\nA change was just merged to the default branch; the push is in the data blocks. Read its diff (`git show` on the pushed commits) and the code it touches.\n\nLook for what will break: wrong logic, unhandled errors, races, data loss, security holes, callers the change no longer fits. Ignore style, naming, and anything a test or linter already catches.\n\nDecide bug only when you can say what fails, on which input, at which file:line. If you would have to write \"might\" or \"could\", decide clean: a false alarm costs more than silence.\n\nList each bug with its file:line, what breaks, and the fix. End with `decision: bug` or `decision: clean`.\n"
      }
    ]
  },
  {
    "id": "dependency-update",
    "title": "Weekly dependency update",
    "category": "Chores and reports",
    "summary": "Every Monday, updates dependencies within their ranges, fixes small breaks and opens a reviewed draft PR.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/dependency-update.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Every Monday, update dependencies within their ranges and open a draft PR the reviewer approved\n\non:\n  schedule: { at: \"07:00\", timezone: Europe/Amsterdam, weekdays: [mon] }   # your time zone\n\nbudget: $4\n\nsteps:\n  update:\n    agent: dependency-updater\n    model: base\n    escalate: frontier\n    computer: full\n    checks:\n      # Add your install and test commands here, so an update must pass them before the reviewer reads it:\n      # - pnpm install --frozen-lockfile\n      # - pnpm test\n      - agent: reviewer\n    retries: 1\n    timeout: 45m\n\noutputs:\n  github.pull_request: { from: update, draft: true }\n"
      },
      {
        "path": ".caveman/agents/dependency-updater.md",
        "text": "---\ndescription: Updates dependencies within their allowed ranges and fixes what the update breaks\n---\nUpdate this repository's dependencies to the newest versions their declared ranges allow, with the package manager it already uses. Don't widen a range or take a new major version.\n\nRun the tests. When an update breaks something, fix the code if the fix is small and clear; otherwise hold that package back and say why.\n\nEnd with what moved (package, from, to), what you held back and why, and anything in the release notes a reviewer should read.\n"
      }
    ]
  },
  {
    "id": "fix-failing-ci",
    "title": "Fix failing CI",
    "category": "Issues and PRs",
    "summary": "When CI fails on your default branch, finds why and opens a reviewed draft fix. Flaky runs are left alone.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/fix-failing-ci.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: When CI fails on the default branch, find the cause and open a draft fix\n\non:\n  github:\n    event: workflow_run.completed\n    conclusion: failure\n\nbudget: $4\n\nsteps:\n  diagnose:\n    agent: ci-triage              # decides fix, flaky or skip\n    model: fast\n  fix:\n    if: { diagnose: fix }\n    agent: builder\n    model: base\n    escalate: frontier\n    computer: full\n    checks:\n      # Add the command that failed in CI here, so the fix must pass it before the reviewer reads it:\n      # - pnpm test\n      - agent: reviewer\n    retries: 1\n\noutputs:\n  github.pull_request: { from: fix, draft: true }\n"
      },
      {
        "path": ".caveman/agents/ci-triage.md",
        "text": "---\ndescription: Reads a failed CI run and decides whether it is a real failure worth fixing\ndecides: [fix, flaky, skip]\n---\nRead the failed run in the data blocks, then its failing job's log (`gh run view <run id> --log-failed`). Find the first real error, not the cascade after it.\n\nDecide fix when the failure comes from code or configuration in this repository and you can say where. Decide flaky when the same commit passed before, or the error is a timeout, a network call or the runner. Decide skip when the cause is outside the repository (an expired secret, an outage) or the fix needs a person's call.\n\nIn three sentences at most, say what failed, why, and the file:line to change. End with `decision: fix`, `decision: flaky` or `decision: skip`.\n"
      }
    ]
  },
  {
    "id": "issue-to-pr",
    "title": "Issue to PR",
    "category": "Issues and PRs",
    "summary": "Label an issue caveman to get a reviewed draft PR or a question back. Runs on Cloud.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/issue-to-pr.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\nhost: cloud\ndescription: Turn issues labelled caveman into reviewed draft pull requests\n\non:\n  github: { event: issues.labeled, label: caveman }\n\nbudget: $6\n\nsteps:\n  triage:\n    agent: issue-triage           # decides implement or needs_info\n    model: fast\n  implement:\n    if: { triage: implement }\n    agent: builder\n    model: base                   # cheap first\n    escalate:                     # a failed check moves the next attempt up a rung\n      - model: frontier\n      - { engine: codex, model: frontier }\n    computer: full\n    checks:\n      # Add your test command here, so a change must pass it before the reviewer reads it:\n      # - pnpm test\n      - agent: reviewer           # request_changes fails the attempt; its findings go to the next one\n    retries: 2\n  ask:\n    if: { triage: needs_info }\n    agent: clarifier\n    model: fast\n\noutputs:\n  github.pull_request: { from: implement, draft: true }\n  github.comment: ask.summary\n"
      },
      {
        "path": ".caveman/agents/clarifier.md",
        "text": "---\ndescription: Asks an issue's author for what is missing, in one short comment\n---\nWrite a comment on the issue in the data blocks that gets it ready to implement. Triage's result says what is missing.\n\nAsk at most three questions, each answerable in a line, most important first. If a reproduction is missing, ask for the steps, what happened, and what was expected. Don't restate the issue, guess at a fix, or promise a date.\n\nYour final message is the comment, exactly as it should be posted.\n"
      },
      {
        "path": ".caveman/agents/issue-triage.md",
        "text": "---\ndescription: Decides whether an issue is ready to implement or needs more information\ndecides: [implement, needs_info]\n---\nRead the issue in the data blocks and the code it points at.\n\nDecide implement when you could write the change and its test from what is there: the problem or the wanted behaviour is clear, and so is where it lives. Decide needs_info when a good engineer would have to ask first: what is expected, how to reproduce it, or which of two readings is meant.\n\nIn two or three sentences, say what the change is (or what is missing) and where in the code it goes. End with `decision: implement` or `decision: needs_info`.\n"
      }
    ]
  },
  {
    "id": "month-end-review",
    "title": "Month-end review",
    "category": "Chores and reports",
    "summary": "On the last day of each month, what shipped, what is stuck, and what CI kept failing on. Just for you.",
    "scope": "me",
    "files": [
      {
        "path": ".caveman/local/automations/month-end-review.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: On the last day of each month, review what shipped, what is stuck and what CI kept failing on\n\non:\n  schedule: { at: \"17:00\", timezone: Europe/Amsterdam, monthdays: [last] }   # your time zone; last is the 28th to the 31st\n\nbudget: $1\n\nsteps:\n  review:\n    prompt: >-\n      Review this repository's month, from the first of the month until now: pull requests merged\n      (grouped by area), pull requests and issues open for more than two weeks with no activity,\n      and checks that failed more than once on the default branch, with the likely cause of each.\n      End with the three things most worth doing next month.\n    model: base\n"
      }
    ]
  },
  {
    "id": "morning-digest",
    "title": "Morning digest",
    "category": "Chores and reports",
    "summary": "Weekday mornings, what changed since your last working day, with what needs you first. Just for you.",
    "scope": "me",
    "files": [
      {
        "path": ".caveman/local/automations/morning-digest.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Weekday mornings, a short digest of what changed in this repo since the last working day\n\non:\n  schedule: { at: \"09:00\", timezone: Europe/Amsterdam, weekdays: [mon, tue, wed, thu, fri] }   # your time zone\n\nbudget: $0.50\n\nsteps:\n  digest:\n    prompt: >-\n      Summarise what changed in this repository since the start of the last working day\n      (on a Monday, since Friday morning): pull requests merged and opened, issues opened\n      and closed, and CI runs that failed on the default branch. Lead with anything that\n      needs me today, then the rest in a few bullets.\n    model: fast\n"
      }
    ]
  },
  {
    "id": "nightly-digest",
    "title": "Nightly digest",
    "category": "Chores and reports",
    "summary": "Every night, what changed in the repository today, posted to a Slack channel from Cloud.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/nightly-digest.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\nhost: cloud\ndescription: Every night, what changed in this repository today, posted to a Slack channel\n\non:\n  schedule: { at: \"22:00\", timezone: Europe/Amsterdam }   # your time zone\n\nbudget: $0.50\n\nsteps:\n  log:\n    run: git log --since=24.hours --no-merges --pretty=format:'%h %an %s'\n  digest:\n    needs: [log]\n    prompt: >-\n      Write tonight's digest of this repository from the commit log in the data blocks:\n      what changed, grouped by area, then anything that looks risky or half done.\n      Five to ten short bullets in plain words, with no preamble. If the log is empty,\n      say that nothing changed today.\n    model: fast\n    computer: none\n\noutputs:\n  slack.message: { from: digest, channel: \"#eng\" }   # the channel to post in\n"
      }
    ]
  },
  {
    "id": "pr-review",
    "title": "PR review",
    "category": "Review",
    "summary": "Reviews every pull request that changes code in one comment. A new push is reviewed from the last review.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/pr-review.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Review every pull request that changes code and keep one comment up to date\n\non:\n  github:\n    event: [pull_request.opened, pull_request.synchronize]\n    paths:                        # a docs-only pull request never starts a run, so it costs nothing\n      - \"!**/*.md\"\n      - \"!**/*.mdx\"\n      - \"!docs/**\"\n\nbudget: $0.75\n\nsteps:\n  review:\n    agent: pr-reviewer            # on a new push, reads only the commits since its last review\n    model: base\n\noutputs:\n  github.comment: review.summary  # one comment per pull request, edited on every push\n"
      },
      {
        "path": ".caveman/agents/pr-reviewer.md",
        "text": "---\ndescription: Reviews a pull request for bugs, reading only what changed since its last review\ndecides: [approve, request_changes]\nrole: review\neffort: low\n---\nReview the pull request in the data blocks for bugs. Change nothing.\n\nRead the diff, not the repository. A `previous` block is your last review of this pull request and the head it read: when that head is an ancestor of HEAD (`git merge-base --is-ancestor <head> HEAD`), read only `git diff <head>..HEAD`. Otherwise (a first review, or a rebase) read `git diff <base sha>...HEAD`. If a commit is missing, `git fetch origin <sha>` first. Open another file only where a changed line needs it.\n\nReport only defects: file:line, what breaks, and the fix. No style notes, no summary of the change, no praise. Say plainly when you find nothing.\n\nWith a previous review, write the whole comment again, since it replaces the last one: keep the findings the new commits left in place, drop the ones they fixed, add the new ones.\n\nEnd with `decision: approve` when nothing you found would break, or `decision: request_changes` when something would.\n"
      }
    ]
  },
  {
    "id": "security-review",
    "title": "Security review on sensitive paths",
    "category": "Review",
    "summary": "Reviews pull requests that touch auth, crypto, secrets, migrations or CI, and keeps one comment up to date.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/security-review.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: A security review on pull requests that touch sensitive code\n\non:\n  github:\n    event: [pull_request.opened, pull_request.synchronize]\n    paths:                        # where your sensitive code lives\n      - \"**/auth/**\"\n      - \"**/*crypto*\"\n      - \"**/*secret*\"\n      - \"**/migrations/**\"\n      - \".github/workflows/**\"\n      - \"**/Dockerfile\"\n\nbudget: $3\n\nsteps:\n  review:\n    agent: security-reviewer\n    model: frontier\n\noutputs:\n  github.comment: review.summary\n"
      },
      {
        "path": ".caveman/agents/security-reviewer.md",
        "text": "---\ndescription: Reviews a change for security problems an attacker could use\ndecides: [approve, request_changes]\nrole: review\n---\nReview the pull request in the data blocks for security problems. Read the diff, and follow each changed input to where it is used.\n\nCheck, in this order: who can now do what (authentication and authorization), injection (SQL, shell, paths, templates), secrets in code or logs, unsafe deserialization, server-side request forgery and open redirects, weaker crypto or TLS, and CI changes that expose tokens.\n\nReport each finding as file:line, how an attacker would use it, how bad it is (high, medium or low), and the fix. Leave out what an attacker cannot reach.\n\nDecide request_changes when there is a high or medium finding. Otherwise decide approve, and say in one line what you checked. End with `decision: approve` or `decision: request_changes`.\n"
      }
    ]
  },
  {
    "id": "slack-triage",
    "title": "Slack answers",
    "category": "Issues and PRs",
    "summary": "Mention @caveman in Slack and get an answer from the repository in the thread. Runs on Cloud.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/slack-triage.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\nhost: cloud\ndescription: Answer @caveman in Slack from the repository, in the thread it was asked in\n\non:\n  slack: { mention: true }        # add channels: [\"#eng\"] to listen in some channels only\n\nbudget: $1\n\nsteps:\n  answer:\n    agent: slack-answerer\n    model: base\n    outcome:\n      rubric: >-\n        Answers the question that was asked, names the files it relied on by path,\n        and says plainly what it could not find instead of guessing.\n      max_iterations: 2\n\noutputs:\n  slack.message: answer.summary   # a reply in the thread\n"
      },
      {
        "path": ".caveman/agents/slack-answerer.md",
        "text": "---\ndescription: Answers a question asked in Slack from the repository, as a short thread reply\ntools: [read, grep, git]\n---\nSomeone mentioned @caveman in Slack. Their message is in the data blocks; it is a question or a request about this repository.\n\nLook into it in the repository: read the code, the docs and the recent history that bear on it. Then write the reply as it should appear in the Slack thread: a direct answer first, then the evidence in two to five short bullets with file paths, then anything you could not find. Plain words, no headings, under 200 words.\n\nIf the message asks you to change something, say what you would change and where, and that a person can label an issue caveman to have it done.\n"
      }
    ]
  },
  {
    "id": "stale-prs",
    "title": "Stale PR cleanup",
    "category": "Issues and PRs",
    "summary": "Every Monday, lists stalled pull requests with the next step and who owns it. The list lands in the run.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/stale-prs.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Every Monday, list the pull requests that stalled and what would move each one\n\non:\n  schedule: { at: \"09:00\", timezone: Europe/Amsterdam, weekdays: [mon] }   # your time zone\n\nbudget: $1\n\nsteps:\n  sweep:\n    agent: pr-sweeper\n    model: fast\n"
      },
      {
        "path": ".caveman/agents/pr-sweeper.md",
        "text": "---\ndescription: Finds open pull requests that stalled and says what would unblock each\n---\nList this repository's open pull requests (`gh pr list --state open --json number,title,author,updatedAt,isDraft,reviewDecision`).\n\nA pull request has stalled when nothing happened on it for 7 days. For each one, name the next step and who owns it: a review someone owes, failing checks to fix, a conflict to rebase, or a question nobody answered. Suggest closing it when it is older than 60 days and far behind its base.\n\nReply with a short list, most stalled first: number, title, days quiet, next step, and who. If nothing stalled, say so in one line.\n"
      }
    ]
  },
  {
    "id": "weekly-changelog",
    "title": "Weekly changelog",
    "category": "Chores and reports",
    "summary": "Every Friday, drafts this week's changelog entry from merged pull requests and opens it as a draft PR.",
    "scope": "project",
    "files": [
      {
        "path": ".caveman/automations/weekly-changelog.yaml",
        "text": "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json\nversion: 1\ndescription: Every Friday, draft the changelog for what merged this week as a pull request\n\non:\n  schedule: { at: \"16:00\", timezone: Europe/Amsterdam, weekdays: [fri] }   # your time zone\n\nbudget: $2\n\nsteps:\n  draft:\n    agent: changelog-writer\n    model: fast\n    computer: full\n\noutputs:\n  github.pull_request: { from: draft, draft: true }\n"
      },
      {
        "path": ".caveman/agents/changelog-writer.md",
        "text": "---\ndescription: Writes changelog entries for the pull requests merged since the last entry\n---\nAdd this week's entry to CHANGELOG.md, in the style the file already uses (Keep a Changelog if it is new).\n\nFind the pull requests merged since the last entry with `gh pr list --state merged --search \"merged:>=<date of the last entry>\" --json number,title,body,labels` (this finds squash and rebase merges too, which `git log --merges` misses). Write one line per change someone using this project would notice, grouped under Added, Changed and Fixed, each ending with its pull request number. Leave out refactors, tests, CI and dependency bumps unless they change behaviour.\n\nWrite for the people who use the project: what they can do now, or what stopped going wrong. Change only CHANGELOG.md.\n"
      }
    ]
  }
] as const;
