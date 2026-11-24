// A computer's row as Caveman lists it, read into one state with what the row adds: a Mac online, asleep or offline;
// a Cloud computer running, asleep, on its way up, held up or failed, that it updates when it next wakes, that Caveman
// lost its disk. This is the reading the runtime's tests of the phone pin (phoneLive.integration.test.ts), computer
// by computer, with the computers' own names.
//
// It is not what a person reads. The app says a chat runs on a Mac of theirs or in Cloud and gives that place one
// state word (words.ts placeOf, placeWord): no computer of Cloud's by name, no raw reason, and neither of the two
// notes (nothing can be done about an update, and a lost disk is said in the chats it touched).
import type { Computer } from "./cloud.ts";

export interface ComputerStatus {
  /** The board's word for it (board/model.ts Device.status). */
  readonly state: "online" | "asleep" | "offline" | "starting";
  /** What its row says after its dot: "Online", "Asleep", "Waking", "Asleep: plan usage used up". */
  readonly label: string;
  readonly tone: "ok" | "idle" | "bad";
  /** What else its row says, each once: that it updates when it next wakes, that Caveman lost its disk. */
  readonly notes: readonly string[];
}

/** What a Cloud computer whose runtime is older than Cloud's minimum says (cloud-computers CONTRACT §5.4). */
export const UPDATES_ON_WAKE = "This computer updates when it next wakes.";
/** How long a computer's row goes on saying its disk was lost. The chats that came back say so for good. */
const DISK_LOST_SHOWN_MS = 30 * 24 * 3_600_000;
/**
 * A Mac that is not on line sleeps, for all the phone can tell, while Caveman heard from it within a day: its lid is
 * closed. One silent for longer, or never heard, is off, signed out or gone: offline. Cloud says only when it last
 * heard from a Mac, never why it stopped.
 */
const MAC_ASLEEP_WITHIN_MS = 24 * 3_600_000;

/** The reasons Cloud gives a computer on its way that are only progress; any other is what holds it up (the web's PROGRESS). */
const PROGRESS =
  /^(booting|waking|stopping|deleting|Pending|Running)$|: (ContainerCreating|PodInitializing|ContainersNotReady|ContainersNotInitialized)$/;
const REASON_MAX = 120;
const clip = (s: string) =>
  s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1).trimEnd()}…` : s;

function notesOf(c: Computer, now: number, timeZone?: string): readonly string[] {
  const notes: string[] = [];
  const lost = c.row?.disk_lost_at ? Date.parse(c.row.disk_lost_at) : Number.NaN;
  if (Number.isFinite(lost) && now - lost < DISK_LOST_SHOWN_MS) {
    const day = new Date(lost).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(timeZone ? { timeZone } : {}),
    });
    notes.push(
      `Caveman lost this computer's disk on ${day}. Its chats continued from their last copy.`,
    );
  }
  if (c.row?.runtime_outdated === true) notes.push(UPDATES_ON_WAKE);
  return notes;
}

/** A computer as its row reads on the phone. */
export function computerStatus(c: Computer, now = Date.now(), timeZone?: string): ComputerStatus {
  const notes = notesOf(c, now, timeZone);
  const say = (
    state: ComputerStatus["state"],
    label: string,
    tone: ComputerStatus["tone"] = state === "online" ? "ok" : "idle",
  ): ComputerStatus => ({ state, label, tone, notes });
  if (c.kind === "laptop") {
    if (c.online) return say("online", "Online");
    const seen = Date.parse(c.last_seen_at);
    return Number.isFinite(seen) && seen > 0 && now - seen < MAC_ASLEEP_WITHIN_MS
      ? say("asleep", "Asleep")
      : say("offline", "Offline");
  }
  const row = c.row;
  if (!row) {
    // A Cloud that names only runtimes: what the chat list says of the computer.
    if (c.online) return say("online", "Running");
    return c.state === "starting"
      ? say("starting", "Starting")
      : c.state === "stopped"
        ? say("offline", "Stopped")
        : say("asleep", "Asleep");
  }
  const reason = row.observed_reason.trim();
  if (row.observed_state === "failed")
    return say("offline", reason ? `Failed: ${clip(reason)}` : "Failed", "bad");
  // Its machine runs: on line once its runtime has linked, a moment after the machine is up.
  if (row.desired_state === "running" && row.observed_state === "running")
    return c.online ? say("online", "Running") : say("starting", "Starting");
  if (row.desired_state === "suspended" && row.sleep_reason === "usage")
    return say("asleep", "Asleep: plan usage used up");
  // On its way and held up by something it names: that, never "Starting" for ever.
  if (row.observed_state !== row.desired_state && reason !== "" && !PROGRESS.test(reason))
    return say(row.desired_state === "running" ? "starting" : "asleep", `Waiting: ${clip(reason)}`);
  if (row.desired_state === "running")
    return say("starting", row.observed_state === "suspended" ? "Waking" : "Starting");
  if (row.desired_state === "suspended")
    return say("asleep", row.observed_state === "suspended" ? "Asleep" : "Going to sleep");
  return say("offline", row.observed_state === row.desired_state ? "Stopped" : "Stopping");
}
