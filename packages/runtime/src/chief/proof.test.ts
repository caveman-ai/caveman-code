// A chat's screenshots on its Chief's board (chief/proof.ts): read from the answer's Markdown images in order, with
// their captions; copied into the attachment store under the Chief's thread (images a model takes only); a later
// turn's replace an earlier one's; and the Chief reads their ids to pass them on.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, expect, test } from "vitest";

import type { Item } from "./Board.ts";
import { chatUpdate } from "./prompt.ts";
import { PROOF_MAX, proofImagesOf, proofLine, storeProof, withProof } from "./proof.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chief-proof-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** The smallest PNG: one transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const shot = (name: string) => {
  const file = path.join(root, "proof", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG);
  return file;
};

test("an answer's local images, in order, once each, with their captions: never a web or data URL", () => {
  const text = [
    "Status: review",
    "![Settings, before](/tmp/proof/a.png) and ![Settings, after](</tmp/proof/with space.png>)",
    '![  Dark   mode  ](file:///tmp/proof/c.png "title")',
    "![logo](https://example.com/logo.png) ![inline](data:image/png;base64,AAAA)",
    "![again](/tmp/proof/a.png) ![](relative/d.png) ![home](~/shots/e.png)",
  ].join("\n");
  expect(proofImagesOf(text)).toEqual([
    { caption: "Settings, before", src: "/tmp/proof/a.png" },
    { caption: "Settings, after", src: "/tmp/proof/with space.png" },
    { caption: "Dark mode", src: "/tmp/proof/c.png" },
    { caption: "", src: "relative/d.png" },
    { caption: "home", src: "~/shots/e.png" },
  ]);
  expect(proofImagesOf("![a](file://otherhost/x.png) no images here")).toEqual([]);
});

test("stored under the Chief's thread, each with its caption and its stored path; what is not an image is left out", async () => {
  const attachmentsDir = path.join(root, "attachments");
  const worktree = path.join(root, "checkout");
  fs.mkdirSync(path.join(worktree, "shots"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "shots", "rel.png"), PNG);
  const before = shot("before.png");
  fs.writeFileSync(path.join(root, "proof", "notes.png"), "not a png");
  const answer = `Status: review\n![Before](${before}) ![Not an image](${path.join(root, "proof", "notes.png")}) ![Gone](${path.join(root, "proof", "gone.png")}) ![Relative](shots/rel.png)`;
  const proof = await storeProof({
    attachmentsDir,
    threadId: "caveman:chief-1",
    workspaceId: "w-1",
    turnId: "t-1",
    answer,
    worktree,
    at: "2026-11-08T10:00:00.000Z",
  });
  expect(proof).toMatchObject({
    workspace_id: "w-1",
    turn_id: "t-1",
    at: "2026-11-08T10:00:00.000Z",
  });
  expect(proof!.images.map((i) => [i.caption, i.name, i.mime_type, i.size_bytes])).toEqual([
    ["Before", "before.png", "image/png", PNG.length],
    ["Relative", "rel.png", "image/png", PNG.length],
  ]);
  for (const image of proof!.images) {
    expect(image.path.startsWith(attachmentsDir)).toBe(true);
    expect(fs.readFileSync(image.path).equals(PNG)).toBe(true);
  }
  // The copy outlives the temp folder it was saved in.
  fs.rmSync(before);
  expect(fs.existsSync(proof!.images[0]!.path)).toBe(true);

  // An answer with none, or none that reads as an image, keeps nothing.
  expect(
    await storeProof({
      attachmentsDir,
      threadId: "caveman:chief-1",
      workspaceId: "w-1",
      turnId: "t-2",
      answer: "Status: done",
      worktree,
      at: "x",
    }),
  ).toBeUndefined();
});

test("a walkthrough keeps its first few images", async () => {
  const many = Array.from(
    { length: PROOF_MAX + 3 },
    (_, i) => `![Step ${i + 1}](${shot(`step-${i}.png`)})`,
  ).join("\n");
  const proof = await storeProof({
    attachmentsDir: path.join(root, "attachments"),
    threadId: "caveman:chief-1",
    workspaceId: "w-2",
    turnId: "t-1",
    answer: many,
    worktree: null,
    at: "x",
  });
  expect(proof!.images.map((i) => i.caption)).toEqual(
    Array.from({ length: PROOF_MAX }, (_, i) => `Step ${i + 1}`),
  );
});

test("a chat's later proof replaces its earlier one; another chat's stays; the Chief reads its ids and captions", () => {
  const image = (id: string, caption: string) => ({
    id,
    name: `${id}.png`,
    mime_type: "image/png",
    size_bytes: 1,
    caption,
    path: `/store/${id}.png`,
  });
  const item = {
    id: "ci-1",
    text: "dark mode",
    state: "review",
    rank: 1,
    pinned: false,
    project_ids: [],
    source: "composer",
    workspace_ids: ["w-1", "w-2"],
    start: false,
    created_at: "a",
    updated_at: "a",
    proof: [
      { workspace_id: "w-1", at: "b", images: [image("old", "Old")] },
      { workspace_id: "w-2", at: "b", images: [image("other", "Other")] },
    ],
  } as unknown as Item;
  const next = withProof(item, {
    workspace_id: "w-1",
    turn_id: "t-9",
    at: "c",
    images: [image("new-1", "Light"), image("new-2", "Dark")],
  });
  expect(next.replaced).toEqual(["/store/old.png"]);
  expect(next.item.proof!.map((p) => p.workspace_id)).toEqual(["w-2", "w-1"]);
  expect(next.item.updated_at).toBe("c");
  expect(proofLine(next.item, "w-1")).toEqual([
    { id: "new-1", caption: "Light" },
    { id: "new-2", caption: "Dark" },
  ]);

  const line = chatUpdate({
    workspaceId: "w-1",
    itemId: "ci-1",
    title: "Dark mode",
    state: "review",
    latest: "Status: review\nDone.",
    proof: proofLine(next.item, "w-1"),
  });
  expect(line).toContain(' proof="new-1: Light; new-2: Dark">');
  expect(chatUpdate({ workspaceId: "w-3", title: "x", state: "done", proof: [] })).not.toContain(
    "proof=",
  );
});
