// New chat in a browser window Caveman Cloud serves: the window has no computer of its own, so a first visit is New
// chat on a repository Cloud sees, running in Cloud, on one of the agents Cloud runs. Nothing of the runtime the
// window quietly uses shows (its project, its branch, its agents), nothing is a dead end ("Add a project to start",
// "Choose a model"), and Send asks Cloud for the chat's place and holds the start for the window's one-line wait.
import { click, press, render, settle, type } from "./dom.test-support.ts";
import offer from "./settings/code-plans-offer.fixture.json";
import type { Client } from "@caveman-app/session-protocol/client";
import type { EngineDescriptor, Project } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { Where } from "./new-chat-bar.tsx";

const seen: { props: Record<string, unknown> | null; repo: Record<string, unknown> | null } = {
  props: null,
  repo: null,
};
vi.mock("./new-chat-bar.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./new-chat-bar.tsx")>();
  const NewChatBar = (props: Record<string, unknown>) => {
    seen.props = props;
    return createElement(real.NewChatBar as never, props as never);
  };
  // The repository's menu, which the question over the box opens (NewChat.tsx): what it was given.
  const RepoMenu = (props: Record<string, unknown>) => {
    seen.repo = props;
    return createElement(real.RepoMenu as never, props as never);
  };
  return { ...real, NewChatBar, RepoMenu };
});

const { RuntimeFixture, WebWindowFixture } = await import("../state/runtime.tsx");
const { keepDraft, flushDrafts } = await import("../state/composer-drafts.ts");
const { chooseRuntime, pendingStart, pendingStartParams } = await import("../state/cloud.ts");
const { CLOUD_OFF } = await import("../state/environment.ts");
const { chatPlaces } = await import("../state/sync/web-window.ts");
const { NewChatRoute } = await import("./NewChat.tsx");
const { CONNECT_REPOSITORY, PLAN_TO_SEND, planToSend, STILL_STARTING, webCloud, webWhere } =
  await import("./new-chat-web.ts");

/** The controls under `root` by their accessible name: a chip's is what it picks and what is picked. */
const named = (root: ParentNode, name: string | RegExp) =>
  [...root.querySelectorAll("button")].filter((b) =>
    typeof name === "string"
      ? b.getAttribute("aria-label") === name
      : name.test(b.getAttribute("aria-label") ?? ""),
  );

type Places = ReturnType<typeof chatPlaces>;
const STUDIO = {
  kind: "mac",
  name: "Studio",
  runtimeId: "rt-studio",
  computerId: "cmp-studio",
} as const;
const CLOUD = { kind: "cloud", name: "Cloud" } as const;
const places = (over: Partial<Places> = {}): Places => ({
  places: [CLOUD],
  cloud: "on",
  lines: [],
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  seen.props = null;
  seen.repo = null;
});

const READY_HINT = "/api/v1/code/computers/ready-hint";

test("where a new chat runs from a browser: the pick while it can take a chat, the Mac the window is on, else Cloud", () => {
  const both = places({ places: [CLOUD, STUDIO] });
  expect(webWhere(both, null, null)).toBe("cloud");
  expect(webWhere(both, "mac:rt-studio", null)).toBe("mac:rt-studio");
  // The window was put on a Mac (New chat on it, last time): New chat opens there.
  expect(webWhere(both, null, { id: "rt-studio", computer_driver: "local" })).toBe("mac:rt-studio");
  // On a Cloud computer (a chat started there): still Cloud, never that machine.
  expect(webWhere(both, null, { id: "rt-box", computer_driver: "cloud" })).toBe("cloud");
  // The Mac picked went off line: Cloud again.
  expect(webWhere(places(), "mac:rt-studio", null)).toBe("cloud");
  // Cloud off: the Mac on line; with none, no place, and the shell says why.
  const off = places({ places: [STUDIO], cloud: "off" });
  expect(webWhere(off, "cloud", null)).toBe("mac:rt-studio");
  expect(webWhere(places({ places: [], cloud: "off" }), null, null)).toBeNull();
  // Cloud has not said yet: offered meanwhile.
  expect(webWhere(places({ places: [], cloud: null }), null, null)).toBe("cloud");
  expect(webCloud(off)).toMatchObject({ chip: "Cloud", disabled: CLOUD_OFF });
  expect(webCloud(both).disabled).toBeUndefined();
});

const agent = (id: string, label: string, state = "signed_in") =>
  ({
    id,
    label,
    auth: { state, accounts: [] },
    capabilities: { images: true },
    access_modes: ["ask", "auto"],
    models: [{ id: "m1", label: "Model One", efforts: ["low"], default_effort: "low" }],
  }) as unknown as EngineDescriptor;
const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
/** The project of the runtime the window quietly uses: never New chat's in Cloud. */
const THEIRS = {
  id: "p-chaos",
  name: "chaos",
  path: "/home/caveman/chaos",
  repository: link("acme/chaos"),
} as Project;

async function webNewChat({
  repos = ["acme/api", "acme/web"],
  window = places(),
  home = false,
  text = "Rename the billing route",
  account = null,
}: {
  repos?: string[];
  window?: Places;
  home?: boolean;
  text?: string | null;
  /** The plan Caveman Cloud says the person holds ("free", or a plan bought); null: Cloud does not say (unread). */
  account?: { plan: string } | null;
} = {}) {
  const asked: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    asked.push({
      method,
      url,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    });
    if (method === "POST" && url === "/api/v1/code/workspaces")
      return Response.json({ id: "ws-1", computer_id: "cmp-1" });
    if (url === "/api/v1/code/workspaces")
      return Response.json({
        workspaces: repos.map((repo, i) => ({
          repo,
          updated_at: new Date(2026, 10, 9, 12 - i).toISOString(),
        })),
      });
    if (url === "/api/v1/projects") return Response.json({ data: [] });
    // What the plan serves, as Cloud lists it.
    if (url === "/api/v1/code/credits/models")
      return Response.json({
        basis: "list_price",
        models: [{ model: "anthropic/claude-sonnet-5-5" }, { model: "moonshot/kimi-k3" }],
      });
    if (account && url === "/api/v1/auth/me")
      return Response.json({ user: { email: "ana@example.com", role: "owner" } });
    if (account && url === "/api/v1/code/plans") return Response.json(offer);
    if (account && url === "/api/v1/code/credits")
      return Response.json(
        account.plan === "free"
          ? { plan: "free", balance_micros: 0 }
          : {
              plan: account.plan,
              balance_micros: 0,
              subscription: {
                plan: account.plan,
                seats: 1,
                status: "active",
                cancel_at_period_end: false,
                pending_update: false,
              },
            },
      );
    if (account && method === "POST" && url === "/api/v1/code/plan/checkout")
      return Response.json({ url: "https://checkout.example.com/s/1" });
    if (url === "/api/v1/code/environments/all") return Response.json({ environments: [] });
    return Response.json({ error: { message: "not here" } }, { status: 404 });
  });
  const calls: string[] = [];
  const client = {
    call: (method: string) => {
      calls.push(method);
      if (method === "project.branches")
        return Promise.resolve({
          checkout: "caveman/their-branch",
          branches: [{ name: "caveman/their-branch", current: true }],
        });
      return Promise.resolve({});
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as Client;
  // With a runtime the window quietly uses: a Cloud computer with a project of its own and no agent signed in.
  const value = (
    home
      ? {
          status: "connected",
          client,
          connection: 1,
          identity: { computerName: "Cloud" },
          workspaces: [],
          raw: new Map(),
          projects: [THEIRS],
          engines: [agent("claude-agent", "Claude Agent", "signed_out")],
          settings: { default_engine: "claude-agent", engines: {}, model_defaults: {} },
          refresh: async () => undefined,
          markSeen: () => undefined,
        }
      : {
          status: "unconfigured",
          client: null,
          connection: 0,
          identity: { computerName: "Cloud" },
          workspaces: [],
          raw: new Map(),
          projects: [],
          engines: [],
          settings: null,
          refresh: async () => undefined,
          markSeen: () => undefined,
        }
  ) as never;
  const usePlace = vi.fn();
  if (text !== null) {
    keepDraft("new-chat", { text, refs: [] });
    flushDrafts();
  }
  const web = {
    window: { kind: "app", failed: false, nothingYet: true },
    places: window,
    home: home ? { kind: "cloud", name: "Cloud" } : null,
    mac: { kind: "none" },
    usePlace,
  } as never;
  const shown = await render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ["/new"] },
        createElement(RuntimeFixture, {
          value,
          children: createElement(WebWindowFixture, {
            value: web,
            children: createElement(
              Routes,
              null,
              createElement(Route, { path: "/new", element: createElement(NewChatRoute) }),
            ),
          }),
        }),
      ),
    ),
  );
  await settle(4);
  const { act } = await import("react");
  const bar = () =>
    seen.props as {
      where?: Where;
      onWhere?: (where: Where) => void;
      computerName: string | null;
      macs: ReadonlyArray<{ id: string; name: string }>;
    };
  /** The repository the question names, and its menu's pick; null where the question names none of Cloud's. */
  const question = () => shown.host.querySelector("h1");
  const repo = () => {
    const name = question()?.querySelector("button")?.textContent ?? null;
    const menu = seen.repo as {
      all: string[];
      value: string | null;
      onChange: (repo: string) => void;
    } | null;
    return name !== null && menu?.value === name ? { name, onChange: menu.onChange } : null;
  };
  const said = () => (shown.host.textContent ?? "").replace(/\s+/g, " ");
  const send = async () => {
    await press(shown.host.querySelector("textarea"), "Enter");
    await settle(6);
  };
  /** What was asked of Cloud to make or change something; the ready hint a box with words in it sends is `hints`. */
  const posts = () => asked.filter((a) => a.method === "POST" && a.url !== READY_HINT);
  const hints = () => asked.filter((a) => a.url === READY_HINT);
  return { shown, asked, calls, bar, repo, question, said, send, posts, hints, usePlace, act };
}

test("words in the box with Cloud picked tell Cloud a chat is coming, once; an empty box says nothing", async () => {
  const empty = await webNewChat({ text: null });
  expect(empty.hints()).toEqual([]);
  expect(empty.posts()).toEqual([]);
  const written = await webNewChat();
  // The computer the chat will land on is on its way up while the person writes: one hint for the repository.
  expect(written.hints()).toEqual([
    { method: "POST", url: READY_HINT, body: { repo: "acme/api" } },
  ]);
  expect(written.posts()).toEqual([]);
});

test("a first visit: New chat on a repository Cloud sees, running in Cloud on an agent Cloud runs, with no dead end", async () => {
  const chat = await webNewChat();
  // The question names the repository; the box's foot, where it runs and its runs. No project, no branch, no
  // "this Mac", and nothing about agents to pick.
  expect(chat.question()?.textContent).toBe("What should we build in acme/api?");
  expect(chat.repo()?.name).toBe("acme/api");
  expect(named(chat.shown.host, /^Start from branch/)).toEqual([]);
  expect(named(chat.shown.host, "Runs in Cloud")).toHaveLength(1);
  expect(chat.bar().computerName).toBeNull();
  expect(chat.shown.host.querySelector("input[name='builders']")).toBeNull();
  // The model picker is the app's own, on Caveman's own pick: the window lists what Cloud does, with no computer to ask.
  expect(named(chat.shown.host, "Model: Auto, Caveman")).toHaveLength(1);
  expect(chat.said()).not.toContain("Choose a model");
  expect(chat.said()).not.toContain("Add a project");
  expect(chat.said()).not.toMatch(/\bengine\b|workspace|Cloud computer/i);
  // Reading the page woke nothing and made nothing.
  expect(chat.posts()).toEqual([]);
});

test("Send asks Cloud for the chat's place and holds the start for the window's wait, as a plain chat", async () => {
  const chat = await webNewChat();
  expect(chat.said()).not.toMatch(/at once|Estimating/);
  await chat.send();
  expect(chat.posts()).toEqual([
    {
      method: "POST",
      url: "/api/v1/code/workspaces",
      body: {
        title: "Rename the billing route",
        repo: "acme/api",
        base_branch: "",
        engine: "caveman",
        computer: { kind: "cloud" },
      },
    },
  ]);
  const start = pendingStart(sessionStorage)!;
  expect(start).toMatchObject({
    computer_id: "cmp-1",
    workspace_id: "ws-1",
    repo: "acme/api",
    engine: "caveman",
    task: "Rename the billing route",
  });
  expect("builders" in start).toBe(false);
  // It starts by itself once its place is up: the person made it here, no link did.
  expect(start.from_link).toBeUndefined();
  expect(pendingStartParams(start, "r1", true)).toMatchObject({
    placed_workspace_id: "ws-1",
    task: { text: "Rename the billing route" },
  });
  // The words went with the start: the box is empty, and a second message does not take the first one's place.
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("");
  await type(chat.shown.host.querySelector("textarea"), "And another thing");
  await chat.send();
  expect(chat.posts()).toHaveLength(1);
  expect(chat.said()).toContain(STILL_STARTING);
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("And another thing");
  expect(pendingStart(sessionStorage)?.task).toBe("Rename the billing route");
});

test("a Free account's Send opens Unlock with every plan: closing it gives the message back, a plan bought sends it", async () => {
  const account = { plan: "free" };
  const chat = await webNewChat({ account });
  const sheet = () => document.querySelector("[role='dialog']");
  const workspaces = () => chat.posts().filter((p) => p.url === "/api/v1/code/workspaces");
  await chat.send();
  // The full offer, every plan side by side, over New chat; nothing asked of Cloud's computers yet.
  expect(sheet()?.textContent).toContain("Unlock more");
  expect(
    [...sheet()!.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Unlock")
      .length,
  ).toBeGreaterThan(1);
  expect(workspaces()).toEqual([]);
  // Closed with no plan: the words are back in the box, with one line on why.
  await press(sheet(), "Escape");
  await settle(6);
  expect(sheet()).toBeNull();
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("Rename the billing route");
  expect(chat.said()).toContain(PLAN_TO_SEND);
  expect(workspaces()).toEqual([]);
  // Sent again, a plan picked and paid for in its tab: the message goes the moment the account holds the plan.
  const tab = { close: () => undefined, location: { href: "" }, opener: null as unknown };
  vi.stubGlobal("open", () => tab);
  await chat.send();
  await click(
    [...sheet()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Unlock"),
  );
  await settle(6);
  const bought = chat.posts().find((p) => p.url === "/api/v1/code/plan/checkout")?.body
    ?.plan as string;
  expect(tab.location.href).toBe("https://checkout.example.com/s/1");
  expect(workspaces()).toEqual([]);
  account.plan = bought;
  await chat.act(async () => void window.dispatchEvent(new Event("focus")));
  await settle(8);
  expect(workspaces()).toHaveLength(1);
  expect(pendingStart(sessionStorage)?.task).toBe("Rename the billing route");
});

test("an account that holds a plan sends at once, with no sheet", async () => {
  const chat = await webNewChat({ account: { plan: "pro" } });
  await chat.send();
  expect(document.querySelector("[role='dialog']")).toBeNull();
  expect(chat.posts().filter((p) => p.url === "/api/v1/code/workspaces")).toHaveLength(1);
});

test("the repository is picked in the question and the agent in the box, and the picks are kept for the next chat", async () => {
  const chat = await webNewChat();
  await chat.act(async () => chat.repo()!.onChange("acme/web"));
  expect(chat.repo()?.name).toBe("acme/web");
  await chat.send();
  expect(chat.posts()[0]?.body).toMatchObject({ repo: "acme/web", engine: "caveman" });
  expect(localStorage.getItem("caveman.new-chat.repo")).toBe("acme/web");
  await chat.shown.unmount();
});

test("Cloud sees no repository: one button says where to connect one, and a send keeps the message", async () => {
  const chat = await webNewChat({ repos: [] });
  const connect = [...chat.shown.host.querySelectorAll("a")].find((a) =>
    a.textContent?.includes(CONNECT_REPOSITORY),
  );
  expect(connect?.getAttribute("href")).toBe("/cave-agent/code");
  expect(chat.said()).not.toContain("Add a project");
  await chat.send();
  expect(chat.posts()).toEqual([]);
  expect(chat.said()).toContain(`${CONNECT_REPOSITORY}.`);
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("Rename the billing route");
});

test("the runtime the window quietly uses lends New chat no project and no branch, and asks nobody to set an agent up", async () => {
  const chat = await webNewChat({ home: true });
  expect(chat.repo()?.name).toBe("acme/api");
  expect(chat.said()).not.toContain("chaos");
  expect(chat.said()).not.toContain("caveman/their-branch");
  expect(chat.calls).not.toContain("project.branches");
  // Its agent is signed out there: that is not this chat's business, and nothing asks to set one up.
  expect(chat.said()).not.toMatch(/Set up an (agent|engine)/);
  expect(named(chat.shown.host, "Model: Auto, Caveman")).toHaveLength(1);
});

test("a model picked in the picker is the chat's: Cloud's start names it by the id its agent runs it by, and it is kept", async () => {
  const chat = await webNewChat();
  // The picker lists the plan's models under Caveman's Auto; each row picks its agent and model at once.
  await click(named(chat.shown.host, "Model: Auto, Caveman")[0]!);
  await settle(4);
  const row = [...document.querySelectorAll("[role='option']")].find(
    (o) => o.querySelector(".truncate")?.textContent === "Kimi K3",
  );
  expect(row).toBeDefined();
  await click(row);
  await settle(2);
  expect(named(chat.shown.host, "Model: Kimi K3, Caveman")).toHaveLength(1);
  await chat.send();
  // The start holds the pick for the chat's first turn; Auto would have named none.
  expect(JSON.parse(sessionStorage.getItem("caveman.cloud.start") ?? "{}")).toMatchObject({
    engine: "caveman",
    options: { model: "caveman/moonshotai/kimi-k3" },
  });
  expect(localStorage.getItem("caveman.new-chat.model")).toBe("caveman/moonshotai/kimi-k3");
  await chat.shown.unmount();
});

test("a window on a Cloud computer names no model the person did not pick: the box shows the one the chat starts on", async () => {
  localStorage.setItem("caveman.new-chat.agent", "claude-agent");
  // Kept from a window with no computer: the stand-in for Claude Agent's own model, which this computer's list replaces.
  localStorage.setItem("caveman.new-chat.model", "default");
  const chat = await webNewChat({ home: true });
  expect(named(chat.shown.host, "Model: Model One, Claude Agent")).toHaveLength(1);
  await chat.send();
  // The computer starts on its own default (its project's, its Settings'); a model named here would override it.
  const start = pendingStart(sessionStorage)!;
  expect(start).toMatchObject({ engine: "claude-agent", task: "Rename the billing route" });
  expect(start.options?.model).toBeUndefined();
  await chat.shown.unmount();
});

test("a Mac on line is a place by its name; picking it puts the window on that Mac, and Cloud lets it go", async () => {
  const chat = await webNewChat({ window: places({ places: [CLOUD, STUDIO] }) });
  expect(chat.bar().macs).toEqual([{ id: "rt-studio", name: "Studio" }]);
  await chat.act(async () => chat.bar().onWhere!("mac:rt-studio"));
  expect(chat.usePlace).toHaveBeenLastCalledWith(STUDIO);
  expect(named(chat.shown.host, "Runs on Studio")).toHaveLength(1);
  // On a Mac the chat is that Mac's runtime's to make: no repository of Cloud's, no picker of Cloud's models.
  expect(chat.repo()).toBeNull();
  expect(named(chat.shown.host, "Model: Auto, Caveman")).toEqual([]);
  // The window is not on that Mac yet: a send says so and makes nothing anywhere.
  await chat.send();
  expect(chat.posts()).toEqual([]);
  expect(chat.said()).toContain("Can't reach Studio yet. Try again.");
  await chat.act(async () => chat.bar().onWhere!("cloud"));
  expect(chat.usePlace).toHaveBeenLastCalledWith(CLOUD);
  expect(named(chat.shown.host, "Runs in Cloud")).toHaveLength(1);
});

test("Cloud off and a Mac on line: New chat opens on the Mac; with no place at all a send says why", async () => {
  chooseRuntime(localStorage, null);
  const onMac = await webNewChat({ window: places({ places: [STUDIO], cloud: "off" }) });
  expect(onMac.bar().where).toBe("mac:rt-studio");
  await onMac.shown.unmount();

  const none = await webNewChat({
    window: places({
      places: [],
      cloud: "off",
      lines: [
        CLOUD_OFF,
        "To use your Mac here, turn on Settings > Remote control in Caveman Code on it.",
      ],
    }),
  });
  expect(none.bar().where).toBeUndefined();
  expect(none.said()).not.toContain("Add a project");
  expect(named(none.shown.host, /^Agent:/)).toEqual([]);
  await none.send();
  expect(none.posts()).toEqual([]);
  expect(none.said()).toContain(CLOUD_OFF);
});

test("what a send says after Unlock closes names the free way where this browser can get the desktop app", () => {
  // Mac: the free way is the app on the person's own subscriptions and keys.
  expect(planToSend(true)).toBe(
    "Chats in Cloud come with a plan. Pick one to send this, or run it free on your computer.",
  );
  // Elsewhere there is no free way to point at: no promise of one.
  expect(planToSend(false)).toBe("Chats in Cloud come with a plan. Pick one to send this.");
});
