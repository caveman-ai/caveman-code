import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ScrollButton } from "./conversation";

test("the scroll button names what waits at the end, so a stopped agent is noticed", () => {
  const plain = renderToStaticMarkup(<ScrollButton />);
  expect(plain).toContain('aria-label="Scroll to the newest message"');
  expect(plain).not.toContain("data-waiting");

  const waiting = renderToStaticMarkup(<ScrollButton waiting="Needs you" />);
  expect(waiting).toContain('aria-label="Needs you: scroll to it"');
  expect(waiting).toContain('data-waiting="true"');
  expect(waiting).toContain(">Needs you<");
});
