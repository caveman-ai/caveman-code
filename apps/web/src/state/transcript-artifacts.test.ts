import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { diffPreview, docSummary, fromMarkdown, mergeFiles, turnEdits } from "./transcript-artifacts.ts";
import { SessionModel } from "./transcript.ts";

let cursor = 0;
const at = "2026-10-15T08:00:00.000Z";
const ev = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ session_id: "s1", cursor: ++cursor, at, type, payload, ...extra }) as SessionEvent;

const md = [
  "Here is the fix:", // 1
  "", // 2
  '```go title="retry.go"', // 3
  "func Next() {}", // 4
  "```", // 5
  "", // 6
  "| Attempt | Wait |", // 7
  "|---|---:|", // 8
  "| 1 | 30s |", // 9
  "| 2 | 1m |", // 10
  "", // 11
  "![load test](https://example.com/load.png) and https://github.com/acme/api/pull/12 (again: https://github.com/acme/api/pull/12)", // 12
  "  ~~~", // 13: an indented, unclosed fence runs to the end
  "  | not | a table |",
  "  |---|---|",
].join("\n");

test("markdown: fenced code (by line), GFM tables, images, PR links once; nothing inside a fence", () => {
  const found = fromMarkdown("a1", md);
  expect(found.map((a) => [a.kind, a.id, a.title, a.meta])).toEqual([
    ["code", "a1:code:3", "retry.go", "1 line"],
    ["table", "a1:table:7", "Table: Attempt, Wait", "2 columns, 2 rows"],
    ["image", "a1:image:12:0", "load test", "Image"],
    ["pr", "a1:pr:acme/api#12", "Pull request #12", "acme/api"],
    ["code", "a1:code:13", "Code", "2 lines"],
  ]);
  const table = found[1]!;
  expect(table.kind === "table" && table.rows).toEqual([["1", "30s"], ["2", "1m"]]);
  const last = found[4]!;
  expect(last.kind === "code" && last.code).toBe("| not | a table |\n|---|---|");
});

test("tools: edits carry a mini diff, writes are creates, commands keep output, screenshots are images", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const e of [
    ev("tool.started", { name: "Edit", title: "webhook/retry.go", kind: "edit", input: { file_path: "/w/webhook/retry.go", old_string: "a\nb", new_string: "c" } }, { item_id: "t1" }),
    ev("tool.done", { status: "completed", result: { additions: 1, deletions: 2 } }, { item_id: "t1" }),
    ev("tool.started", { name: "Write", title: "docs/notes.md", kind: "edit", input: { file_path: "docs/notes.md", content: "# Notes\nhi\n" } }, { item_id: "t2" }),
    ev("tool.done", { status: "completed" }, { item_id: "t2" }),
    ev("tool.started", { name: "bash", title: "go test ./...", kind: "command", input: {} }, { item_id: "t3" }),
    ev("tool.output", { text: "ok\n41 passed\n" }, { item_id: "t3" }),
    ev("tool.done", { status: "completed" }, { item_id: "t3" }),
    ev("tool.started", { name: "screenshot", title: "localhost:4101", kind: "browser", input: {} }, { item_id: "t4" }),
    ev("tool.done", { status: "completed", result: { image: { mime_type: "image/png", data: "AAAA" } } }, { item_id: "t4" }),
    ev("plan.updated", { kind: "todos", steps: [{ text: "Jitter", status: "pending" }] }, { item_id: "p1" }),
    ev("context.updated", { used_tokens: 26_000, window_tokens: 200_000 }),
  ])
    m.apply(e);
  const v = m.snapshot();
  expect(v.context).toEqual({ used: 26_000, window: 200_000 });
  expect(v.items.map((i) => i.kind)).toEqual(["tool", "tool", "tool", "tool", "plan"]);
  const write = v.items[1]!;
  expect(write.kind === "tool" && [write.verb, write.icon]).toEqual(["Created", "create"]);
  expect(v.artifacts.map((a) => [a.kind, a.title, a.meta])).toEqual([
    ["file", "retry.go", "+1 −2"],
    ["file", "notes.md", "Created, 2 lines"],
    ["terminal", "go test ./...", "Output, 2 lines"],
    ["browser", "localhost:4101", "Screenshot"],
  ]);
  const edit = v.artifacts[0]!;
  expect(edit.kind === "file" && edit.diff).toBe("-a\n-b\n+c");
  expect(diffPreview("@@\n x\n-a\n+b\n+c\n-d\n+e", 4)).toEqual(["-a", "+b", "+c", "-d"]);
  const shot = v.artifacts[3]!;
  expect(shot.kind === "browser" && shot.src).toBe("data:image/png;base64,AAAA");
  // Unchanged snapshot -> the same artifact array (the side panel doesn't re-render).
  m.apply(ev("usage", { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: null }));
  expect(m.snapshot().artifacts).toBe(v.artifacts);
});

test("html_render: a finished page is a page artifact; a running, failed or imitated one is not", () => {
  cursor = 0;
  const m = new SessionModel();
  // As a real Claude Agent turn journals it (the tool's MCP name, its result the runtime's page reference).
  const page = { attachmentId: "caveman-d4f4d5c1-91ed-4b56-9ac5-af0363294e52-3220b046-bb3d-4d78-ba76-430474aba72a-html", title: "Model picker foot", height: 750, heights: [[320, 797], [728, 745], [1144, 710]] };
  for (const e of [
    ev("tool.started", { name: "mcp__t3-code__html_render", title: "mcp__t3-code__html_render", kind: "mcp", input: { title: "Model picker foot", height: 750, html: "<!doctype html><p>x</p>" } }, { item_id: "h1" }),
    ev("tool.done", { status: "completed", result: { htmlRender: page } }, { item_id: "h1" }),
    ev("tool.started", { name: "mcp__t3-code__html_render", title: "mcp__t3-code__html_render", kind: "mcp", input: {} }, { item_id: "h2" }),
    ev("tool.done", { status: "failed", result: { htmlRender: page } }, { item_id: "h2" }),
    ev("tool.started", { name: "mcp__other__lookalike", title: "lookalike", kind: "mcp", input: {} }, { item_id: "h3" }),
    ev("tool.done", { status: "completed", result: { htmlRender: page } }, { item_id: "h3" }),
    ev("tool.started", { name: "mcp__t3-code__html_render", title: "mcp__t3-code__html_render", kind: "mcp", input: {} }, { item_id: "h4" }),
  ])
    m.apply(e);
  const pages = m.snapshot().artifacts.filter((a) => a.kind === "page");
  expect(pages.map((a) => [a.id, a.title, a.meta])).toEqual([["h1:page", "Model picker foot", "Page"]]);
  expect(pages[0]!.kind === "page" && pages[0]!.page).toEqual({ ...page, heights: [[320, 797], [728, 745], [1144, 710]] });
});

test("mergeFiles: one entry per path (counts summed, at the last place) and per PR URL", () => {
  const file = (id: string, path: string, change: "edited" | "created", added: number, removed: number) =>
    ({ kind: "file", id, itemId: id, title: path, meta: "", path, change, added, removed, diff: `+${id}`, status: "done" }) as const;
  const pr = (id: string) => ({ kind: "pr", id, itemId: id, title: "PR", meta: "", url: "https://github.com/a/b/pull/1", repo: "a/b", number: 1 }) as const;
  const merged = mergeFiles([file("t1", "b.go", "created", 30, 0), pr("p1"), file("t2", "a.go", "edited", 2, 1), file("t3", "b.go", "edited", 3, 1), pr("p2")]);
  expect(merged.map((a) => [a.id, a.meta])).toEqual([
    ["t2", ""],
    ["t3", "Created, +33 −1"],
    ["p2", ""],
  ]);
  const b = merged[1]!;
  expect(b.kind === "file" && [b.change, b.diff]).toEqual(["created", "+t1\n@@\n+t3"]);
});

test("mergeFiles: edits no call counted stay Edited, never +0 −0", () => {
  const file = (id: string, change: "edited" | "created", added: number | null, removed: number | null) =>
    ({ kind: "file", id, itemId: id, title: "a.ts", meta: "", path: "a.ts", change, added, removed, diff: null, status: "done" }) as const;
  expect(mergeFiles([file("t1", "edited", null, null), file("t2", "edited", null, null)]).map((a) => a.meta)).toEqual(["Edited"]);
  expect(mergeFiles([file("t1", "created", null, null), file("t2", "edited", null, null)]).map((a) => a.meta)).toEqual(["Created"]);
  // One counted call is enough to count: the others add nothing they didn't report.
  expect(mergeFiles([file("t1", "edited", null, null), file("t2", "edited", 4, 1)]).map((a) => a.meta)).toEqual(["+4 −1"]);
});

test("turnEdits: each turn's own edits, its subagents' included, merged per file and ending at its turn_end", () => {
  const file = (itemId: string, path: string, added: number | null) =>
    ({ kind: "file", id: `${itemId}:file`, itemId, title: path, meta: "", path, change: "edited", added, removed: added === null ? null : 0, diff: null, status: "done" }) as const;
  const items = [
    { kind: "user", id: "u1" },
    { kind: "tool", id: "t1" },
    { kind: "subagent", id: "s1", items: [{ kind: "tool", id: "t2" }] },
    { kind: "tool", id: "t3" },
    { kind: "turn_end", id: "e1" },
    { kind: "user", id: "u2" },
    { kind: "turn_end", id: "e2" },
    { kind: "tool", id: "t4" },
    { kind: "turn_end", id: "e3" },
  ] as never;
  const artifacts = [file("t1", "/elsewhere/a.ts", 2), file("t2", "b.ts", null), file("t3", "/elsewhere/a.ts", 3), file("t4", "c.ts", 1)];
  const turns = turnEdits(items, artifacts);
  expect([...turns.keys()]).toEqual(["e1", "e3"]);
  expect(turns.get("e1")!.map((a) => [a.path, a.added])).toEqual([["b.ts", null], ["/elsewhere/a.ts", 5]]);
  expect(turns.get("e3")!.map((a) => a.path)).toEqual(["c.ts"]);
  // A later turn streaming (new item lists, the same finished turns): each finished turn keeps its very list, so its
 // row's `edited` prop is the same and the row skips its render (upstream #27420).
  const streaming = [...(items as unknown as Array<{ kind: string; id: string }>), { kind: "assistant", id: "a4", text: "wor" }] as never;
  const again = turnEdits(streaming, [...artifacts]);
  expect(again.get("e1")).toBe(turns.get("e1"));
  expect(again.get("e3")).toBe(turns.get("e3"));
  // A turn's own files changing makes a new list.
  expect(turnEdits(items, [...artifacts.slice(0, 3), file("t4", "d.ts", 1)]).get("e3")!.map((a) => a.path)).toEqual(["d.ts"]);
});

test("a patch over several files: one file artifact per file it left, in its order, each with its own id; a turn's card lists them all", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "codex" }, { turn_id: "t1" }));
  const files = [
    { path: "/w/d.ts", old_path: "/w/c.ts", status: "renamed" },
    { path: "/w/e.ts", status: "deleted" },
    { path: "/w/a.ts", status: "added" },
    { path: "/w/b.ts", status: "modified" },
  ];
  m.apply(ev("tool.started", { name: "edit", title: "/w/c.ts", kind: "edit", input: { path: "/w/c.ts" }, files }, { item_id: "patch", turn_id: "t1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "patch", turn_id: "t1" }));
  m.apply(ev("turn.done", { status: "completed" }, { item_id: "end", turn_id: "t1" }));
  const view = m.snapshot();
  const found = view.artifacts.filter((a) => a.kind === "file");
  // The deleted file (index 1) has nothing to open; the others keep their place in the patch, the first the one-file id.
  expect(found.map((a) => [a.id, a.title, a.kind === "file" && a.change, a.meta])).toEqual([
    ["patch:file", "d.ts", "edited", "Moved from c.ts"],
    ["patch:file:2", "a.ts", "created", "Created"],
    ["patch:file:3", "b.ts", "edited", "Edited"],
  ]);
  expect(found.every((a) => a.kind === "file" && a.added === null && a.removed === null && a.diff === null)).toBe(true);
  const end = view.items.find((i) => i.kind === "turn_end")!;
  expect(turnEdits(view.items, view.artifacts).get(end.id)!.map((a) => a.path)).toEqual(["/w/d.ts", "/w/a.ts", "/w/b.ts"]);
});

test("an attached image draws from its bytes, a large one from its store id; one that came with neither (an older journal) draws no card", () => {
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t9" }));
  m.apply(
    ev(
      "message.done",
      {
        role: "user",
        text: "look",
        attachments: [
          { type: "image", name: "dot.png", mime_type: "image/png", data: "iVBORw0KGgo=" },
          { type: "image", name: "huge.png", mime_type: "image/png", data: "", id: "caveman-t-1-png" },
          { type: "image", name: "old.png", mime_type: "image/png", data: "" },
          { type: "file", name: "notes.md", mime_type: "text/markdown", data: "" },
        ],
      },
      { turn_id: "t9", item_id: "u9" },
    ),
  );
  expect(m.snapshot().artifacts.map((a) => [a.kind, a.title, a.kind === "image" ? a.src : ""])).toEqual([
    ["image", "dot.png", "data:image/png;base64,iVBORw0KGgo="],
    ["image", "huge.png", "caveman-attachment:caveman-t-1-png"],
  ]);
});

test("proof: a path with spaces is an image; tools' image blocks and a builder's result are screenshots too", () => {
  cursor = 0;
  const m = new SessionModel();
  const shot = "/Users/me/Library/Application Support/Caveman Code (Dev)/after.png";
  for (const e of [
    ev("tool.started", { name: "browser_take_screenshot", title: "playwright", kind: "mcp", input: {} }, { item_id: "t1" }),
    ev("tool.done", { status: "completed", result: { content: [{ type: "text", text: "saved" }, { type: "image", data: "BBBB", mimeType: "image/png" }, { type: "image", data: "<svg/>", mimeType: "image/svg+xml" }] } }, { item_id: "t1" }),
    ev("tool.started", { name: "Read", title: "shot.png", kind: "read", input: {} }, { item_id: "t2" }),
    ev("tool.done", { status: "completed", result: [{ type: "image", source: { type: "base64", media_type: "image/JPEG", data: "CCCC" } }] }, { item_id: "t2" }),
    ev("subagent.started", { title: "Settings page", workspace_id: "w2", agent: "codex" }, { item_id: "b1" }),
    ev("subagent.done", { status: "completed", summary: "Done.\n\n![Settings, dark](/tmp/settings-dark.png)" }, { item_id: "b1" }),
    ev("message.done", { role: "assistant", text: `Fixed it.\n\n![After the fix](${shot})\n\n\`![not](/a b.png)\`` }, { item_id: "a1" }),
  ])
    m.apply(e);
  const v = m.snapshot();
  expect(v.artifacts.map((a) => [a.kind, a.id, a.kind === "image" || a.kind === "browser" ? a.src : null])).toEqual([
    ["image", "t1:image:0", "data:image/png;base64,BBBB"],
    ["image", "t2:image:0", "data:image/jpeg;base64,CCCC"],
    ["image", "b1:image:3:0", "/tmp/settings-dark.png"],
    ["image", "a1:image:3:0", shot],
  ]);
  // A builder's item is a new object every snapshot; its images are not.
  m.apply(ev("usage", { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: null }));
  expect(m.snapshot().artifacts).toBe(v.artifacts);
});

test("docSummary: the title and opening words of a spec", () => {
  const spec = [
    "---",
    "status: draft",
    "---",
    "# One session, any computer: local, Cloud and device handoff",
    "",
    "Status: **research** and design draft, 2026-10-17. See [WHY](README.md) and `README.md`.",
    "Not authority.",
    "",
    "## The answer",
    "More.",
  ].join("\n");
  expect(docSummary(spec)).toEqual({
    title: "One session, any computer: local, Cloud and device handoff",
    excerpt: "Status: research and design draft, 2026-10-17. See WHY and README.md. Not authority.",
  });
  expect(docSummary("---\ntitle: 'Grill decisions'\n---\n\n| a | b |\n|---|---|\n\n- item\n\nBody text here.")).toEqual({ title: "Grill decisions", excerpt: "Body text here." });
  expect(docSummary("```md\n# not a heading\n```\n\nPlain intro.")).toEqual({ title: null, excerpt: "Plain intro." });
  expect(docSummary("Setext title\n===\n\nIntro.")).toEqual({ title: "Setext title", excerpt: "Intro." });
  expect(docSummary("")).toEqual({ title: null, excerpt: null });
});

test("docSummary: a doc's fenced example holding another fence never lends its code to the card", () => {
  const example = ["````md", "```bash", "# install deps", "npm i", "```", "````", "", "# Setup guide", "", "How to set up."].join("\n");
  expect(docSummary(`---\nstatus: draft\n---\n${example}`)).toEqual({ title: "Setup guide", excerpt: "How to set up." });
  // An opener with an info string never closes a fence; a bare closer at least as long does.
  expect(docSummary(["```md", "```bash", "# install deps", "```", "", "Plain intro."].join("\n"))).toEqual({ title: null, excerpt: "Plain intro." });
  expect(docSummary(["````", "# in the example", "```", "still code", "````", "", "Plain intro."].join("\n"))).toEqual({ title: null, excerpt: "Plain intro." });
});
