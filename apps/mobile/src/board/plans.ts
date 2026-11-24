// The turns the script plays out, as data: each a list of board actions with the pause before them. A plan lives on
// its chat (`Chat.plan`) and is written to disk with it, so a relaunch picks a turn up where it was instead of losing
// it with its timers. script.ts lands the steps; nothing here touches the store.
import type { BoardAction } from "../store/board";
import { type AskOption, type Chat, chiefOf, factsOf, type FileChange, type Item, itemId, keywordOf, type Moment, momentFor, type Plan, type Preview, type Step } from "./model";

const step = (tool: Step["tool"], text: string, detail?: string): Step => ({ tool, text, detail });
/** The engine's words; `at` is stamped as the step lands, so the text streams in then. */
const words = (text: string, phase?: "commentary" | "final"): Item => ({ kind: "text", id: itemId(), text, at: 0, phase });

const plan = (...steps: [number, BoardAction[]][]): Plan => ({ next: 0, steps: steps.map(([ms, actions]) => ({ ms, actions })) });

/** A chat has something to look at: it says so in its transcript, it turns ready, its Chief tells you, the moment rises. */
export function surfaceActions(chat: Pick<Chat, "id" | "repo" | "chief">, moment: Moment, steps: Step[] = []): BoardAction[] {
  const { id } = chat;
  const chief = chiefOf(chat);
  return [
    { type: "work", id, steps, close: true },
    { type: "append", id, items: [words(moment.summary, "final"), { kind: "changes", id: itemId(), moment }] },
    { type: "update", id, patch: { phase: "ready", moment, line: factsOf(moment) }, clear: ["script", "step"] },
    { type: "say", chief, who: "chief", text: `[[${id}]] is ready to try. Take a look.` },
    // Ready lands the done mark and buzzes, as a finish does.
    { type: "toast", text: moment.headline, tone: "done", chief, chat: id },
    { type: "moment", id },
  ];
}

/**
 * A question about speed ("run the suite and tell me what's slow"): it runs the tests, times them, and answers with
 * what is slow, changing nothing, so the answer fits what was asked instead of a change to look at.
 */
function timingPlan(chat: Pick<Chat, "id" | "chief">): Plan {
  const { id } = chat;
  const ran = step("run", "Ran the transcript suite", "vitest transcript  29/29 passed · 9.8s");
  const timed = step("read", "Read the timings", "3 suites over 1s");
  return plan(
    [900, [{ type: "update", id, patch: { line: "Running vitest transcript" } }]],
    [2200, [{ type: "work", id, steps: [ran] }, { type: "update", id, patch: { line: "Reading the timings" } }]],
    [
      1400,
      [
        { type: "work", id, steps: [timed], close: true },
        {
          type: "append",
          id,
          items: [
            words(
              "All **29 tests** pass in 9.8 s. What's slow:\n\n- **The fold suite, 4.1 s**: it plays every turn's 240 ms fold for real; faking the clock would bring it under 1 s\n- **Markdown streaming, 2.3 s**: one test types out a long answer word by word\n- **Date lines, 1.2 s**: it builds a week of messages for each case\n\nThe rest are under 0.4 s each. Want me to fake the fold's clock?",
              "final",
            ),
          ],
        },
        { type: "update", id, patch: { phase: "done", line: "Slowest: the fold suite, 4.1 s" }, clear: ["script", "step"] },
      ],
    ],
  );
}

/** The prototype's stand-in for an engine at work: a search, a read, an edit, the tests, then something to look at. */
export function taskPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, ask: string): Plan {
  const { id } = chat;
  if (/\bwhat'?s slow\b|\bslowest\b|\btell me what is slow\b/i.test(ask)) return timingPlan(chat);
  const word = keywordOf(ask) || "it";
  const found = step("search", `Searched for ${word}`, "9 results");
  const read = step("read", "Read 3 files", "index.ts, config.ts, index.test.ts");
  const edited = step("edit", "Edited 2 files", "+24 −6");
  const tested = step("run", "Ran the tests", "pnpm test  14/14 passed");
  // The live line says what it's doing; the step joins the list once it's done, as the next one starts.
  return plan(
    [900, [{ type: "update", id, patch: { line: `Searching for ${word}` } }]],
    [1300, [{ type: "work", id, steps: [found] }, { type: "update", id, patch: { line: "Reading 3 files" } }]],
    [1600, [{ type: "work", id, steps: [read] }, { type: "update", id, patch: { line: "Editing 2 files  +24 −6" } }]],
    [1600, [{ type: "work", id, steps: [edited] }, { type: "update", id, patch: { line: "pnpm test  14/14 passed" } }]],
    [1400, surfaceActions(chat, momentFor(chat.title), [tested])],
  );
}

/** After you allow a command: it runs, and the chat finishes. The staging migration says so in its own words. */
export function allowedPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, command: string): Plan {
  const { id } = chat;
  const chief = chiefOf(chat);
  if (id === "migration") {
    return plan([
      7500,
      [
        { type: "work", id, close: true, steps: [step("run", "Ran the migration", "0042_usage_daily on staging"), step("run", "Checked row counts", "3 tables match")] },
        { type: "append", id, items: [words("Staging is migrated: **0042_usage_daily** is applied and three tables are backfilled. Row counts match the source.", "final")] },
        { type: "update", id, patch: { phase: "done", line: "Migrated staging · 3 tables" }, clear: ["script", "step"] },
        { type: "say", chief, who: "chief", text: `[[${id}]] is done. Staging is migrated and the row counts match.` },
        { type: "toast", text: "Staging migrated", tone: "done", chief, chat: id },
      ],
    ]);
  }
  const short = command.split(" ").slice(0, 3).join(" ");
  return plan([
    6000,
    [
      { type: "work", id, close: true, steps: [step("run", `Ran ${short}`, "exit 0")] },
      { type: "append", id, items: [words(`Done. \`${command}\` ran cleanly, and I picked up where I left off. Nothing else needs you.`, "final")] },
      { type: "update", id, patch: { phase: "done", line: `Ran ${short}` }, clear: ["script", "step"] },
      { type: "say", chief, who: "chief", text: `[[${id}]] is done.` },
      { type: "toast", text: `${chat.title} is done`, tone: "done", chief, chat: id },
    ],
  ]);
}

/** After you deny a command: it says it won't, finds another way, and finishes without it. */
/** A no, and the way it goes on. `instead`: you said what to do instead, so its one word back is to that. */
export function deniedPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, instead = false): Plan {
  const { id } = chat;
  const chief = chiefOf(chat);
  const migration = id === "migration";
  const ack = instead ? "Okay, I won't run it. I'll do it your way." : migration ? "Okay, I won't run it. I'll look for a way without the migration: a view over usage_events instead." : "Okay, I won't run it. I'll find another way.";
  return plan(
    [600, [{ type: "append", id, items: [words(ack, "commentary")] }]],
    [
      7000,
      [
        { type: "work", id, close: true, steps: migration ? [step("read", "Read the schema", "db/schema.ts"), step("edit", "Created usage_daily_view.sql", "+22")] : [step("read", "Read the plan again"), step("edit", "Took another way", "+8 −3")] },
        { type: "append", id, items: [words(migration ? "Done without a migration: **usage_daily** is a view over usage_events now. It's slower on big ranges; say so if you want the table after all." : "Done another way, without that command.", "final")] },
        { type: "update", id, patch: { phase: "done", line: migration ? "A view instead of a table" : "Done another way" }, clear: ["script", "step"] },
        { type: "say", chief, who: "chief", text: `[[${id}]] found a way without it.` },
      ],
    ],
  );
}

/** "Ship it": a pull request, CI going green, merged. */
export function shipPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, number: number): Plan {
  const { id } = chat;
  const chief = chiefOf(chat);
  return plan([
    8000,
    [
      { type: "work", id, close: true, steps: [step("run", "CI passed", "5 of 5 checks")] },
      { type: "append", id, items: [words(`Merged **#${number}**. CI was green.`, "final")] },
      { type: "update", id, patch: { phase: "done", line: `Merged #${number}` }, clear: ["script", "step", "moment"] },
      { type: "say", chief, who: "chief", text: `[[${id}]] is merged. CI was green.` },
      { type: "toast", text: `${chat.title} merged`, tone: "done", chief, chat: id },
    ],
  ]);
}

/** "Change it": back to work, then the changed thing to look at again. */
export function tweakPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, next: Moment): Plan {
  return plan([9000, surfaceActions(chat, next, [step("edit", `Edited ${next.files.length} files`, "+5 −4")])]);
}

/** A parent whose subagents have all finished: it reads what they wrote and brings it together. */
export function gatherPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, children: number, moment: Moment): Plan {
  const { id } = chat;
  return plan(
    [1500, [{ type: "update", id, patch: { line: `Reading what ${children} agents found` }, clear: ["script", "step"] }]],
    [4000, surfaceActions(chat, moment, [step("read", `Read ${children} reports`, "and put them in one order")])],
  );
}

// ---------------------------------------------------------------- after direction

/** How to try what an answered question ends in, by its branch (Moment.preview); a flag removed has nothing to try. */
const TRIES: Readonly<Record<string, Preview>> = {
  "fold-measure-first": { try: "Open a long chat and watch a turn fold: the line you're reading stays put", shots: [{ caption: "Folded", drawn: "fold" }] },
  "fold-pin-anchor": { try: "Open a long chat and watch a turn fold: the Changes pill stays put", shots: [{ caption: "Folded", drawn: "fold" }] },
  "launch-email": { try: "Open the test email on your phone and tap Get the app", shots: [{ caption: "Inbox", drawn: "email" }] },
};

/** A change the scripted world's questions end in, once answered. */
function change(headline: string, branch: string, checks: string, files: FileChange[], changes: string[], summary: string): Moment {
  const preview = TRIES[branch];
  return { headline, nudge: "Take a look.", branch, checks, files, changes, summary, ...(preview ? { preview } : null) };
}

/** What each of the scripted world's questions goes on to do, by the option taken (its index), as steps then a change. */
const DIRECTIONS: Record<string, readonly { ack: string; line: string; steps: Step[]; moment: Moment }[]> = {
  "fold-jump": [
    {
      ack: "Measuring before the fold, then. It's the smaller change.",
      line: "Editing fold.ts  +14 −3",
      steps: [step("edit", "Edited fold.ts", "+14 −3"), step("run", "Recorded the fold again", "0 pt jump at 120 fps"), step("run", "Ran the fold tests", "vitest fold  31/31 passed")],
      moment: change(
        "The fold no longer jumps",
        "fold-measure-first",
        "31 tests pass",
        [
          { path: "src/thread/fold.ts", add: 14, del: 3 },
          { path: "src/thread/fold.test.ts", add: 9, del: 0 },
        ],
        ["A turn is measured before its fold starts", "The list scrolls by the folded height, once", "The 240 ms fold is unchanged"],
        "The thread holds still now. A turn is measured before its fold starts, so the list scrolls by the folded height once instead of chasing it:\n\n- Recorded at 120 fps: **0 pt** of jump, down from 38\n- The 240 ms fold itself is unchanged\n- All **31 tests** pass",
      ),
    },
    {
      ack: "Pinning the anchor, then. It's bigger, but it steadies the Changes pill too.",
      line: "Editing Thread.tsx  +41 −12",
      steps: [step("edit", "Edited Thread.tsx", "+41 −12"), step("edit", "Edited TurnChanges.tsx", "+8 −2"), step("run", "Ran the thread tests", "vitest thread  44/44 passed")],
      moment: change(
        "The fold holds its anchor",
        "fold-pin-anchor",
        "44 tests pass",
        [
          { path: "src/screens/Thread.tsx", add: 41, del: 12 },
          { path: "src/components/transcript/TurnChanges.tsx", add: 8, del: 2 },
        ],
        ["The line you're reading stays put while a turn folds", "The Changes pill no longer nudges up", "The 240 ms fold is unchanged"],
        "The thread now pins the line you're reading while a turn folds, so nothing under your eye moves, and the Changes pill stays where it was. All **44 tests** pass.",
      ),
    },
  ],
  "relay-limits": [
    {
      ack: "Removing it. Nothing in production reads it.",
      line: "Removing legacy_backoff",
      steps: [step("edit", "Removed legacy_backoff", "−46"), step("run", "Ran the relay tests", "go test ./relay  63/63 passed")],
      moment: change(
        "Relay rate limits are in",
        "relay-token-bucket",
        "63 tests pass",
        [
          { path: "relay/limit.go", add: 118, del: 64 },
          { path: "relay/backoff.go", add: 0, del: 46 },
        ],
        ["Token buckets per connection", "legacy_backoff is gone", "63 relay tests pass"],
        "The relay rate-limits with token buckets now, one per connection, and **legacy_backoff** is gone with the one test that read it. All **63 tests** pass.",
      ),
    },
    {
      ack: "Keeping it for one release, off by default.",
      line: "Turning legacy_backoff off by default",
      steps: [step("edit", "Turned legacy_backoff off by default", "+4 −2"), step("run", "Ran the relay tests", "go test ./relay  64/64 passed")],
      moment: change(
        "Relay rate limits are in",
        "relay-token-bucket",
        "64 tests pass",
        [
          { path: "relay/limit.go", add: 118, del: 64 },
          { path: "relay/flags.go", add: 4, del: 2 },
        ],
        ["Token buckets per connection", "legacy_backoff stays one release, off", "64 relay tests pass"],
        "The relay rate-limits with token buckets now. **legacy_backoff** stays one more release, off by default, with a note to remove it in 0.48. All **64 tests** pass.",
      ),
    },
  ],
  "launch-email": [0, 1, 2].map((i) => {
    const subject = ["Your agents, in your pocket", "Answer your agents from anywhere", "Caveman Code is on your phone"][i]!;
    return {
      ack: `“${subject}” it is.`,
      line: "Sending a test email",
      steps: [step("edit", "Set the subject", subject), step("run", "Sent a test to julius@caveman.so", "landed in Inbox")],
      moment: change(
        "The launch email is ready",
        "launch-email",
        "Test email landed",
        [{ path: "emails/launch-email.md", add: 38, del: 0 }],
        [`Subject: ${subject}`, "Three short paragraphs and one button", "A test landed in Inbox, not Promotions"],
        `The launch email is ready with **${subject}** as its subject. A test landed in your inbox, not Promotions. Tell me to schedule it, or what to change.`,
      ),
    };
  }),
};

/**
 * After you gave a chat direction (one of its options, or words of your own): it says what it took, does it, and
 * comes back with something to look at. The scripted world's questions have their own outcomes; any other goes the
 * prototype's usual way.
 */
export function directedPlan(chat: Pick<Chat, "id" | "repo" | "title" | "chief">, options: readonly AskOption[], told: string): Plan {
  const { id } = chat;
  const picked = options.findIndex((o) => o.label === told);
  const scripted = DIRECTIONS[id]?.[picked];
  if (scripted) {
    return plan(
      [600, [{ type: "append", id, items: [words(scripted.ack, "commentary")] }, { type: "update", id, patch: { line: scripted.line } }]],
      [5200, surfaceActions(chat, scripted.moment, scripted.steps)],
    );
  }
  const own = picked < 0;
  return plan(
    [600, [{ type: "append", id, items: [words(own ? "Got it. I'll do it your way." : `Going with “${told}”.`, "commentary")] }, { type: "update", id, patch: { line: "Reading your note" } }]],
    [1800, [{ type: "work", id, steps: [step("read", "Read your note")] }, { type: "update", id, patch: { line: "Editing 2 files  +12 −4" } }]],
    [3600, surfaceActions(chat, { ...momentFor(chat.title), summary: own ? "Done your way. The tests still pass." : `Done, going with **${told}**. The tests still pass.` }, [step("edit", "Edited 2 files", "+12 −4"), step("run", "Ran the tests", "pnpm test  14/14 passed")])],
  );
}
