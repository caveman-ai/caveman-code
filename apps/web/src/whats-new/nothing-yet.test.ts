import * as Dialog from "@radix-ui/react-dialog";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NothingYet } from "./WhatsNew.tsx";

test("What's new with no notes yet still has a way out besides Escape", () => {
  const html = renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(NothingYet, { onDone: () => undefined })));
  expect(html).toContain("Nothing yet");
  expect(html).toMatch(/<button[^>]*>Close<\/button>/);
});
