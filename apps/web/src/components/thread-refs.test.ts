import { expect, test } from "vitest";
import type { WorkspaceView } from "../state/model.ts";
import { changeDraft, draftFromWire, EMPTY_DRAFT, matchChats, pieces, pillDeletion, pluginMention, refEdit, relink, serializeDraft, snapCaret, type Draft } from "./thread-refs.ts";

/** The textarea's own edit: [start, end) becomes `insert`, the caret lands after it. */
const type = (d: Draft, start: number, end: number, insert: string, added?: Parameters<typeof changeDraft>[3]) =>
  changeDraft(d, d.text.slice(0, start) + insert + d.text.slice(end), start + insert.length, added);
/** Pick a chat over [start, end), the way the composer does. */
const pick = (d: Draft, start: number, end: number, workspace_id: string, title: string) => {
  const e = refEdit(d.text, start, end, { workspace_id, title });
  return type(d, start, end, e.insert, e.ref);
};
const spans = (d: Draft) => d.refs.map((r) => [r.workspace_id, d.text.slice(r.start, r.end)]);

test("picking a chat types @Title and a space, and sends it as the wire link", () => {
  let d = type(EMPTY_DRAFT, 0, 0, "ask @log");
  d = pick(d, 4, 8, "ws_a", "Fix [login]\nbug");
  expect(d.text).toBe("ask @Fix login bug ");
  expect(spans(d)).toEqual([["ws_a", "@Fix login bug"]]);
  expect(serializeDraft(d)).toBe("ask [Fix login bug](t3-context://v1/thread/ws_a) ");
  // Dropped onto a word, it gets a space before it too.
  expect(refEdit("see", 3, 3, { workspace_id: "ws_b", title: "Docs" }).insert).toBe(" @Docs ");
});

test("edits before a pill shift it, edits after it leave it, typing at its edges keeps it whole", () => {
  let d = pick(EMPTY_DRAFT, 0, 0, "ws_a", "Ab");
  d = type(d, 4, 4, "then"); // right after the space
  d = type(d, 0, 0, "@"); // an "@" against the pill's own "@"
  expect(spans(d)).toEqual([["ws_a", "@Ab"]]);
  expect(d.text).toBe("@@Ab then");
  d = type(d, 4, 4, "b"); // glued to its end: "b" against the title's "b"
  expect(d.text).toBe("@@Abb then");
  expect(spans(d)).toEqual([["ws_a", "@Ab"]]);
});

test("an edit inside a pill dissolves it into plain text", () => {
  let d = pick(EMPTY_DRAFT, 0, 0, "ws_a", "Login");
  d = type(d, 3, 3, "X");
  expect(d.text).toBe("@LoXgin ");
  expect(d.refs).toEqual([]);
  expect(serializeDraft(d)).toBe("@LoXgin ");
});

test("Backspace at a pill's end removes all of it; undo brings the pill back, a paste of the same text does not", () => {
  let d = type(EMPTY_DRAFT, 0, 0, "x ");
  d = pick(d, 2, 2, "ws_a", "Login"); // "x @Login "
  const pill = d.refs[0]!;
  expect(pillDeletion(d.refs, d.text, 8, "Backspace", false)).toEqual([2, 8]);
  expect(pillDeletion(d.refs, d.text, 2, "Delete", false)).toEqual([2, 8]);
  expect(pillDeletion(d.refs, d.text, 5, "Backspace", false)).toBeUndefined();
  const removed = type(d, 2, 8, "");
  expect(removed.text).toBe("x  ");
  expect(removed.refs).toEqual([]);
  const undone = changeDraft(removed, d.text, 8, undefined, true); // the browser's undo puts the text back
  expect(spans(undone)).toEqual([["ws_a", "@Login"]]);
  expect(undone.refs[0]!.id).toBe(pill.id);
  expect(changeDraft(removed, d.text, 8).refs).toEqual([]); // the same text pasted: plain words, the thread stays removed
});

test("a word delete reaches a pill across spaces; a plain Backspace stops at the space", () => {
  const d = pick(type(EMPTY_DRAFT, 0, 0, "see "), 4, 4, "ws_a", "Fix login"); // "see @Fix login "
  expect(pillDeletion(d.refs, d.text, 15, "Backspace", true)).toEqual([4, 15]);
  expect(pillDeletion(d.refs, d.text, 15, "Backspace", false)).toBeUndefined();
  expect(pillDeletion(d.refs, d.text, 3, "Delete", true)).toEqual([3, 14]);
  expect(pillDeletion(d.refs, d.text + "x", 16, "Backspace", true)).toBeUndefined(); // a word between: native
});

test("a line or word delete that cuts into a pill marks the rest to go too; two undos bring it back", () => {
  const d = pick(type(EMPTY_DRAFT, 0, 0, "see "), 4, 4, "ws_a", "Fix login"); // pill [4, 14)
  const native = type(d, 9, 15, ""); // a word delete took "login " and left "@Fix "
  expect(native.text).toBe("see @Fix ");
  expect(native.refs).toEqual([]);
  expect(native.cut).toEqual([4, 9]);
  const cut = type(native, 4, 9, "");
  expect(cut.text).toBe("see ");
  expect(cut.cut).toBeUndefined();
  const undo1 = changeDraft(cut, native.text, 9, undefined, true);
  const undo2 = changeDraft(undo1, d.text, 15, undefined, true);
  expect(spans(undo2)).toEqual([["ws_a", "@Fix login"]]);
  // A delete that takes a whole pill leaves nothing to cut.
  expect(type(d, 0, 15, "").cut).toBeUndefined();
});

test("duplicate titles stay apart: tracked by position, sent in order", () => {
  let d = pick(EMPTY_DRAFT, 0, 0, "ws_a", "Tests");
  d = pick(d, d.text.length, d.text.length, "ws_b", "Tests");
  expect(spans(d)).toEqual([["ws_a", "@Tests"], ["ws_b", "@Tests"]]);
  d = type(d, d.refs[0]!.start, d.refs[0]!.end, ""); // remove the first
  expect(spans(d)).toEqual([["ws_b", "@Tests"]]);
  expect(serializeDraft(d)).toBe(" [Tests](t3-context://v1/thread/ws_b) ");
});

test("titles are cut at 200 without splitting an emoji, and edited @Title text gets its links back", () => {
  const e = refEdit("", 0, 0, { workspace_id: "ws_a", title: `${"a".repeat(199)}😀 tail` });
  expect(e.ref.title).toBe("a".repeat(199));
  const refs = [
    { workspace_id: "ws_a", title: "Auth" },
    { workspace_id: "ws_b", title: "Auth" },
    { workspace_id: "ws_c", title: "Gone" },
  ];
  expect(relink("now @Auth, then @Auth", refs)).toBe("now [Auth](t3-context://v1/thread/ws_a), then [Auth](t3-context://v1/thread/ws_b)");
});

test("the caret never rests inside a pill", () => {
  const d = pick(EMPTY_DRAFT, 0, 0, "ws_a", "Longer title"); // [0, 13)
  expect(snapCaret(d.refs, 1, 0)).toBe(13); // arrow right into it: past it
  expect(snapCaret(d.refs, 12, 13)).toBe(0); // arrow left into it: before it
  expect(snapCaret(d.refs, 3, null)).toBe(0); // a click: the nearer edge
  expect(snapCaret(d.refs, 10, null)).toBe(13);
  expect(snapCaret(d.refs, 13, 1)).toBe(13); // at an edge: stays
});

test("sent text reads back into the same references", () => {
  let d = type(EMPTY_DRAFT, 0, 0, "compare ");
  d = pick(d, 8, 8, "ws_a", "Auth");
  d = type(d, d.text.length, d.text.length, "and ");
  d = pick(d, d.text.length, d.text.length, "ws_b", "Auth");
  const back = draftFromWire(serializeDraft(d));
  expect(back.text).toBe(d.text);
  expect(spans(back)).toEqual(spans(d));
  expect(pieces(back.text, back.refs).map((p) => (typeof p === "string" ? p : p.workspace_id))).toEqual(["compare ", "ws_a", " and ", "ws_b", " "]);
});

test("Chats: titles holding the query, this project first, then most recent; never this thread or archived ones", () => {
  const w = (id: string, title: string, projectId: string | null, updatedAt: string, state: WorkspaceView["state"] = "completed") => ({ id, title, projectId, updatedAt, state }) as WorkspaceView;
  const all = [
    w("a", "Fix auth", "p2", "2026-10-15T09:00:00Z"),
    w("b", "Auth tests", "p1", "2026-10-14T09:00:00Z"),
    w("c", "Old auth", "p1", "2026-10-15T08:00:00Z", "archived"),
    w("d", "auth here", "p1", "2026-10-15T10:00:00Z"),
    w("e", "Docs", "p1", "2026-10-15T11:00:00Z"),
  ];
  expect(matchChats(all, "AUTH", "d", "p1").map((x) => x.id)).toEqual(["b", "a"]);
  expect(matchChats(all, "", undefined, null).map((x) => x.id)).toEqual(["e", "d", "a", "b"]);
});

test("a picked plugin is a pill that sends a plugin:// link, beside chat links", () => {
  let d = type(EMPTY_DRAFT, 0, 0, "@sl");
  const e = refEdit(d.text, 0, 3, { workspace_id: "", title: "Slack", plugin: "slack@caveman" });
  d = type(d, 0, 3, e.insert, e.ref);
  d = type(d, d.text.length, d.text.length, "summarize ");
  d = pick(d, d.text.length, d.text.length, "w1", "Plan");
  expect(d.text).toBe("@Slack summarize @Plan ");
  expect(serializeDraft(d)).toBe("[@Slack](plugin://slack@caveman) summarize [Plan](t3-context://v1/thread/w1) ");
  expect(relink("@Slack again", [{ workspace_id: "", title: "Slack", plugin: "slack@caveman" }])).toBe("[@Slack](plugin://slack@caveman) again");
});

test("a plugin mention's label cannot break its markdown", () => {
  expect(pluginMention("x@c", "a]b[c\\")).toBe("[@abc](plugin://x@c)");
});
