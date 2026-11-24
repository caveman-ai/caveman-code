// Settings > Chief > Calls in a window on a Cloud computer that keeps nothing of its person's (every engine there
// says no_sign_in_here): the runtime refuses a voice key there (chief.voice.key), so the voice engine's row has no
// field for one and says where a key is added. One an earlier version kept can still be removed. On a Mac the field
// is as it was.
import { mount, settle } from "./browser.fixture.ts";

import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
// Radix's select builds a DocumentFragment, which linkedom does not construct; the voice pickers are not what runs here.
vi.mock("@caveman-app/ui/components/select", async () => {
  const { createElement: h } = await import("react");
  const pass = () => (p: { children?: unknown }) => h("span", null, p.children as never);
  return {
    Select: pass(),
    SelectContent: pass(),
    SelectItem: pass(),
    SelectTrigger: pass(),
    SelectValue: pass(),
  };
});
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { Calls, VOICE_KEY_ELSEWHERE } from "./Chief.tsx";

const OUTSIDE = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [], no_sign_in_here: true },
  },
] as unknown as EngineDescriptor[];
const MAC = [
  { id: "claude-agent", label: "Claude Agent", auth: { state: "signed_in", accounts: [] } },
] as unknown as EngineDescriptor[];
const VOICE = {
  state: "ready",
  engine: "deepgram",
  engine_label: "Deepgram",
  key_url: "https://console.deepgram.com",
  key_help: "Your Deepgram key pays for calls.",
  voices: [{ id: "flux", label: "Flux" }],
  paid_by: "credits",
};

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

async function calls(engines: EngineDescriptor[], voice: Record<string, unknown>) {
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === "chief.get")
        return {
          workspace: { id: "ws-chief" },
          availability: "ready",
          board: { items: [], change_sets: [] },
          voice,
        };
      throw new Error(`unexpected ${method}`);
    },
  };
  const value = {
    client,
    workspaces: [],
    projects: [],
    engines,
    settings: {},
    status: "connected",
    connection: 1,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(Calls) }),
    ),
  );
  await settle();
  return page.container;
}

const labels = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
  );

test("on a Cloud computer that keeps nothing, Calls has no field for a voice key and says where one is added", async () => {
  expect(VOICE_KEY_ELSEWHERE).toBe(
    "Calls and talk to type run on Caveman credits in Cloud. Add a voice key on your Mac (Settings > Chiefs).",
  );
  const there = await calls(OUTSIDE, VOICE);
  expect(there.textContent).toContain(VOICE_KEY_ELSEWHERE);
  expect(there.textContent).not.toContain("Get a key");
  expect(there.querySelector('input[type="password"]')).toBeNull();
  expect(labels(there)).not.toContain("Add");
});

test("a key an earlier version kept there can still be removed", async () => {
  const there = await calls(OUTSIDE, { ...VOICE, paid_by: "key", key_hint: "...abcd" });
  expect(there.textContent).toContain("...abcd");
  expect(labels(there)).toContain("Remove the Deepgram key");
  expect(there.querySelector('input[type="password"]')).toBeNull();
});

test("a Mac keeps the field", async () => {
  const mac = await calls(MAC, VOICE);
  expect(mac.textContent).not.toContain(VOICE_KEY_ELSEWHERE);
  expect(mac.textContent).toContain("Get a key");
  expect(mac.querySelector('input[type="password"]')).not.toBeNull();
  expect(labels(mac)).toContain("Add");
});
