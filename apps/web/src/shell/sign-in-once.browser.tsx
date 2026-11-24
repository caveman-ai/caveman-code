// Settings > Models & keys, "sign in once, everywhere", in every state it has, on fixture engines through the
// production page: nothing connected, a sign-in waiting (this window's and another window's), connected everywhere,
// used up with and without something else to run on, expiring, expired, turned off by the admin, an agent's row
// opened, and a page attached to Cloud with no Mac app behind it. No runtime and no Cloud: a fixture client answers
// the calls the page makes. It checks what it draws, and prints PASS or what is missing.
// /src/shell/sign-in-once.browser.html?view=<state> (?light for the light theme). States: nothing | signed-out |
// waiting | other-window | code | everywhere | open | used-up | used-up-alone | expiring | expired | off |
// default-not-ready | cloud | cloud-empty | cloud-read-only | chat (the one line a chat in Cloud shows for each).
import type { EngineAccount, EngineDescriptor } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  ConnectionsCloudContext,
  RuntimeFixture,
  type RuntimeContextValue,
} from "../state/runtime.tsx";
import type { CloudConnection, CloudConnections } from "../state/sync/model-connections.ts";
import "../styles.css";
import { EngineSignInCard } from "../components/cloud/EngineSignIn.tsx";
import { forgetConnects } from "../routes/settings/Connections.tsx";
import { MANAGE } from "../routes/settings/connections-model.ts";
import { ModelsAndKeysSettings } from "../routes/settings/ModelsAndKeys.tsx";
import { SettingsPage } from "../routes/settings/rows.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "nothing";
if (query.has("light")) document.documentElement.classList.remove("dark");

const DAY = 24 * 3_600_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY - 60_000).toISOString();
/** 11:08 PM tonight, or tomorrow's once it has passed. */
const tonight = () => {
  const at = new Date();
  at.setHours(23, 8, 0, 0);
  return new Date(at.getTime() > Date.now() ? at.getTime() : at.getTime() + DAY).toISOString();
};

const own = (id: string, label: string, a: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  label,
  kind: "login",
  active: true,
  where: "this_mac",
  ...a,
});
const connection = (
  id: string,
  label: string,
  c: Partial<NonNullable<EngineAccount["connection"]>> = {},
  a: Partial<EngineAccount> = {},
): EngineAccount => ({
  id: `connection:${id}`,
  label,
  kind: "login",
  active: false,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", ...c },
  ...a,
});
const CAPABILITIES = {
  structured: true,
  resume_across_machines: true,
  steer: true,
  fork: true,
  approvals: true,
  plans: true,
  subagents: true,
  images: true,
  mcp: true,
  tool_hooks: true,
};
const engine = (
  id: string,
  label: string,
  models: ReadonlyArray<string>,
  accounts: ReadonlyArray<EngineAccount>,
  auth: Partial<EngineDescriptor["auth"]> = {},
): EngineDescriptor =>
  ({
    id,
    label,
    capabilities: CAPABILITIES,
    models: models.map((m) => ({ id: m, label: m })),
    auth: { state: accounts.length > 0 ? "signed_in" : "signed_out", accounts, ...auth },
  }) as unknown as EngineDescriptor;
type Auth = Partial<EngineDescriptor["auth"]>;
const claude = (accounts: ReadonlyArray<EngineAccount>, auth: Auth = { everywhere: "available" }) =>
  engine("claude-agent", "Claude Agent", ["Fable 5.2", "Opus 5.5", "Sonnet 5.5"], accounts, auth);
const codex = (accounts: ReadonlyArray<EngineAccount>, auth: Auth = { everywhere: "available" }) =>
  engine("codex", "Codex", ["GPT-6 Luna", "GPT-6 Sol"], accounts, auth);
const cursor = (auth: Auth = {}) => engine("cursor", "Cursor", [], [], auth);

const CLAUDE_OWN = own("claudeAgent:default", "ada@analytical.test");
const CHATGPT_OWN = own("codex-account-chatgpt", "ChatGPT Pro");
const CLAUDE_PLAN = connection("c1", "Claude plan", {}, { active: true });
const CHATGPT_PLAN = connection("g1", "ChatGPT plan", { kind: "chatgpt_plan" }, { active: true });
const ANTHROPIC_KEY = connection("k1", "Anthropic key", { kind: "api_key" }, { kind: "api_key" });
const aside = (a: EngineAccount): EngineAccount => ({ ...a, active: false });
const THERE = { everywhere: "manage", no_sign_in_here: true } as const;

/** A press: a button by its name, on an agent's row when one is named ("Claude Agent > Use everywhere"). */
type Press = string;

interface Case {
  readonly engines: ReadonlyArray<EngineDescriptor>;
  /** The agent new chats start on. */
  readonly start?: string;
  /** Buttons pressed in turn once the page is up. */
  readonly press?: ReadonlyArray<Press>;
  /** Cloud's list, for a page that holds the person's own Cloud session; null: this device holds none. */
  readonly cloud?: ReadonlyArray<CloudConnection> | null;
  /** What the page must say. */
  readonly says: ReadonlyArray<string>;
  readonly never?: ReadonlyArray<string>;
}

/** What the page never says, whatever the state: the old status prefix, the old sheet, the old buttons, a pointer to nothing. */
const NEVER = [
  "Ready ·",
  "and 1 more",
  "Use first",
  "Done",
  "Your agents",
  "Manage",
  "below",
  "Approve in your browser.",
  "sealed",
  "Claude Code",
  "Cloud computer",
];

const CASES: Record<string, Case> = {
  // Signed in to Caveman, nothing connected: each plan is only this Mac's, and one button makes it work everywhere.
  nothing: {
    engines: [claude([CLAUDE_OWN]), codex([CHATGPT_OWN]), cursor()],
    says: [
      "This Mac only",
      "Use everywhere",
      "More agents",
      "New chats start on",
      "Add local subscriptions",
    ],
    never: [...NEVER, "Everywhere ·"],
  },
  // Nothing to run on at all: one status and the one button that starts the sign-in.
  "signed-out": {
    engines: [
      claude([], { everywhere: "available", state: "signed_out" }),
      codex([], { everywhere: "available", state: "signed_out" }),
      cursor(),
    ],
    says: ["Not signed in", "Sign in"],
    never: [...NEVER, "This Mac only", "Use everywhere"],
  },
  // Use everywhere goes straight to the browser: the row waits, with the page as a link and Cancel. No sheet. Under
  // the line, the field for the code Claude's page shows when it cannot hand the sign-in back to this Mac.
  waiting: {
    engines: [claude([CLAUDE_OWN]), codex([CHATGPT_OWN]), cursor()],
    press: ["Claude Agent > Use everywhere"],
    says: [
      "Connecting… approve in the browser on this Mac",
      "Open the sign-in page",
      "Finish",
      "Cancel",
    ],
    never: [...NEVER, "Connect Claude"],
  },
  // A sign-in another window started: this one watches it, and has nothing to cancel.
  "other-window": {
    engines: [
      claude([CLAUDE_OWN], {
        everywhere: "available",
        connecting: {
          request_id: "another-window",
          since: new Date(Date.now() - 42_000).toISOString(),
        },
      }),
      codex([CHATGPT_OWN]),
      cursor(),
    ],
    says: ["Connecting… approve in the browser on this Mac"],
    never: [...NEVER, "Cancel", "Open the sign-in page"],
  },
  code: {
    engines: [claude([CLAUDE_OWN]), codex([CHATGPT_OWN]), cursor()],
    press: ["Codex > Use everywhere", "Codex > Use a code instead"],
    says: ["Enter ABCD-1234 on the sign-in page.", "Open the sign-in page", "Cancel"],
    // Codex's code is typed on the page, never here.
    never: [...NEVER, "Finish"],
  },
  everywhere: {
    engines: [
      claude([CLAUDE_PLAN, aside(CLAUDE_OWN)]),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    says: ["Everywhere"],
    never: [...NEVER, "Use everywhere", "This Mac only"],
  },
  // An agent's row opened: its plans and keys in the order they are tried, each with one menu.
  open: {
    engines: [
      claude([CLAUDE_PLAN, ANTHROPIC_KEY, aside(CLAUDE_OWN)]),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    press: ["Claude Agent"],
    says: [
      "Claude plan",
      "Anthropic key",
      "ada@analytical.test",
      "Everywhere",
      "This Mac",
      "Models",
      "Compact idle chats",
    ],
    never: [...NEVER, "Switch account", "Add login", "Another Claude login", "Reconnect"],
  },
  // The plan is used up and a key carries on: the status says until when, and what runs now.
  "used-up": {
    engines: [
      claude([
        connection("c1", "Claude plan", { status: "used_up", used_up_until: tonight() }),
        { ...ANTHROPIC_KEY, active: true },
        aside(CLAUDE_OWN),
      ]),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    says: ["Used up until", "11:08 PM · now on your Anthropic key"],
    never: [...NEVER, "Reconnect"],
  },
  // Used up with nothing else connected: this Mac's own login carries on here.
  "used-up-alone": {
    engines: [
      claude([
        connection("c1", "Claude plan", { status: "used_up", used_up_until: tonight() }),
        CLAUDE_OWN,
      ]),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    says: ["Used up until", "11:08 PM · now on this Mac's login"],
    never: [...NEVER, "Anthropic key"],
  },
  // Said only from a week out, with the one button.
  expiring: {
    engines: [
      claude([
        connection("c1", "Claude plan", { expires_at: inDays(5) }, { active: true }),
        aside(CLAUDE_OWN),
      ]),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    says: ["Expires in 5 days", "Reconnect"],
    never: NEVER,
  },
  expired: {
    engines: [
      claude([connection("c1", "Claude plan", { status: "expired" }), CLAUDE_OWN]),
      codex([
        connection("g1", "ChatGPT plan", { kind: "chatgpt_plan", status: "revoked" }),
        CHATGPT_OWN,
      ]),
      cursor(),
    ],
    says: ["Expired · now on this Mac's login", "Reconnect"],
    never: [...NEVER, "No longer accepted"],
  },
  off: {
    engines: [
      claude([connection("c1", "Claude plan", { off: true }), CLAUDE_OWN], { everywhere: "off" }),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    says: ["Turned off by your admin · runs on this Mac's login"],
    never: [...NEVER, "Use everywhere", "Reconnect", "Switched off"],
  },
  // The agent new chats start on has nothing to run on: its row says so, and points nowhere.
  "default-not-ready": {
    engines: [
      claude([], { everywhere: "available", state: "signed_out" }),
      codex([CHATGPT_PLAN, aside(CHATGPT_OWN)]),
      cursor(),
    ],
    start: "claude-agent",
    says: ["Claude Agent isn't set up. Pick another.", "Not signed in"],
    never: NEVER,
  },
  // Attached to Cloud, with the person's own Cloud session on this device: no sign-in is made here.
  cloud: {
    engines: [
      claude([CLAUDE_PLAN, ANTHROPIC_KEY], THERE),
      codex([], { ...THERE, state: "signed_out" }),
      cursor({ no_sign_in_here: true }),
      engine(
        "caveman",
        "Caveman",
        [],
        [connection("k1", "Anthropic key", { kind: "api_key" }, { kind: "api_key", active: true })],
        { no_sign_in_here: true, state: "api_key" },
      ),
    ],
    press: ["Codex"],
    start: "claude-agent",
    cloud: [
      {
        id: "c1",
        kind: "claude_plan",
        provider: "anthropic",
        label: "",
        position: 0,
        status: "ready",
        serves: ["claude-agent"],
      },
      {
        id: "k1",
        kind: "api_key",
        provider: "anthropic",
        label: "",
        position: 1,
        status: "ready",
        serves: ["claude-agent", "caveman"],
      },
    ],
    says: ["Everywhere", "Not signed in · connect from the desktop app", "Models"],
    never: [
      ...NEVER,
      "Add local subscriptions",
      "More agents",
      "Set up",
      "Sign in",
      "API keys and servers",
      MANAGE.noMac,
      "ChatGPT plan",
      "isn't set up",
    ],
  },
  // No Mac: a Claude plan can still be added by the line its own CLI prints, behind one click.
  "cloud-empty": {
    engines: [
      claude([], { ...THERE, state: "signed_out" }),
      codex([], { ...THERE, state: "signed_out" }),
      cursor({ no_sign_in_here: true }),
    ],
    press: ["Claude Agent", MANAGE.noMac],
    cloud: [],
    says: [
      MANAGE.fromMac,
      "Run claude setup-token on any computer and paste the token here.",
      "Connect",
    ],
    never: [...NEVER, "Add local subscriptions", "Switch account", "Add login", "Set up"],
  },
  // This device holds no Cloud session: the page shows the state and offers nothing it would be refused.
  "cloud-read-only": {
    engines: [
      claude([connection("c1", "Claude plan", { status: "expired" })], {
        ...THERE,
        state: "signed_out",
      }),
      codex([CHATGPT_PLAN], THERE),
      cursor({ no_sign_in_here: true }),
    ],
    press: ["Claude Agent"],
    start: "codex",
    cloud: null,
    says: ["Expired · reconnect from the desktop app", "Claude plan", "Everywhere · Expired"],
    never: [...NEVER, "Remove", "Reconnect", "Sign in", "Set up", MANAGE.noMac, MANAGE.fromMac],
  },
};

/**
 * A chat in Cloud whose agent has nothing to run on there: the one line it shows, for each reason, as Cloud reports
 * the agent (nothing is signed in there). The window's own Mac is where its button starts the sign-in.
 */
const IN_CHAT: ReadonlyArray<{
  id: string;
  note: string;
  engine: EngineDescriptor;
  says: ReadonlyArray<string>;
  never?: ReadonlyArray<string>;
}> = [
  {
    id: "connect",
    note: "Nothing connected",
    engine: claude([], { ...THERE, state: "signed_out" }),
    says: ["Claude isn't connected for Cloud.", "Connect Claude"],
  },
  {
    id: "connect-chatgpt",
    note: "Codex, nothing connected",
    engine: codex([], { ...THERE, state: "signed_out" }),
    says: ["ChatGPT isn't connected for Cloud.", "Connect ChatGPT"],
  },
  {
    id: "expired",
    note: "The plan's sign-in ended",
    engine: claude([connection("c1", "Claude plan", { status: "expired" })], {
      ...THERE,
      state: "signed_out",
    }),
    says: ["Your Claude sign-in expired.", "Reconnect"],
  },
  {
    id: "used-up",
    note: "The plan is used up and nothing else is connected",
    engine: claude(
      [connection("c1", "Claude plan", { status: "used_up", used_up_until: tonight() })],
      { ...THERE, state: "signed_out" },
    ),
    says: ["Claude plan used up until", "11:08 PM."],
    never: ["Connect Claude", "Reconnect"],
  },
  {
    id: "admin-off",
    note: "The admin turned Claude plans off",
    engine: claude([connection("c1", "Claude plan", { off: true })], {
      everywhere: "off",
      no_sign_in_here: true,
      state: "signed_out",
    }),
    says: [
      "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
    ],
    never: ["Connect Claude", "Reconnect"],
  },
];
const inChat = view === "chat";

const picked: Case = inChat
  ? { engines: [claude([CLAUDE_OWN]), codex([CHATGPT_OWN]), cursor()], says: [] }
  : (CASES[view] ?? CASES.nothing!);

/** A runtime that answers what the page asks: a sign-in opens its page and is never approved. */
const client = {
  on: () => () => undefined,
  call: async (method: string, params: { device_code?: boolean; engine?: string }) => {
    if (method === "engine.providers") return { providers: [] };
    if (method === "web.keys.status") return { providers: [], credits: false };
    if (method === "engine.account.add")
      return {
        accounts: [],
        sign_in: params.device_code
          ? {
              command: "",
              message: "",
              url: "https://auth.openai.com/codex/device",
              code: "ABCD-1234",
            }
          : {
              command: "",
              message: "",
              url:
                params.engine === "codex"
                  ? "https://auth.openai.com/oauth/authorize"
                  : "https://claude.ai/oauth/authorize",
            },
      };
    if (method === "engine.account.complete") return new Promise(() => undefined);
    return { accounts: [] };
  },
};
const runtime = {
  status: "connected",
  client,
  connection: 1,
  engines: picked.engines,
  settings: { default_engine: picked.start ?? "codex" },
  workspaces: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;

/** Cloud's list, kept here, as a page holding the person's own Cloud session writes to it. */
function cloudOf(start: ReadonlyArray<CloudConnection>): CloudConnections {
  let connections = [...start];
  const list = async () => ({ connections, kinds: {} });
  return {
    list,
    addClaudePlan: async () => {
      connections = [
        ...connections,
        {
          id: "new",
          kind: "claude_plan",
          provider: "anthropic",
          label: "",
          position: connections.length,
          status: "ready",
          serves: ["claude-agent"],
        },
      ];
      return list();
    },
    moveToTop: async (id) => {
      connections = [
        connections.find((c) => c.id === id)!,
        ...connections.filter((c) => c.id !== id),
      ].map((c, position) => ({ ...c, position }));
      return list();
    },
    remove: async (id) => {
      connections = connections.filter((c) => c.id !== id);
      return list();
    },
  };
}

forgetConnects();
const host = document.getElementById("sign-in-once")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <RuntimeFixture value={runtime}>
        <ConnectionsCloudContext.Provider value={picked.cloud ? cloudOf(picked.cloud) : null}>
          <TooltipProvider>
            <main className="p-5 text-foreground max-md:p-0">
              {inChat ? (
                <div
                  data-case="chat"
                  className="flex w-full max-w-[720px] flex-col gap-2 max-md:px-4"
                >
                  {IN_CHAT.map((c) => (
                    <figure key={c.id} data-chat={c.id} className="m-0">
                      <figcaption className="mt-6 text-[12px] text-[hsl(var(--subtle-foreground))]">
                        {c.note}
                      </figcaption>
                      {/* Under the last message of the chat, where the composer's own column is. */}
                      <EngineSignInCard
                        workspaceId={`w-${c.id}`}
                        engine={c.engine as EngineDescriptor & { id: "claude-agent" | "codex" }}
                      />
                    </figure>
                  ))}
                </div>
              ) : (
                /*
                Settings' own pane as routes/Settings.tsx draws a list page: the bar that names it, then the page across
                the pane. It follows the window: as wide as the pane beside Settings' sidebar, or the whole narrow window.
              */
                <section
                  data-case={view}
                  className="w-full max-w-[1032px] overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)] max-md:rounded-none max-md:border-0 max-md:shadow-none"
                >
                  <header className="flex h-12 items-center gap-1.5 border-b border-border px-5 text-[15px] max-md:px-4">
                    <span className="text-muted-foreground max-md:hidden">Settings</span>
                    <span className="text-[hsl(var(--subtle-foreground))] max-md:hidden">/</span>
                    <h1 className="font-medium">Models & keys</h1>
                  </header>
                  <div className="px-8 pt-4 max-md:px-4 max-md:pt-2">
                    <SettingsPage title="Models & keys" wide>
                      <ModelsAndKeysSettings />
                    </SettingsPage>
                  </div>
                </section>
              )}
            </main>
          </TooltipProvider>
        </ConnectionsCloudContext.Provider>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const said = () => (document.querySelector("[data-case]")?.textContent ?? "").replace(/\s+/g, " ");
const named = (b: Element, name: string) =>
  b.textContent?.trim() === name || b.getAttribute("aria-label") === name;
/** An agent's row and what it opened onto: from the row whose name is the agent's, up to the next agent's. */
function agentButtons(agent: string): HTMLButtonElement[] {
  const rows = [...document.querySelectorAll("[data-case] [role='group'] > *")];
  const isRow = (el: Element) => el.querySelector(":scope > div > button[aria-expanded]") !== null;
  const at = rows.findIndex(
    (el) =>
      isRow(el) &&
      el.querySelector(":scope > div > button[aria-expanded]")?.textContent?.trim() === agent,
  );
  if (at < 0) return [];
  const end = rows.findIndex((el, i) => i > at && isRow(el));
  return rows
    .slice(at, end < 0 ? rows.length : end)
    .flatMap((el) => [...el.querySelectorAll("button")]);
}

async function run() {
  const problems: string[] = [];
  for (const entry of picked.press ?? []) {
    const [agent, name] = entry.includes(" > ")
      ? (entry.split(" > ") as [string, string])
      : [undefined, entry];
    let button: HTMLButtonElement | undefined;
    for (let i = 0; i < 30 && !button; i++) {
      const among = agent
        ? agentButtons(agent)
        : [...document.querySelectorAll<HTMLButtonElement>("[data-case] button")];
      button = among.find((b) => named(b, name));
      if (!button) await tick();
    }
    if (button) button.click();
    else problems.push(`no button ${entry}`);
    await tick(120);
  }
  await tick(200);
  for (const c of inChat ? IN_CHAT : []) {
    const line = (document.querySelector(`[data-chat="${c.id}"]`)?.textContent ?? "").replace(
      /\s+/g,
      " ",
    );
    for (const text of c.says)
      if (!line.includes(text)) problems.push(`${c.id} is missing: ${text}`);
    for (const text of [...(c.never ?? []), ...NEVER, "Settings >", "API key", "Sign in to"])
      if (line.includes(text)) problems.push(`${c.id} must not say: ${text}`);
    // One line and at most one button.
    if (
      (document.querySelectorAll(`[data-chat="${c.id}"] button, [data-chat="${c.id}"] a`).length ??
        0) > 1
    )
      problems.push(`${c.id} has more than one button`);
  }
  for (const text of picked.says) if (!said().includes(text)) problems.push(`missing: ${text}`);
  for (const text of picked.never ?? [])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // Spend never shows here, and Claude's engine is never called Claude Code.
  if (/\$\d/.test(said())) problems.push("a dollar amount is on the page");
  // One status per agent's row: never two dots on a row.
  for (const row of document.querySelectorAll("[data-case] [role='group'] > div"))
    if (row.querySelectorAll(":scope > div > span > span[aria-hidden]").length > 1)
      problems.push("a row says two states");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
}
void run();
