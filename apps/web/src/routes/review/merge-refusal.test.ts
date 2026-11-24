// Merge, confirmed in its dialog, when the host refuses it: the person sees why on the Merge button, since the
// dialog (the real ConfirmDialog) closed itself as it was confirmed.
import { buttons, click, document, render, settle } from "./dom.test-support.ts";
import type { PrDetail } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { expect, test } from "vitest";
import { MergeButton } from "./PrPage.tsx";

// The runtime passes the host's refusal on as a ProtocolError carrying the host's sentence (reviews.test.ts).
const REFUSAL = "Base branch policy prohibits the merge.";

const detail = {
  project_id: "p1",
  repo: "acme/app",
  host: "github.com",
  number: 42,
  title: "Add the thing",
  url: "https://github.com/acme/app/pull/42",
  head_branch: "feat/thing",
  base_branch: "main",
  state: "open",
  // GitHub says "unknown" for many protected-branch cases the merge call still refuses.
  mergeable: "unknown",
  checks_list: [],
  can: { merge: true, review: false, comment: false, merge_methods: ["squash"], ready: false },
} as unknown as PrDetail;

test("a merge the host refuses says why on the Merge button, the confirm dialog already closed", async () => {
  const merges: string[] = [];
  let refuse: (e: Error) => void = () => undefined;
  const host = await render(
    createElement(MergeButton, {
      detail,
      onMerge: (method) => (merges.push(method), new Promise((_, reject) => (refuse = reject))),
    }),
  );
  const mergeButton = () => host.querySelector("button")!;

  await click(mergeButton());
  await click(buttons(document.querySelector("[role=dialog]")!, "Squash and merge")[0]);
  expect(merges).toEqual(["squash"]);
  expect(document.querySelector("[role=dialog]")).toBeNull();
  // While the merge is out, the button says so and takes no second one.
  expect(mergeButton().textContent).toBe("Merging…");
  expect(mergeButton().hasAttribute("disabled")).toBe(true);

  refuse(new Error(REFUSAL));
  await settle();
  expect(mergeButton().textContent).toBe("Couldn't merge");
  expect(mergeButton().getAttribute("title")).toBe(REFUSAL);
  expect(mergeButton().hasAttribute("disabled")).toBe(false);
  // Opened again, the dialog repeats it.
  await click(mergeButton());
  expect(document.querySelector("[role=dialog]")?.textContent).toContain(`Last try: ${REFUSAL}`);
});
