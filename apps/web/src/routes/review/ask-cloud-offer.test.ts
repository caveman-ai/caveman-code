// Review's Ask on a new Cloud computer carries the same one-time offer as a Cloud start page: in the Ask
// popover, above Fix and Ask, never in front of them. The popover counts nothing as shown (CloudOffer countShown={false}):
// opening and closing it without an answer uses nothing up. An answer (state/cloud-offer.ts), or a Cloud start page that
// already showed the offer, ends it here.
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { afterEach, expect, test } from "vitest";
import { buttons, click, render, settle } from "../dom.test-support.ts";
import { noteCloudOfferShown, resetCloudOffer } from "../../state/cloud-offer.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { forgetConnects } from "../settings/Connections.tsx";
import { PLANS } from "../settings/connections-model.ts";
import type { AskMode } from "./Ask.tsx";
import { AskMenu } from "./PrPage.tsx";

const TITLE = "Use your Claude subscription here too?";
/** Claude on this Mac's own login, which one approval would carry to Cloud. */
const claude = {
  id: "claude-agent",
  label: "Claude Agent",
  auth: {
    state: "signed_in",
    everywhere: "available",
    accounts: [{ id: PLANS["claude-agent"].own, active: true, label: "Plan", kind: "login" }],
  },
} as unknown as EngineDescriptor;

afterEach(() => {
  localStorage.clear();
  resetCloudOffer();
  forgetConnects();
});

async function open(
  props: { cloudStart?: boolean; inChat?: boolean; engines?: ReadonlyArray<EngineDescriptor> },
  calls: Array<[AskMode, string]> = [],
) {
  const client = { call: async () => ({}), on: () => () => undefined };
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: props.engines ?? [claude],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  const view = await render(
    createElement(RuntimeFixture, {
      value,
      children: createElement(AskMenu, {
        onSpawn: async (mode, text) => void calls.push([mode, text]),
        onOpenChange: () => undefined,
        place: null,
        ...(props.cloudStart !== undefined ? { cloudStart: props.cloudStart } : {}),
        ...(props.inChat !== undefined ? { inChat: props.inChat } : {}),
      }),
    }),
  );
  await click(buttons(view.host, /Ask/)[0]);
  await settle(3);
  return view;
}

const body = () => document.body.textContent ?? "";

test("a chat on a new Cloud computer shows the offer in the popover, above Fix and Ask", async () => {
  await open({ cloudStart: true });
  expect(body()).toContain(TITLE);
  const offer = [...document.querySelectorAll("[role=group]")].find(
    (g) => g.getAttribute("aria-label") === TITLE,
  )!;
  const fix = buttons(document.body, "Fix")[0]!;
  // The offer comes before the start buttons in the popover.
  const order = [...document.querySelectorAll("*")];
  expect(order.indexOf(offer)).toBeLessThan(order.indexOf(fix));
  expect(buttons(offer as HTMLElement, "Yes")).toHaveLength(1);
  expect(buttons(offer as HTMLElement, "No")).toHaveLength(1);
});

test("a chat anywhere else (This Mac, an existing Cloud computer, a chat's own tab) shows no offer", async () => {
  await open({ cloudStart: false });
  expect(body()).not.toContain("here too?");
});

test("a chat's own tab shows no offer even when asked with cloudStart", async () => {
  await open({ cloudStart: true, inChat: true });
  expect(body()).not.toContain("here too?");
});

test("an unanswered offer never holds the start", async () => {
  const calls: Array<[AskMode, string]> = [];
  await open({ cloudStart: true }, calls);
  expect(body()).toContain(TITLE);
  await click(buttons(document.body, "Ask").find((b) => b.getAttribute("title") === "↩"));
  expect(calls).toEqual([["ask", ""]]);
});

test("a window with no plan login to carry over shows no offer", async () => {
  await open({ cloudStart: true, engines: [] });
  expect(body()).not.toContain("here too?");
});

test("once a Cloud start page showed the offer (it counts that), the popover does not show it", async () => {
  noteCloudOfferShown();
  await open({ cloudStart: true });
  expect(body()).not.toContain("here too?");
});

test("opening and closing the popover without an answer writes nothing and leaves the offer showing next time", async () => {
  for (let i = 0; i < 3; i++) {
    const visit = await open({ cloudStart: true });
    expect(body()).toContain(TITLE);
    await visit.unmount();
    resetCloudOffer();
    expect(localStorage.getItem("caveman.cloudOffer")).toBeNull();
  }
});

test("Yes in the popover starts the approval and ends the offer", async () => {
  await open({ cloudStart: true });
  await click(buttons(document.body, "Yes")[0]);
  expect(body()).toContain("Approve it in your browser");
  expect(JSON.parse(localStorage.getItem("caveman.cloudOffer")!)).toMatchObject({ answer: "yes" });
  resetCloudOffer();
  await open({ cloudStart: true });
  expect(body()).not.toContain(TITLE);
});

test("an answer in the popover is kept: No says where to turn it on, and it does not come back", async () => {
  await open({ cloudStart: true });
  await click(buttons(document.body, "No")[0]);
  expect(body()).toContain("Turn it on any time in Settings > Models & keys.");
  await act(async () => resetCloudOffer());
  expect(JSON.parse(localStorage.getItem("caveman.cloudOffer")!)).toMatchObject({ answer: "no" });
  await open({ cloudStart: true });
  expect(body()).not.toContain(TITLE);
});
