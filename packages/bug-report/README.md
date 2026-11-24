# @caveman-app/bug-report

Problem reports for every Caveman client: the one-button "Report a problem"
in the Caveman Code app, and in the `caveman-code` CLI. It covers the
redaction that runs before anything leaves the computer, the error signature
Cloud groups reports by, the bounded log bundle, and the outbox that holds a
report until Caveman Cloud takes it.

It has no dependencies (Node built-ins only), no UI and no auth. The client
brings those: its own preview, its own sign-in, its own HTTP call. The app's
spec is `docs/`, and Caveman Cloud owns the wire
contract.

## Two entry points

| Import | Runs in | What |
|---|---|---|
| `@caveman-app/bug-report` | anywhere, browsers included | the contract types (`BugReportPayload`), `BUG_REPORT_ROUTE`, `BUG_REPORT_LIMITS`, `redact()` and `REDACTION_VERSION`, `templateDraft()` |
| `@caveman-app/bug-report/node` | Node ≥ 22.19 | `errorSignature()`, `readLogTail()`, `tarGz()`, `prepareReport()`, `finalizeReport()`, `PreparedReports`, `BugReportOutbox` |
| `@caveman-app/bug-report/crash` | anywhere, browsers included | `scrubCrashEvent()`, what an automatic crash report (a Sentry event) may carry, by the same rules; `telemetryOffByEnv()` (`docs/`) |

## Using it from another client

```ts
import { BUG_REPORT_ROUTE } from "@caveman-app/bug-report";
import { BugReportOutbox, finalizeReport, prepareReport } from "@caveman-app/bug-report/node";

const prepared = prepareReport(
  { surface: "other", error: { name: err.name, message: err.message, stack: err.stack } },
  [{ name: "cli.log", path: logPath, code: false }],
  { appVersion, buildChannel, platform: process.platform, osVersion, arch: process.arch, homeDir, userName },
);
// Show the person everything in `prepared` (it is already redacted) and let them edit and choose.
const parts = finalizeReport(prepared, { title, summary, note, include: { logs: true, screenshot: false, threadExcerpt: false, code: false } });
outbox.enqueue(parts); // then POST to BUG_REPORT_ROUTE, report part first
```

The rules every client keeps:

- Nothing is sent without showing the person what `finalizeReport` will send,
  and an explicit action from them.
- POST `BUG_REPORT_ROUTE` as multipart in this order: `report` (the payload as
  JSON) first, then `logs` (`application/gzip`) and `screenshot`
  (`image/png`). Cloud answers 400 to any other order. Only over HTTPS, on the
  person's Caveman sign-in.
- Mark logs that hold transcripts or file contents `code: true`. They go only
  when the person turns on code for that report.
- Changing a rule means bumping `REDACTION_VERSION` and adding a test in
  `src/index.test.ts`.

The app's runtime sender (`packages/runtime/src/bugReports/sender.ts`) shows
the retries, sign-in waits and status calls.

## Getting it into `caveman-code`

`caveman-code` installs with npm, which can't read this repository's pnpm
workspace. It takes a packed copy built to plain JavaScript, the same way
this app vendors `@pebble-agent/protocol` from `caveman-agent-sdk`:

```sh
# in caveman-code
pnpm --filter @caveman-app/bug-report pack --pack-destination <somewhere>
# in caveman-code: vendor the .tgz and depend on it
#   "@caveman-app/bug-report": "file:vendor/caveman-app-bug-report-<rev>.tgz"
```

The pack builds `dist/` first (`prepack`), and its `exports` point at `dist`
(`publishConfig`). In this workspace they point at `src`. Never publish it:
the repository is private.
