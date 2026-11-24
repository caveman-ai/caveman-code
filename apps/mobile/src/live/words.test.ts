// Every sentence the phone says about where a chat runs, pinned: a place's one state word, a message that waits, the
// open chat's one line, and what the phone says when something could not be done. No sentence here names one of
// Cloud's computers, a size, or a mechanism, and no wait or refusal asks the person to try again by hand.
import { describe, expect, it } from "vitest";

import { CloudError, SignedOut, type CloudChat, type Computer, type QueuedCall } from "./cloud";
import {
  CLOUD_BUSY,
  CLOUD_OFF,
  cloudFull,
  cloudFullOn,
  cloudLine,
  cloudRowLine,
  counts,
  KEEP_GOING,
  lidAgentsOff,
  lidWords,
  macWord,
  movingNote,
  noteOf,
  passes,
  placeOf,
  placeWord,
  planName,
  problemWords,
  queuedAnswer,
  startFailure,
  startWords,
  staysWords,
  untilWords,
  waited,
  waitingLine,
  whereMark,
  whereName,
  type NoteInput,
} from "./words";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const ZONE = "UTC";

const mac = (patch: Partial<Computer> = {}): Computer => ({
  runtime_id: "rt-mac",
  computer_id: "c-mac",
  kind: "laptop",
  name: "Studio",
  online: true,
  last_seen_at: ago(5_000),
  ...patch,
});
const row = (
  desired: string,
  observed: string,
  more: Partial<NonNullable<Computer["row"]>> = {},
): NonNullable<Computer["row"]> => ({
  desired_state: desired,
  observed_state: observed,
  observed_reason: "",
  ...more,
});
const box = (patch: Partial<Computer> = {}): Computer => ({
  runtime_id: "rt-box",
  computer_id: "c-box",
  kind: "cloud",
  name: "acme-web",
  online: true,
  state: "running",
  last_seen_at: ago(5_000),
  row: row("running", "running"),
  ...patch,
});
const chat = (patch: Partial<CloudChat> = {}): CloudChat => ({
  session_id: "s1",
  workspace_id: "w1",
  computer_id: "c-mac",
  runtime_id: "rt-mac",
  where: { kind: "laptop", name: "Studio", online: false },
  kind: "chat",
  title: "Fix the relay test",
  engine: "claude-agent",
  repo: "acme/relay",
  branch: "caveman/fix-the-relay-test",
  status: "idle",
  last_activity_at: ago(HOUR),
  calls: [],
  ...patch,
});
const call = (patch: Partial<QueuedCall> = {}): QueuedCall => ({
  request_id: "r1",
  method: "turn.submit",
  status: "queued",
  ...patch,
});

describe("where a chat runs, by name", () => {
  it("is the Mac's own name, or Cloud: never one of Cloud's computers by name", () => {
    expect(whereName(mac())).toBe("Studio");
    expect(whereName(box())).toBe("Cloud");
    expect(whereName(box({ name: "box-a" }))).toBe("Cloud");
    expect(whereName(undefined)).toBe("Cloud");
  });
});

describe("a place's one state", () => {
  it("a Mac is online, asleep within a day of being heard from, and offline after that or when never heard", () => {
    expect(placeOf(mac(), { now: NOW })).toEqual({ is: "running" });
    expect(placeOf(mac({ online: false, last_seen_at: ago(10 * MIN) }), { now: NOW })).toEqual({
      is: "asleep",
    });
    expect(placeOf(mac({ online: false, last_seen_at: ago(25 * HOUR) }), { now: NOW })).toEqual({
      is: "offline",
    });
    expect(placeOf(mac({ online: false, last_seen_at: "" }), { now: NOW })).toEqual({
      is: "offline",
    });
  });

  it("Cloud runs, sleeps, is on its way up, or is paused by a plan that is used up", () => {
    expect(placeOf(box())).toEqual({ is: "running" });
    expect(
      placeOf(
        box({
          online: false,
          runtime_id: "",
          state: "suspended",
          row: row("suspended", "suspended"),
        }),
      ),
    ).toEqual({ is: "asleep" });
    // Going to sleep, stopping and stopped are all one thing to a person: asleep.
    expect(
      placeOf(
        box({ online: false, row: row("suspended", "running", { observed_reason: "stopping" }) }),
      ),
    ).toEqual({ is: "asleep" });
    expect(
      placeOf(
        box({ online: false, runtime_id: "", state: "stopped", row: row("stopped", "stopped") }),
      ),
    ).toEqual({ is: "asleep" });
    expect(
      placeOf(
        box({
          online: false,
          runtime_id: "",
          state: "starting",
          row: row("running", "suspended", { observed_reason: "waking" }),
        }),
      ),
    ).toEqual({ is: "waking" });
    // Its machine runs and its runtime has not linked yet: still on its way up.
    expect(placeOf(box({ online: false }))).toEqual({ is: "waking" });
    expect(
      placeOf(
        box({
          online: false,
          runtime_id: "",
          state: "suspended",
          row: row("suspended", "suspended", { sleep_reason: "usage" }),
        }),
      ),
    ).toEqual({ is: "paused" });
    // Cloud lists when the plan resets beside the reason.
    expect(
      placeOf(
        box({
          online: false,
          runtime_id: "",
          state: "suspended",
          row: row("suspended", "suspended", {
            sleep_reason: "usage",
            resets_at: "2026-11-14T08:00:00.000Z",
          }),
        }),
      ),
    ).toEqual({ is: "paused", until: "2026-11-14T08:00:00.000Z" });
    expect(placeWord({ is: "paused", until: "2026-11-14T08:00:00.000Z" }, NOW, ZONE)).toBe(
      "Paused until Saturday · plan used up",
    );
    // Refused when asked, with when the plan resets.
    expect(
      placeOf(box({ online: false, row: row("suspended", "suspended") }), {
        held: { resetsAt: "2026-11-16T08:00:00.000Z" },
      }),
    ).toEqual({ is: "paused", until: "2026-11-16T08:00:00.000Z" });
  });

  it("Cloud that cannot start says so as one state, with what held it up kept for whoever asks", () => {
    expect(
      placeOf(
        box({
          online: false,
          row: row("running", "failed", {
            observed_reason: "image pull failed: ghcr.io/caveman/computer:9f3 not found",
          }),
        }),
      ),
    ).toEqual({
      is: "failed",
      detail: "image pull failed: ghcr.io/caveman/computer:9f3 not found",
    });
    expect(
      placeOf(
        box({
          online: false,
          row: row("running", "pending", { observed_reason: "Pending: Unschedulable" }),
        }),
      ),
    ).toEqual({ is: "failed", detail: "Pending: Unschedulable" });
    // Only progress: it is waking.
    expect(
      placeOf(
        box({
          online: false,
          row: row("running", "pending", { observed_reason: "Pending: ContainerCreating" }),
        }),
      ),
    ).toEqual({ is: "waking" });
  });

  it("reads a Cloud that names only runtimes by what the chat list says", () => {
    const { row: _row, ...bare } = box({ online: false, state: "starting" });
    expect(placeOf(bare)).toEqual({ is: "waking" });
    expect(placeOf({ ...bare, state: "suspended" })).toEqual({ is: "asleep" });
  });

  it("has one word: nothing for a place that runs, never Parked, Stopped, Starting or a raw reason", () => {
    expect(placeWord({ is: "running" })).toBeNull();
    expect(placeWord({ is: "asleep" })).toBe("Asleep");
    expect(placeWord({ is: "waking" })).toBe("Waking…");
    expect(placeWord({ is: "offline" })).toBe("Offline");
    expect(placeWord({ is: "failed", detail: "image pull failed" })).toBe("Waking…");
    expect(placeWord({ is: "paused" })).toBe("Paused · plan used up");
    expect(placeWord({ is: "paused", until: "2026-11-16T08:00:00.000Z" }, NOW, ZONE)).toBe(
      "Paused until Monday · plan used up",
    );
  });

  it("says a reset in the person's own clock: the time today, the day this week, the date after", () => {
    expect(untilWords("2026-11-10T23:08:00.000Z", NOW, ZONE)).toBe("11:08 PM");
    expect(untilWords("2026-11-16T08:00:00.000Z", NOW, ZONE)).toBe("Monday");
    expect(untilWords("2026-12-01T08:00:00.000Z", NOW, ZONE)).toBe("Dec 1");
    expect(untilWords("2026-11-10T23:08:00.000Z", NOW, "America/New_York")).toBe("6:08 PM");
    // Past, or not a time: nothing is said.
    expect(untilWords(ago(HOUR), NOW, ZONE)).toBeUndefined();
    expect(untilWords(undefined, NOW, ZONE)).toBeUndefined();
  });

  it("Settings > Computers says a Mac is Online, Asleep or Offline, and Cloud by how many of its chats' places run", () => {
    expect(macWord({ is: "running" })).toBe("Online");
    expect(macWord({ is: "asleep" })).toBe("Asleep");
    expect(macWord({ is: "offline" })).toBe("Offline");
    expect(cloudLine([{ is: "running" }, { is: "running" }])).toBe("Running");
    expect(cloudLine([{ is: "running" }, { is: "running" }, { is: "asleep" }])).toBe("2 running");
    expect(cloudLine([{ is: "asleep" }, { is: "asleep" }])).toBe("Asleep");
    expect(cloudLine([{ is: "asleep" }, { is: "waking" }])).toBe("Waking…");
    expect(
      cloudLine([{ is: "asleep" }, { is: "paused", until: "2026-11-16T08:00:00.000Z" }], NOW, ZONE),
    ).toBe("Paused until Monday · plan used up");
    expect(cloudLine([])).toBe("Asleep");
  });

  it("Cloud's own row says the desktop's words: how many run, and the share of the month's plan beside a plain state", () => {
    expect(cloudRowLine([{ is: "running" }, { is: "running" }, { is: "asleep" }], 12.7)).toBe(
      "2 running · 12% of this month's plan",
    );
    expect(cloudRowLine([{ is: "running" }])).toBe("1 running");
    expect(cloudRowLine([{ is: "asleep" }], 0)).toBe("Asleep · 0% of this month's plan");
    expect(cloudRowLine([{ is: "waking" }], 40)).toBe("Waking… · 40% of this month's plan");
    // A plan that is used up says when it resets, and no share beside it.
    expect(
      cloudRowLine([{ is: "paused", until: "2026-11-14T08:00:00.000Z" }], 100, NOW, ZONE),
    ).toBe("Paused until Saturday · plan used up");
    expect(cloudRowLine([{ is: "running" }], Number.NaN)).toBe("1 running");
  });
});

describe("why a chat stays where it is, by the code Cloud lists for it", () => {
  /** Every code a runtime sends (packages/runtime cloudLink/stays.ts STAYS) and Cloud's own two (CLOUD_STAYS). */
  const CODES = [
    "agent",
    "folder",
    "several_repositories",
    "kind",
    "not_on_github",
    "not_signed_in",
    "not_chosen",
    "lid_off",
    "cloud_off",
    "caveman_not_on_cloud",
    "unpaid",
    "no_plan",
    "not_saved",
    "save_failing",
    "changes_not_saved",
    "too_big",
    "too_many_files",
    "other",
    "repo_unverified",
    "cloud_full",
  ];

  it("says each in one sentence beside Run in Cloud, with what to do and where when there is something to do", () => {
    expect(
      Object.fromEntries(CODES.map((code) => [code, staysWords(code, { engine: "claude-agent" })])),
    ).toEqual({
      agent: "This agent runs on your Mac only.",
      folder: "This project is a folder on your Mac.",
      several_repositories: "This chat works in several repositories.",
      kind: "Chiefs and agents stay on your Mac.",
      not_on_github: "Cloud needs this project on GitHub.",
      not_signed_in: "Sign in to Caveman on your Mac (Settings > Account).",
      not_chosen: KEEP_GOING,
      lid_off: KEEP_GOING,
      cloud_off: "Cloud is off. Ask your admin.",
      caveman_not_on_cloud: "Caveman chats don't run in Cloud yet.",
      unpaid: "Your plan is used up.",
      no_plan: "Connect Claude on your Mac (Settings > Models & keys).",
      not_saved: "Not saved yet. It can run in Cloud after its next turn.",
      save_failing: "Its last save didn't reach Caveman. Your Mac tries again.",
      changes_not_saved: "Your Mac is saving its changes again.",
      too_big: "Its uncommitted files are too large. Commit and push them on your Mac.",
      too_many_files: "Its uncommitted files are too large. Commit and push them on your Mac.",
      other: "This chat can't run in Cloud yet.",
      repo_unverified: "Caveman can't read this repository. Connect GitHub on your Mac (Settings).",
      cloud_full: "Cloud is full.",
    });
    expect(KEEP_GOING).toBe("Choose Keep chats going in Cloud on your Mac (Settings > Computers).");
    expect(staysWords("no_plan", { engine: "codex" })).toBe(
      "Connect ChatGPT on your Mac (Settings > Models & keys).",
    );
    expect(staysWords("no_plan", { engine: "caveman" })).toBe(
      "Connect its plan on your Mac (Settings > Models & keys).",
    );
  });

  it("has one plain line for a code this build does not know, and for none", () => {
    expect(staysWords("something_new")).toBe("This chat can't run in Cloud yet.");
    expect(staysWords(undefined)).toBe("This chat can't run in Cloud yet.");
    // An object's own names are no codes.
    expect(staysWords("constructor")).toBe("This chat can't run in Cloud yet.");
  });

  it("says a chat in Cloud stays there, beside Run on a Mac", () => {
    expect(staysWords("kind", { cloud: true })).toBe("Chiefs and agents stay where they started.");
    expect(staysWords("several_repositories", { cloud: true })).toBe(
      "This chat works in several repositories.",
    );
    expect(staysWords("other", { cloud: true })).toBe("This chat stays in Cloud.");
  });

  it("no sentence names a branch, a checkout, a copy, a computer of Cloud's or an engine", () => {
    for (const code of CODES)
      for (const cloud of [false, true])
        expect(staysWords(code, { cloud })).not.toMatch(
          /branch|checkout|copy|Cloud computer|worktree|engine|runtime|session/i,
        );
  });

  it("says each in the desktop's few words under When a Mac sleeps: Pauses, or that it stays on that Mac", () => {
    const said = (code: string, engine = "claude-agent") => {
      const { what, why } = lidWords(code, engine, "Studio");
      return `${what} · ${why}`;
    };
    expect(said("no_plan")).toBe("Pauses · Claude isn't connected");
    expect(said("no_plan", "codex")).toBe("Pauses · ChatGPT isn't connected");
    expect(said("no_plan", "caveman")).toBe("Pauses · its plan isn't connected");
    expect(said("unpaid")).toBe("Pauses · plan used up");
    expect(said("folder")).toBe("Stays on Studio · folder project");
    expect(said("not_on_github")).toBe("Stays on Studio · repository isn't on GitHub");
    expect(said("several_repositories")).toBe("Stays on Studio · works in several repositories");
    expect(said("agent")).toBe("Stays on Studio · this agent runs only on a Mac");
    expect(said("kind")).toBe("Stays on Studio · Chiefs and agents stay on their Mac");
    expect(said("not_signed_in")).toBe("Pauses · not signed in to Caveman");
    expect(said("cloud_off")).toBe("Pauses · Cloud turned off by your admin");
    expect(said("caveman_not_on_cloud")).toBe("Pauses · Caveman agent isn't in Cloud yet");
    expect(said("not_saved")).toBe("Pauses · saves after its next turn");
    expect(said("save_failing")).toBe("Pauses · its last save didn't reach Caveman");
    expect(said("changes_not_saved")).toBe("Pauses · saving its changes again");
    expect(said("too_big")).toBe("Pauses · uncommitted files too large");
    expect(said("too_many_files")).toBe("Pauses · uncommitted files too large");
    expect(said("something_new")).toBe("Pauses · can't run in Cloud yet");
    expect(lidAgentsOff("Claude Agent")).toEqual({
      what: "Pauses",
      why: "Claude Agent chats turned off",
    });
  });
});

describe("a message that waits, under it, in one line", () => {
  const studio = { name: "Studio", cloud: false };
  const cloud = { name: "Cloud", cloud: true };

  it("says Cloud is being woken for it, whichever of Cloud's computers", () => {
    expect(waitingLine(call(), cloud)).toBe("Waking Cloud…");
    expect(waitingLine(call({ status: "delivered" }), cloud)).toBe("Waking Cloud…");
    expect(waitingLine(call({ method: "ask.respond" }), cloud)).toBe(
      "Answer queued · waking Cloud",
    );
  });

  it("says a sleeping Mac's chat runs in Cloud where Cloud is moving it: sending is enough", () => {
    expect(waitingLine(call({ waiting: { reason: "laptop_asleep" } }), studio)).toBe(
      "Studio is asleep. Running in Cloud.",
    );
  });

  it("says a message is kept until the Mac wakes where the chat stays there, with why by Cloud's code where that is news", () => {
    const detail =
      "Studio is asleep. It stays on its laptop: its runtime does not follow it for moves.";
    const kept = (code?: string, engine = "claude-agent") =>
      waitingLine(
        call({ waiting: { reason: "not_movable", detail, ...(code ? { code } : {}) } }),
        studio,
        { engine },
      );
    // No code (a Cloud from before them), the Mac's own choice, or what the chat is: the mark alone.
    expect(kept()).toBe("Sends when Studio wakes");
    expect(kept("not_chosen")).toBe("Sends when Studio wakes");
    expect(kept("lid_off")).toBe("Sends when Studio wakes");
    expect(kept("kind")).toBe("Sends when Studio wakes");
    expect(kept("something_new")).toBe("Sends when Studio wakes");
    // What kept it out of Cloud, in the desktop's few words, then the same mark.
    expect(kept("folder")).toBe("Folder project. Sends when Studio wakes.");
    expect(kept("no_plan")).toBe("Claude isn't connected. Sends when Studio wakes.");
    expect(kept("no_plan", "codex")).toBe("ChatGPT isn't connected. Sends when Studio wakes.");
    expect(kept("unpaid")).toBe("Plan used up. Sends when Studio wakes.");
    expect(kept("cloud_full")).toBe("Cloud is full. Sends when Studio wakes.");
    expect(kept("not_saved")).toBe("Saves after its next turn. Sends when Studio wakes.");
    expect(kept("too_big")).toBe("Uncommitted files too large. Sends when Studio wakes.");
    expect(kept("repo_unverified")).toBe(
      "Caveman can't read its repository. Sends when Studio wakes.",
    );
    // Never Cloud's own sentence, which is written for a log.
    expect(kept("folder")).not.toContain("laptop");
    expect(
      waitingLine(call({ waiting: { reason: "not_movable", detail } }), { name: "", cloud: false }),
    ).toBe("Sends when your Mac wakes");
  });

  it("says only that it is sending while Cloud has not said it waits on anything: the chat may just have moved to Cloud", () => {
    expect(waitingLine(call(), studio)).toBe("Sending");
    expect(waitingLine(call({ method: "ask.respond" }), studio)).toBe("Answer queued");
  });

  it("says nothing once it ran, and Not sent for one Cloud gave up on: never a status, a code or Try again", () => {
    expect(waitingLine(call({ status: "done" }), studio)).toBeNull();
    expect(waitingLine(call({ status: "expired" }), studio)).toBe("Not sent");
    expect(
      waitingLine(
        call({
          status: "failed",
          error: { code: "cave_code_call_unanswered", message: "The computer never took it." },
        }),
        studio,
      ),
    ).toBe("Not sent");
    expect(
      waitingLine(
        call({
          status: "failed",
          error: { code: "invalid_state", message: "the ask was answered" },
        }),
        studio,
      ),
    ).toBe("Answered on another device");
  });

  it("an approval answered while its place could not hear says it is queued, never that it was given", () => {
    expect(queuedAnswer("allow", cloud)).toBe("Allow queued · waking Cloud");
    expect(queuedAnswer("deny", cloud)).toBe("Deny queued · waking Cloud");
    expect(queuedAnswer("allow", studio)).toBe("Allow queued · sends when Studio wakes");
    // A question's answer is no yes or no.
    expect(queuedAnswer("answer", cloud)).toBe("Answer queued · waking Cloud");
  });
});

describe("the open chat's one line about where it runs", () => {
  const onMac = { name: "Studio", cloud: false };
  const inCloud = { name: "Cloud", cloud: true };
  const note = (patch: Partial<NoteInput>) =>
    noteOf({ where: inCloud, place: { is: "running" }, now: NOW, timeZone: ZONE, ...patch });

  it("says nothing while its place runs", () => {
    expect(note({})).toBeNull();
    expect(note({ where: onMac })).toBeNull();
  });

  it("says Asleep for a place that sleeps: nothing is pressed to wake it, sending does", () => {
    expect(note({ place: { is: "asleep" } })).toEqual({ words: "Asleep" });
    expect(note({ where: onMac, place: { is: "asleep" } })).toEqual({ words: "Asleep" });
    expect(note({ where: onMac, place: { is: "offline" } })).toEqual({ words: "Offline" });
  });

  it("says Cloud is waking with its seconds, once a message has woken it", () => {
    expect(note({ place: { is: "waking" }, since: NOW - 4_000 })).toEqual({
      words: "Waking Cloud…",
      since: NOW - 4_000,
    });
    expect(note({ place: { is: "asleep" }, since: NOW - 1_000, waiting: call() })).toEqual({
      words: "Waking Cloud…",
      since: NOW - 1_000,
    });
    // The one shape of a wait: the doing, an ellipsis, and whoever draws it adds a space and the seconds.
    expect(counts("Waking Cloud…")).toBe(true);
    expect(counts("Moving to Studio…")).toBe(true);
    expect(counts("Sends when Studio wakes")).toBe(false);
    expect(`${"Waking Cloud…"} ${waited(8_000)}`).toBe("Waking Cloud… 8s");
  });

  it("says when a used-up plan resets, with no button and never Try again", () => {
    const line = note({ place: { is: "paused", until: "2026-11-16T08:00:00.000Z" } });
    expect(line).toEqual({ words: "Paused until Monday · plan used up" });
    expect(note({ place: { is: "paused" } })).toEqual({ words: "Paused · plan used up" });
  });

  it("says a start that failed is being tried again, with what held it up a tap away", () => {
    expect(
      note({
        place: {
          is: "failed",
          detail: "image pull failed: ghcr.io/caveman/computer:9f3 not found",
        },
      }),
    ).toEqual({
      words: "Cloud couldn't start. Trying again.",
      detail: "image pull failed: ghcr.io/caveman/computer:9f3 not found",
    });
  });

  it("says a chat is on its way somewhere else, both ways, with its seconds", () => {
    expect(
      note({ where: onMac, place: { is: "asleep" }, moving: { to: "Cloud", since: NOW - 3_000 } }),
    ).toEqual({ words: "Moving to Cloud…", since: NOW - 3_000 });
    expect(note({ moving: { to: "Studio", since: NOW - 3_000 } })).toEqual({
      words: "Moving to Studio…",
      since: NOW - 3_000,
    });
  });

  it("says a move that waits for the chat's turn goes when the turn ends, with nothing counting", () => {
    expect(
      note({ where: onMac, moving: { to: "Cloud", since: NOW - 3_000, waitingTurn: true } }),
    ).toEqual({ words: "Moves when this turn ends." });
    expect(movingNote({ to: "Cloud", since: NOW, waitingTurn: true })).toEqual({
      words: "Moves when this turn ends.",
    });
    expect(counts("Moves when this turn ends.")).toBe(false);
  });

  it("says there is no network once that has lasted ten seconds, and that a message sends when it is back", () => {
    expect(note({ offlineSince: NOW - 4_000 })).toBeNull();
    expect(note({ offlineSince: NOW - 11_000 })).toEqual({ words: "No network." });
    expect(
      note({ where: onMac, place: { is: "asleep" }, offlineSince: NOW - 11_000, waiting: call() }),
    ).toEqual({ words: "No network. Sends when you're back online." });
  });

  it("says the one thing a Mac asks, once: to allow this phone, with the code to check there", () => {
    expect(note({ where: onMac, allow: { state: "waiting", code: "7K2-M4P-9QX-T3V" } })).toEqual({
      words: "On Studio, choose Allow when it shows this code.",
      code: "7K2-M4P-9QX-T3V",
      block: true,
    });
    expect(note({ where: onMac, allow: { state: "refused", code: "" } })).toEqual({
      words: "Allow this phone on Studio (Settings > General).",
      block: true,
    });
  });

  it("says what waits for a sleeping Mac in one line: no button Cloud would refuse, and never Cloud's own reason, which is written for a log", () => {
    const cloudsWhy =
      "Studio is asleep. It stays on its laptop: its runtime does not follow it for moves.";
    expect(
      note({
        where: onMac,
        place: { is: "asleep" },
        waiting: call({ waiting: { reason: "laptop_asleep" } }),
        chat: chat(),
      }),
    ).toEqual({ words: "Studio is asleep. Running in Cloud." });
    const kept = note({
      where: onMac,
      place: { is: "asleep" },
      waiting: call({ waiting: { reason: "not_movable", detail: cloudsWhy } }),
      chat: chat(),
    });
    expect(kept).toEqual({ words: "Sends when Studio wakes" });
    // The backstop, for a chat whose Mac said nothing of whether it can move: a plain line, never Cloud's own.
    expect(
      problemWords(
        Object.assign(
          new Error("This chat stays on its computer: its runtime does not follow it for moves."),
          { name: "CloudError", status: 409, code: "cave_code_session_not_movable" },
        ),
      ),
    ).toBe("This chat can't run in Cloud yet.");
  });

  it("says a move Caveman refused in one line, with Caveman's own reason and fix a tap away", () => {
    const why =
      "Connect Claude on your Mac (Settings > Models & keys). It then works in Cloud too.";
    expect(note({ where: onMac, place: { is: "asleep" }, refused: why })).toEqual({
      words: "Can't run in Cloud.",
      detail: why,
    });
  });

  it("no line it says names one of Cloud's computers, a size, or how the thing works", () => {
    const all = [
      note({ place: { is: "asleep" } }),
      note({ place: { is: "waking" }, since: NOW }),
      note({ place: { is: "paused" } }),
      note({ place: { is: "failed", detail: "x" } }),
      note({ moving: { to: "Cloud", since: NOW } }),
      note({ offlineSince: NOW - 11_000 }),
      note({
        where: onMac,
        place: { is: "asleep" },
        waiting: call({ waiting: { reason: "laptop_asleep" } }),
      }),
    ];
    for (const line of all)
      expect(line?.words).not.toMatch(
        /box-a|acme-web|Cloud computer|runtime|session|workspace|copy|lease|CPU|GB|Try again|Wake\b|Connect\b/,
      );
  });

  it("counts a wait's seconds", () => {
    expect(waited(0)).toBe("0s");
    expect(waited(4_200)).toBe("4s");
    expect(waited(65_000)).toBe("1m 05s");
  });
});

describe("a row's mark for where its chat runs", () => {
  it("says the web's words: In Cloud, or On the Mac's own name", () => {
    expect(whereMark({ name: "Cloud", cloud: true })).toBe("In Cloud");
    expect(whereMark({ name: "Studio", cloud: false })).toBe("On Studio");
    expect(whereMark({ name: "", cloud: false })).toBe("On your Mac");
  });
});

describe("a chat that did not start", () => {
  const protocol = (message: string) =>
    Object.assign(new Error(message), { name: "SessionProtocolError" });
  const studio = { name: "Studio", cloud: false };
  const cloud = { name: "Cloud", cloud: true };

  it("says the web's one line: what did not happen, and why in one sentence", () => {
    expect(startFailure("Cloud is busy.")).toBe("The chat didn't start: Cloud is busy.");
    expect(startFailure("studio is asleep")).toBe("The chat didn't start: Studio is asleep.");
    expect(startFailure(CLOUD_OFF)).toBe("The chat didn't start: Cloud is off. Ask your admin.");
  });

  it("says Cloud's own refusals and the phone's own sentences as they are", () => {
    const used =
      "You have used this month's Cloud computer time. It comes back on Dec 1, or add credits in Caveman.";
    expect(startWords(new CloudError(402, used), cloud)).toBe(used);
    expect(
      startWords(
        new CloudError(409, "Cloud computers are off for Acme.", "cave_code_cloud_computers_off"),
        cloud,
      ),
    ).toBe("Cloud is off. Ask your admin.");
    expect(startWords(new Error("Allow this phone on Studio (Settings > General)."), studio)).toBe(
      "Allow this phone on Studio (Settings > General).",
    );
    expect(startWords(protocol("Caveman is not installed on this computer."), studio)).toBe(
      "Caveman is not installed on this computer.",
    );
  });

  it("never says what failed underneath: git's words, a path, a status code", () => {
    expect(
      startWords(
        protocol("could not clone https://github.com/acme/relay.git: repository not found"),
        studio,
      ),
    ).toBe("Studio couldn't start it.");
    expect(
      startWords(protocol("fatal: not a git repository at /Users/ada/code/relay/.git/"), studio),
    ).toBe("Studio couldn't start it.");
    expect(startWords(protocol("spawn ENOENT"), cloud)).toBe("Cloud couldn't start it.");
    expect(startWords(protocol("Request failed with 502"), cloud)).toBe("Cloud couldn't start it.");
  });

  it("knows a start Cloud has no room for, from Cloud or from the computer it reached, and what is left to say of it", () => {
    expect(
      cloudFull(
        new CloudError(
          409,
          "That Cloud computer runs as many chats as it can.",
          "cave_code_computer_full",
        ),
      ),
    ).toBe(true);
    expect(cloudFull(protocol(CLOUD_BUSY))).toBe(true);
    expect(cloudFull(new CloudError(409, "Cloud is full on Pro."))).toBe(false);
    expect(cloudFull(new TypeError("Network request failed"))).toBe(false);
    // Tried again first; when it still has no room the line no longer says it is trying.
    expect(
      startWords(
        new CloudError(
          409,
          "That Cloud computer runs as many chats as it can.",
          "cave_code_computer_full",
        ),
        cloud,
      ),
    ).toBe("Cloud is busy.");
    expect(startWords(protocol(CLOUD_BUSY), cloud)).toBe("Cloud is busy.");
  });

  it("says Cloud is full on the person's plan where every computer they may run at once is working", () => {
    const running = new CloudError(
      409,
      "You run as many Cloud computers at once as you may.",
      "cave_code_computer_limit_person_running",
    );
    const awake = new CloudError(
      409,
      "Your plan's memory awake is all in use.",
      "cave_code_computer_limit_plan_awake",
    );
    expect(startWords(running, cloud, "Pro")).toBe("Cloud is full on Pro.");
    expect(startWords(awake, cloud, planName("max20"))).toBe("Cloud is full on Max.");
    // No computer of theirs has said which plan: the sentence without it.
    expect(startWords(awake, cloud)).toBe("Cloud is full.");
    expect(startFailure(cloudFullOn("Team"))).toBe("The chat didn't start: Cloud is full on Team.");
    // The same code as one of the person's computers passes it on.
    expect(
      problemWords(
        Object.assign(protocol("That did not work."), {
          error: { data: { cloud_code: "cave_code_computer_limit_person_running" } },
        }),
        "start",
        "Pro",
      ),
    ).toBe("Cloud is full on Pro.");
    // Not tried again by itself: Cloud already made what room it could.
    expect(cloudFull(running)).toBe(false);
    expect(planName("go")).toBe("Pro");
    expect(planName("enterprise")).toBe("enterprise");
    expect(planName(undefined)).toBeUndefined();
  });
});

describe("something that could not be done", () => {
  it("says Cloud's own sentence where it wrote one for a person", () => {
    expect(problemWords(new CloudError(402, "Your plan is used up until Monday."))).toBe(
      "Your plan is used up until Monday.",
    );
    expect(problemWords(new CloudError(409, "Cloud is full on Pro."))).toBe(
      "Cloud is full on Pro.",
    );
  });

  it("never says a status, a token or which of our parts failed", () => {
    expect(problemWords(new CloudError(402, "Caveman answered 402."), "sign-in")).toBe(
      "Couldn't sign in. Try again.",
    );
    expect(
      problemWords(new CloudError(502, "Caveman minted no token for this phone."), "sign-in"),
    ).toBe("Couldn't sign in. Try again.");
    expect(
      problemWords(new CloudError(502, "Caveman sent an approve page on another site."), "sign-in"),
    ).toBe("Couldn't sign in. Try again.");
    // A start is tried again by itself before it says so (start.ts): what is left no longer says it is trying.
    expect(
      problemWords(new CloudError(502, "Caveman made no Cloud computer for this chat."), "start"),
    ).toBe("Cloud couldn't start.");
    expect(problemWords(new TypeError("Network request failed"), "start")).toBe(
      "Can't reach Caveman.",
    );
    expect(problemWords(new CloudError(503, "Caveman is not reachable right now."))).toBe(
      "Can't reach Caveman. Trying again.",
    );
    expect(problemWords(new TypeError("Network request failed"), "sign-in")).toBe(
      "Couldn't sign in. Try again.",
    );
  });

  it("says where to go for what the person must do themselves", () => {
    expect(problemWords(new SignedOut())).toBe("Sign in to Caveman again (Settings > Account).");
    expect(
      problemWords(
        new CloudError(
          403,
          "This Caveman server does not allow device sign-in.",
          "cave_device_login_disabled",
        ),
        "sign-in",
      ),
    ).toBe("Your admin turned off signing in from a phone.");
    expect(
      problemWords(
        new CloudError(
          403,
          "This Caveman server does not start Cloud chats from a phone yet. Start it on your Mac.",
          "cave_agent_operation_forbidden",
        ),
        "start",
      ),
    ).toBe("Cloud chats can't be started from the phone yet. Start it on your Mac.");
    expect(problemWords(new Error("The code expired. Sign in again."), "sign-in")).toBe(
      "The code expired. Sign in again.",
    );
  });

  it("knows what passes by itself, so the app tries again and the person is never asked to", () => {
    expect(passes(new TypeError("Network request failed"))).toBe(true);
    expect(passes(new CloudError(503, "busy"))).toBe(true);
    expect(passes(new CloudError(429, "slow down"))).toBe(true);
    expect(passes(new CloudError(409, "The chat is archived or ended."))).toBe(false);
    expect(passes(new CloudError(402, "Your plan is used up."))).toBe(false);
    expect(passes(new SignedOut())).toBe(false);
    expect(passes(new Error("The chat is archived or ended."))).toBe(false);
  });
});
