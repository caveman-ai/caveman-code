// The agents a chat started and reviewing a sleeping Cloud chat, through the production components on scripted state: no
// runtime and no Cloud. It checks what it draws, and prints PASS or what is missing.
// /src/shell/x1-review-builders.browser.html?view=<state> (?light for the light theme). States:
//   result          a chat that started agents: two quiet lines an agent's result left, then their one result row
//   builders        that chat's Agents tab with an agent in each of the six states
//   filtered        the same tab as the result row's click opens it: only the agents left out
//   changes-waking  a Cloud chat's Changes opened while Cloud sleeps: one line counting the wait
//   changes-loaded  the same, Cloud answering a moment later: the changes load by themselves
import type { BuildersResult, Workspace } from "@caveman-app/session-protocol";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Transcript } from "../components/Transcript.tsx";
import AgentsSurface from "../panels/agents/AgentsSurface.tsx";
import { Changes } from "../panels/diff/DiffSurface.tsx";
import { PanelWorkspace } from "../panels/workspace.ts";
import { generatedOf } from "../state/generated.ts";
import { RuntimeFixture, SyncHubFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import type { SyncHub } from "../state/sync/hub.ts";
import type { TranscriptItem } from "../state/transcript-model.ts";
import "../styles.css";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "result";
if (query.has("light")) document.documentElement.classList.remove("dark");

const NOW = Date.now();
const at = (s: number) => new Date(NOW - 60 * 60_000 + s * 1000).toISOString();
// A Cloud computer by the name Cloud gives it: it may never reach the page.
const MACHINE = "box-web-7f3";
const CLOUD = { id: "c-web", kind: "caveman_cloud", label: MACHINE, status: "online" } as const;

// ------------------------------------------------------------------ the lead and its builders

const workspace = (id: string, title: string, over: Partial<Workspace> = {}): Workspace =>
  ({
    id,
    session_id: `s-${id}`,
    title,
    status: "idle",
    engine: "claude-agent",
    repo: { url: "https://github.com/acme/web" },
    base_ref: "main",
    branch: `caveman/${id}`,
    created_at: at(0),
    updated_at: at(600),
    computer: CLOUD,
    ...over,
  }) as Workspace;
const LEAD = workspace("w-lead", "Port every settings page");
const tonight = new Date(NOW);
tonight.setHours(23, 8, 0, 0);
const builder = (
  id: string,
  title: string,
  b: NonNullable<Workspace["builder"]>,
  status: Workspace["status"] = "idle",
) =>
  workspace(id, title, {
    parent_workspace_id: LEAD.id,
    builder: b,
    status,
    created_at: at(Number(id.slice(3))),
  });
const BUILDERS = [
  builder("w-b1", "Port the account page", { state: "working" }, "working"),
  builder("w-b2", "Port the appearance page", { state: "done" }),
  builder("w-b3", "Port the theme page", { state: "merged" }),
  builder("w-b4", "Port the keys page", { state: "left_out", why: "conflicts in keys.tsx" }),
  builder("w-b5", "Port the plan page", {
    state: "paused",
    until: tonight.toISOString(),
    plan: "Claude plan",
  }),
  builder("w-b6", "Port the billing page", { state: "failed", why: "its tests fail" }),
];

const RESULT: BuildersResult = {
  total: 30,
  merged: 28,
  left_out: [
    { workspace_id: "w-b4", title: "Port the keys page", why: "conflicts in keys.tsx" },
    { title: "Port the billing page", why: "its tests fail" },
  ],
  pull_requests: [{ number: 128, url: "https://github.com/acme/web/pull/128", repo: "acme/web" }],
};

/** The runtime's own user-role message, as the transcript reads it (state/generated.ts). */
const made = (id: string, s: number, p: Parameters<typeof generatedOf>[0]): TranscriptItem => ({
  kind: "user",
  id,
  text: p.text,
  at: at(s),
  delivery: "message",
  ...(p.from ? { from: p.from } : {}),
  generated: generatedOf(p)!,
});
const say = (id: string, s: number, text: string): TranscriptItem => ({
  kind: "assistant",
  id,
  text,
  streaming: false,
  at: at(s),
});
const end = (id: string, s: number): TranscriptItem => ({
  kind: "turn_end",
  id,
  outcome: "completed",
  at: at(s),
  cursor: s,
});
const ITEMS: TranscriptItem[] = [
  {
    kind: "user",
    id: "ask",
    text: "Port every settings page to the new rows. Split it up so it goes fast.",
    at: at(0),
    delivery: "message",
  },
  say(
    "plan",
    10,
    "Splitting this into 30 agents, one per settings page. Each one opens its page, moves it to the new rows and runs its tests.",
  ),
  end("end-1", 12),
  made("b3", 300, {
    text: '[Builder "Port the theme page" finished its turn]\n(what the lead is told to do next)',
    from: { workspace_id: "w-b3", title: "Port the theme page" },
    generated: { shown: "Port the theme page finished" },
  }),
  say("ack-1", 305, "The theme page is in."),
  end("end-2", 306),
  // History from before `generated`: the bracket line, never shown as it is.
  made("b2", 400, {
    text: '[Builder "Port the appearance page" was stopped (on this computer, workspace ws_b2)]',
    from: { workspace_id: "w-b2", title: "Port the appearance page" },
  }),
  say("ack-2", 405, "The appearance page stopped before its tests ran; it is back in the queue."),
  end("end-3", 406),
  made("done", 900, {
    text: "[Caveman Code] Your builders have finished. (the lead's instructions)",
    generated: { shown: "Builders finished" },
    builders_result: RESULT,
  }),
  say(
    "wrap",
    920,
    "28 of the 30 pages are in one pull request. The keys page conflicts with the new rows and the billing page's tests fail; both are left out for now.",
  ),
  end("end-4", 925),
];

// ------------------------------------------------------------------ the chat's Changes while Cloud sleeps

const CHANGED = {
  from: "main",
  to: "WORKTREE",
  files: [
    {
      path: "src/settings/Keys.tsx",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch:
        'diff --git a/src/settings/Keys.tsx b/src/settings/Keys.tsx\n--- a/src/settings/Keys.tsx\n+++ b/src/settings/Keys.tsx\n@@ -1,3 +1,5 @@\n import { Row } from "./rows";\n-export const Keys = () => <div />;\n+export function Keys() {\n+  return <Row title="Keys" />;\n+}\n+\n',
    },
    {
      path: "src/settings/rows.tsx",
      status: "added",
      additions: 2,
      deletions: 0,
      patch:
        "diff --git a/src/settings/rows.tsx b/src/settings/rows.tsx\n--- /dev/null\n+++ b/src/settings/rows.tsx\n@@ -0,0 +1,2 @@\n+export const Row = ({ title }: { title: string }) => <div>{title}</div>;\n+\n",
    },
  ],
};
/** The hub as the Changes panel reads it: the chat's Cloud computer asleep, then answering for `changes-loaded`. */
function scriptedHub(): { hub: SyncHub; wakes: string[] } {
  const listeners = new Set<() => void>();
  const wakes: string[] = [];
  let asleep = true;
  const since = NOW - 4_000;
  const hub = {
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    asleepInCloud: () => asleep,
    openWait: () => (asleep ? { since, failed: false } : null),
    wake: (_: string, reason: string) => (wakes.push(reason), true),
    homeRuntimeId: () => "rt-mac",
    throughHub: () => false,
    list: null,
  } as unknown as SyncHub;
  if (view === "changes-loaded") {
    setTimeout(() => {
      asleep = false;
      for (const l of listeners) l();
    }, 1_200);
  }
  return { hub, wakes };
}

// ------------------------------------------------------------------ the page

const changes = view.startsWith("changes");
const asked: string[] = [];
const client = {
  on: () => () => undefined,
  attach: async () => ({ unsubscribe: () => undefined }),
  call: (method: string) => {
    asked.push(method);
    if (method === "fs.diff") return Promise.resolve(CHANGED);
    return new Promise(() => undefined);
  },
};
const runtime = {
  status: "connected",
  client,
  connection: 1,
  engines: [],
  settings: { default_engine: "claude-agent", engines: {} },
  workspaces: [],
  projects: [],
  raw: new Map([LEAD, ...BUILDERS].map((w) => [w.id, w])),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const { hub, wakes } = scriptedHub();

const bar = (title: string, sub: string) => (
  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
    <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
    <span className="shrink-0 text-muted-foreground">{sub}</span>
  </div>
);

function Page() {
  if (view === "builders" || view === "filtered") {
    const only =
      view === "filtered" ? { ids: ["w-b4"], titles: ["Port the billing page"] } : undefined;
    return (
      <PanelWorkspace.Provider value={LEAD}>
        {bar(LEAD.title, "Agents")}
        <AgentsSurface
          workspaceId={LEAD.id}
          active
          tab={{ id: "agents", kind: "agents", params: only ? { only } : {}, reveal: 0 }}
        />
      </PanelWorkspace.Provider>
    );
  }
  if (changes) {
    return (
      <PanelWorkspace.Provider value={LEAD}>
        {bar(LEAD.title, "Changes")}
        <Changes
          workspaceId={LEAD.id}
          tab={{ id: "diff", kind: "diff", params: {}, reveal: 0 }}
          active
          sessionId={LEAD.session_id}
          sources={null}
          projectId={null}
        />
      </PanelWorkspace.Provider>
    );
  }
  return (
    <>
      {bar(LEAD.title, "Claude Agent")}
      <Conversation contentClassName="px-6 py-5">
        <Transcript
          sessionId={LEAD.session_id}
          workspaceId={LEAD.id}
          items={ITEMS}
          engine="claude-agent"
          engineLabel="Claude Agent"
          engineIsCaveman={false}
          running={false}
          onAnswer={() => {}}
          cavemanVersion={null}
        />
      </Conversation>
    </>
  );
}

const host = document.getElementById("x1")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <RuntimeFixture value={runtime}>
        <SyncHubFixture hub={hub}>
          <TooltipProvider>
            <main
              data-case={view}
              className="flex h-full min-h-0 flex-col bg-background text-foreground"
            >
              <Page />
            </main>
          </TooltipProvider>
        </SyncHubFixture>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

const said = () => (host.textContent ?? "").replace(/\s+/g, " ");
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clock = tonight.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const SAYS: Record<string, ReadonlyArray<string>> = {
  result: [
    "Port the theme page finished",
    "Port the appearance page stopped",
    "28 of 30 merged · 2 left out",
    "#128",
  ],
  builders: [
    "Agents",
    "Working",
    "Done",
    "Merged",
    "Left out: conflicts in keys.tsx",
    `Paused until ${clock}`,
    "Failed: its tests fail",
    "Cloud",
  ],
  filtered: ["Left out: 2 of 6", "Show all", "Port the keys page", "Port the billing page"],
  "changes-waking": ["Waking Cloud… "],
  "changes-loaded": ["Keys.tsx", "rows.tsx"],
};
const NEVER: Record<string, ReadonlyArray<string>> = {
  result: ["[Builder", "[Caveman Code]", "(what the lead is told", "the lead's instructions"],
  builders: ["Builders", "Subagents"],
  filtered: ["Port the account page", "Port the theme page", "builders"],
  "changes-waking": ["Couldn't load the changes", "Retry", "asleep"],
  "changes-loaded": ["Waking Cloud"],
};

async function run() {
  for (let i = 0; i < 60 && SAYS[view]!.some((text) => !said().includes(text)); i++) await tick(50);
  const problems: string[] = [];
  for (const text of SAYS[view] ?? [])
    if (!said().includes(text)) problems.push(`does not say: ${text}`);
  for (const text of [...(NEVER[view] ?? []), MACHINE, "Cloud computer", "Claude Code"])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  if (/[$€£]\s?\d/.test(said())) problems.push("an amount of money is on the page");
  if (changes && wakes.join() !== "open") problems.push(`opening woke ${wakes.length} times`);
  if (view === "changes-waking" && asked.includes("fs.diff"))
    problems.push("read the changes from a sleeping computer");
  // The person's bubble is never the runtime's message.
  if (view === "result" && host.querySelectorAll("[data-user-message]").length !== 1)
    problems.push("a generated message drew as the person's bubble");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
  document.documentElement.dataset.result = problems.length === 0 ? "passed" : "failed";
}
void run();
