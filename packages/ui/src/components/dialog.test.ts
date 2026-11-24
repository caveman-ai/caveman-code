import { describe, expect, it } from "vitest";

import { DIALOG_CONTENT_CLASS } from "./dialog";

describe("DialogContent", () => {
  it("keeps its one column inside the box, so a long line truncates instead of widening the dialog", () => {
    expect(DIALOG_CONTENT_CLASS.split(" ")).toContain("grid");
    expect(DIALOG_CONTENT_CLASS.split(" ")).toContain("grid-cols-[minmax(0,1fr)]");
  });
});
