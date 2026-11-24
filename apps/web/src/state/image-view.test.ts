import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { SessionModel } from "./transcript.ts";

test.each(["completed", "failed", "declined"] as const)("native view_image is an image read, never generation: %s", (status) => {
  const model = new SessionModel();
  const apply = (type: SessionEvent["type"], payload: unknown, cursor: number) => model.apply({ type, payload, cursor, at: "2026-10-22T12:00:00Z", session_id: "images", turn_id: "turn", item_id: "view" } as SessionEvent);
  apply("tool.started", { name: "view_image", title: "view_image", kind: "other", input: { path: "/tmp/art.png" } }, 1);
  expect(model.snapshot().items[0]).toMatchObject({ kind: "tool", verb: "Viewing", icon: "read", subject: "/tmp/art.png" });
  expect(model.snapshot().artifacts).toEqual([]);
  apply("tool.done", { status }, 2);
  expect(model.snapshot().items[0]).toMatchObject({ verb: "Viewed", parts: [{ action: "image_view", subject: "/tmp/art.png" }] });
  expect(model.snapshot().artifacts).toEqual(status === "completed" ? [{ kind: "image", id: "view:image:0", itemId: "view", title: "art.png", meta: "Viewed image", src: "/tmp/art.png", alt: "art.png", line: null }] : []);
});

test.each(["/tmp/secret.txt", "/tmp/art.svg"])("image reads do not promote unsupported files: %s", (path) => {
  const model = new SessionModel();
  model.apply({ type: "tool.started", payload: { name: "view_image", title: "view_image", kind: "other", input: { path } }, cursor: 1, at: "2026-10-22T12:00:00Z", session_id: "s", item_id: "view" });
  model.apply({ type: "tool.done", payload: { status: "completed" }, cursor: 2, at: "2026-10-22T12:00:01Z", session_id: "s", item_id: "view" });
  expect(model.snapshot().artifacts).toEqual([]);
});

test("Claude Agent's Read of an image is a viewed image; a read of any other file is not", () => {
  const model = new SessionModel();
  const read = (id: string, file_path: string, cursor: number) => {
    model.apply({ type: "tool.started", payload: { name: "Read", title: `Read ${file_path}`, kind: "read", input: { file_path } }, cursor, at: "2026-11-07T02:22:56Z", session_id: "s", item_id: id });
    model.apply({ type: "tool.done", payload: { status: "completed" }, cursor: cursor + 1, at: "2026-11-07T02:22:57Z", session_id: "s", item_id: id });
  };
  read("shot", "/tmp/proof/p-people.png", 1);
  read("code", "/tmp/proof/notes.md", 3);
  expect(model.snapshot().artifacts.filter((a) => a.kind === "image")).toEqual([{ kind: "image", id: "shot:image:0", itemId: "shot", title: "p-people.png", meta: "Viewed image", src: "/tmp/proof/p-people.png", alt: "p-people.png", line: null }]);
});
