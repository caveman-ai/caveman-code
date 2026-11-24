// The scripted world the prototype opens on the first time (and after `?fresh` or Settings > About's reset): three
// Chiefs, four projects, four devices and about twenty chats in every state, with timestamps over the last week so
// lists have ages and transcripts have date lines. It shows everything the phone has to draw: chats that need you
// (three approvals and three that need direction, one of each on every Chief's board, each with what it did so far),
// chats at work (playing out turns the script lands step by step), chats ready to try, a week of finished ones, a
// parent chat with three subagents (one asks, one works, one is done), and one long chat of six turns with commentary,
// many steps, a steer, a stopped turn and a follow-up queued behind the turn that is running.
import type { Queued } from "../store/session-state";
import { type AskOption, chiefForRepo, DARK_RUNS_MOMENT, type Engine, factsOf, type FileChange, type Item, itemId, type Moment, type Need, type Plan, type Preview, type Said, type Step, type Tool, totals, type Chat } from "./model";
import { surfaceActions } from "./plans";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const step = (tool: Tool, text: string, detail?: string): Step => ({ tool, text, detail });
const you = (text: string, at: number, extra?: { steer?: boolean }): Item => ({ kind: "you", id: itemId(), text, at, ...extra });
const commentary = (text: string, at: number): Item => ({ kind: "text", id: itemId(), text, at, phase: "commentary" });
const final = (text: string, at: number): Item => ({ kind: "text", id: itemId(), text, at, phase: "final" });
const work = (steps: Step[], startedAt: number, endedAt?: number): Item => ({ kind: "work", id: itemId(), steps, startedAt, endedAt });
const changes = (moment: Moment): Item => ({ kind: "changes", id: itemId(), moment });

/** A command it waits to run, with why and what it did so far: the chat's `need`, its `ask` and its transcript's item. */
function approval(command: string, why: string, summary: string, at: number): { need: Need; ask: string; item: Item } {
  return { need: { kind: "approval", command, why, summary, at }, ask: command, item: { kind: "ask", id: itemId(), command } };
}

/** Direction it waits on: the question, its options (one recommended) and what it did so far; and the transcript's item. */
function direction(question: string, options: AskOption[], summary: string, at: number): { need: Need; item: Item } {
  return { need: { kind: "question", question, options, summary, at }, item: { kind: "ask", id: itemId(), command: "", question } };
}

/** When something last happened in a transcript: its last message, step or stop. */
function lastAt(items: readonly Item[], fallback: number): number {
  return items.reduce((latest, item) => {
    const at = item.kind === "work" ? (item.endedAt ?? item.startedAt) : item.kind === "you" || item.kind === "text" || item.kind === "stop" ? item.at : 0;
    return Math.max(latest, at);
  }, fallback);
}

interface Spec extends Omit<Chat, "updatedAt" | "line" | "startedAt"> {
  line?: string;
  startedAt?: number;
}

/**
 * A seeded chat. Every one in the scripted world was started by a Chief, the one that watches its workspace, unless
 * its spec says otherwise (`chief: null` for one of your own); a subagent is its parent's Chief's.
 */
function chat(spec: Spec): Chat {
  const startedAt = spec.startedAt ?? spec.items.find((i): i is Extract<Item, { kind: "you" }> => i.kind === "you")?.at ?? Date.now();
  return { ...spec, chief: spec.chief !== undefined ? spec.chief : chiefForRepo(spec.repo), startedAt, line: spec.line ?? "", updatedAt: lastAt(spec.items, startedAt) };
}

const done = (repo: string, title: string, at: number, extra: { id: string; engine: Engine; model: string; device: string; line: string; items: Item[] }): Chat =>
  chat({ ...extra, title, repo, phase: "done", startedAt: at });

/**
 * How to try what the scripted chats build, by their branch (Moment.preview): the agent's one line on what to try and
 * what to try it on. Read again for a board written to disk before moments carried one (script.ts).
 */
export const PREVIEWS: Readonly<Record<string, Preview>> = {
  "chief-push": {
    try: "Lock your phone, then answer the next ask from the notification",
    shots: [{ caption: "Lock screen", drawn: "push-lock" }],
  },
  "usage-tooltips": {
    try: "Hold a bar on the usage chart and slide along the week",
    shots: [{ caption: "Tooltip", drawn: "usage-tooltip" }],
  },
  "hero-phone": {
    try: "Read the hero on your phone, then tap Get the app",
    url: "https://caveman.so",
    shots: [{ caption: "Phone", drawn: "hero" }],
  },
  "transcript-date-lines": {
    try: "Open Fold finished turns and scroll up past yesterday",
    shots: [{ caption: "Date line", drawn: "fold" }],
  },
};

function moment(headline: string, branch: string, checks: string, files: FileChange[], changesList: string[], summary: string): Moment {
  const preview = PREVIEWS[branch];
  return { headline, nudge: "Take a look.", branch, checks, files, changes: changesList, summary, ...(preview ? { preview } : null) };
}

const PUSH_MOMENT = moment(
  "Push for the Chief is ready",
  "chief-push",
  "31 tests pass",
  [
    { path: "src/chief/notify.ts", add: 42, del: 3 },
    { path: "src/push/apns.ts", add: 88, del: 0 },
    { path: "src/chief/notify.test.ts", add: 36, del: 0 },
  ],
  ["A push when a Chief needs you, with the ask in it", "Allow and Deny right on the notification", "Quiet hours respected"],
  "The Chief now sends a push when it needs you, with the ask right in the notification:\n\n- **Allow** and **Deny** work from the lock screen\n- Quiet hours hold everything but approvals\n- All **31 tests** pass\n\nTry it on your phone, then tell me to ship it.",
);

const TOOLTIPS_MOMENT = moment(
  "Usage chart tooltips are ready",
  "usage-tooltips",
  "18 tests pass",
  [
    { path: "web/src/usage/UsageChart.tsx", add: 31, del: 12 },
    { path: "web/src/usage/tooltip.ts", add: 47, del: 0 },
  ],
  ["Tooltips show the day's spend by model", "They follow the finger on a phone", "Numbers keep two decimals"],
  "Hovering a bar on the usage chart now shows that day's spend by model, and on a phone the tooltip follows your finger. **18 tests** pass.",
);

const HERO_MOMENT = moment(
  "Hero copy is ready",
  "hero-phone",
  "Builds clean",
  [
    { path: "site/src/pages/index.astro", add: 12, del: 19 },
    { path: "site/src/content/hero.md", add: 6, del: 9 },
  ],
  ["One line under the headline instead of three", "The CTA says what happens", "No adjectives left"],
  "The hero is down to a headline and one line:\n\n> Your agents, in your pocket. Answer what needs you and get back to your day.\n\nThe button says **Get the app**. I took out every adjective I could find.",
);

/** Who is signed in: the one person whose computers, chats and Chiefs the world is (Profile, Settings, Home's avatar). */
export const YOU = { name: "Julius Brussee", initial: "J", email: "julius@caveman.so", organization: "Caveman" } as const;

export const FOLD_MOMENT = moment(
  "Date lines are in",
  "transcript-date-lines",
  "29 tests pass",
  [
    { path: "src/components/transcript/lines.ts", add: 18, del: 2 },
    { path: "src/components/Transcript.tsx", add: 26, del: 3 },
    { path: "src/components/transcript/DateLine.tsx", add: 41, del: 0 },
    { path: "src/components/transcript/lines.test.ts", add: 12, del: 0 },
  ],
  ["A centred date line where two messages are 30 minutes apart", "Today and Yesterday by name, then the date", "Folded turns keep their lines"],
  "Date lines are in. Where two messages are more than 30 minutes apart, a centred line says when the next one was:\n\n- **Today** and **Yesterday** by name, then the weekday, then the date\n- A folded turn keeps its line, so the fold never hides a gap\n\nAll **29 tests** pass.",
);

export const AUDIT_MOMENT = moment(
  "Three audits are in",
  "phone-audits",
  "No code changed",
  [
    { path: "docs/research/audit-state.md", add: 412, del: 0 },
    { path: "docs/research/audit-thread.md", add: 288, del: 0 },
    { path: "docs/research/audit-composer.md", add: 301, del: 0 },
  ],
  ["State first: nothing survives a relaunch", "Then the thread's rhythm and folds", "Then the keyboard"],
  "All three audits are in. Fix them in this order:\n\n1. **State.** Nothing survives a relaunch and one reducer re-renders the whole shell. One store, a boot snapshot and per-chat drafts.\n2. **Thread.** Finished turns should fold to their answer, and the gaps between turns are too tight.\n3. **Composer.** The keyboard jumps when the box grows. Measure before reaching for a native module.\n\nEach file has the evidence and the steps.",
);

/** The first launch's world, around `now`. */
export function world(now: number): { chats: Chat[]; said: Said[]; queues: Record<string, Queued[]> } {
  const ago = (ms: number) => now - ms;
  // Yesterday afternoon and evening, by the calendar, so the long chat's date lines say "Yesterday".
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = today.getTime() - DAY;
  const y = (h: number, m = 0) => yesterday + h * HOUR + m * MINUTE;
  const daysAgo = (d: number, h = 15) => today.getTime() - d * DAY + h * HOUR;

  // ---------------------------------------------------------------- needs you

  const migrating = approval("pnpm db:migrate --env staging", "Touches three tables on staging", "Wrote the 0042_usage_daily migration. The rollup tests pass locally, 22 of 22.", ago(9 * MINUTE));
  const migration = chat({
    id: "migration",
    title: "Usage table migration",
    repo: "Caveman Cloud",
    device: "cloud",
    engine: "codex",
    model: "GPT-5.5",
    phase: "needs",
    line: "Run a migration on staging?",
    ask: migrating.ask,
    need: migrating.need,
    items: [
      you("Add a daily rollup table for usage and backfill it from usage_events.", ago(12 * MINUTE)),
      commentary("I'll look at how usage_events is shaped and where the rollups are read before writing the table.", ago(12 * MINUTE - 20_000)),
      work(
        [
          step("search", "Searched for usage_events", "14 results"),
          step("read", "Read 3 files", "db/schema.ts, usage/rollup.ts, usage/query.ts"),
          step("edit", "Created 0042_usage_daily.sql", "+64"),
          step("run", "Ran the rollup tests", "pnpm test usage  22/22 passed"),
        ],
        ago(12 * MINUTE),
        ago(9 * MINUTE),
      ),
      commentary("The migration is written and the rollup query passes locally. To apply it I need to run it on staging, which touches three tables.", ago(9 * MINUTE)),
      migrating.item,
    ],
  });

  const deploying = approval("vercel deploy --prod", "Publishes the post to everyone", "Built the post and checked the preview: images load, the card renders on X.", ago(21 * MINUTE));
  const launchPost = chat({
    id: "launch-post",
    title: "Publish the launch post",
    repo: "marketing",
    device: "studio",
    engine: "cursor",
    model: "Composer 2.5",
    phase: "needs",
    line: "Deploy the site to production?",
    ask: deploying.ask,
    need: deploying.need,
    items: [
      you("Publish the launch post for the phone app once the preview looks right.", ago(26 * MINUTE)),
      work(
        [
          step("read", "Read launch-post.mdx", "1,240 words"),
          step("edit", "Edited the OG image", "og/launch-post.png"),
          step("run", "Built the site", "astro build  412 pages"),
          step("run", "Checked the preview", "launch-post.caveman.so"),
        ],
        ago(26 * MINUTE),
        ago(21 * MINUTE),
      ),
      commentary("The post builds and the preview looks right: images load and the card renders on X and LinkedIn. Publishing it is a production deploy.", ago(21 * MINUTE)),
      deploying.item,
    ],
  });

  // A parent and its three subagents: the parent waits on them, the composer audit asks, the thread audit works.
  const auditAsk = "Audit the phone app before v1: state, the thread and the composer. One subagent each, then tell me what to fix first.";
  const audit = chat({
    id: "audit",
    title: "Audit the phone app",
    repo: "caveman-code",
    device: "cloud",
    engine: "claude",
    model: "Opus 5.5",
    phase: "working",
    // No count in its live line: its agents finish one by one, and the row under them says which.
    line: "Waiting on its agents",
    script: ["Waiting on its agents"],
    items: [
      you(auditAsk, ago(41 * MINUTE)),
      commentary("I'll split this three ways and run them side by side, then put the findings in one order.", ago(41 * MINUTE - 15_000)),
      work([step("read", "Read the README", "apps/mobile/README.md"), step("read", "Read SPEC.md", "docs/"), step("search", "Searched for useBoard", "9 results")], ago(41 * MINUTE), ago(39 * MINUTE)),
      { kind: "agents", id: itemId(), children: ["audit-state", "audit-thread", "audit-composer"] },
      commentary("The state audit is in. I'm waiting on the thread and the composer.", ago(18 * MINUTE)),
      work([step("read", "Read audit-state.md", "412 lines")], ago(18 * MINUTE)),
    ],
  });
  const auditState = chat({
    id: "audit-state",
    parent: "audit",
    title: "Audit: state and persistence",
    repo: "caveman-code",
    device: "cloud",
    engine: "claude",
    model: "Sonnet 5.5",
    phase: "done",
    line: "Wrote audit-state.md",
    items: [
      you("Audit how apps/mobile holds state: what persists, what re-renders, and how the runtime would plug in.", ago(39 * MINUTE)),
      work(
        [
          step("read", "Read useBoard.ts", "436 lines"),
          step("read", "Read inbox.ts", "209 lines"),
          step("search", "Searched for useState", "61 results"),
          step("read", "Read client.ts", "packages/session-protocol"),
          step("run", "Reloaded the web build", "localStorage empty"),
          step("edit", "Wrote audit-state.md", "+412"),
        ],
        ago(39 * MINUTE),
        ago(18 * MINUTE),
      ),
      final("The state audit is in `audit-state.md`. Short version: **nothing persists**, and one reducer re-renders the whole shell on every tick. The fix is one store with selectors, a boot snapshot read before the first frame, and drafts and queues kept per chat.", ago(18 * MINUTE)),
    ],
  });
  const auditThread = chat({
    id: "audit-thread",
    parent: "audit",
    title: "Audit: the thread",
    repo: "caveman-code",
    device: "cloud",
    engine: "claude",
    model: "Sonnet 5.5",
    phase: "working",
    line: "Taking screenshots of a long chat",
    items: [
      you("Audit the thread: streaming, folding, the rhythm between turns, and how it holds up with 200 steps.", ago(39 * MINUTE)),
      work([step("read", "Read Transcript.tsx", "362 lines"), step("read", "Read WorkRun.tsx", "301 lines"), step("run", "Opened a long chat", "6 turns, 48 steps")], ago(39 * MINUTE)),
    ],
  });
  auditThread.plan = auditThreadPlan();
  const adding = approval(
    "pnpm --filter @caveman-app/mobile add react-native-keyboard-controller",
    "On a scratch branch, to measure it",
    "Found the weak spot: the box jumps a frame as it grows. It wants to measure a fix.",
    ago(31 * MINUTE),
  );
  const auditComposer = chat({
    id: "audit-composer",
    parent: "audit",
    title: "Audit: the composer",
    repo: "caveman-code",
    device: "cloud",
    engine: "claude",
    model: "Sonnet 5.5",
    phase: "needs",
    line: "Add react-native-keyboard-controller?",
    ask: adding.ask,
    need: adding.need,
    items: [
      you("Audit the composer: the keyboard, the box growing, voice, and the queue.", ago(39 * MINUTE)),
      work([step("read", "Read Composer.tsx", "540 lines"), step("read", "Read composer/Queue.tsx", "122 lines"), step("search", "Searched for KeyboardAvoidingView", "3 results")], ago(39 * MINUTE), ago(31 * MINUTE)),
      commentary("The keyboard handling is the weak spot: the box jumps a frame when it grows. To measure the alternative I want to try react-native-keyboard-controller on a scratch branch.", ago(31 * MINUTE)),
      adding.item,
    ],
  });

  // Three that need direction, one on each Chief's board: which of two fixes, whether to keep a flag, what to call it.
  const jumping = direction(
    "Which fix should it take?",
    [
      { label: "Measure before the fold", detail: "Small: +14 −3 in fold.ts", recommended: true },
      { label: "Pin the scroll anchor", detail: "Bigger, and steadies the Changes pill" },
    ],
    "Found it: the list measures a turn while its fold animates, so it scrolls 38 pt.",
    ago(12 * MINUTE),
  );
  const foldJump = chat({
    id: "fold-jump",
    title: "Thread jumps when a turn folds",
    repo: "caveman-code",
    device: "mbp",
    engine: "claude",
    model: "Opus 5.5",
    phase: "needs",
    line: "Which fix should it take?",
    need: jumping.need,
    items: [
      you("When a turn folds, the thread jumps up a few lines. Find out why and fix it.", ago(19 * MINUTE)),
      commentary("I'll reproduce it on the long chat first, then look at what measures the list while the fold runs.", ago(19 * MINUTE - 20_000)),
      work(
        [
          step("search", "Searched for onLayout", "11 results"),
          step("read", "Read fold.ts", "214 lines"),
          step("read", "Read Thread.tsx", "388 lines"),
          step("run", "Recorded the fold at 120 fps", "jumps 38 pt on frame 3"),
        ],
        ago(19 * MINUTE),
        ago(12 * MINUTE),
      ),
      commentary(
        "Found it: the list measures the turn while its fold is still animating, so it scrolls by the old height. Two ways to fix it, both keeping the 240 ms fold:\n\n- **Measure before the fold**: a small change in fold.ts\n- **Pin the scroll anchor**: bigger, and it steadies the Changes pill too\n\nWhich should I take?",
        ago(12 * MINUTE),
      ),
      jumping.item,
    ],
  });

  const flagging = direction(
    "Keep the legacy_backoff flag?",
    [
      { label: "Remove it", detail: "Nothing in production reads it; −46 lines", recommended: true },
      { label: "Keep it one more release", detail: "Off by default, gone in 0.48" },
    ],
    "Moved the relay to token buckets; all 64 tests pass. Only one test reads the flag.",
    ago(36 * MINUTE),
  );
  const relayLimits = chat({
    id: "relay-limits",
    title: "Relay rate limits",
    repo: "Caveman Cloud",
    device: "cloud",
    engine: "codex",
    model: "GPT-5.5",
    phase: "needs",
    line: "Keep the backoff flag?",
    need: flagging.need,
    items: [
      you("Move the relay from the old exponential backoff to token-bucket rate limits, one bucket per connection.", ago(52 * MINUTE)),
      work(
        [step("read", "Read relay/limit.go", "220 lines"), step("edit", "Edited relay/limit.go", "+118 −64"), step("run", "Ran the relay tests", "go test ./relay  64/64 passed")],
        ago(52 * MINUTE),
        ago(36 * MINUTE),
      ),
      commentary("Token buckets are in and all **64 relay tests** pass. The old `legacy_backoff` flag is now read by one test and nothing in production. Should I remove it, or keep it for a release?", ago(36 * MINUTE)),
      flagging.item,
    ],
  });

  const naming = direction(
    "Which subject line should it send?",
    [
      { label: "Your agents, in your pocket", detail: "Matches the hero", recommended: true },
      { label: "Answer your agents from anywhere", detail: "Says what it does" },
      { label: "Caveman Code is on your phone", detail: "Plain news" },
    ],
    "Wrote the launch email in the hero's voice: three short paragraphs, one button.",
    ago(6 * MINUTE),
  );
  const launchEmail = chat({
    id: "launch-email",
    title: "Launch email",
    repo: "marketing",
    device: "studio",
    engine: "claude",
    model: "Sonnet 5.5",
    phase: "needs",
    line: "Which subject line?",
    need: naming.need,
    items: [
      you("Write the launch email for the phone app. Short, in the hero's voice.", ago(14 * MINUTE)),
      work([step("read", "Read hero.md", "the new hero"), step("read", "Read README.md", "project guidelines"), step("edit", "Wrote launch-email.md", "+38")], ago(14 * MINUTE), ago(6 * MINUTE)),
      commentary("The email is written: three short paragraphs and one button, in the hero's voice. It needs a subject line, and three fit under 40 characters.", ago(6 * MINUTE)),
      naming.item,
    ],
  });

  // ---------------------------------------------------------------- working

  const darkRuns = chat({
    id: "dark-runs",
    title: "Dark mode for Runs",
    repo: "caveman-code",
    device: "mbp",
    engine: "claude",
    model: "Opus 5.5",
    phase: "working",
    line: "Reading RunsPage.tsx",
    script: ["Editing RunsPage.tsx  +38 −12", "vitest runs  6/8", "vitest runs  8/8 passed", "Taking screenshots"],
    // It checks the page in its browser as it goes, light and dark; once it's ready the browser stays, to look at.
    screens: { browser: { url: "http://localhost:5173/runs", title: "Runs · Caveman Code", view: "runs" } },
    using: "browser",
    items: [
      you("Make the Runs page follow the app theme, dark by default.", ago(9 * MINUTE)),
      work([step("search", "Searched for RunsPage", "3 results"), step("read", "Read globals.css", "the deck's tokens")], ago(9 * MINUTE)),
    ],
  });
  const t = totals(DARK_RUNS_MOMENT.files);
  darkRuns.plan = {
    next: 0,
    steps: [
      {
        ms: 9000,
        actions: surfaceActions(darkRuns, DARK_RUNS_MOMENT, [
          step("edit", `Edited ${DARK_RUNS_MOMENT.files.length} files`, `+${t.add} −${t.del}`),
          step("run", "Ran the tests", "vitest runs  8/8 passed"),
          step("run", "Took screenshots", "light and dark"),
        ]),
      },
    ],
  };

  const relay = chat({
    id: "relay",
    title: "Flaky relay reconnect",
    repo: "Caveman Cloud",
    device: "cloud",
    engine: "claude",
    model: "Sonnet 5.5",
    phase: "working",
    line: "go test ./relay -count 50",
    script: ["Found it: Close races the read loop", "Editing relay/conn.go  +9 −2", "go test ./relay -count 200", "200 of 200 passed"],
    items: [
      you("The relay reconnect test flakes about one run in twenty. Find out why.", ago(23 * MINUTE)),
      work([step("read", "Read relay/conn.go", "312 lines"), step("run", "Ran the test 50 times", "3 of 50 failed")], ago(23 * MINUTE)),
    ],
  });

  const onboarding = chat({
    id: "onboarding",
    title: "Onboarding copy pass",
    repo: "marketing",
    device: "cloud",
    engine: "codex",
    model: "GPT-5.5",
    phase: "working",
    line: "Reading 4 files",
    script: ["Rewriting the hero", "Trying the hero on the page", "Checking tone against WHY.md"],
    // It read the page in its browser first; now it tries each hero on the Cloud computer's desktop.
    screens: {
      browser: { url: "http://localhost:4321/onboarding", title: "Welcome · caveman", view: "onboarding" },
      computer: { view: "desktop" },
    },
    using: "computer",
    items: [you("Do a copy pass on onboarding. Shorter and plainer.", ago(2 * MINUTE)), work([], ago(2 * MINUTE))],
  });

  const resume = chat({
    id: "sdk-resume",
    title: "Resume and fork in the SDK",
    repo: "caveman-agent-sdk",
    device: "mbp",
    engine: "codex",
    model: "GPT-5.5",
    phase: "working",
    line: "Reading session/resume.ts",
    script: ["Editing session/fork.ts  +61 −4", "pnpm test session  18/40", "pnpm test session  40/40", "Writing the fork example"],
    items: [
      you("The SDK should resume a session by id and fork it at any message. Same shapes as the runtime's.", ago(16 * MINUTE)),
      commentary("I'll match the runtime's session.fork first, then wire resume through the same cursor.", ago(16 * MINUTE - 20_000)),
      work([step("read", "Read the protocol's session.ts", "packages/session-protocol"), step("search", "Searched for cursor", "22 results")], ago(15 * MINUTE)),
    ],
  });

  // The long chat: six turns since yesterday afternoon, the last one running with a follow-up queued behind it.
  const fold = chat({
    id: "fold",
    title: "Fold finished turns",
    repo: "caveman-code",
    device: "studio",
    engine: "codex",
    model: "GPT-5.5",
    effort: "high",
    phase: "working",
    line: "Editing Transcript.tsx",
    items: [
      // 1. The fold itself.
      you("Long chats feel cramped. Fold every finished turn down to its final answer, the way Codex does.", y(16, 2)),
      commentary("I'll start with how the transcript groups turns today, then put the fold on top of that.", y(16, 2) + 30_000),
      work([step("search", "Searched for turnsOf", "4 results"), step("read", "Read lines.ts", "187 lines"), step("read", "Read Transcript.tsx", "362 lines"), step("read", "Read WorkRun.tsx", "301 lines")], y(16, 3), y(16, 5)),
      commentary("Turns are already grouped by `turnsOf`, and a steer joins the turn it steered. The fold can sit on that: everything before the final answer goes under one line.", y(16, 5) + 20_000),
      work([step("edit", "Edited lines.ts", "+38 −6"), step("edit", "Edited Transcript.tsx", "+64 −21"), step("run", "Ran the transcript tests", "vitest transcript  24/24 passed")], y(16, 6), y(16, 13)),
      final(
        "Finished turns now fold. Each one reads as your message, one quiet line, and the final answer:\n\n- **Worked for 7m ›** opens everything it did, in order\n- Your own words, steers included, never fold\n- A turn that's still running, or was stopped, stays open\n\nAll **24 tests** pass.",
        y(16, 14),
      ),
      // 2. The Changes pill.
      you("Keep the Changes pill visible when a turn is folded.", y(16, 41)),
      commentary("The pill sits under the answer, so it can stay outside the fold.", y(16, 41) + 25_000),
      work([step("read", "Read TurnChanges.tsx", "88 lines"), step("edit", "Edited Transcript.tsx", "+9 −3"), step("run", "Ran the transcript tests", "vitest transcript  25/25 passed")], y(16, 42), y(16, 46)),
      final("Done. The Changes pill stays under the final answer when the turn folds, and only on turns that changed files. Added a test for it; **25 tests** pass.", y(16, 47)),
      // 3. The fold's clock, with a steer while it worked.
      you("Make the fold line say how long it worked.", y(18, 12)),
      work([step("read", "Read TurnEnd.tsx", "143 lines"), step("edit", "Edited TurnEnd.tsx", "+14 −5")], y(18, 12), y(18, 14)),
      you("Say “Worked for 3m 12s”, and just “48s” when it's under a minute.", y(18, 14) + 10_000, { steer: true }),
      commentary("Got it: minutes and seconds, and seconds alone under a minute.", y(18, 14) + 30_000),
      work([step("edit", "Edited TurnEnd.tsx", "+6 −4"), step("run", "Ran the transcript tests", "vitest transcript  27/27 passed")], y(18, 15), y(18, 18)),
      final("The fold line now says **Worked for 3m 12s**, or **Worked for 48s** under a minute. It counts from the first step to the last, not from your message.", y(18, 18) + 30_000),
      // 4. Stopped.
      you("Now do the same for the Chief's chat.", ago(3 * HOUR)),
      commentary("The Chief's chat keeps its lines in one list, not in turns. I'll group them by your messages first.", ago(3 * HOUR - 20_000)),
      work([step("read", "Read ChiefChat.tsx", "284 lines"), step("search", "Searched for said", "12 results"), step("edit", "Edited ChiefChat.tsx", "+22 −4")], ago(3 * HOUR - 30_000), ago(3 * HOUR - 4 * MINUTE)),
      { kind: "stop", id: itemId(), at: ago(3 * HOUR - 4 * MINUTE) },
      // 5. Put back.
      you("Sorry, wrong one. Leave the Chief for now, just the thread.", ago(2 * HOUR + 52 * MINUTE)),
      commentary("Okay. I'll put ChiefChat.tsx back the way it was.", ago(2 * HOUR + 52 * MINUTE - 15_000)),
      work([step("edit", "Reverted ChiefChat.tsx", "+4 −22"), step("run", "Ran the transcript tests", "vitest transcript  27/27 passed")], ago(2 * HOUR + 51 * MINUTE), ago(2 * HOUR + 49 * MINUTE)),
      final("ChiefChat.tsx is back as it was; only the thread folds. Nothing else moved.", ago(2 * HOUR + 49 * MINUTE)),
      // 6. Running now.
      you("Add a date line when two messages are more than 30 minutes apart.", ago(4 * MINUTE)),
      commentary("I'll measure the gap between messages as the turns are built, and draw a centred line where it's over 30 minutes.", ago(4 * MINUTE - 25_000)),
      work([step("read", "Read lines.ts", "205 lines"), step("search", "Searched for toLocaleDateString", "3 results"), step("edit", "Edited lines.ts", "+18 −2")], ago(3 * MINUTE + 20_000)),
    ],
  });
  fold.plan = {
    next: 0,
    steps: [
      { ms: 20_000, actions: [{ type: "work", id: "fold", steps: [step("edit", "Edited Transcript.tsx", "+26 −3")] }, { type: "update", id: "fold", patch: { line: "Writing DateLine.tsx" } }] },
      { ms: 25_000, actions: [{ type: "work", id: "fold", steps: [step("edit", "Created DateLine.tsx", "+41")] }, { type: "update", id: "fold", patch: { line: "vitest transcript  20/29" } }] },
      { ms: 25_000, actions: [{ type: "update", id: "fold", patch: { line: "vitest transcript  29/29 passed" } }] },
      { ms: 15_000, actions: surfaceActions(fold, FOLD_MOMENT, [step("run", "Ran the transcript tests", "vitest transcript  29/29 passed")]) },
    ],
  };

  // ---------------------------------------------------------------- ready to try

  const push = chat({
    id: "push",
    title: "Push for the Chief",
    repo: "caveman-code",
    device: "mbp",
    engine: "caveman",
    model: "Auto",
    phase: "ready",
    moment: PUSH_MOMENT,
    line: factsOf(PUSH_MOMENT),
    // It checked the push in Simulator on this Mac (computer use, agent-desktop): the window it used last stays to look at.
    screens: { computer: { view: "simulator", app: { name: "Simulator", bundle_id: "com.apple.iphonesimulator" } } },
    items: [
      you("Send a push when the Chief needs me, with the ask right in the notification.", ago(34 * MINUTE)),
      work(
        [
          step("search", "Searched for notify", "7 results"),
          step("read", "Read chief/notify.ts", "96 lines"),
          step("edit", "Edited chief/notify.ts", "+42 −3"),
          step("edit", "Created push/apns.ts", "+88"),
          step("run", "Ran the notify tests", "pnpm test notify  31/31 passed"),
        ],
        ago(34 * MINUTE),
        ago(7 * MINUTE),
      ),
      final(PUSH_MOMENT.summary, ago(6 * MINUTE)),
      changes(PUSH_MOMENT),
    ],
  });

  const tooltips = chat({
    id: "tooltips",
    title: "Usage chart tooltips",
    repo: "Caveman Cloud",
    device: "cloud",
    engine: "grok",
    model: "Grok 4.7",
    phase: "ready",
    moment: TOOLTIPS_MOMENT,
    line: factsOf(TOOLTIPS_MOMENT),
    items: [
      you("The usage chart needs tooltips: the day's spend by model.", ago(58 * MINUTE)),
      work([step("read", "Read UsageChart.tsx", "214 lines"), step("edit", "Edited UsageChart.tsx", "+31 −12"), step("edit", "Created tooltip.ts", "+47"), step("run", "Ran the usage tests", "pnpm test usage  18/18 passed")], ago(58 * MINUTE), ago(36 * MINUTE)),
      final(TOOLTIPS_MOMENT.summary, ago(35 * MINUTE)),
      changes(TOOLTIPS_MOMENT),
    ],
  });

  const hero = chat({
    id: "hero",
    title: "Hero copy for the phone app",
    repo: "marketing",
    device: "studio",
    engine: "opencode",
    model: "Kimi K3",
    phase: "ready",
    moment: HERO_MOMENT,
    line: factsOf(HERO_MOMENT),
    items: [
      you("Rewrite the hero for the phone app. One line under the headline, no adjectives.", ago(2 * HOUR)),
      work([step("read", "Read index.astro", "180 lines"), step("read", "Read README.md", "project guidelines"), step("edit", "Edited hero.md", "+6 −9"), step("run", "Built the site", "astro build  412 pages")], ago(2 * HOUR), ago(95 * MINUTE)),
      final(HERO_MOMENT.summary, ago(94 * MINUTE)),
      changes(HERO_MOMENT),
    ],
  });

  // ---------------------------------------------------------------- done, over the last days

  const rail = done("caveman-code", "Chief rail redesign", ago(3 * HOUR), {
    id: "rail",
    engine: "caveman",
    model: "Auto",
    device: "mbp",
    line: "Merged #471",
    items: [
      you("Redesign the Chief rail as a Linear list: groups, one row rhythm, no cards.", ago(3 * HOUR)),
      work([step("read", "Read inbox-parts.tsx", "418 lines"), step("edit", "Edited 3 files", "+212 −305"), step("run", "Ran the tests", "pnpm test inbox  41/41 passed")], ago(3 * HOUR), ago(168 * MINUTE)),
      final("Merged **#471**. The rail is a Linear list now: quiet group headers, one row rhythm, and amber only where something waits on you.", ago(165 * MINUTE)),
    ],
  });

  const adm = done("caveman-code", "adm-zip under onnxruntime", ago(5 * HOUR), {
    id: "adm",
    engine: "codex",
    model: "GPT-5.4",
    device: "mbp",
    line: "Merged #468",
    items: [
      you("adm-zip comes in under onnxruntime-node. Get rid of it.", ago(5 * HOUR)),
      work([step("search", "Searched the lockfile", "adm-zip@0.5.16"), step("edit", "Edited package.json", "+3 −1")], ago(5 * HOUR), ago(296 * MINUTE)),
      final("Merged **#468**. An override pins onnxruntime-node's installer to fetch without adm-zip, and the lockfile no longer carries it.", ago(295 * MINUTE)),
    ],
  });

  const tls = done("Caveman Cloud", "Relay cert rotation", y(11), {
    id: "tls",
    engine: "codex",
    model: "GPT-5.5",
    device: "cloud",
    line: "Merged #455",
    items: [
      you("Rotate the relay's TLS certificates without dropping connections.", y(11)),
      commentary("I'll load the new certificate next to the old one and let connections drain onto it.", y(11) + 30_000),
      work([step("read", "Read relay/tls.go", "140 lines"), step("edit", "Edited relay/tls.go", "+52 −8"), step("run", "Ran the relay tests", "go test ./relay  64/64 passed"), step("run", "Rotated on staging", "0 connections dropped")], y(11, 1), y(11, 34)),
      final("Merged **#455**. The relay now loads a new certificate beside the old one and moves connections over as they reconnect. On staging, nothing dropped.", y(11, 36)),
    ],
  });

  const faq = done("marketing", "Pricing FAQ", y(14, 20), {
    id: "faq",
    engine: "claude",
    model: "Sonnet 5.5",
    device: "studio",
    line: "Merged #79",
    items: [
      you("Add an FAQ under pricing. Five questions, the ones support gets most.", y(14, 20)),
      work([step("search", "Searched the support inbox", "212 threads"), step("edit", "Edited pricing.astro", "+64 −2")], y(14, 21), y(14, 33)),
      final("Merged **#79**. Five questions under pricing, picked from the 212 support threads this month: credits, seats, refunds, keys and data.", y(14, 34)),
    ],
  });

  const sdkStream = done("caveman-agent-sdk", "Streaming types for the SDK", daysAgo(2, 10), {
    id: "sdk-stream",
    engine: "claude",
    model: "Opus 5.5",
    device: "mbp",
    line: "Merged #212",
    items: [
      you("The SDK's stream events are typed as any. Give them real types.", daysAgo(2, 10)),
      work([step("read", "Read src/stream.ts", "302 lines"), step("edit", "Edited 4 files", "+188 −61"), step("run", "Ran the type tests", "tsd  48/48 passed")], daysAgo(2, 10), daysAgo(2, 11)),
      final("Merged **#212**. Every stream event is a tagged union now, and `for await` narrows on `event.type`.", daysAgo(2, 11)),
    ],
  });

  const searchScopes = done("caveman-code", "Sidebar search scopes", daysAgo(2, 16), {
    id: "search-scopes",
    engine: "cursor",
    model: "Composer 2.5",
    device: "studio",
    line: "Merged #449",
    items: [
      you("Let sidebar search scope to one project or one Chief.", daysAgo(2, 16)),
      work([step("read", "Read Sidebar.tsx", "640 lines"), step("edit", "Edited Sidebar.tsx", "+48 −12"), step("run", "Ran the sidebar tests", "vitest sidebar  19/19 passed")], daysAgo(2, 16), daysAgo(2, 17)),
      final("Merged **#449**. Search scopes to a project or a Chief from the chips over the results.", daysAgo(2, 17)),
    ],
  });

  const whyPost = done("marketing", "Blog: why the caveman", daysAgo(3, 12), {
    id: "why-post",
    engine: "codex",
    model: "GPT-5.5",
    device: "studio",
    line: "Merged #74",
    items: [
      you("Draft a short post on why the mascot is a caveman. Use WHY.md, keep it under 600 words.", daysAgo(3, 12)),
      work([step("read", "Read README.md", "project notes"), step("edit", "Wrote why-the-caveman.mdx", "+38")], daysAgo(3, 12), daysAgo(3, 13)),
      final("Merged **#74**. 540 words: fewer words, same meaning, and a caveman who would rather be outside.", daysAgo(3, 13)),
    ],
  });

  const webhooks = done("Caveman Cloud", "Billing webhook retries", daysAgo(4, 9), {
    id: "webhooks",
    engine: "caveman",
    model: "Kimi K3",
    device: "cloud",
    line: "Merged #431",
    items: [
      you("Stripe webhooks fail on deploys. Retry them with backoff and make the handler idempotent.", daysAgo(4, 9)),
      work([step("read", "Read billing/webhook.ts", "188 lines"), step("edit", "Edited billing/webhook.ts", "+57 −14"), step("run", "Ran the billing tests", "pnpm test billing  33/33 passed")], daysAgo(4, 9), daysAgo(4, 10)),
      final("Merged **#431**. Webhooks retry with backoff for up to an hour, and each event is handled once, keyed by its id.", daysAgo(4, 10)),
    ],
  });

  const effect4 = done("caveman-agent-sdk", "Effect 4 in the SDK examples", daysAgo(5, 14), {
    id: "effect4",
    engine: "opencode",
    model: "GLM 5.3",
    device: "cloud",
    line: "Merged #198",
    items: [
      you("Move the SDK's examples to Effect 4.", daysAgo(5, 14)),
      work([step("search", "Searched for Effect.gen", "31 results"), step("edit", "Edited 9 examples", "+140 −152"), step("run", "Ran the examples", "9 of 9 ran")], daysAgo(5, 14), daysAgo(5, 15)),
      final("Merged **#198**. All nine examples run on Effect 4; two needed the new `Effect.fn`.", daysAgo(5, 15)),
    ],
  });

  // What each Chief said yesterday, so its chat has a past.
  let line = 1;
  const said = (chief: string, who: Said["who"], text: string, at: number): Said => ({ id: line++, chief, who, text, at });
  const lines: Said[] = [
    said("grug", "chief", "[[tls]] rotated the relay's certificates on staging. Nothing dropped.", y(11, 37)),
    said("oona", "chief", "[[faq]] is live under pricing.", y(14, 35)),
    said("home", "chief", "[[search-scopes]] is merged. Search scopes to a project or a Chief now.", y(17, 30)),
    said("home", "you", "nice. anything else waiting on me?", y(17, 32)),
    said("home", "chief", "[[fold]] is still going; I'll tell you when it lands.", y(17, 32) + 20_000),
    // A note that became work: Oona split it into three chats, so her chat shows "Started 3 chats" under that turn.
    said("oona", "you", "Get the phone app's launch ready: a new hero, a plainer onboarding, then the post. Split it however you like.", ago(2 * HOUR + 5 * MINUTE)),
    said("oona", "chief", "Split three ways. [[hero]] goes first on OpenCode; [[onboarding]] and [[launch-post]] follow on Studio once it's in. I'll bring each one to you when it's ready.", ago(2 * HOUR + 4 * MINUTE)),
  ];

  return {
    chats: [migration, launchPost, foldJump, relayLimits, launchEmail, audit, auditState, auditThread, auditComposer, darkRuns, relay, onboarding, resume, fold, push, tooltips, hero, rail, adm, tls, faq, sdkStream, searchScopes, whyPost, webhooks, effect4],
    said: lines,
    queues: { fold: [{ id: itemId(), text: "Then run the whole transcript suite again and tell me what's slow.", at: ago(MINUTE) }] },
  };
}

/** The thread audit's turn: it finishes, which lets the parent gather all three once the composer's ask is answered. */
function auditThreadPlan(): Plan {
  const id = "audit-thread";
  return {
    next: 0,
    steps: [
      { ms: 25_000, actions: [{ type: "work", id, steps: [step("run", "Took screenshots of a long chat", "6 turns, light and dark")] }, { type: "update", id, patch: { line: "Comparing with Codex's turn fold" } }] },
      { ms: 25_000, actions: [{ type: "work", id, steps: [step("read", "Read codex.md", "turn and phase semantics")] }, { type: "update", id, patch: { line: "Writing audit-thread.md" } }] },
      {
        ms: 25_000,
        actions: [
          { type: "work", id, close: true, steps: [step("edit", "Wrote audit-thread.md", "+288")] },
          {
            type: "append",
            id,
            // A text's `at` is stamped as it lands (script.ts), so it streams in then.
            items: [final("The thread audit is in `audit-thread.md`. Finished turns should fold to their answer, the gaps between turns are too tight, and a turn with 200 steps needs its run summarised in one line.", 0)],
          },
          { type: "update", id, patch: { phase: "done", line: "Wrote audit-thread.md" }, clear: ["script", "step"] },
        ],
      },
    ],
  };
}
