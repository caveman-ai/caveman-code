import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { CloudError } from "../../state/sync/cloud-api.ts";
import { KeptLimitLink } from "./KeptLimitLink.tsx";

const render = (error: unknown) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(KeptLimitLink, { error })));
const MESSAGE = "You keep 10 Cloud computers, the most one person may keep, and sleeping ones count. Delete one you no longer need first.";

// m-21: only the web front door linked a kept-computer refusal to Settings > Computers. New workspace, a new chat on
// Cloud and Ask on a new Cloud computer show this under the refusal, from this tab's own Cloud call or This Mac's.
test("a refusal at the kept-computer limit links to Settings > Computers, whichever way Cloud said it (m-21)", () => {
  const direct = render(new CloudError(409, "cave_code_computer_limit_person_total", MESSAGE));
  expect(direct).toContain('href="/settings/computers"');
  expect(direct).toContain("Your Cloud computers");
  // Through This Mac's runtime: Cloud's code on the protocol error's data.
  const throughMac = render(new SessionProtocolError({ code: -32004, message: MESSAGE, data: { reason: "invalid_state", cloud_code: "cave_code_computer_limit_plan_kept" } }));
  expect(throughMac).toContain('href="/settings/computers"');
  // A visible focus ring on the link (keyboard).
  expect(throughMac).toContain("focus-visible:ring-2");
});

test("any other failure shows no link (m-21)", () => {
  expect(render(new CloudError(409, "cave_code_computer_limit_person_running", "Put one to sleep first."))).toBe("");
  expect(render(new SessionProtocolError({ code: -32004, message: "The runtime refused", data: { reason: "invalid_state" } }))).toBe("");
  expect(render(new Error("network down"))).toBe("");
  expect(render(null)).toBe("");
});
