import { expect, test } from "vitest";
import type { WhereView } from "./chats-view.ts";
import { heldFeed, sourceLine } from "./lines.ts";

const where = (over: Partial<WhereView>): WhereView => ({ kind: "cloud", name: "api-box", runtimeId: "r", computerId: "c", online: true, asleep: false, ...over });

test("a live chat says nothing; every other state says why and that it comes back", () => {
  expect(sourceLine({ kind: "live" }, where({}))).toBeNull();
  expect(sourceLine({ kind: "loading" }, where({}))).toBeNull();
  expect(sourceLine({ kind: "reconnecting" }, where({}))).toBe("Reconnecting");
  expect(sourceLine({ kind: "ended", reason: "lease_lost", message: "This chat moved to another computer." }, where({}))).toBe("This chat moved to another computer. Reconnecting");
  expect(sourceLine({ kind: "copy", through: 4 }, where({ online: false, asleep: true }))).toBe("Asleep. Sending wakes it.");
  expect(sourceLine({ kind: "copy", through: 4 }, where({ kind: "laptop", name: "Julius's MacBook", online: false }))).toBe("Julius's MacBook is asleep. Sending continues this chat on a Cloud computer.");
  expect(sourceLine({ kind: "copy", through: 4 }, where({ online: true }))).toBe("Can't reach api-box right now. Showing Caveman's copy. Reconnecting");
});

test("once a send waits for an asleep Cloud computer, the line says it is waking, not that sending would wake it", () => {
  expect(sourceLine({ kind: "copy", through: 4 }, where({ online: false, asleep: true }), true)).toBe("Waking api-box");
  expect(sourceLine({ kind: "copy", through: 4 }, where({ online: false }), true)).toBe("Waking api-box");
  expect(sourceLine({ kind: "copy", through: 4 }, where({ kind: "laptop", name: "Julius's MacBook", online: false }), true)).toBe("Julius's MacBook is asleep. Sending continues this chat on a Cloud computer.");
});

test("a Mac that has not allowed this device: the line says so, with the code to check, whatever the view reads", () => {
  const approval = { title: "Waiting for MacBook Pro to allow this browser", detail: "On MacBook Pro, choose Allow when it asks, and check it shows 482913. You only do this once." };
  expect(sourceLine({ kind: "copy", through: 2 }, where({ kind: "laptop", name: "MacBook Pro" }), false, approval)).toBe(
    "Waiting for MacBook Pro to allow this browser. On MacBook Pro, choose Allow when it asks, and check it shows 482913. You only do this once.",
  );
  expect(sourceLine({ kind: "loading" }, where({ kind: "laptop", name: "MacBook Pro" }), false, approval)).toContain("482913");
});

test("a reattach says Reconnecting only once it is overdue: a chat shown again says nothing, so nothing jumps", () => {
  expect(sourceLine(heldFeed({ kind: "reconnecting" }, false), where({}))).toBeNull();
  expect(sourceLine(heldFeed({ kind: "reconnecting" }, true), where({}))).toBe("Reconnecting");
  // Every other state reads as it is.
  const ended = { kind: "ended", reason: "closed", message: "The runtime stopped." } as const;
  expect(heldFeed(ended, false)).toBe(ended);
  expect(heldFeed(null, false)).toBeNull();
});
