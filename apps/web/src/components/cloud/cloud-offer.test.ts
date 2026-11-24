// The one-time Cloud offer through the real component (components/cloud/CloudOffer.tsx): shown the first time, a Yes
// starts the browser approval Settings > Models & keys makes, a No starts nothing, either is remembered, and it is
// never shown where there is nothing to approve.
import { buttons, click, container, settle } from "../../lib/dom.test-support.ts";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { PLANS } from "../../routes/settings/connections-model.ts";
import { forgetConnects } from "../../routes/settings/Connections.tsx";
import { resetCloudOffer } from "../../state/cloud-offer.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { CloudOffer } from "./CloudOffer.tsx";

const KEY = "caveman.cloudOffer";
const TITLE = "Use your Claude subscription here too?";

/** An agent on this computer's own plan login, which one approval would carry to Cloud (`everywhere: "available"`). */
const own = (id: "claude-agent" | "codex", label: string): EngineDescriptor =>
  ({
    id,
    label,
    auth: {
      state: "signed_in",
      everywhere: "available",
      accounts: [{ id: PLANS[id].own, active: true, label: "Plan", kind: "login" }],
    },
  }) as unknown as EngineDescriptor;
/** The same plan, connected already. */
const connected = (id: "claude-agent" | "codex", label: string): EngineDescriptor => {
  const e = own(id, label);
  return {
    ...e,
    auth: {
      ...e.auth,
      accounts: [
        {
          id: "connection:1",
          active: true,
          label: "Plan",
          kind: "login",
          where: "everywhere",
          connection: { kind: PLANS[id].kind, state: "ready" },
        },
      ],
    },
  } as unknown as EngineDescriptor;
};

async function mountOffer(engines: ReadonlyArray<EngineDescriptor>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return Promise.resolve({});
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    settings: null,
    engines,
    workspaces: [],
    projects: [],
    raw: new Map(),
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(RuntimeFixture, { value, children: createElement(CloudOffer) })),
  );
  await settle();
  return {
    calls,
    text: () => host.textContent ?? "",
    host,
    unmount: () => act(async () => root.unmount()),
  };
}

const saved = () =>
  JSON.parse(localStorage.getItem(KEY) ?? "null") as {
    answer: string | null;
    shown: number;
  } | null;

afterEach(() => {
  localStorage.clear();
  resetCloudOffer();
  forgetConnects();
});

test("the first Cloud start asks once, with a Yes and a No, and starts nothing by itself", async () => {
  const offer = await mountOffer([own("claude-agent", "Claude Agent")]);
  expect(offer.text()).toContain(TITLE);
  expect(buttons(offer.host, "Yes")).toHaveLength(1);
  expect(buttons(offer.host, "No")).toHaveLength(1);
  expect(offer.calls).toEqual([]);
  expect(saved()).toEqual({ answer: null, shown: 1 });
  await offer.unmount();
});

test("Yes starts the browser approval for the plan and is remembered", async () => {
  const offer = await mountOffer([own("claude-agent", "Claude Agent")]);
  await click(buttons(offer.host, "Yes")[0]);
  expect(offer.calls.find((c) => c.method === "engine.account.add")?.params).toMatchObject({
    engine: "claude-agent",
    everywhere: true,
  });
  expect(saved()?.answer).toBe("yes");
  expect(offer.text()).not.toContain(TITLE);
  expect(offer.text()).toContain("Approve it in your browser");
  await offer.unmount();
  // The next Cloud start does not ask again.
  const next = await mountOffer([own("claude-agent", "Claude Agent")]);
  expect(next.text()).toBe("");
  await next.unmount();
});

test("No asks nothing of the runtime, says where to turn it on, and is remembered", async () => {
  const offer = await mountOffer([own("claude-agent", "Claude Agent")]);
  await click(buttons(offer.host, "No")[0]);
  expect(offer.calls).toEqual([]);
  expect(saved()?.answer).toBe("no");
  expect(offer.text()).toContain("Settings > Models & keys");
  await offer.unmount();
  const next = await mountOffer([own("claude-agent", "Claude Agent")]);
  expect(next.text()).toBe("");
  await next.unmount();
});

test("two plans are one question, and Yes approves each", async () => {
  const offer = await mountOffer([own("claude-agent", "Claude Agent"), own("codex", "Codex")]);
  expect(offer.text()).toContain("Use your Claude and ChatGPT subscriptions here too?");
  await click(buttons(offer.host, "Yes")[0]);
  expect(
    offer.calls.filter((c) => c.method === "engine.account.add").map((c) => c.params.engine),
  ).toEqual(["claude-agent", "codex"]);
  await offer.unmount();
});

test("nothing is shown, or counted, where there is no plan login here or it is connected already", async () => {
  const none = await mountOffer([]);
  expect(none.text()).toBe("");
  await none.unmount();
  const done = await mountOffer([connected("claude-agent", "Claude Agent")]);
  expect(done.text()).toBe("");
  expect(saved()).toBeNull();
  await done.unmount();
});

test("an offer left unanswered shows the first time only, then is left to Settings (D2)", async () => {
  const first = await mountOffer([own("claude-agent", "Claude Agent")]);
  expect(first.text()).toContain(TITLE);
  await first.unmount();
  resetCloudOffer();
  expect(saved()).toEqual({ answer: null, shown: 1 });
  const second = await mountOffer([own("claude-agent", "Claude Agent")]);
  expect(second.text()).toBe("");
  await second.unmount();
});

test("a device whose storage refuses still shows it and answers it", async () => {
  const real = localStorage;
  const blocked = () => {
    throw new Error("blocked");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: blocked,
      setItem: blocked,
      removeItem: () => undefined,
      clear: () => undefined,
    },
  });
  try {
    resetCloudOffer();
    const offer = await mountOffer([own("claude-agent", "Claude Agent")]);
    expect(offer.text()).toContain(TITLE);
    await click(buttons(offer.host, "No")[0]);
    expect(offer.text()).toContain("Settings > Models & keys");
    await offer.unmount();
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
    resetCloudOffer();
  }
});
