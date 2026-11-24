import { afterEach, expect, test, vi } from "vitest";
import { budgetOf } from "../../components/LatencyOverlay.tsx";
import { CloudError } from "./cloud-api.ts";
import { eventDelay, LatencyMeter, quantile, reportLatency, statusDelay, type LatencyReport } from "./latency.ts";
import { WakeHints } from "./wake.ts";

afterEach(() => vi.useRealTimers());

test("p50 and p95 per path and way, over the last samples", () => {
  const meter = new LatencyMeter();
  for (let ms = 1; ms <= 100; ms++) meter.record("event", "relay", ms);
  meter.record("event", "direct", 12);
  meter.record("open", "cache", -3); // two clocks: never below zero
  expect(meter.stats()).toEqual([
    { path: "event", via: "direct", count: 1, p50: 12, p95: 12 },
    { path: "event", via: "relay", count: 100, p50: 50, p95: 95 },
    { path: "open", via: "cache", count: 1, p50: 0, p95: 0 },
  ]);
  for (let i = 0; i < 300; i++) meter.record("send", "relay", 7);
  expect(meter.stats().find((s) => s.path === "send")?.count).toBe(200);
  expect(quantile([], 0.5)).toBe(0);
});

test("an event's delay counts from its runtime's commit, to the millisecond when the runtime says it", () => {
  const now = Date.parse("2026-10-21T12:00:00.250Z");
  expect(eventDelay({ at: "2026-10-21T12:00:00.200Z" }, now)).toBe(50);
  expect(eventDelay({ at: "2026-10-21T12:00:00.000Z", committed_ms: now - 8 }, now)).toBe(8);
});

test("a status change's delay counts from the runtime's stamp; no change, or a stamp from before an outage, is no sample", () => {
  const now = Date.parse("2026-10-22T12:00:00.400Z");
  const working = { status: "working", last_activity_at: "2026-10-22T12:00:00.100Z" };
  expect(statusDelay({ status: "idle" }, working, now)).toBe(300);
  expect(statusDelay({ status: "working" }, working, now)).toBeUndefined();
  expect(statusDelay(undefined, working, now)).toBeUndefined();
  expect(statusDelay({ status: "idle" }, { status: "working", last_activity_at: "2026-10-22T11:58:00.000Z" }, now)).toBeUndefined();
  expect(statusDelay({ status: "idle" }, { status: "working", last_activity_at: "not a time" }, now)).toBeUndefined();
});

test("the report goes to Cloud a minute at a time while there is something new, and stops for a Cloud without the ingest", async () => {
  vi.useFakeTimers();
  const meter = new LatencyMeter();
  const sent: LatencyReport[] = [];
  let answer: "ok" | "missing" | "down" = "down";
  const api = {
    latency: async (report: LatencyReport) => {
      if (answer === "down") throw new TypeError("fetch failed");
      if (answer === "missing") throw new CloudError(404, undefined, "not found");
      sent.push(report);
    },
  };
  const stop = reportLatency(meter, api, "web", 60_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([]); // nothing measured yet
  meter.record("event", "relay", 40);
  await vi.advanceTimersByTimeAsync(60_000); // Cloud down: tried, not counted as sent
  answer = "ok";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([{ client: "web", window_s: 60, label: "measured", paths: [{ path: "event", via: "relay", count: 1, p50_ms: 40, p95_ms: 40 }] }]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(1); // nothing new
  answer = "missing";
  meter.record("event", "relay", 41);
  await vi.advanceTimersByTimeAsync(60_000);
  answer = "ok";
  meter.record("event", "relay", 42);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sent).toHaveLength(1); // that Cloud has no ingest: not asked again
  stop();
});

test("a Cloud that does not know a path or way yet refuses the report: the others still go, and that one is not sent again", async () => {
  vi.useFakeTimers();
  const meter = new LatencyMeter();
  const sent: LatencyReport["paths"][] = [];
  let asked = 0;
  const api = {
    latency: async (report: LatencyReport) => {
      asked++;
      // An older Cloud: no "list" way, and the whole report refused for it.
      if (report.paths.some((p) => p.via === "list")) throw new CloudError(400, "cave_bad_request", "via is loopback, relay, direct, copy, queue or cache.");
      sent.push(report.paths);
    },
  };
  const stop = reportLatency(meter, api, "desktop", 60_000);
  meter.record("event", "relay", 40);
  meter.record("status", "list", 250);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([[{ path: "event", via: "relay", count: 1, p50_ms: 40, p95_ms: 40 }]]);
  expect(asked).toBe(3); // the report, then each path alone
  meter.record("event", "relay", 30);
  meter.record("status", "list", 260);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([[{ path: "event", via: "relay", count: 1, p50_ms: 40, p95_ms: 40 }], [{ path: "event", via: "relay", count: 1, p50_ms: 30, p95_ms: 30 }]]);
  expect(asked).toBe(4); // the refused path is no longer sent
  stop();
});

test("each sample is reported once: a report covers what was measured since the last one; a Cloud that keeps no telemetry is not asked again", async () => {
  vi.useFakeTimers();
  const meter = new LatencyMeter();
  const sent: LatencyReport["paths"][] = [];
  let answer: "ok" | "busy" | "none" = "ok";
  const api = {
    latency: async (report: LatencyReport) => {
      if (answer === "busy") throw new CloudError(429, "cave_rate_limited", "slow down");
      if (answer === "none") throw new CloudError(503, undefined, "no telemetry store");
      sent.push(report.paths);
    },
  };
  const stop = reportLatency(meter, api, "desktop", 60_000);
  for (const ms of [10, 20, 30]) meter.record("send", "relay", ms);
  await vi.advanceTimersByTimeAsync(60_000);
  meter.record("send", "relay", 500);
  answer = "busy"; // not taken: these wait for the next round, with what comes meanwhile
  await vi.advanceTimersByTimeAsync(60_000);
  answer = "ok";
  meter.record("send", "relay", 700);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toEqual([
    [{ path: "send", via: "relay", count: 3, p50_ms: 20, p95_ms: 30 }],
    [{ path: "send", via: "relay", count: 2, p50_ms: 500, p95_ms: 700 }],
  ]);
  expect(meter.stats()[0]?.count).toBe(5); // the overlay still shows the rolling window
  answer = "none";
  meter.record("send", "relay", 1);
  await vi.advanceTimersByTimeAsync(60_000);
  answer = "ok";
  meter.record("send", "relay", 2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sent).toHaveLength(2);
  stop();
});

test("wake hints are bounded like Cloud bounds them: one per computer per 30 s, five per device per minute", () => {
  let now = 0;
  const asked: string[] = [];
  const hints = new WakeHints({ wakeHint: async (id, reason) => void asked.push(`${id}:${reason}`) }, () => now);
  expect(hints.hint("c1", "typing")).toBe(true);
  expect(hints.hint("c1", "typing")).toBe(false);
  now += 30_000;
  expect(hints.hint("c1", "open")).toBe(true);
  for (const id of ["c2", "c3", "c4"]) expect(hints.hint(id, "open")).toBe(true);
  expect(hints.hint("c5", "open")).toBe(false); // five in this minute already
  now += 60_000;
  expect(hints.hint("c5", "open")).toBe(true);
  expect(asked).toEqual(["c1:typing", "c1:open", "c2:open", "c3:open", "c4:open", "c5:open"]);
});

test("the overlay marks what breaks a budget this device can hold alone", () => {
  expect(budgetOf("event", "direct")).toBe(50);
  expect(budgetOf("event", "loopback")).toBe(50);
  expect(budgetOf("open", "cache")).toBe(100);
  expect(budgetOf("event", "relay")).toBeNull();
});

test("the meter's snapshot keeps its identity until a sample changes it", () => {
  const meter = new LatencyMeter();
  const empty = meter.snapshot();
  expect(meter.snapshot()).toBe(empty);
  meter.record("open", "cache", 20);
  const one = meter.snapshot();
  expect(one).not.toBe(empty);
  expect(one).toHaveLength(1);
  expect(meter.snapshot()).toBe(one);
});
