// The sidebar's call pill names the Chief on the call and hides on that Chief's page, from the first ring on: the call
// itself (and its chief_id) only arrives once the runtime answers the start.
import type { ChiefProfile } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { CallState } from "../call/store.ts";

const h = vi.hoisted(() => ({ call: null as unknown }));

vi.mock("../panes/drag.ts", () => ({}));
vi.mock("../panes/store.ts", () => ({ panes: {}, announce: () => undefined }));
vi.mock("../call/store.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call/store.ts")>()),
  useCall: () => h.call,
}));
vi.mock("../state/chiefs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/chiefs.ts")>()),
  useChiefs: () => ({ status: "ready", chiefs, working: new Set(), error: null }),
}));

import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import { ChiefCallPill } from "./Sidebar.tsx";

const UGG = "chief-ugg";
const chiefs = [
  { id: "chief-home", name: "Home", home: true },
  { id: UGG, name: "Ugg", home: false },
] as unknown as ChiefProfile[];

/** Ringing, before the runtime answered the start: no call yet, only the Chief it is to. */
const ringing = (chiefId: string | undefined): CallState => ({
  phase: "calling",
  call: null,
  muted: false,
  talking: false,
  speaking: "none",
  thinking: false,
  caption: null,
  handedAt: null,
  answered: false,
  liveAt: null,
  error: null,
  elsewhere: null,
  incoming: null,
  missed: [],
  ended: null,
  chiefId,
});

/** What the pill says on the page at `path`; null: hidden there. */
function pillAt(path: string): string | null {
  const html = renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      {
        value: {
          status: "connected",
          client: {},
          connection: 1,
          chiefHere: true,
        } as unknown as RuntimeContextValue,
      },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(ChiefCallPill)),
    ),
  );
  return html === "" ? null : (/>(Calling [^<]*)</.exec(html)?.[1] ?? html);
}

test("ringing Ugg: the pill says Calling Ugg… everywhere but Ugg's page, where the call has the box's place", () => {
  h.call = ringing(UGG);
  expect({ elsewhere: pillAt("/"), home: pillAt("/chief"), ugg: pillAt(`/chief/${UGG}`) }).toEqual({
    elsewhere: "Calling Ugg…",
    home: "Calling Ugg…",
    ugg: null,
  });
});

test("ringing the home Chief: the pill names it, and hides on its page", () => {
  h.call = ringing(undefined);
  expect({ ugg: pillAt(`/chief/${UGG}`), home: pillAt("/chief") }).toEqual({
    ugg: "Calling Home…",
    home: null,
  });
});

test("on the called Chief's page with Mission control open, the pill is back: the stage left with the conversation", () => {
  h.call = ringing(UGG);
  expect({ ugg: pillAt(`/chief/${UGG}?mission=`), uggChat: pillAt(`/chief/${UGG}`) }).toEqual({
    ugg: "Calling Ugg…",
    uggChat: null,
  });
});
