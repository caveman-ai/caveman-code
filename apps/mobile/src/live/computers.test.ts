// A computer's row as Caveman lists it, read into one state (computers.ts): a Mac awake, asleep or offline, a Cloud
// computer in each of its states, and what its row adds. This is the reading the runtime's tests of the phone use; what
// a person reads of a place is pinned in words.test.ts.
import { describe, expect, it } from "vitest";

import type { Computer, ComputerRow } from "./cloud";
import { computerStatus, UPDATES_ON_WAKE } from "./computers";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 3_600_000;

const mac = (patch: Partial<Computer> = {}): Computer => ({
  runtime_id: "rt-mac",
  computer_id: "c-mac",
  kind: "laptop",
  name: "Studio",
  online: true,
  last_seen_at: ago(5_000),
  ...patch,
});
const row = (patch: Partial<ComputerRow> = {}): ComputerRow => ({
  desired_state: "running",
  observed_state: "running",
  observed_reason: "",
  ...patch,
});
const box = (patch: Partial<Computer> = {}, rowPatch?: Partial<ComputerRow> | null): Computer => ({
  runtime_id: "rt-box",
  computer_id: "c-box",
  kind: "cloud",
  name: "caveman-code",
  online: true,
  state: "running",
  last_seen_at: ago(5_000),
  ...(rowPatch === null ? {} : { row: row(rowPatch) }),
  ...patch,
});
const said = (c: Computer) => {
  const { state, label, tone } = computerStatus(c, NOW, "UTC");
  return [state, label, tone];
};

describe("a Mac", () => {
  it("is online while Caveman hears from it", () => {
    expect(said(mac())).toEqual(["online", "Online", "ok"]);
  });

  it("is asleep once it is not on line and was heard from within a day, and offline after that or when never heard", () => {
    expect(said(mac({ online: false, last_seen_at: ago(10 * MIN) }))).toEqual([
      "asleep",
      "Asleep",
      "idle",
    ]);
    expect(said(mac({ online: false, last_seen_at: ago(23 * 3_600_000) }))).toEqual([
      "asleep",
      "Asleep",
      "idle",
    ]);
    expect(said(mac({ online: false, last_seen_at: ago(2 * DAY) }))).toEqual([
      "offline",
      "Offline",
      "idle",
    ]);
    expect(said(mac({ online: false, last_seen_at: "" }))).toEqual(["offline", "Offline", "idle"]);
    expect(said(mac({ online: false, last_seen_at: new Date(0).toISOString() }))).toEqual([
      "offline",
      "Offline",
      "idle",
    ]);
  });
});

describe("a Cloud computer, by its row", () => {
  it("runs once its runtime is on line, and is starting while its machine runs and the runtime has not linked", () => {
    expect(said(box())).toEqual(["online", "Running", "ok"]);
    expect(said(box({ online: false, runtime_id: "" }))).toEqual(["starting", "Starting", "idle"]);
  });

  it("is asleep with no runtime, and says so when the plan's usage ran out", () => {
    const asleep = box(
      { online: false, runtime_id: "", state: "suspended" },
      { desired_state: "suspended", observed_state: "suspended" },
    );
    expect(said(asleep)).toEqual(["asleep", "Asleep", "idle"]);
    expect(
      said(
        box(
          { online: false, runtime_id: "", state: "suspended" },
          { desired_state: "suspended", observed_state: "suspended", sleep_reason: "usage" },
        ),
      ),
    ).toEqual(["asleep", "Asleep: plan usage used up", "idle"]);
    expect(
      said(box({ online: true }, { desired_state: "suspended", observed_state: "running" })),
    ).toEqual(["asleep", "Going to sleep", "idle"]);
  });

  it("is waking or starting on its way up, and says what holds it up when something does", () => {
    const up = { online: false, runtime_id: "", state: "starting" } as const;
    expect(said(box(up, { desired_state: "running", observed_state: "suspended" }))).toEqual([
      "starting",
      "Waking",
      "idle",
    ]);
    expect(
      said(
        box(up, {
          desired_state: "running",
          observed_state: "starting",
          observed_reason: "booting",
        }),
      ),
    ).toEqual(["starting", "Starting", "idle"]);
    expect(
      said(
        box(up, {
          desired_state: "running",
          observed_state: "pending",
          observed_reason: "no room on any host in eu-west",
        }),
      ),
    ).toEqual(["starting", "Waiting: no room on any host in eu-west", "idle"]);
    const long = "x".repeat(400);
    expect(
      computerStatus(
        box(up, { desired_state: "running", observed_state: "pending", observed_reason: long }),
        NOW,
      ).label,
    ).toHaveLength("Waiting: ".length + 120);
  });

  it("says it failed, with Cloud's reason, and that it stopped", () => {
    expect(
      said(
        box({ online: false }, { observed_state: "failed", observed_reason: "image pull failed" }),
      ),
    ).toEqual(["offline", "Failed: image pull failed", "bad"]);
    expect(said(box({ online: false }, { observed_state: "failed" }))).toEqual([
      "offline",
      "Failed",
      "bad",
    ]);
    expect(
      said(
        box(
          { online: false, state: "stopped" },
          { desired_state: "stopped", observed_state: "stopped" },
        ),
      ),
    ).toEqual(["offline", "Stopped", "idle"]);
    expect(
      said(box({ online: true }, { desired_state: "stopped", observed_state: "running" })),
    ).toEqual(["offline", "Stopping", "idle"]);
  });

  it("adds that it updates when it next wakes, and for a month that Caveman lost its disk", () => {
    expect(computerStatus(box(), NOW, "UTC").notes).toEqual([]);
    expect(computerStatus(box({}, { runtime_outdated: true }), NOW, "UTC").notes).toEqual([
      UPDATES_ON_WAKE,
    ]);
    const lost = computerStatus(
      box(
        { online: false, runtime_id: "", state: "suspended" },
        {
          desired_state: "suspended",
          observed_state: "suspended",
          disk_lost_at: "2026-11-07T23:30:00.000Z",
          runtime_outdated: true,
        },
      ),
      NOW,
      "UTC",
    );
    expect(lost.label).toBe("Asleep");
    expect(lost.notes).toEqual([
      "Caveman lost this computer's disk on Nov 7. Its chats continued from their last copy.",
      UPDATES_ON_WAKE,
    ]);
    expect(computerStatus(box({}, { disk_lost_at: ago(31 * DAY) }), NOW, "UTC").notes).toEqual([]);
    expect(computerStatus(box({}, { disk_lost_at: "not a date" }), NOW, "UTC").notes).toEqual([]);
  });
});

describe("a Cloud computer a Cloud names only by its runtime", () => {
  it("reads by what the chat list says of it", () => {
    expect(said(box({}, null))).toEqual(["online", "Running", "ok"]);
    expect(said(box({ online: false, state: "starting" }, null))).toEqual([
      "starting",
      "Starting",
      "idle",
    ]);
    expect(said(box({ online: false, state: "suspended" }, null))).toEqual([
      "asleep",
      "Asleep",
      "idle",
    ]);
    expect(said(box({ online: false, state: "stopped" }, null))).toEqual([
      "offline",
      "Stopped",
      "idle",
    ]);
  });
});
