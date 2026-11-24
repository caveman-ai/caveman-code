// A Cloud chat's line in a window whose runtime is another computer (the desktop app's is This Mac): what its agent
// runs on is the chat's computer to say, never This Mac's own login. Where nothing is signed in on a Cloud computer
// the line says what is missing and its button starts the sign-in on This Mac; a Cloud that signs each computer in
// keeps its card.
import { click, deferred, mount, settle } from "../../routes/settings/browser.fixture.ts";

import type { EngineAccount, EngineDescriptor, Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { forgetConnects } from "../../routes/settings/Connections.tsx";
import {
  ChatClientScope,
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../../state/runtime.tsx";
import { chatPlaces, webWindow } from "../../state/sync/web-window.ts";
import { chatPickerEngines, useTurnChoice } from "../Composer.tsx";
import {
  cloudNeed,
  EngineSignInCard,
  needsEngineSignIn,
  useEnginesThere,
  useEngineThere,
} from "./EngineSignIn.tsx";

// What the agent's own CLI says of itself on a Cloud computer: it asks for a key the person does not need.
const CLI = "Add an Anthropic API key to use Claude Agent.";
const MISSING = "Claude isn't connected for Cloud.";
const claude = (auth: Partial<EngineDescriptor["auth"]>) =>
  ({
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_out", accounts: [], ...auth },
  }) as unknown as EngineDescriptor;
const cloudChat = {
  engine: "claude-agent",
  computer: { id: "c1", kind: "caveman_cloud", label: "devbox", status: "online" },
} as unknown as Workspace;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
  forgetConnects();
});

/** The chat's card as its pane draws it: from the engine the chat's own computer reports. */
function Card({ here }: { here: EngineDescriptor | undefined }) {
  const there = useEngineThere(cloudChat, here);
  return needsEngineSignIn(cloudChat, there)
    ? createElement(EngineSignInCard, { workspaceId: "w", engine: there })
    : createElement("output", null, "no card");
}

/** A Cloud chat in a window on This Mac, whose Claude is `mac`; the Cloud computer answers engine.list when the test says. */
async function desktop(mac: EngineDescriptor) {
  const answer = deferred<{ engines: EngineDescriptor[] }>();
  const calls: string[] = [];
  let changed: ((event: { engines: EngineDescriptor[] }) => void) | undefined;
  const home = {
    on: () => () => undefined,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push(`mac:${method}${params.everywhere ? ":everywhere" : ""}`);
      return method === "engine.account.add"
        ? {
            accounts: [],
            sign_in: { command: "", message: "", url: "https://claude.ai/oauth/authorize" },
          }
        : new Promise(() => undefined);
    },
  };
  const chat = {
    on: (name: string, handler: (event: { engines: EngineDescriptor[] }) => void) => {
      if (name === "engine.changed") changed = handler;
      return () => undefined;
    },
    call: (method: string) => {
      calls.push(`cloud:${method}`);
      return method === "engine.list" ? answer.promise : new Promise(() => undefined);
    },
  };
  const value = {
    client: home,
    engines: [mac],
    workspaces: [],
    status: "connected",
    connection: 1,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(ChatClientScope, {
          client: chat as never,
          children: createElement(Card, { here: mac }),
        }),
      }),
    ),
  );
  return {
    container: page.container,
    answer,
    calls,
    push: (engines: EngineDescriptor[]) => act(async () => changed?.({ engines })),
  };
}

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());

test("a Cloud chat with nothing to run on says so in one line, and its button starts the sign-in on this Mac", async () => {
  // This Mac can connect a plan once; its own Claude is signed out, which a Cloud computer never reads.
  const p = await desktop(claude({ everywhere: "available" }));
  // Not known yet: no line, and never one drawn from This Mac's login.
  expect(p.container.textContent).toBe("no card");
  expect(p.calls).toEqual(["cloud:engine.list"]);
  p.answer.resolve({ engines: [claude({ message: CLI, no_sign_in_here: true })] });
  await settle();
  // Our sentence and one button: never the CLI's own words, never a field.
  expect(p.container.textContent).toBe(`${MISSING}Connect Claude`);
  expect(buttons(p.container)).toEqual(["Connect Claude"]);
  expect(p.container.querySelector("input")).toBeNull();
  // One click: the same sign-in Settings > Models & keys starts, on This Mac's runtime, never on the chat's.
  await click(p.container.querySelector("button")!);
  await settle();
  expect(p.calls).toContain("mac:engine.account.add:everywhere");
  expect(p.calls.filter((c) => c.startsWith("cloud:"))).toEqual(["cloud:engine.list"]);
  expect(p.container.textContent).toContain("Connecting… approve in the browser on");
  // Under the line, the field for the code Claude's page shows when it cannot hand the sign-in back to this Mac.
  expect(p.container.querySelector("input")?.getAttribute("aria-label")).toBe(
    "Code from the sign-in page",
  );
  expect(buttons(p.container)).toEqual(["Finish", "Cancel"]);
  // It landed: the chat's computer says so, and the line goes. The message that waited is the runtime's to run.
  await p.push([claude({ state: "signed_in", no_sign_in_here: true })]);
  expect(p.container.textContent).toBe("no card");
});

test("This Mac's own login never hides the line of a Cloud chat that has nothing to run on", async () => {
  const p = await desktop(claude({ state: "signed_in", everywhere: "available" }));
  p.answer.resolve({ engines: [claude({ message: CLI, no_sign_in_here: true })] });
  await settle();
  expect(p.container.textContent).toBe(`${MISSING}Connect Claude`);
});

test("a window with no Mac behind it offers no sign-in that would be refused: its button goes to Models & keys", async () => {
  const calls: string[] = [];
  const home = {
    on: () => () => undefined,
    call: async (method: string) => void calls.push(method),
  };
  const here = claude({ message: CLI, no_sign_in_here: true, everywhere: "manage" });
  const value = {
    client: home,
    engines: [here],
    workspaces: [],
    status: "connected",
    connection: 1,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(Card, { here }) }),
    ),
  );
  expect(page.container.textContent).toBe(`${MISSING}Models & keys`);
  expect(page.container.querySelector("a")?.getAttribute("href")).toBe("/settings/models");
  expect(buttons(page.container)).toEqual([]);
  // The window's own runtime is the chat's computer: the engine it already has is read, and nothing is asked.
  expect(calls).toEqual([]);
});

test("a browser window starts no sign-in: its line says the Mac app connects it, and No Mac? leads to where a token is pasted", async () => {
  const calls: string[] = [];
  const chat = {
    on: () => () => undefined,
    call: async (method: string) => (
      calls.push(method),
      {
        engines: [
          claude({ message: CLI, no_sign_in_here: true, everywhere: "manage" }),
          { ...claude({ no_sign_in_here: true }), id: "codex" },
        ],
      }
    ),
  };
  // No computer behind the window: the chat's own computer says what its agent runs on.
  const value = {
    client: null,
    engines: [],
    workspaces: [],
    status: "connected",
    connection: 1,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const web: WebWindowValue = {
    window: webWindow(true, null),
    places: chatPlaces(null, true),
    home: null,
    mac: { kind: "none" },
    usePlace: () => undefined,
  };
  const card = (chatOf: Workspace) => {
    const Line = () => {
      const there = useEngineThere(chatOf, undefined);
      return needsEngineSignIn(chatOf, there)
        ? createElement(EngineSignInCard, { workspaceId: "w", engine: there })
        : createElement("output", null, "no card");
    };
    return createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(WebWindowFixture, {
          value: web,
          children: createElement(ChatClientScope, {
            client: chat as never,
            children: createElement(Line),
          }),
        }),
      }),
    );
  };
  page = await mount(card(cloudChat));
  await settle();
  expect(page.container.textContent).toBe(`${MISSING} Connect from the desktop app.No Mac?`);
  expect(page.container.querySelector("a")?.getAttribute("href")).toBe("/settings/models");
  expect(buttons(page.container)).toEqual([]);
  await page.unmount();
  // Codex has no token to paste: the line alone.
  page = await mount(card({ ...cloudChat, engine: "codex" } as Workspace));
  await settle();
  expect(page.container.textContent).toBe(
    "ChatGPT isn't connected for Cloud. Connect from the desktop app.",
  );
  expect(page.container.querySelector("a")).toBeNull();
  expect(calls).toEqual(["engine.list", "engine.list"]);
});

test("no line while a plan or key that is connected can run the agent, whatever its own CLI says of itself", () => {
  const NOW = Date.parse("2026-11-09T20:00:00Z");
  const account = (c: Partial<NonNullable<EngineAccount["connection"]>>): EngineAccount => ({
    id: "connection:c1",
    label: "Claude plan",
    kind: "login",
    active: true,
    where: "everywhere",
    connection: { kind: "claude_plan", status: "ready", ...c },
  });
  const there = (accounts: EngineAccount[]) =>
    claude({ message: CLI, no_sign_in_here: true, accounts });
  expect(needsEngineSignIn(cloudChat, there([]), NOW)).toBe(true);
  expect(needsEngineSignIn(cloudChat, there([account({})]), NOW)).toBe(false);
  expect(
    needsEngineSignIn(cloudChat, there([account({ expires_at: "2026-11-12T20:00:00Z" })]), NOW),
  ).toBe(false);
  expect(needsEngineSignIn(cloudChat, there([account({ status: "used_up" })]), NOW)).toBe(true);
  expect(needsEngineSignIn(cloudChat, there([account({ status: "expired" })]), NOW)).toBe(true);
  expect(needsEngineSignIn(cloudChat, there([account({ off: true })]), NOW)).toBe(true);
});

test("what is missing is said in one line with what happens next: expired, used up, turned off, never connected", () => {
  const NOW = Date.parse("2026-11-09T20:00:00Z");
  const LA = "America/Los_Angeles";
  const plan = (
    c: Partial<NonNullable<EngineAccount["connection"]>>,
    label = "Claude plan",
  ): EngineAccount => ({
    id: `connection:${label}`,
    label,
    kind: "login",
    active: false,
    where: "everywhere",
    connection: { kind: "claude_plan", status: "ready", ...c },
  });
  const need = (id: string, accounts: EngineAccount[]) =>
    cloudNeed(
      { id, auth: { state: "signed_out", accounts, no_sign_in_here: true } } as never,
      NOW,
      LA,
    );
  expect(need("claude-agent", [])).toEqual({
    kind: "connect",
    line: "Claude isn't connected for Cloud.",
  });
  expect(need("codex", [])).toEqual({
    kind: "connect",
    line: "ChatGPT isn't connected for Cloud.",
  });
  const ended = plan({ status: "expired" });
  expect(need("claude-agent", [ended])).toEqual({
    kind: "reconnect",
    line: "Your Claude sign-in expired.",
    account: ended,
  });
  expect(
    need("codex", [plan({ kind: "chatgpt_plan", status: "revoked" }, "ChatGPT plan")]).line,
  ).toBe("Your ChatGPT sign-in expired.");
  // Used up with nothing behind it: there is nothing to press, and no promise Cloud may sleep through.
  expect(
    need("claude-agent", [plan({ status: "used_up", used_up_until: "2026-11-10T07:08:00Z" })]),
  ).toEqual({ kind: "used_up", line: "Claude plan used up until 11:08 PM." });
  expect(need("claude-agent", [plan({ status: "used_up" })]).line).toBe("Claude plan used up.");
  expect(need("claude-agent", [plan({ off: true })])).toEqual({
    kind: "admin_off",
    line: "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
  });
  expect(need("codex", [plan({ kind: "chatgpt_plan", off: true }, "ChatGPT plan")]).line).toBe(
    "Your admin turned ChatGPT plans off. Add an OpenAI key, or run this chat on your Mac.",
  );
  // Never the agent's other name, never where a person cannot go.
  for (const id of ["claude-agent", "codex"])
    expect([need(id, []), need(id, [ended])].map((n) => n.line).join(" ")).not.toMatch(
      /Claude Code|Cloud computer|Settings on your Mac|connection/,
    );
});

test("a Cloud that signs each computer in keeps its card: Sign in, or an API key, in two short lines", async () => {
  const p = await desktop(claude({ state: "signed_in" }));
  p.answer.resolve({ engines: [claude({})] });
  await settle();
  expect(p.container.textContent).toContain("Sign in to Claude for Cloud");
  expect(p.container.textContent).toContain(
    "Sign in with Claude, or add an Anthropic key. It then works in Cloud.",
  );
  expect(p.container.textContent).not.toMatch(/follow you|access log|your Cloud computers/);
  // Cloud is one place: the card never names a computer or says "Cloud computer".
  expect(p.container.textContent).not.toMatch(/Cloud computer|on the computer/);
  expect(buttons(p.container)).toEqual(["Sign in", "Use an API key"]);
});

/** The model picker's list, as a chat's composer reads it (useEnginesThere): each engine's models, by id. */
function Models() {
  const engines = useEnginesThere();
  return createElement(
    "output",
    null,
    engines.length === 0
      ? "none yet"
      : engines.map((e) => `${e.id}: ${e.models.map((m) => m.id).join(", ")}`).join(" | "),
  );
}
const withModels = (id: string, models: ReadonlyArray<string>, defaultModel = models[0]) =>
  ({
    id,
    label: id,
    auth: { state: "signed_in", accounts: [] },
    models: models.map((model) => ({ id: model, label: model, efforts: [] })),
    default_model: defaultModel,
  }) as unknown as EngineDescriptor;

test("a Cloud chat's model picker lists what its own computer runs, never This Mac's Auto", async () => {
  // This Mac routes Claude Agent with Auto; the Cloud computer does not, and has a model This Mac lacks.
  const mac = withModels("claude-agent", ["caveman-auto", "claude-sonnet-4-6"]);
  const answer = deferred<{ engines: EngineDescriptor[] }>();
  // What the Cloud computer answers engine.list with: held until the test says, then whatever it last listed.
  let listed: Promise<{ engines: EngineDescriptor[] }> = answer.promise;
  const calls: string[] = [];
  let changed: ((event: { engines: EngineDescriptor[] }) => void) | undefined;
  const home = {
    on: () => () => undefined,
    call: async (method: string) => void calls.push(`mac:${method}`),
  };
  const chat = {
    on: (name: string, handler: (event: { engines: EngineDescriptor[] }) => void) => {
      if (name === "engine.changed") changed = handler;
      return () => undefined;
    },
    call: (method: string) => {
      calls.push(`cloud:${method}`);
      return method === "engine.list" ? listed : new Promise(() => undefined);
    },
  };
  const value = {
    client: home,
    engines: [mac],
    workspaces: [],
    status: "connected",
    connection: 1,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  // The window's own chats (no other computer): the window's list, and nothing asked.
  page = await mount(createElement(RuntimeFixture, { value, children: createElement(Models) }));
  expect(page.container.textContent).toBe("claude-agent: caveman-auto, claude-sonnet-4-6");
  expect(calls).toEqual([]);
  await page.unmount();
  // The Cloud chat: nothing offered until its computer says, then that computer's models.
  page = await mount(
    createElement(RuntimeFixture, {
      value,
      children: createElement(ChatClientScope, {
        client: chat as never,
        children: createElement(Models),
      }),
    }),
  );
  expect(page.container.textContent).toBe("none yet");
  expect(calls).toEqual(["cloud:engine.list"]);
  answer.resolve({
    engines: [
      withModels("claude-agent", ["claude-sonnet-4-6", "claude-opus-5"]),
      withModels("caveman", ["auto", "deepseek/deepseek-flash"]),
    ],
  });
  await settle();
  expect(page.container.textContent).toBe(
    "claude-agent: claude-sonnet-4-6, claude-opus-5 | caveman: auto, deepseek/deepseek-flash",
  );
  // The computer's list changes (a connection made on another device): the picker follows.
  const fewer = [withModels("claude-agent", ["claude-sonnet-4-6"])];
  await act(async () => changed?.({ engines: fewer }));
  expect(page.container.textContent).toBe("claude-agent: claude-sonnet-4-6");
  // Opened again while the computer does not answer (asleep, or waking): what it last said shows at once.
  await page.unmount();
  listed = new Promise(() => undefined);
  page = await mount(
    createElement(RuntimeFixture, {
      value,
      children: createElement(ChatClientScope, {
        client: chat as never,
        children: createElement(Models),
      }),
    }),
  );
  expect(page.container.textContent).toBe("claude-agent: claude-sonnet-4-6");
  expect(calls.filter((call) => call === "cloud:engine.list")).toHaveLength(2);
});

/** A Cloud chat's composer on Claude Agent: the model it starts on and the picker's rows, with their labels. */
function Picker() {
  const turn = useTurnChoice("claude-agent");
  const rows = chatPickerEngines(useEnginesThere()).flatMap((e) =>
    e.models.map(
      (m) => `${e.id}/${m.id} "${m.label}"${m.description ? ` (${m.description})` : ""}`,
    ),
  );
  return createElement(
    "output",
    null,
    rows.length === 0 ? "none yet" : `starts on ${turn.model?.id ?? "nothing"}; ${rows.join("; ")}`,
  );
}

test("Auto on a Cloud chat: offered when its own computer lists it, as its Cloud routes it there, and its words name no computer", async () => {
  // This Mac has no Auto of its own (its proxy holds no routing key); the Cloud computer's runtime lists Auto because
  // its Cloud said routes_auto, and starts new chats on it.
  const auto = {
    id: "caveman-auto",
    label: "Auto",
    efforts: [],
    description: "Caveman picks the model for each message",
  };
  const there = (
    models: ReadonlyArray<{ id: string; label: string; efforts: string[]; description?: string }>,
  ) =>
    ({
      id: "claude-agent",
      label: "Claude Agent",
      auth: { state: "signed_in", accounts: [] },
      models,
      default_model: models[0]!.id,
    }) as unknown as EngineDescriptor;
  const sonnet = { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: [] };
  const mac = there([sonnet]);
  // What the computer lists now, and everyone following its engine.changed (the composer and its picker each do).
  let listed = [there([auto, sonnet])];
  const following = new Set<(event: { engines: EngineDescriptor[] }) => void>();
  const changed = (engines: EngineDescriptor[]) => {
    listed = engines;
    for (const handler of following) handler({ engines });
  };
  const chat = {
    on: (name: string, handler: (event: { engines: EngineDescriptor[] }) => void) => {
      if (name !== "engine.changed") return () => undefined;
      following.add(handler);
      return () => following.delete(handler);
    },
    call: (method: string) =>
      method === "engine.list"
        ? Promise.resolve({ engines: listed })
        : new Promise(() => undefined),
  };
  const home = { on: () => () => undefined, call: async () => undefined };
  const value = {
    client: home,
    engines: [mac],
    workspaces: [],
    projects: [],
    status: "connected",
    connection: 1,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(RuntimeFixture, {
      value,
      children: createElement(ChatClientScope, {
        client: chat as never,
        children: createElement(Picker),
      }),
    }),
  );
  await settle();
  expect(page.container.textContent).toBe(
    'starts on caveman-auto; claude-agent/caveman-auto "Auto" (Caveman picks the model for each message); claude-agent/claude-sonnet-4-6 "Sonnet 4.6"',
  );
  // No computer is named: not its label, its id or "Cloud computer".
  expect(page.container.textContent).not.toMatch(/devbox|c1\b|Cloud computer/);
  // Its Cloud stops routing (an older Cloud, or the switch off): the computer lists no Auto, and neither does the picker.
  await act(async () => changed([there([sonnet])]));
  expect(page.container.textContent).toBe(
    'starts on claude-sonnet-4-6; claude-agent/claude-sonnet-4-6 "Sonnet 4.6"',
  );
});
