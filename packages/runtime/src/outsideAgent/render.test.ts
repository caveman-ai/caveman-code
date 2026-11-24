// Names and levels, the plain text an outside agent reads (the question card, the digest, the transcript page, the
// chat list), the image items a page holds, and chat_wait's once-only memory.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import { NOW, engine, minutesAgo, workspace } from "./fixtures.testkit.ts";
import { accessFor, agentName, canStartOn, defaultEngineFor, findEngine, isCodexClient } from "./names.ts";
import { askCard, askHandle, askMatches, chatList, digestText, eventLines, imageRefs, transcriptPage, type QuestionCard } from "./render.ts";
import { Tracker } from "./wait.ts";

describe("names and levels", () => {
  it("maps MCP clients to how people say them, and --name wins", () => {
    expect(agentName(undefined, "claude-code")).toBe("Claude Code");
    expect(agentName(undefined, "codex-mcp-client")).toBe("Codex");
    expect(agentName(undefined, "grok-build")).toBe("Grok");
 // bot local exec daemon is the client that runs its stdio servers.
    expect(agentName(undefined, "sand-local-exec-daemon")).toBe("Grok Bot");
    expect(agentName(undefined, "grok-bot")).toBe("Grok Bot");
    expect(agentName(undefined, "cursor-vscode")).toBe("Cursor");
    expect(agentName(undefined, "opencode")).toBe("OpenCode");
    expect(agentName(undefined, "goose")).toBe("Goose");
    expect(agentName(undefined, "my-bot")).toBe("my-bot");
    expect(agentName(undefined, undefined)).toBe("Outside agent");
    expect(agentName("  Nightly bot ", "claude-code")).toBe("Nightly bot");
    expect(isCodexClient("codex-mcp-client")).toBe(true);
    expect(isCodexClient("claude-code")).toBe(false);
  });

  it("resolves a left-out access to the agent's level and refuses an explicit one above it", () => {
    expect(accessFor("supervised", "Grok", undefined)).toEqual({ ok: true, access: "ask" });
    expect(accessFor("supervised", "Grok", "ask")).toEqual({ ok: true, access: "ask" });
    expect(accessFor("supervised", "Grok", "auto").ok).toBe(false);
    expect(accessFor("full", "Grok", undefined)).toEqual({ ok: true, access: undefined });
    expect(accessFor("full", "Grok", "review")).toEqual({ ok: true, access: "review" });
    const read = accessFor("read", "Grok", undefined);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.text).toContain("raise Grok in Caveman Code > Settings > Caveman MCP");
  });

  it("starts on the default engine when it honours the level, else the first that does", () => {
    const grok = engine({ id: "grok", label: "Grok", access_modes: ["full"] });
    const codex = engine({ id: "codex", label: "Codex" });
    const off = engine({ id: "cursor", label: "Cursor", auth: { state: "signed_out", accounts: [] } });
    expect(canStartOn(grok, "supervised")).toBe(false);
    expect(canStartOn(grok, "full")).toBe(true);
    expect(canStartOn(off, "full")).toBe(false);
    expect(defaultEngineFor([off, grok, codex], "supervised", "grok")?.id).toBe("codex");
    expect(defaultEngineFor([off, grok, codex], "full", "grok")?.id).toBe("grok");
    expect(findEngine([grok, codex], "CODEX")?.id).toBe("codex");
    expect(findEngine([grok, codex], "gro")?.id).toBe("grok");
    expect(findEngine([grok, codex], "gemini")).toBeUndefined();
  });
});

const card: QuestionCard = {
  kind: "question",
  questions: [
    {
      id: "q1",
      prompt: "Which store?",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "sqlite", label: "SQLite" },
      ],
      recommended: "pg",
      multi_select: false,
      allow_text: true,
    },
  ],
};

describe("text", () => {
  it("shows a question card in full on one line", () => {
    expect(askCard("a1", card)).toEqual(['ask a1 · q1 "Which store?" [pg] Postgres (recommended) [sqlite] SQLite · one pick, words ok']);
  });

  it("writes the digest with what it waits on and a Next call", () => {
    const w = workspace({ id: "d", title: "Deploy", status: "needs_input", head: 41, root_path: "/wt/d", started_by: { agent: "Grok" } });
    const text = digestText(
      { workspace: w, messages: 3, queued: 1, goal: "Deploy it", latest: "x".repeat(10), latest_clipped: true, ask: { ask_id: "a2", ask: { kind: "approval", title: "pnpm i", options: [] } } },
      { labels: { projects: [], engines: [] }, now: NOW },
    );
    expect(text).toContain("started by Grok");
    expect(text).toContain("1 message queued");
    expect(text).toContain("Waits on: the person in Caveman Code: approve `pnpm i`");
    expect(text).toContain('(cut at 2,000 characters; the rest: chat_read {"chat":"d","view":"transcript"})');
    expect(text).toContain("Worktree: /wt/d");
    expect(text).toContain("Head cursor: 41");
    expect(text).toMatch(/Next: Tell your user: "Deploy waits for you in Caveman Code"/);
  });

  it("says a Caveman chat that ended on a question asked in its answer", () => {
    const w = workspace({ id: "c", engine: "caveman", status: "idle" });
    const text = digestText({ workspace: w, messages: 2, queued: 0, latest: "Should I also migrate the old rows?" }, { labels: { projects: [], engines: [] }, now: NOW });
    expect(text).toContain("Waits on: it asked in its answer; reply with chat_send");
    expect(text).toContain('Next: chat_send {"chat":"c","text":"…"}');
  });

  it("drops usage from a transcript page and keeps the newest that fit", () => {
    const event = (cursor: number, type: string, payload: unknown) => ({ session_id: "s", cursor, at: minutesAgo(1), type, payload }) as unknown as SessionEvent;
    expect(eventLines(event(1, "usage", { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: null }), "c")).toEqual([]);
    expect(eventLines(event(1, "context.updated", { used_tokens: 1, window_tokens: 2 }), "c")).toEqual([]);
    const events = [1, 2, 3, 4].map((i) => event(i, "message.done", { role: "assistant", text: `answer ${i} ${"y".repeat(40)}` }));
    const page = transcriptPage(events, 1, false, { chatId: "c", maxBytes: 120 });
    expect(page.text).not.toContain("answer 1");
    expect(page.text).toContain("answer 4");
    expect(page.from).toBe(3);
    expect(page.more).toBe(true);
    expect(transcriptPage(events, 1, false, { chatId: "c" })).toMatchObject({ from: 1, more: false });
  });

  it("folds builders under their lead", () => {
    const lines = chatList(
      [workspace({ id: "lead", title: "Lead", status: "working" }), workspace({ id: "b", title: "Builder", parent_workspace_id: "lead" }), workspace({ id: "solo", title: "Solo" })],
      { projects: [], engines: [] },
      NOW,
    );
    expect(lines[0]).toMatch(/^\[lead\] Lead/);
    expect(lines[1]).toMatch(/^ {2}↳ \[b\] Builder/);
    expect(lines[2]).toMatch(/^\[solo\] Solo/);
  });

  it("finds a page's image items, never a path written in an answer", () => {
    const event = (cursor: number, type: string, payload: unknown, item_id?: string) => ({ session_id: "s", cursor, at: AT, type, payload, ...(item_id ? { item_id } : {}) }) as unknown as SessionEvent;
    const AT = minutesAgo(1);
    const refs = imageRefs([
      event(1, "tool.started", { name: "view_image", title: "View", kind: "read", input: { path: "/w/a.png" } }, "v"),
      event(2, "tool.done", { status: "completed", result: { saved_path: "/w/gen.webp" } }, "g"),
      event(3, "message.done", { role: "assistant", text: "![x](/w/answer.png)" }),
      event(4, "tool.done", { status: "completed", result: { content: [{ type: "image", data: "QUJD", mimeType: "image/svg+xml" }] } }),
    ]);
    expect(refs.map((r) => (r.kind === "path" ? r.path : r.kind === "inline" ? r.mime : r.kind))).toEqual(["/w/gen.webp", "/w/a.png"]);
  });

  it("names an image whose bytes the page doesn't carry whole as withheld: kept by name only, or cut", () => {
    const event = (cursor: number, type: string, payload: unknown) => ({ session_id: "s", cursor, at: minutesAgo(1), type, payload }) as unknown as SessionEvent;
    const cut = `iVBORw0KGgo${"A".repeat(40)}… (90000 more characters)`;
    const refs = imageRefs([
      event(1, "message.done", { role: "user", text: "", attachments: [{ type: "image", name: "photo.png", mime_type: "image/png", data: "" }, { type: "file", name: "notes.md", mime_type: "text/markdown", data: "" }] }),
      event(2, "message.done", { role: "user", text: "", attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data: cut }] }),
      event(3, "tool.done", { status: "completed", result: { content: [{ type: "image", imageUrl: `data:image/png;base64,${cut}` }] } }),
      event(4, "message.done", { role: "user", text: "", attachments: [{ type: "image", name: "dot.png", mime_type: "image/png", data: "iVBORw0K\nGgo=" }] }),
    ]);
    expect(refs.map((r) => `${r.kind} ${r.label}`)).toEqual(["inline dot.png", "withheld Screenshot", "withheld shot.png", "withheld photo.png"]);
  });
});

describe("ask handles", () => {
  it("names an engine's long request id by a short handle, and takes either back", () => {
    const long = "runtime-request:provider:claudeAgent:provider-turn:" + "x".repeat(300);
    const handle = askHandle(long);
    expect(handle).toMatch(/^a[0-9a-f]{7}$/);
    expect(askMatches(handle, long)).toBe(true);
    expect(askMatches(long, long)).toBe(true);
    expect(askMatches("a0000000", long)).toBe(false);
    expect(askHandle("a1")).toBe("a1");
    const card = { kind: "question" as const, questions: [{ id: "q1", prompt: "Which?", options: [{ id: "red", label: "red" }], multi_select: false, allow_text: true }] };
    expect(askCard(long, card).join("\n")).not.toContain("runtime-request");
  });
});

describe("chat_wait's memory", () => {
  it("reports each change once, and nothing a process already acted on", async () => {
    const tracker = new Tracker();
    const ids = new Set(["a"]);
    tracker.observe(workspace({ id: "a", status: "working" }));
    expect(tracker.take(ids)).toEqual([]);
    tracker.observe(workspace({ id: "a", status: "idle", updated_at: minutesAgo(1) }));
    tracker.observe(workspace({ id: "a", status: "idle", title: "renamed", updated_at: minutesAgo(0) }));
    expect(tracker.take(ids)).toEqual([{ kind: "finished", chatId: "a" }]);
    expect(tracker.take(ids)).toEqual([]);
    // Messaged: a view from before the message isn't news; the turn it started finishing is.
    tracker.acted("a", "messaged");
    tracker.observe(workspace({ id: "a", status: "idle", updated_at: minutesAgo(0) }));
    expect(tracker.take(ids)).toEqual([]);
    tracker.observe(workspace({ id: "a", status: "idle", updated_at: new Date(NOW + 60_000).toISOString() }));
    expect(tracker.take(ids)).toEqual([{ kind: "finished", chatId: "a" }]);
    expect(tracker.touched.has("a")).toBe(true);
  });

  it("never calls its own answer the person's, and reports a pull request once", () => {
    const tracker = new Tracker();
    const ids = new Set(["q"]);
    tracker.observe(workspace({ id: "q", status: "needs_input", activity: { ask: { kind: "question", prompt: "Which?" } } }));
    expect(tracker.take(ids)).toEqual([{ kind: "asking", chatId: "q" }]);
    tracker.acted("q", "answered");
    tracker.observe(workspace({ id: "q", status: "working", updated_at: new Date(NOW + 1).toISOString() }));
    expect(tracker.take(ids)).toEqual([]);
    const pr = { number: 7, url: "u", state: "open" as const };
    tracker.observe(workspace({ id: "q", status: "working", pull_request: pr, updated_at: new Date(NOW + 2).toISOString() }));
    tracker.observe(workspace({ id: "q", status: "working", pull_request: pr, updated_at: new Date(NOW + 3).toISOString() }));
    expect(tracker.take(ids)).toEqual([{ kind: "pr", chatId: "q", pr: 7 }]);
  });

  it("a chat that hasn't finished a turn yet is idle, never finished", () => {
    const tracker = new Tracker();
    const ids = new Set(["n"]);
    tracker.observe(workspace({ id: "n", status: "idle", activity: {} }));
    expect(tracker.take(ids)).toEqual([]);
    tracker.observe(workspace({ id: "n", status: "working" }));
    tracker.observe(workspace({ id: "n", status: "idle", activity: { last_outcome: "completed" } }));
    expect(tracker.take(ids)).toEqual([{ kind: "finished", chatId: "n" }]);
  });

  it("keeps waiting when the next view takes a change back within the settle", async () => {
    const tracker = new Tracker();
    const ids = new Set(["s"]);
    tracker.observe(workspace({ id: "s", status: "working" }));
    const started = Date.now();
    const next = tracker.wait(ids, 300, { settleMs: 30 });
    // Asked, then moved on before the settle ended: no news, so the wait runs to its end.
    tracker.observe(workspace({ id: "s", status: "needs_input", activity: { ask: { kind: "question", prompt: "?" } } }));
    tracker.acted("s", "answered");
    expect(await next).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("waits for the next change, and a cancelled wait reports nothing", async () => {
    const tracker = new Tracker();
    const ids = new Set(["w"]);
    tracker.observe(workspace({ id: "w", status: "working" }));
    const next = tracker.wait(ids, 5_000, { settleMs: 10 });
    tracker.observe(workspace({ id: "w", status: "failed" }));
    expect(await next).toEqual([{ kind: "failed", chatId: "w" }]);
    expect(await tracker.wait(ids, 20)).toEqual([]);
    tracker.observe(workspace({ id: "w", status: "working" }));
    const abort = new AbortController();
    const cancelled = tracker.wait(ids, 5_000, { signal: abort.signal, settleMs: 50 });
    tracker.observe(workspace({ id: "w", status: "idle" }));
    abort.abort();
    expect(await cancelled).toEqual([]);
    expect(tracker.take(ids)).toEqual([{ kind: "finished", chatId: "w" }]);
  });
});
