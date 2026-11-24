import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const frame = vi.hoisted(() => ({ text: "", revealing: true }));
vi.mock("./word-fade.ts", async (original) => ({
  ...await original<typeof import("./word-fade.ts")>(),
  usePacedText: () => frame,
  useWordFading: () => false,
}));
import { Response } from "./response.tsx";

test("a completed transport still stabilizes partially revealed emphasis, links and tables", () => {
  frame.revealing = true;
  frame.text = "Both **drafts are";
  let out = renderToStaticMarkup(<Response paced streaming={false}>{"Both **drafts are ready**."}</Response>);
  expect(out).toMatch(/<strong[^>]*>drafts are<\/strong>/);
  expect(out).not.toContain("**");

  frame.text = "See [the draft](https://exa";
  out = renderToStaticMarkup(<Response paced streaming={false}>{"See [the draft](https://example.com)."}</Response>);
  expect(out).toContain("the draft");
  expect(out).not.toContain("https://exa");

  const table = "| Task | State |\n| --- | --- |\n| Export | Blocked |";
  frame.text = "| Task | State |\n| ---";
  out = renderToStaticMarkup(<Response paced streaming={false}>{table}</Response>);
  expect(out).not.toContain("Task");
  frame.text = table;
  frame.revealing = false;
  out = renderToStaticMarkup(<Response paced streaming={false}>{table}</Response>);
  expect(out).toContain("<table");
  expect(out).toContain("Blocked");
});
