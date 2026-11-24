import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { cacheExpiry } from "./cache-expiry.ts";
import { SessionModel } from "./transcript.ts";

const at = "2026-10-20T12:00:00.000Z";
const now = Date.parse(at);
const report = (model = "claude-sonnet-4-6") => ({ model, at });
const event = (cursor: number, type: SessionEvent["type"], payload: unknown, extra = {}): SessionEvent =>
  ({ session_id: "s", cursor, at, type, payload, ...extra }) as SessionEvent;
const usage = (over = {}) => ({ model: "claude-sonnet-4-6", input_tokens: 20, output_tokens: 10, cache_read_tokens: 100, cache_write_tokens: 0, cost: null, ...over });

describe("default-retention estimates (not provider guarantees)", () => {
  test.each([
    [0, "~5m remaining"], [30_000, "~4m 30s remaining"], [299_001, "~1s remaining"],
    [300_000, "Likely expired"], [86_400_000, "Likely expired"],
  ])("Claude at age %i", (age, label) => {
    expect(cacheExpiry(report("anthropic/claude-opus-4-6"), now + age).label).toBe(label);
  });
  test.each([
    [0, "~5m–10m remaining"], [300_000, "May expire within ~5m"],
    [599_999, "May expire within ~1s"], [600_000, "Likely expired"],
  ])("OpenAI at age %i", (age, label) => {
    expect(cacheExpiry(report("openai/gpt-5.4"), now + age).label).toBe(label);
  });
  test.each(["o1", "o3-mini", "o4-mini", "gpt-5.4"])("recognizes %s", (model) => {
    expect(cacheExpiry(report(model), now).label).toBe("~5m–10m remaining");
  });
  test.each([null, undefined])("no report: %s", (r) => expect(cacheExpiry(r, now).label).toBe("No cache reported"));
  test.each(["unknown", "gemini-3", "my-gpt-proxy", "openrouter/claude-opus-4-6"])("does not guess %s", (model) => {
    expect(cacheExpiry(report(model), now).label).toBe("Expiry unavailable");
  });
  test("rejects invalid timestamps and clock skew", () => {
    expect(cacheExpiry({ ...report(), at: "bad" }, now).label).toBe("Expiry unavailable");
    expect(cacheExpiry(report(), now - 1).label).toBe("Expiry unavailable");
    expect(cacheExpiry(report(), NaN).label).toBe("Expiry unavailable");
  });
  test("every countdown second agrees with an independent deadline calculation", () => {
    for (let seconds = 0; seconds < 300; seconds++) {
      const label = cacheExpiry(report(), now + seconds * 1000).label;
      const parts = /^~(?:(\d+)m)?(?: ?(\d+)s)? remaining$/.exec(label)!;
      expect(Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)).toBe(300 - seconds);
    }
  });
});

describe("real transcript event folding", () => {
  test("reads and writes refresh from event time, never from replay/open time; duplicates cannot refresh", () => {
    const m = new SessionModel();
    m.apply(event(1, "usage", usage()));
    expect(m.cacheReport).toEqual(report());
    expect(cacheExpiry(m.cacheReport, now + 600_000).label).toBe("Likely expired");
    const later = new Date(now + 60_000).toISOString();
    m.apply(event(2, "usage", usage({ cache_read_tokens: 0, cache_write_tokens: 100 }), { at: later }));
    expect(cacheExpiry(m.cacheReport, now + 60_000).label).toBe("~5m remaining");
    m.apply(event(2, "usage", usage(), { at: new Date(now + 120_000).toISOString() }));
    expect(m.cacheReport?.at).toBe(later);
    m.apply(event(3, "context.updated", { used_tokens: 5000, window_tokens: 200_000 }));
    expect(m.cacheReport?.at).toBe(later);
    expect(m.snapshot().items).toEqual([]);
  });
  test("zero cached tokens clear the previous report", () => {
    const m = new SessionModel();
    m.apply(event(1, "usage", usage()));
    m.apply(event(2, "usage", usage({ cache_read_tokens: 0 })));
    expect(m.cacheReport).toBeNull();
  });
  test.each([
    ["session.restored", { at: 0 }], ["compaction.started", {}], ["compaction.done", { status: "completed" }],
    ["turn.started", { engine: "codex", model: "gpt-5.4" }], ["model.routed", { model: "gpt-5.4" }],
  ] as const)("%s invalidates an old prefix", (type, payload) => {
    const m = new SessionModel();
    m.apply(event(1, "usage", usage()));
    m.apply(event(2, type, payload));
    expect(m.cacheReport).toBeNull();
  });
  test("a subagent's usage or route does not replace the main context's report", () => {
    const m = new SessionModel();
    m.apply(event(1, "usage", usage()));
    m.apply(event(2, "usage", usage({ model: "gpt-5.4" }), { parent_item_id: "subagent" }));
    m.apply(event(3, "model.routed", { model: "gpt-5.4" }, { parent_item_id: "subagent" }));
    expect(m.cacheReport).toEqual(report());
  });
});
