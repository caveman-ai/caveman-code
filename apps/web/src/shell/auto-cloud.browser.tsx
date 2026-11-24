// Auto offered on a chat in Cloud, through the production composer on scripted state: no runtime and no
// Cloud. The chat's own computer answers engine.list as a Cloud computer's runtime does: with Auto at the head of
// Claude Agent's and Codex's models where its Cloud routes Auto in its data plane, without it where that Cloud is
// older or has the switch off. It checks what it draws, and prints PASS or what is missing.
// /src/shell/auto-cloud.browser.html?view=<state> (?light for the light theme). States:
//   routed   a chat in Cloud on Claude Agent, its model picker open: Auto first, and the chat starts on it
//   older    the same chat where Cloud does not route Auto: the agent's own models only
import type { EngineDescriptor, Workspace } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Composer } from "../components/Composer.tsx";
import { ChatClientScope, RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "routed";
if (query.has("light")) document.documentElement.classList.remove("dark");

// A Cloud computer by the name Cloud gives it: it may never reach the page.
const MACHINE = "box-web-7f3";
const CHAT = {
  id: "w-auto",
  session_id: "s-auto",
  title: "Fix the flaky upload test",
  status: "idle",
  engine: "claude-agent",
  repo: { url: "https://github.com/acme/web" },
  base_ref: "main",
  branch: "caveman/fix-upload",
  created_at: "2026-11-10T09:00:00Z",
  updated_at: "2026-11-10T09:05:00Z",
  computer: { id: "c-web", kind: "caveman_cloud", label: MACHINE, status: "online" },
} as unknown as Workspace;

const AUTO = {
  id: "caveman-auto",
  label: "Auto",
  efforts: [],
  description: "Caveman picks the model for each message",
};
const efforts = ["low", "medium", "high"];
const agent = (
  id: "claude-agent" | "codex",
  label: string,
  models: ReadonlyArray<{ id: string; label: string; efforts: string[]; description?: string }>,
  routed: boolean,
) =>
  ({
    id,
    label,
    auth: {
      state: "signed_in",
      accounts: [
        {
          id: `${id}:default`,
          label: id === "claude-agent" ? "Claude Max" : "ChatGPT Pro",
          kind: "login",
          active: true,
        },
      ],
    },
    models: routed ? [AUTO, ...models] : models,
    default_model: routed ? AUTO.id : models[0]!.id,
    access_modes: ["full", "default"],
    capabilities: { structured: true, images: true, interrupt: true, steer: true },
  }) as unknown as EngineDescriptor;
const engines = (routed: boolean) => [
  agent(
    "claude-agent",
    "Claude Agent",
    [
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
    ],
    routed,
  ),
  agent(
    "codex",
    "Codex",
    [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts },
      { id: "gpt-6-luna", label: "GPT-6 Luna", efforts },
    ],
    routed,
  ),
];

// This Mac, the window's own runtime: no Auto of its own here (its proxy holds no routing key). The picker must not
// take its list for the chat in Cloud.
const home = {
  on: () => () => undefined,
  attach: async () => ({ unsubscribe: () => undefined }),
  call: () => new Promise(() => undefined),
};
const there = {
  on: () => () => undefined,
  attach: async () => ({ unsubscribe: () => undefined }),
  call: (method: string) =>
    method === "engine.list"
      ? Promise.resolve({ engines: engines(view === "routed") })
      : new Promise(() => undefined),
};
const runtime = {
  status: "connected",
  client: home,
  connection: 1,
  engines: engines(false).map((e) => ({ ...e, models: e.models.slice(0, 1) })),
  settings: { default_engine: "claude-agent", engines: {}, favorite_models: [] },
  workspaces: [CHAT],
  projects: [],
  raw: new Map([[CHAT.id, CHAT]]),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;

function Page() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <span className="min-w-0 truncate font-medium text-foreground">{CHAT.title}</span>
        <span className="shrink-0 text-muted-foreground">Cloud</span>
      </div>
      <div className="min-h-0 flex-1" />
      <div className="mx-auto w-full max-w-[860px] px-4 pb-6">
        <Composer
          running={false}
          canSteer
          workspaceId={CHAT.id}
          engineId="claude-agent"
          engineLabel="Claude Agent"
          onSubmit={async () => undefined}
          onInterrupt={async () => undefined}
          placeholder="Ask Claude Agent"
        />
      </div>
    </div>
  );
}

const host = document.getElementById("auto")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <RuntimeFixture value={runtime}>
        <ChatClientScope client={there as never}>
          <TooltipProvider>
            <main data-case={view} className="h-full min-h-0 bg-background text-foreground">
              <Page />
            </main>
          </TooltipProvider>
        </ChatClientScope>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

const said = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SAYS: Record<string, ReadonlyArray<string>> = {
  routed: ["AutoDefault", "Opus 5.5", "GPT-6.1 Sol"],
  older: ["Opus 5.5", "Sonnet 5.5", "GPT-6.1 Sol"],
};
const NEVER: Record<string, ReadonlyArray<string>> = {
  routed: [],
  older: ["Auto", "Caveman picks the model"],
};

async function run() {
  // The picker opens as a person opens it: its button, once the chat's computer has said what it runs.
  for (
    let i = 0;
    i < 60 && !said().includes("Opus 5.5") && !said().includes(view === "routed" ? "Auto" : "Opus");
    i++
  )
    await tick(50);
  const trigger = [...host.querySelectorAll("button")].find((b) =>
    /Auto|Opus 5\.5/.test(b.textContent ?? ""),
  );
  trigger?.click();
  for (let i = 0; i < 60 && SAYS[view]!.some((text) => !said().includes(text)); i++) await tick(50);
  const problems: string[] = [];
  if (trigger === undefined) problems.push("no model picker button");
  else if (view === "routed" && !/Auto/.test(trigger.textContent ?? ""))
    problems.push(`the chat does not start on Auto: ${trigger.textContent}`);
  for (const text of SAYS[view] ?? [])
    if (!said().includes(text)) problems.push(`does not say: ${text}`);
  for (const text of [...(NEVER[view] ?? []), MACHINE, "Cloud computer", "Claude Code"])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // No amount of money is drawn. The picker's rows carry a price per task in their accessible labels, which predates
  // this page and is not Auto's: it is said beside the result, not counted against it.
  const visible = document.body.cloneNode(true) as HTMLElement;
  for (const hidden of visible.querySelectorAll(".sr-only, #result")) hidden.remove();
  const drawn = (visible.textContent ?? "").replace(/\s+/g, " ");
  if (/[$€£]\s?\d/.test(drawn)) problems.push("an amount of money is drawn");
  const heard = /[$€£]\s?\d/.test(said())
    ? " (note: the picker's accessible labels name a price per task)"
    : "";
  // Auto heads the list for both agents, and only where the chat's computer listed it.
  const autos = [...document.querySelectorAll("[role=option], [cmdk-item]")].filter((row) =>
    /^Auto/.test((row.textContent ?? "").trim()),
  ).length;
  if (view === "routed" && autos < 2)
    problems.push(`Auto is offered for ${autos} agents, want Claude Agent and Codex`);
  result.textContent =
    problems.length === 0 ? `PASS ${view}${heard}` : `FAIL ${view}\n${problems.join("\n")}`;
  document.documentElement.dataset.result = problems.length === 0 ? "passed" : "failed";
}
void run();
