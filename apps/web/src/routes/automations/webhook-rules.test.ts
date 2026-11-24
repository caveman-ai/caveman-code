// A webhook automation's filters and dedupe: as words, and as the rows its editor saves (upstream #22194, #22234, #23282).
import { describe, expect, test } from "vitest";
import { dedupeChanged, dedupeDraft, dedupeWords, emptyFilter, filterDrafts, filtersChanged, filterWords, parseDedupe, parseFilters, windowWords, type Filter } from "./webhook-rules.ts";

const stored: Filter[] = [
  { path: "headers.x-github-event", op: "equals", value: "issues" },
  { path: "body.action", op: "in", value: ["opened", "reopened"] },
  { path: "body.issue.labels[].name", op: "not_equals", value: "wontfix" },
  { path: "query.source", op: "starts_with", value: "gh" },
  { path: "body.sender", op: "exists" },
];

describe("webhook rules as words", () => {
  test("each filter as one line, each dedupe rule as a sentence", () => {
    expect(stored.map(filterWords)).toEqual([
      "headers.x-github-event equals issues",
      "body.action is one of opened, reopened",
      "body.issue.labels[].name does not equal wontfix",
      "query.source starts with gh",
      "body.sender exists",
    ]);
    expect(dedupeWords(undefined)).toEqual([]);
    expect(dedupeWords({ replay_key: "{{headers.x-github-delivery}}", coalesce_key: "{{body.issue.number}}" })).toEqual([
      "Skips a request whose {{headers.x-github-delivery}} it saw in the last 7 days",
      "Runs once for requests with the same {{body.issue.number}} within 2 minutes, on the latest",
    ]);
    expect([10, 60, 90, 300, 3600, 7200].map(windowWords)).toEqual(["10 seconds", "1 minute", "90 seconds", "5 minutes", "1 hour", "2 hours"]);
  });
});

describe("the editor's rows", () => {
  test("stored filters round-trip through the rows unchanged", () => {
    const rows = filterDrafts(stored);
    expect(rows.map((r) => r.value)).toEqual(["issues", "opened, reopened", "wontfix", "gh", ""]);
    const parsed = parseFilters(rows);
    expect(parsed).toEqual({ filters: stored });
    expect(filtersChanged(rows, rows)).toBe(false);
  });

  test("a row that would not save says which and why", () => {
    const row = (path: string, op: Filter["op"], value = "") => ({ ...emptyFilter(), path, op, value });
    expect(parseFilters([row("body.action", "equals", "opened"), row("env.HOME", "exists")])).toEqual({ error: expect.stringMatching(/^Filter 2 needs a path under body, headers or query/) });
    expect(parseFilters([row("body.action", "in", " , ")])).toEqual({ error: expect.stringMatching(/at least one value/) });
    expect(parseFilters([row("body.action", "equals")])).toEqual({ error: expect.stringMatching(/and a value/) });
    expect(parseFilters(Array.from({ length: 17 }, () => row("body", "exists")))).toEqual({ error: "Use at most 16 filters." });
    // An `in` list is trimmed, and its empty entries dropped.
    expect(parseFilters([row(" body.action ", "in", "opened,  reopened ,")])).toEqual({ filters: [{ path: "body.action", op: "in", value: ["opened", "reopened"] }] });
  });

  test("a change to the rows is one: an edit, a test switched, a row added or removed", () => {
    const rows = filterDrafts(stored);
    expect(filtersChanged(rows, rows.map((r, i) => (i === 0 ? { ...r, value: "push" } : r)))).toBe(true);
    expect(filtersChanged(rows, rows.map((r, i) => (i === 0 ? { ...r, op: "starts_with" as const } : r)))).toBe(true);
    expect(filtersChanged(rows, rows.slice(1))).toBe(true);
    // An `exists` row's value field is not shown, so what it holds is no change.
    expect(filtersChanged(rows, rows.map((r, i) => (i === 4 ? { ...r, value: "x" } : r)))).toBe(false);
  });

  test("dedupe fields: empty keys turn it off, a key must read the request, the window is whole seconds 10 to 3600", () => {
    const saved = dedupeDraft({ replay_key: "{{headers.x-github-delivery}}", coalesce_key: "{{body.id}}", coalesce_window_seconds: 300 });
    expect(saved).toEqual({ replay: "{{headers.x-github-delivery}}", coalesce: "{{body.id}}", window: "300" });
    expect(parseDedupe(saved)).toEqual({ dedupe: { replay_key: "{{headers.x-github-delivery}}", coalesce_key: "{{body.id}}", coalesce_window_seconds: 300 } });
    expect(parseDedupe({ replay: "", coalesce: "", window: "" })).toEqual({ dedupe: {} });
    // A window without a key to fold by is dropped.
    expect(parseDedupe({ replay: "", coalesce: "", window: "60" })).toEqual({ dedupe: {} });
    expect(parseDedupe({ replay: "always", coalesce: "", window: "" })).toEqual({ error: expect.stringMatching(/request placeholder/) });
    expect(parseDedupe({ replay: "", coalesce: "{{env.HOME}}", window: "" })).toEqual({ error: expect.stringMatching(/request placeholder/) });
    expect(parseDedupe({ replay: "", coalesce: "{{body.id}}", window: "5" })).toEqual({ error: "The window is whole seconds from 10 to 3600." });
    expect(parseDedupe({ replay: "", coalesce: "{{body.id}}", window: "12.5" })).toEqual({ error: "The window is whole seconds from 10 to 3600." });
    expect(dedupeChanged(saved, saved)).toBe(false);
    expect(dedupeChanged(saved, { ...saved, replay: " {{headers.x-github-delivery}} " })).toBe(false);
    expect(dedupeChanged(saved, { ...saved, replay: "" })).toBe(true);
  });
});
