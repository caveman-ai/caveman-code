import type { ChiefItem } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import type { WorkspaceView } from "../../state/model.ts";
import { previewChats, proofImages, shownIn } from "./showing-model.ts";

const image = (id: string, caption: string) => ({
  id,
  name: `${id}.png`,
  mime_type: "image/png",
  size_bytes: 1,
  caption,
  path: `/state/attachments/chief/${id}.png`,
});
const item = (patch: Partial<ChiefItem>): ChiefItem => ({
  id: "ci-1",
  number: 12,
  text: "pricing page",
  title: "Pricing page",
  state: "review",
  rank: 1,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: ["w-1"],
  created_at: "2026-11-08T09:00:00.000Z",
  updated_at: "2026-11-08T09:00:00.000Z",
  ...patch,
});
const chat = (id: string, patch: Partial<WorkspaceView> = {}): WorkspaceView =>
  ({
    id,
    title: `Chat ${id}`,
    state: "completed",
    preview: { command: "pnpm vite --port {port}", path: "/" },
    ...patch,
  }) as WorkspaceView;
/** A chat that registered no preview. */
const plain = (id: string): WorkspaceView => {
  const { preview: _none, ...rest } = chat(id);
  return rest as WorkspaceView;
};

describe("a piece of work's screenshots", () => {
  test("in order, chat by chat, captioned, read from the stored copy; a run of them counts its steps", () => {
    const work = item({
      proof: [
        {
          workspace_id: "w-1",
          at: "2026-11-08T10:00:00.000Z",
          images: [image("a", "Light"), image("b", "Dark")],
        },
        { workspace_id: "w-2", at: "2026-11-08T11:00:00.000Z", images: [image("c", "")] },
      ],
    });
    expect(proofImages(work).map((i) => [i.id, i.title, i.meta, i.src])).toEqual([
      ["proof:a", "Light", "1 of 2", "/state/attachments/chief/a.png"],
      ["proof:b", "Dark", "2 of 2", "/state/attachments/chief/b.png"],
      // No caption: its file name.
      ["proof:c", "c.png", "", "/state/attachments/chief/c.png"],
    ]);
    // A message shows what had been kept when it was written, never what came later.
    expect(proofImages(work, "2026-11-08T10:30:00.000Z").map((i) => i.id)).toEqual([
      "proof:a",
      "proof:b",
    ]);
    expect(proofImages(item({}))).toEqual([]);
  });
});

describe("Open preview chips", () => {
  test("one per chat that registered a preview, never an archived chat's or another item's", () => {
    const work = item({ workspace_ids: ["w-1", "w-2", "w-3"] });
    const chats = [chat("w-1"), plain("w-2"), chat("w-3", { state: "archived" }), chat("w-9")];
    expect(previewChats(work, chats).map((c) => c.id)).toEqual(["w-1"]);
  });
});

describe("under a Chief message", () => {
  const items = [
    item({
      proof: [
        { workspace_id: "w-1", at: "2026-11-08T10:00:00.000Z", images: [image("a", "Light")] },
      ],
    }),
    item({ id: "ci-2", number: 13, workspace_ids: ["w-2"] }),
    item({ id: "ci-3", number: 14, workspace_ids: ["w-3"] }),
  ];
  const chats = [plain("w-1"), chat("w-2"), plain("w-3")];

  test("each piece of work it names with something to show, in the order named, once", () => {
    const shown = shownIn(
      "[[13]] is ready, and [[12]] too. [[13]] again; [[14]] has nothing; [[99]] is gone.",
      "2026-11-08T10:05:00.000Z",
      items,
      chats,
    );
    expect(
      shown.map((s) => [s.item.id, s.images.map((i) => i.id), s.previews.map((p) => p.id)]),
    ).toEqual([
      ["ci-2", [], ["w-2"]],
      ["ci-1", ["proof:a"], []],
    ]);
  });

  test("a chat it names shows that chat's own screenshots and chip; each shows once", () => {
    const a = "0cad8d4b-4f6f-45cf-88ad-ad68d61dbf1f";
    const b = "9c0786c5-6eaa-4689-a848-a93a56d2831c";
    const work = item({
      id: "ci-7",
      number: 7,
      workspace_ids: [a, b],
      proof: [
        { workspace_id: a, at: "2026-11-08T10:00:00.000Z", images: [image("x", "Work list")] },
        { workspace_id: b, at: "2026-11-08T10:00:00.000Z", images: [image("y", "Relay")] },
      ],
    });
    const views = [chat(a), plain(b)];
    const named = (text: string) =>
      shownIn(text, "2026-11-08T10:05:00.000Z", [work], views).map((s) => [
        s.key,
        s.images.map((i) => i.id),
        s.previews.map((p) => p.id),
      ]);
    expect(named(`[[chat:${b}]] is done, and [[chat:${a}]] too.`)).toEqual([
      [b, ["proof:y"], []],
      [a, ["proof:x"], [a]],
    ]);
    // Its item after it brings only what its chat did not.
    expect(named(`[[chat:${a}]]; all of [[7]].`)).toEqual([
      [a, ["proof:x"], [a]],
      ["ci-7", ["proof:y"], []],
    ]);
    // A chat that is gone from the chat list keeps its screenshots: they live on the item.
    expect(
      shownIn(`[[chat:${b}]]`, "2026-11-08T10:05:00.000Z", [work], []).map((s) =>
        s.images.map((i) => i.id),
      ),
    ).toEqual([["proof:y"]]);
    // A chat off this Chief's board shows nothing.
    expect(named("[[chat:11111111-2222-3333-4444-555555555555]]")).toEqual([]);
    // A chat whose result card is in the conversation shows its screenshots and chip there, not under the reply.
    expect(
      shownIn(
        `[[chat:${a}]] and all of [[7]].`,
        "2026-11-08T10:05:00.000Z",
        [work],
        views,
        new Set([a]),
      ).map((s) => [s.key, s.images.map((i) => i.id), s.previews.map((p) => p.id)]),
    ).toEqual([["ci-7", ["proof:y"], []]]);
  });

  test("a message written before the screenshots shows none of them", () => {
    expect(shownIn("Started [[12]].", "2026-11-08T09:30:00.000Z", items, chats)).toEqual([]);
    expect(shownIn("Nothing named here.", "2026-11-08T12:00:00.000Z", items, chats)).toEqual([]);
  });
});
