// NOTE: not run by the suite, and its cases predate the decision that the sync prompt never opens by itself:
// they expect it over the app. They need rework to open it from Getting started's sync step first.
// On This Mac: what stands between its chats and the person's other devices, through the production shell on fixture
// state. Sync is asked once where nobody can miss it; Not now moves it to Getting started, whose step opens it again;
// a device whose "Allow?" was closed unanswered waits there too. No runtime and no Cloud: a fixture client answers
// the calls the shell makes.
// /src/shell/sync-ask.browser.html?view=<state> (?light for the light theme). States: ask | later | reopened |
// turned-on | device | device-later | done-later | on-settings | to-settings | from-settings | round-trip. It checks what it draws, and prints PASS or what is missing.
import type { CloudStatus, DeviceList, EngineDescriptor } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";
import { AppShell } from "./AppShell.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "ask";
if (query.has("light")) document.documentElement.classList.remove("dark");

interface Case {
  /** What the person said to the prompt before this load. */
  readonly said?: "later" | "never";
  /** Getting started as this device kept it. */
  readonly card?: "open" | "folded" | "hidden" | "done";
  /** A browser asking to control this Mac. */
  readonly device?: boolean;
  /** The page the window is on; New chat unless named. */
  readonly path?: string;
  /** Where the window goes once the page is up, in turn (the Settings menu item works with a question open). */
  readonly goes?: ReadonlyArray<string>;
  /** Pressed in turn once the page is up, by the words on the button. */
  readonly does?: ReadonlyArray<string>;
  readonly says: ReadonlyArray<string>;
  readonly never?: ReadonlyArray<string>;
}

const TITLE = "Your chats on every device";
const STEP = "Sync chats to your devices";
const ALLOW = "Chrome on Mac wants to control this Mac. Allow?";

const CASES: Record<string, Case> = {
  // After the first run, before anything is copied: the one question, over the app.
  ask: { says: [TITLE, "Turn on sync", "Not now"], never: [STEP] },
  // Settings is its own page with the shell put away, and the one page the first run lets through: no question
  // comes up over it.
  "on-settings": { path: "/settings/general", says: [], never: [TITLE, "Turn on sync"] },
  // Settings opened while the question is up: it goes with the shell, unanswered, and is back with it.
  "to-settings": { goes: ["/settings/general"], says: [], never: [TITLE, "Turn on sync"] },
  "from-settings": { path: "/settings/general", goes: ["/new"], says: [TITLE, "Turn on sync"] },
  // There and back with the question up: leaving for Settings is not an answer, so it is asked again, and
  // nothing was moved to Getting started.
  "round-trip": {
    goes: ["/settings/general", "/new"],
    says: [TITLE, "Turn on sync"],
    never: [STEP],
  },
  // Not now: the question is gone, and its step leads Getting started with the amber dot.
  later: { does: ["Not now"], says: [STEP, "Getting started", "Set up an engine"], never: [TITLE] },
  // The step opens the question again.
  reopened: { said: "later", does: [STEP], says: [TITLE, "Turn on sync"] },
  // Turned on: the setting is written, and the step is ticked.
  "turned-on": { does: ["Turn on sync"], says: [`${STEP}, done`], never: [TITLE] },
  // A browser asks: the Mac's own question.
  device: { said: "never", device: true, says: [ALLOW, "it shows TQ4-K9P"] },
  // Closed unanswered: it waits in Getting started, and its step asks again.
  "device-later": {
    said: "never",
    device: true,
    does: ["Close"],
    says: ["Allow Chrome on Mac"],
    never: [ALLOW],
  },
  // Setup finished long ago: what was put off still has its place at the sidebar's foot.
  "done-later": {
    said: "later",
    card: "done",
    says: [STEP, "Getting started"],
    never: [TITLE, "Set up an engine"],
  },
};
const picked = CASES[view] ?? CASES.ask!;

// No first-run flag: an installation from before it, whose chats let it skip the first run, is asked too.
localStorage.removeItem("caveman.firstRunDone");
localStorage.removeItem("caveman.tourPending");
if (picked.said) localStorage.setItem("caveman.syncAsk", picked.said);
else localStorage.removeItem("caveman.syncAsk");
if (picked.card) localStorage.setItem("caveman.gettingStarted", picked.card);
else localStorage.removeItem("caveman.gettingStarted");

let synced = false;
const changed = new Set<(status: CloudStatus) => void>();
const status = (): CloudStatus => ({
  state: "connected",
  runtime_id: "rt-studio",
  account: { email: "ada@acme.dev", organization_name: "Acme" },
  sync: synced ? { available: true, on: true } : { available: true, on: false, ask: true },
});
const devices: DeviceList = {
  required: true,
  devices: [],
  requests: picked.device
    ? [
        {
          device_id: "d-chrome",
          name: "Chrome on Mac",
          code: "TQ4-K9P",
          user_id: "u1",
          at: new Date(Date.now() - 5_000).toISOString(),
        },
      ]
    : [],
  blocked: [],
} as unknown as DeviceList;

const client = {
  on: (event: string, listener: (value: never) => void) => {
    if (event === "cloud.changed") changed.add(listener as (status: CloudStatus) => void);
    return () => void changed.delete(listener as (status: CloudStatus) => void);
  },
  call: async (method: string, params: { settings?: { sync_chats?: boolean } } = {}) => {
    switch (method) {
      case "cloud.status":
        return status();
      case "settings.set":
        if (params.settings?.sync_chats === true) {
          synced = true;
          for (const listener of changed) listener(status());
        }
        return {};
      case "device.list":
        return devices;
      case "plugin.list":
        return { plugins: [] };
      case "automation.list":
        return { automations: [] };
      default:
        throw new Error(`not here: ${method}`);
    }
  },
} as unknown as Client;

const ENGINE = {
  id: "caveman",
  label: "Caveman",
  capabilities: {},
  models: [{ id: "auto", label: "Auto", efforts: [] }],
  auth: { state: "signed_out", accounts: [] },
} as unknown as EngineDescriptor;

const value = {
  status: "connected",
  error: null,
  client,
  connection: 1,
  chiefHere: true,
  identity: {
    orgName: "Acme",
    computerName: "Studio",
    computerWord: "this Mac",
    computerOnline: true,
    userName: "Ada",
    plan: null,
  },
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [ENGINE],
  settings: { theme: "dark", text_size: "default", engines: {}, model_defaults: {} },
  refresh: async () => undefined,
  markSeen: () => undefined,
} as unknown as RuntimeContextValue;

const router = createMemoryRouter(
  [{ element: <AppShell />, children: [{ path: "*", Component: () => null }] }],
  { initialEntries: [picked.path ?? "/new"] },
);

const host = document.getElementById("sync-ask")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <RuntimeFixture value={value}>
      <TooltipProvider>
        <div data-case={view} className="h-full">
          <RouterProvider router={router} />
        </div>
      </TooltipProvider>
    </RuntimeFixture>,
  ),
);

const said = () =>
  (document.body.textContent ?? "").replace(result.textContent ?? "", "").replace(/\s+/g, " ");
const tick = (ms = 80) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].findLast(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );

async function run() {
  const problems: string[] = [];
  for (let i = 0; i < 60 && !document.querySelector("[data-sidebar]"); i++) await tick();
  await tick(900);
  for (const label of picked.does ?? []) {
    const target = button(label);
    if (target) target.click();
    else problems.push(`nothing to press: ${label}`);
    await tick(1300);
  }
  for (const path of picked.goes ?? []) {
    await router.navigate(path);
    await tick(900);
  }
  for (const text of picked.says) if (!said().includes(text)) problems.push(`missing: ${text}`);
  for (const text of picked.never ?? [])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // A step that waits on the person is marked: the amber dot, never only words.
  if (view === "later" || view === "done-later" || view === "device-later") {
    const row = [...document.querySelectorAll("[data-sidebar] li")].find((li) =>
      /Sync chats|Allow Chrome/.test(li.textContent ?? ""),
    );
    if (!row?.querySelector(".bg-warning")) problems.push("the step that waits on you has no dot");
  }
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
  document.title = result.textContent.split("\n")[0]!;
}
void run();
