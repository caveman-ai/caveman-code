import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { OlderImage } from "./OlderImage.tsx";

test("a computer whose image predates the desktop is told it updates when it wakes, not sent to make a new computer", () => {
  const html = renderToStaticMarkup(createElement(OlderImage, { computerId: "c1", update: undefined }));
  expect(html).toContain("This computer has no desktop yet");
  expect(html).toContain("It updates the next time it wakes.");
  expect(html).not.toContain("A new Cloud computer has one");
  // A device that cannot reach Cloud's routes: no button that could only fail; the wake does it.
  expect(html).not.toContain("Update now");
});

test("Update now is there wherever the device reaches Cloud (the web's cookie, the desktop's token), for a known computer", () => {
  const update = async () => undefined;
  expect(renderToStaticMarkup(createElement(OlderImage, { computerId: "c1", update }))).toMatch(/<button[^>]*>Update now<\/button>/);
  expect(renderToStaticMarkup(createElement(OlderImage, { computerId: undefined, update }))).not.toContain("Update now");
});
