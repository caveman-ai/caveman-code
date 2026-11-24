// The scripted world's pull requests as an agent reviewed them: each one's diff, as `pr.diff` would send it, and the
// guide the writer left for it, as `pr.guide` would. They follow the writer's rules (packages/engine-core
// textGenerationPrompts.ts): titles are actions of a few words, never a file; each stop says before, after and why;
// the contract or data shape comes first, then the service, then its callers, then the tests; a call for the reviewer
// sits on the stop it belongs to and most stops have none; every changed file is placed exactly once. A guide is kept
// by the repository and branch it was written on, and knows the head it was written for, so a change that moved on
// since (asked to change, and back) reads as stale.
import type { DiffFile } from "./diff";
import { added, file, headOf, hunk, placer } from "./fixture";
import type { PrGuide, PrThread } from "./model";

/** A pull request's diff and its guide, kept by `repo@branch`. */
export interface Reviewed {
  files: readonly DiffFile[];
  guide: PrGuide;
  /** The review threads on its lines (`pr.discussion`'s threads). */
  threads?: readonly PrThread[];
  /** Reviews others sent, oldest first (`pr.discussion`'s reviews). */
  reviews?: readonly PrReview[];
}

/** A review someone sent: who, their verdict, what they wrote, and when. */
export interface PrReview {
  author: string;
  verdict: "approve" | "request_changes" | "comment";
  body: string;
  at: number;
}

const MINUTE = 60_000;
const written = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE).toISOString();
const headFor = (files: readonly DiffFile[]) => headOf(files.map((f) => ({ path: f.path, add: f.additions, del: f.deletions })));
const HAIKU = "Claude Haiku 5.5 · single pass";

// ---------------------------------------------------------------- Push for the Chief (caveman-code, chief-push)

const APNS = added(
  "src/push/apns.ts",
  `
// One push to one phone through Apple's HTTP/2 API, signed with the team's key. A Chief's asks are the only
// pushes the app sends, so the payload is shaped for them: the ask as the alert, Allow and Deny as its actions.
import { createSign } from "node:crypto";

/** The category the app registers at launch, which draws Allow and Deny. */
export const ASK_CATEGORY = "CHIEF_ASK";

export type AskKind = "approval" | "question";

/** The push a Chief sends when it needs you. */
export interface ChiefPush {
  chief: string;
  /** Where a tap lands: the chat, opened on its ask. */
  chat: string;
  kind: AskKind;
  /** The ask in at most 28 characters ("Run a staging migration?"). */
  title: string;
  /** The command, for an approval; the question, for direction. */
  body: string;
}

export interface ApnsKey {
  teamId: string;
  keyId: string;
  /** The .p8 key's PEM text. */
  pem: string;
}

/** Apple's production gateway; a development build pushes through api.sandbox.push.apple.com. */
const HOST = "https://api.push.apple.com";
/** Apple refuses a token older than an hour, so it is renewed well before. */
const TOKEN_TTL_MS = 50 * 60_000;

let cached: { token: string; at: number } | null = null;

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** The provider token: an ES256 JWT, reused until it nears Apple's hour. */
export function providerToken(key: ApnsKey, now = Date.now()): string {
  if (cached && now - cached.at < TOKEN_TTL_MS) return cached.token;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = base64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(now / 1000) }));
  const signer = createSign("SHA256");
  signer.update(header + "." + claims);
  const signature = signer.sign({ key: key.pem, dsaEncoding: "ieee-p1363" });
  cached = { token: header + "." + claims + "." + base64url(signature), at: now };
  return cached.token;
}

/** What Apple delivers: the alert, the category that carries Allow and Deny, and the chat a tap opens. */
export function payloadOf(push: ChiefPush) {
  const approval = push.kind === "approval";
  return {
    aps: {
      alert: { title: push.title, body: push.body },
      sound: "default",
      category: approval ? ASK_CATEGORY : undefined,
      "thread-id": push.chief,
      "interruption-level": approval ? "time-sensitive" : "active",
    },
    chat: push.chat,
  };
}

/** What Apple says when a token is gone for good: the app was deleted, or the token was never this app's. */
export const GONE = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"]);

export type SendResult = { ok: true } | { ok: false; status: number; reason: string };

/** Sends one push. A token Apple no longer knows comes back with a reason in \`GONE\`, for the caller to forget. */
export async function sendPush(key: ApnsKey, topic: string, device: string, push: ChiefPush): Promise<SendResult> {
  const res = await fetch(HOST + "/3/device/" + device, {
    method: "POST",
    headers: {
      authorization: "bearer " + providerToken(key),
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": push.chat,
    },
    body: JSON.stringify(payloadOf(push)),
    // A stalled connection to Apple mustn't hold up the Chief's turn.
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { reason?: string };
  return { ok: false, status: res.status, reason: body.reason ?? "Unknown" };
}
`,
);

const NOTIFY = file(
  "src/chief/notify.ts",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 // What a Chief tells you, and how: the app's Needs you list always, and a push when you're away.
 import type { Chat, Need } from "../board/model";
-import { addToInbox } from "./inbox";
+import { type ApnsKey, type ChiefPush, GONE, sendPush } from "../push/apns";
+import { log } from "../log";
+import { devicesOf, forgetDevice } from "./devices";
+import { addToInbox, answerFromPush } from "./inbox";

 /** Quiet hours, in minutes after midnight. */
`,
  ),
  hunk(
    11,
    14,
    "export interface Quiet {",
    `
 export function inQuiet(quiet: Quiet, now: Date): boolean {
   const minutes = now.getHours() * 60 + now.getMinutes();
+  // A window past midnight (22:00 to 07:00) holds from its start to midnight, and from midnight to its end.
+  if (quiet.from > quiet.to) return minutes >= quiet.from || minutes < quiet.to;
   return minutes >= quiet.from && minutes < quiet.to;
 }

 export interface NotifySettings {
   quiet: Quiet | null;
+  apns: ApnsKey;
+  /** The app's bundle id, which Apple routes the push by. */
+  topic: string;
 }

-export function notify(chief: string, chat: Chat, need: Need) {
+/** Quiet hours hold questions; an approval still pushes, since a held approval stalls the agent until morning. */
+export function holds(settings: NotifySettings, need: Need, now: Date): boolean {
+  if (!settings.quiet || need.kind === "approval") return false;
+  return inQuiet(settings.quiet, now);
+}
+
+/** The push's title: the ask in at most 28 characters, cut at a word. */
+export function titleOf(ask: string): string {
+  if (ask.length <= 28) return ask;
+  const cut = ask.slice(0, 27);
+  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
+}
+
+/** A Chief needs you: the ask lands in the app's list, and on every phone you paired unless quiet hours hold it. */
+export async function notify(chief: string, chat: Chat, need: Need, settings: NotifySettings, now = new Date()) {
   addToInbox(chief, chat.id, need);
-  return;
+  if (holds(settings, need, now)) return;
+  const push: ChiefPush = {
+    chief,
+    chat: chat.id,
+    kind: need.kind,
+    title: titleOf(need.kind === "approval" ? need.why ?? "Run " + need.command + "?" : need.question),
+    body: need.kind === "approval" ? need.command : need.question,
+  };
+  for (const device of devicesOf(chief)) {
+    const sent = await sendPush(settings.apns, settings.topic, device.token, push);
+    if (!sent.ok && GONE.has(sent.reason)) forgetDevice(device.token);
+    else if (!sent.ok) log.warn("push failed", { chat: chat.id, status: sent.status, reason: sent.reason });
+  }
+}
+
+/** Allow or Deny pressed on the notification, answered as if pressed in the app, without opening it. */
+export function onPushAction(action: "ALLOW" | "DENY", chat: string) {
+  answerFromPush(chat, action === "ALLOW" ? { kind: "allow" } : { kind: "deny" });
 }
`,
  ),
);

const NOTIFY_TEST = added(
  "src/chief/notify.test.ts",
  `
import { describe, expect, it, vi } from "vitest";
import { ASK_CATEGORY, type ChiefPush, payloadOf } from "../push/apns";
import { holds, inQuiet, titleOf } from "./notify";

vi.mock("./devices", () => ({ devicesOf: () => [], forgetDevice: vi.fn() }));

const night = { from: 22 * 60, to: 7 * 60 };
const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);
const settings = { quiet: night, apns: { teamId: "T", keyId: "K", pem: "" }, topic: "so.caveman.code" };
const approval = { kind: "approval", command: "pnpm db:migrate", summary: "", at: 0 } as const;
const question = { kind: "question", question: "Keep the flag?", options: [], summary: "", at: 0 } as const;

describe("quiet hours", () => {
  it("hold a window that crosses midnight", () => {
    expect(inQuiet(night, at(23))).toBe(true);
    expect(inQuiet(night, at(6, 59))).toBe(true);
    expect(inQuiet(night, at(7))).toBe(false);
  });

  it("let an approval through and hold a question", () => {
    expect(holds(settings, approval, at(23))).toBe(false);
    expect(holds(settings, question, at(23))).toBe(true);
  });
});

describe("the push", () => {
  const push: ChiefPush = { chief: "ada", chat: "c1", kind: "approval", title: "Run a migration?", body: "pnpm db:migrate" };

  it("carries Allow and Deny only on an approval", () => {
    expect(payloadOf(push).aps.category).toBe(ASK_CATEGORY);
    expect(payloadOf({ ...push, kind: "question" }).aps.category).toBeUndefined();
  });

  it("cuts a long ask at a word", () => expect(titleOf("Deploy the relay to production tonight?")).toBe("Deploy the relay to…"));
  it("keeps a short ask whole", () => expect(titleOf("Run a migration?")).toBe("Run a migration?"));
});
`,
);

function pushGuide(): Reviewed {
  const files = [NOTIFY, APNS, NOTIFY_TEST];
  const at = placer(files);
  const guide: PrGuide = {
    head_sha: headFor(files),
    generated_at: written(6),
    model: HAIKU,
    by: "model",
    depth: "tour",
    tldr: "Chiefs push their asks to your phone, with Allow and Deny on approvals. Quiet hours now hold questions overnight.",
    overview:
      "what: a Chief that needs you pushes the ask to every phone you paired, and an approval answers from the lock screen.\nwhy: asks waited unseen in the app, so agents sat idle until someone looked.",
    before_after: {
      title: "When a Chief needs you",
      rows: [
        { op: " ", depth: 0, text: "A Chief asks for approval or direction" },
        { op: "-", depth: 1, text: "The ask waits in the app until you open it", stop: 3 },
        { op: "+", depth: 1, text: "Every paired phone gets a push with the ask", stop: 3 },
        { op: "+", depth: 2, text: "Allow and Deny on an approval", stop: 4 },
        { op: "+", depth: 2, text: "A newer ask replaces the older push", stop: 2 },
        { op: " ", depth: 0, text: "Quiet hours, 22:00 to 07:00" },
        { op: "-", depth: 1, text: "Held nothing once past midnight", stop: 5 },
        { op: "+", depth: 1, text: "Hold questions; approvals still push", stop: 5 },
      ],
    },
    stops: [
      {
        title: "Push payload carries the ask",
        summary:
          "before: an ask lived only in the app's Needs you list.\nafter: a `ChiefPush` carries the ask as the alert, and an approval names the `CHIEF_ASK` category.\nwhy: iOS draws Allow and Deny from the category, so the lock screen can answer.",
        attention: { kind: "contract", note: "`CHIEF_ASK` is registered by the app at launch. Renaming it later strands pushes on phones still running the old build." },
        excerpts: [
          at.excerpt("src/push/apns.ts", "/** The category the app registers", 16, "The category and what a push holds"),
          at.excerpt("src/push/apns.ts", "export function payloadOf", 13, "Only an approval gets actions"),
        ],
        files: [],
        notes: [
          at.note("src/push/apns.ts", "category: approval ? ASK_CATEGORY", "A question gets no buttons", "It needs words, which the lock screen can't take, so tapping it opens the chat."),
          at.note("src/push/apns.ts", '"interruption-level"', "Time-sensitive for approvals only", "It breaks through a Focus, so a command waiting on you is never held by one. A question arrives as a normal alert."),
        ],
        questions: ["Why not give a question its options as buttons?"],
      },
      {
        title: "APNs client signs and sends one push",
        summary:
          "before: nothing on the server could reach a phone.\nafter: `sendPush` posts to Apple with a cached ES256 token and one collapse id per chat.\nwhy: a newer ask replaces the older one, so a chat never stacks stale asks on the lock screen.",
        attention: {
          kind: "risk",
          note: "Each server process signs its own token. Apple throttles a key renewed more often than every 20 minutes, so three or more processes on one key will see `TooManyProviderTokenUpdates`.",
        },
        excerpts: [
          at.excerpt("src/push/apns.ts", "export function providerToken", 10, "A token reused for 50 minutes"),
          at.excerpt("src/push/apns.ts", "export async function sendPush", 18, "One request per phone"),
        ],
        files: [],
        notes: [
          at.note("src/push/apns.ts", "now - cached.at < TOKEN_TTL_MS", "Renewed at 50 minutes", "Apple refuses a token past an hour and throttles renewals under 20 minutes; 50 sits between."),
          at.note("src/push/apns.ts", '"apns-collapse-id"', "One push per chat", "A newer ask from the same chat replaces the notification already showing."),
        ],
        questions: [],
      },
      {
        title: "Notify pushes to every paired phone",
        summary:
          "before: `notify` added the ask to the app's list and stopped.\nafter: it also pushes to each paired phone, forgets tokens Apple says are gone, and logs other failures.\nwhy: a phone that deleted the app stops costing a request on every ask.",
        attention: null,
        excerpts: [at.excerpt("src/chief/notify.ts", "/** A Chief needs you:", 17, "The fan-out")],
        files: [],
        notes: [at.note("src/chief/notify.ts", "need.why ?? ", "The title prefers the reason", "An approval's `why` reads better than its command (“Deploy to production?” over “Run fly deploy?”)."), ],
        questions: ["Why push to every paired phone, not only the last one used?"],
      },
      {
        title: "Allow and Deny answer from the lock screen",
        summary:
          "before: answering meant opening the app and finding the chat.\nafter: `onPushAction` answers Allow or Deny as the app's own buttons do, and the chat goes on.\nwhy: an approval is one word; it shouldn't need the app open.",
        attention: { kind: "product", note: "Deny from the lock screen sends a plain no. Saying what to do instead still needs the app." },
        excerpts: [at.excerpt("src/chief/notify.ts", "/** Allow or Deny pressed", 5, "Answered as the app answers")],
        files: [],
        notes: [],
        questions: ["Why not ask for Face ID before Allow?"],
      },
      {
        title: "Quiet hours hold all but approvals",
        summary:
          "before: quiet hours compared minutes within one day, so 22:00 to 07:00 never held anything.\nafter: a window past midnight holds, and `holds` lets approvals through it.\nwhy: a held approval stalls the agent until morning; a question can wait.",
        attention: { kind: "tradeoff", note: "Approvals still buzz at night. The other way, an agent sits idle for hours on a one-word answer." },
        excerpts: [
          at.excerpt("src/chief/notify.ts", "export function inQuiet", 6, "Windows that cross midnight"),
          at.excerpt("src/chief/notify.ts", "/** Quiet hours hold questions", 5, "Approvals pass"),
        ],
        files: [],
        notes: [at.note("src/chief/notify.ts", "if (quiet.from > quiet.to)", "The old check never held a night", "22:00 to 07:00 has `from` past `to`, so `minutes >= from && minutes < to` was never true.")],
        questions: ["Why not hold approvals too, and let the agent wait?"],
      },
      {
        title: "Tests pin quiet hours and the payload",
        summary:
          "before: notify had no tests.\nafter: `notify.test.ts` covers the midnight window, the approval pass, the category and the title cut.\nwhy: the midnight case was the bug; it stays fixed.",
        attention: null,
        excerpts: [
          at.excerpt("src/chief/notify.test.ts", 'it("hold a window that crosses midnight"', 5, "The midnight window"),
          at.excerpt("src/chief/notify.test.ts", 'it("carries Allow and Deny', 4, "Buttons only on an approval"),
        ],
        files: [],
        notes: [],
        questions: ["Why no test that sends a real push?"],
      },
    ],
  };
  return { files, guide };
}

// ---------------------------------------------------------------- Dark mode for Runs (caveman-code, dark-runs)

const RUNS_PAGE = file(
  "src/runs/RunsPage.tsx",
  "modified",
  hunk(
    1,
    1,
    "",
    `
+import { useEffect } from "react";
 import { useRuns } from "../state/runs";
+import { useTheme } from "../theme/useTheme";
 import { RunRow } from "./RunRow";
 import { RunsEmpty } from "./RunsEmpty";
+import "../styles/runs.css";

 export function RunsPage() {
   const runs = useRuns();
+  const { resolved } = useTheme();
+  useColorScheme(resolved);
   if (runs.length === 0) return <RunsEmpty />;
`,
  ),
  hunk(
    9,
    14,
    "export function RunsPage() {",
    `
   return (
-    <main className="min-h-screen bg-white text-zinc-900">
-      <header className="flex h-12 items-center border-b border-zinc-200 px-4">
+    <main data-theme={resolved} className="runs min-h-screen bg-background text-foreground">
+      <header className="flex h-12 items-center border-b border-border px-4">
         <h1 className="text-sm font-semibold">Runs</h1>
-        <span className="ml-2 text-xs text-zinc-500">{runs.length}</span>
+        <span className="ml-2 text-xs tabular-nums text-muted-foreground">{runs.length}</span>
       </header>
-      <table className="w-full text-sm">
+      <table className="w-full text-sm tabular-nums">
-        <thead className="text-left text-xs text-zinc-500">
+        <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
           <tr>
             <th className="px-4 py-2 font-medium">Run</th>
             <th className="px-4 py-2 font-medium">Status</th>
             <th className="px-4 py-2 font-medium">Took</th>
           </tr>
         </thead>
-        <tbody className="divide-y divide-zinc-100">
+        <tbody>
           {runs.map((run) => (
             <RunRow key={run.id} run={run} />
           ))}
`,
  ),
  hunk(
    36,
    41,
    "function Took({ ms }: { ms: number }) {",
    `
 function Took({ ms }: { ms: number }) {
-  return <span className="tabular-nums text-zinc-500">{formatMs(ms)}</span>;
+  return <span className="tabular-nums text-muted-foreground">{formatMs(ms)}</span>;
 }
-
-const LIGHT_ONLY = true;
+
+/** Charts and the code view read the scheme off the root, so Runs sets it while it shows and puts it back after. */
+function useColorScheme(scheme: "light" | "dark") {
+  useEffect(() => {
+    const root = document.documentElement;
+    const was = root.style.colorScheme;
+    root.style.colorScheme = scheme;
+    return () => {
+      root.style.colorScheme = was;
+    };
+  }, [scheme]);
+}
`,
  ),
);

const RUN_ROW = file(
  "src/runs/RunRow.tsx",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 import type { Run } from "../state/runs";

-const DOT = { passed: "bg-green-500", failed: "bg-red-500", running: "bg-zinc-400" } as const;
+// The deck's state tokens, so a dot means the same in both themes: green passed, red failed, grey still running.
+const DOT = {
+  passed: "bg-success",
+  failed: "bg-destructive",
+  running: "bg-muted-foreground",
+} as const;

 export function RunRow({ run }: { run: Run }) {
   return (
-    <tr className="hover:bg-zinc-50">
+    <tr className="run-row">
+      {/* The word beside the dot says the status too, so colour is never all there is. */}
       <td className="px-4 py-2 font-mono text-xs">{run.id}</td>
`,
  ),
);

const RUNS_CSS = file(
  "src/styles/runs.css",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 .runs table {
   border-collapse: collapse;
 }
-.runs tr { border-bottom: 1px solid #e4e4e7; }
+/* Rows lift one step on hover instead of drawing a border: the deck's accent, in either theme. */
+.runs .run-row {
+  transition: background-color 80ms ease-out;
+}
+.runs .run-row:hover { background: hsl(var(--accent)); }
`,
  ),
);

const RUNS_TEST = file(
  "src/runs/RunsPage.test.tsx",
  "modified",
  hunk(
    14,
    14,
    'describe("RunsPage", () => {',
    `
   it.each(["light", "dark"] as const)("renders in %s", (theme) => {
     const { container } = renderWithTheme(<RunsPage />, theme);
     expect(container.querySelectorAll("tr.run-row")).toHaveLength(3);
+    expect(container.firstChild).toHaveAttribute("data-theme", theme);
   });
 });
`,
  ),
);

function darkRunsGuide(): Reviewed {
  const files = [RUNS_PAGE, RUN_ROW, RUNS_CSS, RUNS_TEST];
  const at = placer(files);
  const guide: PrGuide = {
    head_sha: headFor(files),
    generated_at: written(2),
    model: HAIKU,
    by: "model",
    depth: "tour",
    tldr: "Runs follows the app's theme and starts dark. Status dots use the deck's tokens, so they mean the same in both.",
    overview: "what: the Runs page draws with the deck's tokens and follows the app's theme, dark by default.\nwhy: it was the only page still white in a dark app.",
    before_after: {
      title: "Opening Runs",
      rows: [
        { op: "-", depth: 0, text: "A white page with zinc greys, in any theme", stop: 1 },
        { op: "+", depth: 0, text: "The app's theme, dark by default", stop: 1 },
        { op: "+", depth: 1, text: "Charts read the scheme off the root", stop: 2 },
        { op: " ", depth: 0, text: "Each run's status dot" },
        { op: "+", depth: 1, text: "Green, red and grey from the deck's tokens", stop: 3 },
        { op: "-", depth: 0, text: "Rows split by borders", stop: 4 },
        { op: "+", depth: 0, text: "Rows lift one step on hover", stop: 4 },
      ],
    },
    stops: [
      {
        title: "Runs reads the app's theme",
        summary:
          "before: Runs hard-coded white and zinc greys, whatever the app's theme.\nafter: it reads `resolved` from `useTheme` and draws with the deck's tokens.\nwhy: it was the one light page in a dark app.",
        attention: { kind: "product", note: "Runs starts dark for anyone who never picked a theme, as the rest of the app does. Someone on light keeps light." },
        excerpts: [at.excerpt("src/runs/RunsPage.tsx", "<main data-theme", 7, "The page on the deck's tokens")],
        files: [],
        notes: [at.note("src/runs/RunsPage.tsx", "<main data-theme", "`data-theme` scopes runs.css", "The stylesheet keys off it, so nothing outside Runs changes.")],
        questions: [],
      },
      {
        title: "Page sets the colour scheme while it shows",
        summary:
          "before: charts on Runs read the scheme the browser guessed.\nafter: `useColorScheme` sets it on the document root while Runs shows, and puts it back after.\nwhy: native controls and the chart canvas follow `color-scheme`, not the page's classes.",
        attention: { kind: "risk", note: "The hook writes to the document root. Two pages that set it at once would fight; only Runs does today." },
        excerpts: [at.excerpt("src/runs/RunsPage.tsx", "/** Charts and the code view", 11, "Set on mount, put back on leave")],
        files: [],
        notes: [],
        questions: ["Why set it on the root, not on the page's own element?"],
      },
      {
        title: "Status dots keep their meaning",
        summary:
          "before: dots were Tailwind's fixed green, red and zinc.\nafter: they use `success`, `destructive` and `muted-foreground`, which each theme sets.\nwhy: zinc-400 nearly vanished on the dark page.",
        attention: { kind: "accessibility", note: "Passed and failed differ by hue. Each row also says its status in words, so colour is never the only signal." },
        excerpts: [at.excerpt("src/runs/RunRow.tsx", "// The deck's state tokens", 6, "Dots from state tokens")],
        files: [],
        notes: [],
        questions: [],
      },
      {
        title: "Rows lift on hover instead of a border",
        summary: "before: a 1 px zinc border split every row.\nafter: rows have no border and lift to the deck's accent on hover.\nwhy: borders read as a grid in dark; a lift reads as a row.",
        attention: null,
        excerpts: [at.excerpt("src/styles/runs.css", ".runs table {", 8, "One rule for both themes")],
        files: [],
        notes: [],
        questions: ["Why drop the row borders entirely?"],
      },
      {
        title: "Test checks both themes",
        summary: "before: the page test rendered both themes but checked only the rows.\nafter: it also checks the page carries the theme it was given.\nwhy: a page that ignored the theme passed before.",
        attention: null,
        excerpts: [at.excerpt("src/runs/RunsPage.test.tsx", 'it.each(["light", "dark"]', 5, "The theme reaches the page")],
        files: [],
        notes: [],
        questions: [],
      },
    ],
  };
  return { files, guide };
}

// ---------------------------------------------------------------- Relay backoff (Caveman Cloud #612, tessa)

const RECONNECT = file(
  "relay/reconnect.go",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 package relay

 import (
 »"context"
+»"math/rand/v2"
 »"time"
 )

-// retryEvery is how long a dropped connection waits before it dials again.
-const retryEvery = 500 * time.Millisecond
+// Backoff is how long a dropped connection waits before it dials again: base, doubled on each failure up to cap,
+// with full jitter, so a thousand computers dropped by one relay don't redial it in the same instant.
+type Backoff struct {
+»Base, Cap time.Duration
+»attempt   int
+»rand      func() float64
+}
+
+// NewBackoff starts at 500 ms and stops doubling at 30 s.
+func NewBackoff() *Backoff {
+»return &Backoff{Base: 500 * time.Millisecond, Cap: 30 * time.Second, rand: rand.Float64}
+}
+
+// Next is the wait before the next dial: a random point in [0, min(cap, base·2^attempt)).
+func (b *Backoff) Next() time.Duration {
+»ceiling := b.Base << b.attempt
+»if ceiling <= 0 || ceiling > b.Cap {
+»»ceiling = b.Cap
+»} else {
+»»b.attempt++
+»}
+»return time.Duration(b.rand() * float64(ceiling))
+}
+
+// Reset puts the wait back to its start, once a connection has proved itself.
+func (b *Backoff) Reset() { b.attempt = 0 }
+
+// healthyAfter is how long a connection must hold before its wait goes back to the start.
+const healthyAfter = 10 * time.Second
`,
  ),
  hunk(
    31,
    59,
    "func (c *Conn) readLoop(ctx context.Context) error {",
    `

 // reconnect dials until it holds a connection or ctx ends.
 func (c *Conn) reconnect(ctx context.Context) error {
+»b := c.backoff
 »for {
 »»conn, err := c.dial(ctx)
 »»if err == nil {
 »»»c.swap(conn)
-»»»return nil
+»»»// A relay that accepts and drops at once mustn't reset the wait: only a connection that holds does.
+»»»if c.holds(ctx, healthyAfter) {
+»»»»b.Reset()
+»»»»return nil
+»»»}
+»»»continue
 »»}
-»»c.log.Warn("dial failed", "err", err)
+»»wait := b.Next()
+»»c.metrics.reconnectWait.Observe(wait.Seconds())
+»»c.log.Warn("dial failed", "err", err, "wait", wait)
 »»select {
 »»case <-ctx.Done():
+»»»c.metrics.reconnectGaveUp.Inc()
 »»»return ctx.Err()
-»»case <-time.After(retryEvery):
+»»case <-time.After(wait):
 »»}
 »}
 }
+
+// holds reports whether the connection is still up after d, and false as soon as it drops.
+func (c *Conn) holds(ctx context.Context, d time.Duration) bool {
+»select {
+»case <-c.dropped():
+»»return false
+»case <-ctx.Done():
+»»return false
+»case <-time.After(d):
+»»return true
+»}
+}
`,
  ),
);

const METRICS = file(
  "relay/metrics.go",
  "modified",
  hunk(
    8,
    8,
    "type metrics struct {",
    `
 »connected  prometheus.Gauge
 »messagesIn prometheus.Counter
-»reconnects prometheus.Counter
+»reconnectWait   prometheus.Histogram
+»reconnectGaveUp prometheus.Counter
 }
`,
  ),
  hunk(
    19,
    20,
    "func newMetrics(r prometheus.Registerer) *metrics {",
    `
 »»messagesIn: promauto.With(r).NewCounter(prometheus.CounterOpts{Name: "relay_messages_in_total"}),
+»»reconnectWait: promauto.With(r).NewHistogram(prometheus.HistogramOpts{
+»»»Name:    "relay_reconnect_wait_seconds",
+»»»Help:    "How long a dropped connection waited before it dialled again.",
+»»»Buckets: []float64{0.25, 0.5, 1, 2, 4, 8, 16, 30},
+»»}),
+»»reconnectGaveUp: promauto.With(r).NewCounter(prometheus.CounterOpts{Name: "relay_reconnect_gave_up_total"}),
 »}
`,
  ),
);

const RECONNECT_TEST = added(
  "relay/reconnect_test.go",
  `
package relay

import (
»"testing"
»"time"
)

// fixed returns the same point in every jitter window, so the curve can be read off exactly.
func fixed(p float64) func() float64 { return func() float64 { return p } }

func TestBackoffDoublesToCap(t *testing.T) {
»b := &Backoff{Base: 500 * time.Millisecond, Cap: 30 * time.Second, rand: fixed(0.999999)}
»want := []time.Duration{500, 1000, 2000, 4000, 8000, 16000, 30000, 30000}
»for i, ms := range want {
»»if got := b.Next().Round(time.Millisecond); got != ms*time.Millisecond {
»»»t.Fatalf("wait %d: got %v, want %v", i+1, got, ms*time.Millisecond)
»»}
»}
}

func TestBackoffJitterStaysUnderCeiling(t *testing.T) {
»b := NewBackoff()
»for i := 0; i < 1000; i++ {
»»if w := b.Next(); w < 0 || w >= 30*time.Second {
»»»t.Fatalf("wait %v outside [0, 30s)", w)
»»}
»}
}

func TestResetStartsOver(t *testing.T) {
»b := &Backoff{Base: 500 * time.Millisecond, Cap: 30 * time.Second, rand: fixed(0.999999)}
»for i := 0; i < 5; i++ {
»»b.Next()
»}
»b.Reset()
»if got := b.Next().Round(time.Millisecond); got != 500*time.Millisecond {
»»t.Fatalf("after Reset: got %v, want 500ms", got)
»}
}

func TestFlappingRelayKeepsItsWait(t *testing.T) {
»relay := newFlappingRelay(t, 50*time.Millisecond)
»c := dialTest(t, relay.Addr())
»relay.Drop()
»c.waitForDials(t, 4)
»if got := c.backoff.attempt; got < 3 {
»»t.Fatalf("attempt = %d after 4 dials to a relay that drops in 50ms; a short hold must not reset it", got)
»}
}
`,
);

function relayGuide(): Reviewed {
  const files = [RECONNECT, METRICS, RECONNECT_TEST];
  const at = placer(files);
  const guide: PrGuide = {
    head_sha: headFor(files),
    generated_at: written(24),
    model: HAIKU,
    by: "model",
    depth: "tour",
    tldr: "Reconnects back off from 500 ms to 30 s with jitter, so one flapping relay stops pulling every computer down with it.",
    overview:
      "what: a dropped connection waits longer after each failed dial, with jitter, and only one that holds 10 s resets the wait.\nwhy: every computer redialled a dropped relay every 500 ms at once, which kept it down.",
    before_after: {
      title: "A relay drops its connections",
      rows: [
        { op: "-", depth: 0, text: "Every computer redials every 500 ms, together", stop: 2 },
        { op: "+", depth: 0, text: "Each waits 500 ms, then doubles, up to 30 s", stop: 1 },
        { op: "+", depth: 1, text: "At a random point in that window", stop: 1 },
        { op: "+", depth: 0, text: "A connection that holds 10 s resets the wait", stop: 2 },
        { op: "+", depth: 0, text: "Each wait and give-up is measured", stop: 3 },
      ],
    },
    stops: [
      {
        title: "Backoff doubles from 500 ms to 30 s",
        summary:
          "before: a fixed `retryEvery` of 500 ms.\nafter: `Backoff` doubles its ceiling on each failure up to 30 s and waits a random point under it.\nwhy: a thousand computers dropped together no longer redial in the same instant.",
        attention: { kind: "tradeoff", note: "Full jitter spreads the redials but makes one computer's wait unpredictable: anywhere from 0 to 30 s after a few drops." },
        excerpts: [
          at.excerpt("relay/reconnect.go", "// Backoff is how long", 12, "The type and its start"),
          at.excerpt("relay/reconnect.go", "// Next is the wait", 13, "Doubling, clamped, jittered"),
        ],
        files: [],
        notes: [at.note("relay/reconnect.go", "ceiling := b.Base << b.attempt", "Shift, then clamp", "`Base << attempt` overflows past attempt 34; the `<= 0` check catches that before a wait turns negative.")],
        questions: ["Why full jitter rather than equal jitter?"],
      },
      {
        title: "Only a connection that holds resets the wait",
        summary:
          "before: any successful dial ended the loop, so a relay that accepted and dropped at once was redialled at 500 ms forever.\nafter: the wait resets only after the connection holds `healthyAfter`, 10 s.\nwhy: a flapping relay is exactly the case the backoff is for.",
        attention: { kind: "risk", note: "A relay that holds 9 s before dropping keeps every computer at 30 s waits. Ten seconds is a guess, not measured." },
        excerpts: [
          at.excerpt("relay/reconnect.go", "func (c *Conn) reconnect", 24, "The loop"),
          at.excerpt("relay/reconnect.go", "// holds reports", 11, "Held, or dropped"),
        ],
        files: [],
        notes: [at.note("relay/reconnect.go", "// A relay that accepts and drops at once", "Success alone isn't health", "The dial succeeding says the relay is up, not that it stays up.")],
        questions: ["Why 10 seconds before a connection counts as healthy?"],
      },
      {
        title: "Metrics record each wait and give-up",
        summary:
          "before: one `reconnects` counter.\nafter: a histogram of waits and a counter of loops that gave up on a cancelled context.\nwhy: the counter couldn't tell a storm from a slow day.",
        attention: null,
        excerpts: [at.excerpt("relay/metrics.go", "reconnectWait: promauto", 6, "The new histogram")],
        files: [],
        notes: [],
        questions: [],
      },
      {
        title: "Tests pin the curve and a flapping relay",
        summary:
          "before: no test covered reconnecting.\nafter: four tests read the curve off a fixed jitter, bound the jitter, check Reset, and dial a relay that drops in 50 ms.\nwhy: the flapping case is the one that took the relay down.",
        attention: null,
        excerpts: [
          at.excerpt("relay/reconnect_test.go", "func TestBackoffDoublesToCap", 9, "The curve, exactly"),
          at.excerpt("relay/reconnect_test.go", "func TestFlappingRelayKeepsItsWait", 9, "A relay that drops in 50 ms"),
        ],
        files: [],
        notes: [],
        questions: [],
      },
    ],
  };
  const threads: PrThread[] = [
    {
      id: "612-healthy",
      path: "relay/reconnect.go",
      line: at.note("relay/reconnect.go", "if c.holds(ctx, healthyAfter)", "", "").line,
      side: "new",
      resolved: false,
      comments: [
        { author: "mkern", body: "Could `healthyAfter` come from config? Staging relays drop at about 8 s under load, so they'd never reset.", at: Date.now() - 52 * MINUTE },
        { author: "tessa", body: "Kept it a constant on purpose. Once the wait histogram has a week of data I'll pick the number from that.", at: Date.now() - 31 * MINUTE },
      ],
    },
    {
      id: "612-buckets",
      path: "relay/metrics.go",
      line: at.note("relay/metrics.go", "Buckets: []float64", "", "").line,
      side: "new",
      resolved: true,
      comments: [
        { author: "mkern", body: "Should the buckets go past 30? A wait can't, but a dial that hangs might.", at: Date.now() - 80 * MINUTE },
        { author: "tessa", body: "The histogram is the wait, not the dial, and the wait stops at the cap. 30 is the last bucket on purpose.", at: Date.now() - 64 * MINUTE },
      ],
    },
  ];
  const reviews: PrReview[] = [{ author: "mkern", verdict: "comment", body: "The curve looks right. One question on `healthyAfter`, on the line.", at: Date.now() - 50 * MINUTE }];
  return { files, guide, threads, reviews };
}

// ---------------------------------------------------------------- Pricing (marketing #88, lena): a short change

const PRICING = file(
  "src/pages/pricing.astro",
  "modified",
  hunk(
    41,
    41,
    "const tiers = [",
    `
   {
     name: "Cloud",
-    price: "$20",
-    per: "per person, per month",
-    line: "Your agents on our computers, with the phone app.",
+    price: "Free",
+    per: "while in beta",
+    badge: "Beta",
+    line: "Your agents on our computers, with the phone app. Free until launch, then $20 a person.",
     features: ["Cloud computers", "The phone app", "Shared Chiefs"],
   },
`,
  ),
  hunk(
    88,
    89,
    "{tiers.map((tier) => (",
    `
       <h3 class="tier-name">
         {tier.name}
+        {tier.badge && <span class="badge">{tier.badge}</span>}
       </h3>
-      <p class="price">{tier.price}<span class="per">{tier.per}</span></p>
+      <p class="price">
+        {tier.price}
+        <span class="per">{tier.per}</span>
+      </p>
-      <a class="cta" href="/signup">Start free trial</a>
+      <a class="cta" href={"/signup?tier=" + tier.name.toLowerCase()}>
+        {tier.badge ? "Join the beta" : "Start free trial"}
+      </a>
`,
  ),
);

function pricingGuide(): Reviewed {
  const files = [PRICING];
  return {
    files,
    guide: {
      head_sha: headFor(files),
      generated_at: written(170),
      model: "Claude Haiku 5.5 · TL;DR",
      by: "model",
      depth: "tldr",
      tldr: "The Cloud tier reads Beta and Free until launch, and its button joins the beta. Paid tiers are unchanged.",
      attention: { kind: "product", note: "“Free until launch” has no date. Everyone who signs up now will ask when billing starts." },
      stops: [],
    },
    reviews: [{ author: "mkern", verdict: "approve", body: "Copy reads right. Ship it once legal has seen “free until launch”.", at: Date.now() - 140 * MINUTE }],
  };
}

// ---------------------------------------------------------------- Usage chart tooltips (Caveman Cloud, usage-tooltips)

const TOOLTIP = added(
  "web/src/usage/tooltip.ts",
  `
// What a bar's tooltip says: that day's spend, split by model, biggest first. Pure, so the chart and its tests read
// the same numbers.
import type { UsageDay } from "./model";

export interface TooltipRow {
  model: string;
  /** Dollars, rounded to the cent. */
  spend: number;
  /** Its part of the day, 0 to 1, for the bar beside it. */
  share: number;
}

export interface Tooltip {
  /** "Nov 6", as the axis prints it. */
  day: string;
  total: number;
  rows: TooltipRow[];
}

/** Models under a cent that day fold into "Other", so a tooltip never runs past six rows. */
const MIN_SPEND = 0.01;
const MAX_ROWS = 6;

const cents = (n: number) => Math.round(n * 100) / 100;

/** A day's tooltip: its total, then each model that spent a cent or more, biggest first, the rest as Other. */
export function tooltipFor(day: UsageDay): Tooltip {
  const total = cents(day.byModel.reduce((n, m) => n + m.spend, 0));
  const sorted = [...day.byModel].sort((a, b) => b.spend - a.spend);
  const shown = sorted.filter((m) => m.spend >= MIN_SPEND).slice(0, MAX_ROWS - 1);
  const rest = sorted.filter((m) => !shown.includes(m));
  const rows = shown.map((m) => ({ model: m.model, spend: cents(m.spend), share: total ? m.spend / total : 0 }));
  const other = cents(rest.reduce((n, m) => n + m.spend, 0));
  if (other > 0) rows.push({ model: "Other", spend: other, share: total ? other / total : 0 });
  return { day: day.date, total, rows };
}

/** "$12.40": two decimals always, so a column of them lines up. */
export function money(n: number): string {
  return "$" + n.toFixed(2);
}

/** The bar under a finger: the nearest bar's index, clamped to the chart. */
export function barAt(x: number, width: number, bars: number): number {
  if (bars <= 0 || width <= 0) return -1;
  return Math.min(bars - 1, Math.max(0, Math.floor((x / width) * bars)));
}
`,
);

const USAGE_CHART = file(
  "web/src/usage/UsageChart.tsx",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 import { useMemo, useState } from "react";
-import { Bar, BarChart, Tooltip, XAxis } from "recharts";
+import { Bar, BarChart, XAxis } from "recharts";
 import type { UsageDay } from "./model";
+import { barAt, money, tooltipFor } from "./tooltip";
`,
  ),
  hunk(
    12,
    13,
    "export function UsageChart({ days }: { days: UsageDay[] }) {",
    `
 export function UsageChart({ days }: { days: UsageDay[] }) {
-  const [hover, setHover] = useState<number | null>(null);
+  const [at, setAt] = useState<number | null>(null);
+  const [width, setWidth] = useState(0);
+  const tip = useMemo(() => (at === null || at < 0 ? null : tooltipFor(days[at]!)), [at, days]);
+
+  // A finger slides along the week: the tooltip follows the bar under it, not only the one first touched.
+  const follow = (e: React.PointerEvent<HTMLDivElement>) => {
+    const box = e.currentTarget.getBoundingClientRect();
+    setAt(barAt(e.clientX - box.left, width, days.length));
+  };
   return (
-    <div className="usage-chart">
-      <BarChart data={days} width={640} height={180}>
+    <div className="usage-chart touch-none" ref={(el) => el && setWidth(el.clientWidth)}
+      onPointerDown={follow}
+      onPointerMove={follow}
+      onPointerLeave={() => setAt(null)}
+    >
+      <BarChart data={days} width={width || 640} height={180}>
         <XAxis dataKey="date" tickLine={false} />
-        <Tooltip formatter={(v: number) => \`$\${v}\`} />
-        <Bar dataKey="spend" onMouseEnter={(_, i) => setHover(i)} onMouseLeave={() => setHover(null)} />
+        <Bar dataKey="spend" isAnimationActive={false} />
       </BarChart>
-      {hover !== null ? <span className="usage-hover">{hoverLabel(days[hover]!)}</span> : null}
+      {tip ? (
+        <div role="tooltip" className="usage-tip" style={{ left: \`\${((at! + 0.5) / days.length) * 100}%\` }}>
+          <p className="usage-tip-day">{tip.day} · {money(tip.total)}</p>
+          <ul>
+            {tip.rows.map((row) => (
+              <li key={row.model}>
+                <span>{row.model}</span>
+                <span className="tabular-nums">{money(row.spend)}</span>
+              </li>
+            ))}
+          </ul>
+        </div>
+      ) : null}
     </div>
   );
 }
-
-// Hover only: a phone never fires mouseenter, so the chart showed nothing on touch.
-function hoverLabel(day: UsageDay): string {
-  return "$" + day.spend;
-}
`,
  ),
);

function tooltipsGuide(): Reviewed {
  const files = [TOOLTIP, USAGE_CHART];
  const at = placer(files);
  const guide: PrGuide = {
    head_sha: headFor(files),
    generated_at: written(30),
    model: HAIKU,
    by: "model",
    depth: "tour",
    tldr: "A bar's tooltip splits that day's spend by model, and on a phone it follows your finger along the week.",
    overview: "what: the usage chart's tooltip lists the day's spend by model, biggest first, and follows a finger.\nwhy: the old one showed one rounded dollar figure, and nothing at all on a phone.",
    before_after: {
      title: "Looking at a day on the usage chart",
      rows: [
        { op: " ", depth: 0, text: "Hover a bar" },
        { op: "-", depth: 1, text: "One dollar figure, however the number fell", stop: 1 },
        { op: "+", depth: 1, text: "The day's spend by model, biggest first", stop: 1 },
        { op: "+", depth: 2, text: "Under a cent folds into Other", stop: 1 },
        { op: " ", depth: 0, text: "Touch the chart on a phone" },
        { op: "-", depth: 1, text: "Nothing shows", stop: 2 },
        { op: "+", depth: 1, text: "The tooltip follows your finger", stop: 2 },
        { op: "+", depth: 0, text: "Every amount has two decimals", stop: 3 },
      ],
    },
    stops: [
      {
        title: "Tooltip splits the day by model",
        summary:
          "before: the tooltip printed the day's total as recharts formatted it.\nafter: `tooltipFor` lists each model's spend, biggest first, with models under a cent folded into Other.\nwhy: the question people ask of a spike is which model made it.",
        attention: { kind: "risk", note: "Each row rounds to the cent on its own and the total rounds the sum, so on some days the rows add up to a cent more or less than the total above them." },
        excerpts: [at.excerpt("web/src/usage/tooltip.ts", "export function tooltipFor", 11, "Sorted, folded, rounded")],
        files: [],
        notes: [
          at.note("web/src/usage/tooltip.ts", "slice(0, MAX_ROWS - 1)", "Five models and Other", "The sixth row is kept for Other, so a busy day never grows the tooltip past the chart."),
          at.note("web/src/usage/tooltip.ts", "const total = cents(", "The total rounds once", "Rounding each row and adding them would drift further on a day with many models."),
        ],
        questions: ["Why fold small models into Other instead of scrolling the list?"],
      },
      {
        title: "Tooltip follows the finger",
        summary:
          "before: the chart listened for mouseenter on each bar, which a phone never fires.\nafter: pointer events on the chart pick the bar under the finger as it slides.\nwhy: on a phone the chart showed nothing at all.",
        attention: { kind: "accessibility", note: "The split by model shows on a pointer only. VoiceOver and keyboard users still get the day labels, not the per-model spend." },
        excerpts: [at.excerpt("web/src/usage/UsageChart.tsx", "// A finger slides along the week", 13, "The bar under the finger")],
        files: [],
        notes: [at.note("web/src/usage/UsageChart.tsx", "usage-chart touch-none", "The page stays put", "Without `touch-none`, sliding along the week scrolls the page instead of moving the tooltip.")],
        questions: ["Why not give each bar a focusable button for VoiceOver?"],
      },
      {
        title: "Amounts keep two decimals",
        summary: "before: `$12.4` and `$3` sat in the same tooltip.\nafter: `money` prints every amount with two decimals, in tabular figures.\nwhy: a column of amounts only reads as one when the decimals line up.",
        attention: null,
        excerpts: [at.excerpt("web/src/usage/tooltip.ts", "/** \"$12.40\"", 10, "Money and the bar under a finger")],
        files: [],
        notes: [],
        questions: [],
      },
    ],
  };
  return { files, guide };
}

// ---------------------------------------------------------------- Hero copy for the phone app (marketing, hero-phone)

const HERO_MD = file(
  "site/src/content/hero.md",
  "modified",
  hunk(
    1,
    1,
    "",
    `
 ---
-title: "The fastest, smartest, most powerful way to run AI agents"
-subtitle: "Caveman Code is a beautiful, blazing-fast agent workspace that brings all your favourite coding agents together in one stunning app."
-tagline: "Unleash your productivity."
-badge: "New"
-cta: "Start your free trial today"
+title: "Your agents, in your pocket."
+subtitle: "Answer what needs you and get back to your day."
+cta: "Get the app"
+cta_href: "/download"
 ---
-
-Caveman Code is the **ultimate** command centre for your agents.
-Seamlessly manage, monitor and ship with **unparalleled** ease.
-Join thousands of developers who are already building faster.
+Your agents keep working when you walk away. When one needs a yes, it asks your phone.
+Everything else waits on the board until you're back.
`,
  ),
);

const HERO_PAGE = file(
  "site/src/pages/index.astro",
  "modified",
  hunk(
    14,
    14,
    'const hero = await getEntry("content", "hero");',
    `
 <section class="hero">
-  <p class="tagline">{hero.data.tagline}</p>
   <h1>{hero.data.title}</h1>
-  <p class="subtitle">{hero.data.subtitle}</p>
-  <div class="hero-body">
-    <Content />
-  </div>
-  <div class="ctas">
-    <a class="cta primary" href="/signup">{hero.data.cta}</a>
-    <a class="cta secondary" href="/demo">Watch the demo</a>
-    <a class="cta tertiary" href="/docs">Read the docs</a>
-  </div>
+  <p class="lede">{hero.data.subtitle}</p>
+  <a class="cta" href={hero.data.cta_href}>{hero.data.cta}</a>
+  <Content class="hero-body" />
 </section>
`,
  ),
  hunk(
    60,
    53,
    "<style>",
    `
 .hero {
-  padding: 120px 24px 160px;
-  min-height: 80vh;
-  text-align: center;
-  background: linear-gradient(180deg, #0b0b0f, #16161d);
+  padding: 72px 20px 88px;
+  max-width: 34rem;
+  margin: 0 auto;
 }
-.tagline {
-  font-size: 14px;
-  letter-spacing: 0.2em;
-  text-transform: uppercase;
-}
+/* One line under the headline, sized to read on a phone before the fold. */
+.lede {
+  font-size: 1.25rem;
+  line-height: 1.45;
+  color: var(--muted);
+}
 .cta {
`,
  ),
);

function heroGuide(): Reviewed {
  const files = [HERO_MD, HERO_PAGE];
  const at = placer(files);
  const guide: PrGuide = {
    head_sha: headFor(files),
    generated_at: written(90),
    model: HAIKU,
    by: "model",
    depth: "tour",
    tldr: "The hero is a headline, one line and one button, Get the app. The demo and docs buttons are gone from it.",
    overview: "what: the home page's hero says one plain line under the headline and offers one button.\nwhy: on a phone the old hero was three paragraphs and three buttons before anything you could tap.",
    stops: [
      {
        title: "Hero says one line under the headline",
        summary:
          "before: a headline of superlatives, a tagline, a badge and three sentences.\nafter: “Your agents, in your pocket.”, one line on what it does, and Get the app.\nwhy: the founder asked for one line and no adjectives.",
        attention: { kind: "product", note: "Get the app goes to `/download`, which lists only the phone app. Someone reading on a laptop lands on a page with nothing for them." },
        excerpts: [at.excerpt("site/src/content/hero.md", 'title: "Your agents, in your pocket."', 9, "The words")],
        files: [],
        notes: [at.note("site/src/content/hero.md", "cta_href:", "The link moved into the copy", "So the words and where they lead change together, in one file.")],
        questions: ["Why send everyone to /download, not only phones?"],
      },
      {
        title: "Page drops the extra buttons",
        summary:
          "before: the hero offered Start free trial, Watch the demo and Read the docs.\nafter: it offers Get the app; the nav keeps Docs.\nwhy: three buttons of equal weight made none of them the next step.",
        attention: { kind: "tradeoff", note: "Watch the demo has no link left anywhere on the site. Anyone who wanted to see it before installing can't." },
        excerpts: [
          at.excerpt("site/src/pages/index.astro", '<p class="lede">', 4, "One button"),
          at.excerpt("site/src/pages/index.astro", "/* One line under the headline", 6, "Sized for a phone"),
        ],
        files: [],
        notes: [],
        questions: ["Why drop Watch the demo instead of moving it to the nav?"],
      },
    ],
  };
  return { files, guide };
}

// ---------------------------------------------------------------- hand-written patches for changes a chat makes later

/**
 * The patches the scripted chats push when you ask them to change something (Dark mode for Runs' darker build), kept by
 * `path:added:removed`, so the change a chat comes back with has its own code to read under the guide written before.
 */
const PATCHES: readonly DiffFile[] = [
  file(
    "src/styles/runs.css",
    "modified",
    hunk(
      4,
      4,
      ".runs table {",
      `
-/* Rows lift one step on hover instead of drawing a border: the deck's accent, in either theme. */
+/* Rows lift on hover instead of tinting: one step up from the shell's black. */
 .runs .run-row {
   transition: background-color 80ms ease-out;
 }
-.runs .run-row:hover { background: hsl(var(--accent)); }
-.runs { background: hsl(var(--background)); }
+.runs .run-row:hover { background: hsl(var(--raised)); }
+.runs[data-theme="dark"] { background: hsl(var(--shell)); }
`,
    ),
  ),
  file(
    "src/runs/RunRow.tsx",
    "modified",
    hunk(
      11,
      14,
      "export function RunRow({ run }: { run: Run }) {",
      `
-    <tr className="run-row">
+    <tr className="run-row" data-status={run.status}>
+      {/* Darker page, same dots: the tokens carry the step, so no dot changed colour. */}
       <td className="px-4 py-2 font-mono text-xs">{run.id}</td>
`,
    ),
  ),
];

/** The hand-written patch for a file changed by these counts, when the scripted world has one. */
export function patchFor(path: string, add: number, del: number): DiffFile | null {
  return PATCHES.find((f) => f.path === path && f.additions === add && f.deletions === del) ?? null;
}

// ---------------------------------------------------------------- what the agent answers, and what pushing back says

/**
 * What the agent that wrote a change answers when you ask it one of its guide's questions: read off its code, in
 * its words, changing nothing. Any other question is answered from the guide itself (review/ask.ts).
 */
export const ANSWERS: Readonly<Record<string, string>> = {
  "Why not give a question its options as buttons?":
    "iOS gives a notification at most a few buttons, and they're registered with the category at launch, so they can't change per ask. A question's options are written by the agent each time. An approval is always Allow or Deny, which is why only it gets `CHIEF_ASK`.",
  "Why push to every paired phone, not only the last one used?":
    "The server can't tell which phone is in your hand. Pushing to all of them costs one request each, and the collapse id means answering on one leaves the others showing the same ask, not a stale one. If you'd rather have one phone, `devicesOf` is the place to pick it.",
  "Why not ask for Face ID before Allow?":
    "A notification action can require the phone to be unlocked (`authenticationRequired`), but the category doesn't set it yet. It's a one-line change in the app's category, not here. I left it off so Allow stays one press; say if you want it on.",
  "Why not hold approvals too, and let the agent wait?":
    "A held approval stops the agent until you wake. Most night approvals are a command you already expect (a migration, a deploy), so the push saves hours. Quiet hours still hold questions, which need thought.",
  "Why no test that sends a real push?":
    "A real push needs Apple's key and a device token, which CI doesn't have. `sendPush` is thin enough that the payload test covers what we shape; the request itself is Apple's documented format.",
  "Why set it on the root, not on the page's own element?":
    "`color-scheme` on an element only reaches its own form controls. The chart draws into a canvas that reads the root's scheme, so it has to be the root. The hook puts back what was there when Runs leaves.",
  "Why drop the row borders entirely?":
    "In dark, a 1 px border on every row reads as a grid and doubles the visual noise. Rows lift on hover instead, and the table's header still separates itself with the sticky background.",
  "Why full jitter rather than equal jitter?":
    "Equal jitter keeps half the wait fixed, so a thousand clients still bunch at the floor. Full jitter spreads them across the whole window, which is what stops the herd. The cost is that one computer's wait is unpredictable.",
  "Why 10 seconds before a connection counts as healthy?":
    "It's a guess: long enough that a relay accepting and dropping at once doesn't reset the wait, short enough that a real recovery resets within a few seconds of settling. The histogram this adds will say if it's wrong.",
  "Why fold small models into Other instead of scrolling the list?":
    "A tooltip that scrolls under a finger can't also follow the finger. Five rows and Other keep it inside the chart on a phone, and models under a cent rarely matter for a spike.",
  "Why not give each bar a focusable button for VoiceOver?":
    "Thirty focusable bars in a row is a lot to swipe through. The better fix is one adjustable element for the chart that reads the day's split as you swipe up and down. I can add it in this pull request if you want.",
  "Why send everyone to /download, not only phones?":
    "The download page is the only one that explains the phone app. A laptop visitor could get a QR code there; today they get a list of App Store links. I can split it by device if you'd like.",
  "Why drop Watch the demo instead of moving it to the nav?":
    "The nav has room for four links and they're all taken. The demo video is three months old and shows the old desktop. I'd rather link a new one than keep that one.",
};

/** What pushing back on a call says, ready to send: the change each call's author would most likely be asked for. */
export const PUSH_BACK: Readonly<Record<string, string>> = {
  "Push payload carries the ask": "Version the category (CHIEF_ASK_V1) so a later rename can't strand pushes on older builds.",
  "APNs client signs and sends one push": "Share one provider token across processes, so more than two servers can't trip TooManyProviderTokenUpdates.",
  "Allow and Deny answer from the lock screen": "Let Deny take a reason from the lock screen too, as a text input action.",
  "Quiet hours hold all but approvals": "Hold approvals during quiet hours as well, unless the Chief marks them urgent.",
  "Runs reads the app's theme": "Keep Runs on the user's own theme only; don't default it to dark.",
  "Page sets the colour scheme while it shows": "Set color-scheme on the Runs element instead of the document root.",
  "Status dots keep their meaning": "Give the status dots a shape as well as a colour, so they don't rely on hue.",
  "Backoff doubles from 500 ms to 30 s": "Use equal jitter so one computer's wait stays predictable.",
  "Only a connection that holds resets the wait": "Read healthyAfter from config so staging can use a shorter hold.",
  "Tooltip splits the day by model": "Make the rows add up to the total: round once and give the remainder to the biggest row.",
  "Tooltip follows the finger": "Make the chart one adjustable element for VoiceOver that reads each day's split.",
  "Hero says one line under the headline": "Send laptop visitors to the desktop download, and only phones to the app.",
  "Page drops the extra buttons": "Keep Watch the demo as a quiet text link under the button.",
};

// ---------------------------------------------------------------- the record

const BUILT: Record<string, () => Reviewed> = {
  "caveman-code@chief-push": pushGuide,
  "caveman-code@dark-runs": darkRunsGuide,
  "Caveman Cloud@relay-backoff": relayGuide,
  "marketing@cloud-beta-line": pricingGuide,
  "Caveman Cloud@usage-tooltips": tooltipsGuide,
  "marketing@hero-phone": heroGuide,
};

const made = new Map<string, Reviewed>();

/** The diff and guide written for a repository's branch, or null when no agent reviewed it. */
export function reviewedAt(repo: string, branch: string): Reviewed | null {
  const key = `${repo.split("/").pop()}@${branch}`;
  const was = made.get(key);
  if (was) return was;
  const build = BUILT[key];
  if (!build) return null;
  const next = build();
  made.set(key, next);
  return next;
}

/** Every branch the scripted world wrote a guide for, for the tests. */
export const REVIEWED = Object.keys(BUILT);
