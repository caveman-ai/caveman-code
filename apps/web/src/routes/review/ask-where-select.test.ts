import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ASK_PLACES, askPlaceLabel, AskWhereSelect } from "./Ask.tsx";
import { ASK_HERE, askInCloud } from "./askWhere.ts";

const computers = [
  { runtimeId: "r-a", computerId: "c-a", name: "widgets-1", asleep: false },
  { runtimeId: "r-b", computerId: "c-b", name: "widgets-2", asleep: true },
];

test("Ask on the Review page runs on This Mac or in Cloud, bare: a kit dropdown, no computer's name, asleep note or new computer", () => {
  const none = renderToStaticMarkup(createElement(AskWhereSelect, { where: ASK_HERE, onChange: () => undefined, computers: [], canMakeOne: false }));
  expect(none).toBe("");
  // The menu offers exactly two places.
  expect(ASK_PLACES.map(askPlaceLabel)).toEqual([expect.stringMatching(/^This (Mac|PC|computer)$/), "Cloud"]);
  const html = renderToStaticMarkup(createElement(AskWhereSelect, { where: { kind: "computer", ...computers[0]! }, onChange: () => undefined, computers, canMakeOne: true }));
  // A button that opens the menu, named by its pick; no native select.
  expect(html).not.toContain("<select");
  expect(html).toMatch(/<button[^>]*aria-haspopup="menu"/);
  expect(html).toContain('aria-label="Where the chat runs: Cloud"');
  for (const word of ["widgets-1", "widgets-2", "asleep", "wakes first", "A new Cloud computer", "Cloud computer"]) expect(html).not.toContain(word);
  expect(renderToStaticMarkup(createElement(AskWhereSelect, { where: ASK_HERE, onChange: () => undefined, computers: [], canMakeOne: true }))).toMatch(/aria-label="Where the chat runs: This (Mac|PC|computer)"/);
});

test("Cloud is the computer that holds the repository, an awake one first, else a new one; none when Cloud can take none", () => {
  expect(askInCloud(computers, true)).toEqual({ kind: "computer", ...computers[0] });
  expect(askInCloud([], true)).toEqual({ kind: "new" });
  expect(askInCloud([], false)).toBeNull();
});
