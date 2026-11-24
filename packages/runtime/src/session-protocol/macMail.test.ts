import { describe, expect, it } from "vitest";

import { broaderThan, mailMessageId } from "./macMail.ts";

describe("mailMessageId", () => {
  it("is one message per sending chat and request key: a retry is the same mail, another chat's same key is not", () => {
    const id = mailMessageId("caveman:w1", "q1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mailMessageId("caveman:w1", "q1")).toBe(id);
    expect(mailMessageId("caveman:w2", "q1")).not.toBe(id);
    expect(mailMessageId("caveman:w1", "q2")).not.toBe(id);
  });
});

describe("broaderThan", () => {
  it("ranks T3's runtime modes, and treats grill as default and anything unknown as broader", () => {
    const limits = { runtimeMode: "auto-accept-edits", interactionMode: "default" };
    expect(broaderThan({ runtimeMode: "full-access", interactionMode: "default" }, limits)).toBe(true);
    expect(broaderThan({ runtimeMode: "approval-required", interactionMode: "grill" }, limits)).toBe(false);
    expect(broaderThan({ runtimeMode: "auto-accept-edits", interactionMode: "default" }, limits)).toBe(false);
    expect(broaderThan({ runtimeMode: "something-new", interactionMode: "default" }, limits)).toBe(true);
    expect(broaderThan({ runtimeMode: "approval-required", interactionMode: "plan" }, limits)).toBe(true);
  });
});
