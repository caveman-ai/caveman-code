// The sidebar's chat rows in every status they end in, through the production Sidebar on fixture data: an ask, a
// turn at work before its first minute, with its clock (4m, 1h, 12h) and with its todos (2/5, 10/12), a lead waiting
// on its agents, failed, finished, stopped, queued, asleep, and a pull request (open, draft, merged) on the folder's
// rule, under the folder's icon. No runtime and no Cloud. It checks the column every row ends on (each status glyph's right edge, and its centre
// on the title's), that every title starts on one edge, glyph or not, and that a pull request's glyph sits on the rule;
// it prints PASS or the rows that stray. /src/shell/sidebar-rows.browser.html (?light for the light theme).
import type { Project, Workspace } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { RuntimeFixture, workspaceView, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";
import { Sidebar } from "./Sidebar.tsx";

const query = new URLSearchParams(location.search);
if (query.has("light")) document.documentElement.classList.remove("dark");

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const APP = {
  id: "p-app",
  name: "app",
  path: "/Users/ada/code/app",
  created_at: at(9000),
  updated_at: at(9000),
} as Project;
const MAC = {
  id: "this_mac",
  kind: "this_mac",
  label: "This Mac",
  status: "online",
} as Workspace["computer"];
const SEEN = at(-1);

let n = 0;
const chat = (title: string, extra: Partial<Workspace> = {}, minutesAgo = n): Workspace =>
  ({
    id: `c${n}`,
    session_id: `s-c${n++}`,
    title,
    status: "idle",
    engine: "claude-agent",
    repo: { path: APP.path },
    base_ref: "main",
    branch: `caveman/c${n}`,
    project_id: APP.id,
    created_at: at(minutesAgo + 60),
    updated_at: at(minutesAgo),
    computer: MAC,
    inbox: { visited_at: SEEN },
    ...extra,
  }) as Workspace;
const working = (title: string, ranMinutes: number, todos?: { done: number; total: number }) =>
  chat(
    title,
    {
      status: "working",
      inbox: { visited_at: at(ranMinutes) },
      activity: { turn_started_at: at(ranMinutes), ...(todos ? { todos } : {}) },
    } as Partial<Workspace>,
    0,
  );
const pr = (number: number, state: "open" | "draft" | "merged" | "closed") =>
  ({
    pull_request: { number, url: `https://github.com/acme/app/pull/${number}`, state },
  }) as Partial<Workspace>;

const lead = chat(
  "Split the billing service",
  { status: "idle", inbox: { visited_at: SEEN } } as Partial<Workspace>,
  0,
);
const CHATS: Workspace[] = [
  {
    ...chat("Add stable release channel", { inbox: { visited_at: at(400) } } as Partial<Workspace>),
    ...pr(431, "open"),
  },
  { ...chat("Hide Cloud controls on the web"), ...pr(429, "merged") },
  { ...chat("Uncensored model list"), ...pr(427, "draft") },
  chat("Migrate auth to passkeys", {
    status: "needs_input",
    activity: { ask: { kind: "approval", prompt: "Run pnpm migrate?" } },
  } as Partial<Workspace>),
  chat("Compare auth providers", {
    status: "needs_input",
    activity: { ask: { kind: "question", prompt: "Which one?" } },
  } as Partial<Workspace>),
  working("Just started a turn", 0.2),
  working("Refactor billing webhooks", 4),
  working("Rate limit middleware", 64, { done: 2, total: 5 }),
  working("Write API docs for v2", 720),
  working("Port the settings page", 30, { done: 10, total: 12 }),
  { ...working("Open pull request at work", 9), ...pr(412, "open") },
  lead,
  chat(
    "Agent: read the ledger",
    {
      status: "working",
      parent_workspace_id: lead.id,
      activity: { turn_started_at: at(3) },
    } as Partial<Workspace>,
    0,
  ),
  chat(
    "Agent: draft the split",
    {
      status: "working",
      parent_workspace_id: lead.id,
      activity: { turn_started_at: at(2) },
    } as Partial<Workspace>,
    0,
  ),
  chat("Fix flaky checkout test", {
    status: "failed",
    inbox: { visited_at: at(400) },
  } as Partial<Workspace>),
  chat("Audit bundle size", {
    status: "idle",
    inbox: { visited_at: at(400) },
  } as Partial<Workspace>),
  chat("Bump Node to 22", {
    status: "idle",
    inbox: { visited_at: at(400) },
    activity: { last_outcome: "interrupted" },
  } as Partial<Workspace>),
  chat("Queued after the others", { status: "waiting" } as Partial<Workspace>),
  chat("Asleep on a Cloud computer", { status: "parked" } as Partial<Workspace>),
  chat("A chat with no status at all"),
  // A chat whose project this computer doesn't know, in no repository: the "No repository" stand-in folder.
  chat("Notes on another computer", {
    project_id: undefined,
    repo: { path: "" },
  } as unknown as Partial<Workspace>),
];

const client = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  call: async (method: string) => {
    if (method.startsWith("chief."))
      throw new SessionProtocolError({ code: -32601, message: "method not found" });
    if (method === "queue.list") return { turns: [] };
    if (method === "plugin.list") return { plugins: [] };
    if (method === "automation.list") return { automations: [] };
    return {};
  },
};

const runtime = (): RuntimeContextValue =>
  ({
    status: "connected",
    error: null,
    client,
    connection: 1,
    identity: {
      orgName: "Acme",
      computerName: "This Mac",
      computerWord: "this Mac",
      computerOnline: true,
      userName: "Ada",
      plan: null,
    },
    engines: [],
    settings: { default_engine: "claude-agent", engines: {}, model_defaults: {} },
    workspaces: CHATS.map((w) => workspaceView(w, "Claude Agent")),
    raw: new Map(CHATS.map((w) => [w.id, w])),
    projects: [APP],
    refresh: async () => undefined,
    markSeen: () => undefined,
  }) as unknown as RuntimeContextValue;

localStorage.setItem("caveman.sidebarQueue", "0");
localStorage.removeItem("caveman.closedFolders");

const host = document.getElementById("sidebar-rows")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter initialEntries={["/"]}>
      <RuntimeFixture value={runtime()}>
        <TooltipProvider>
          <main className="p-5 text-foreground">
            <div
              style={{ width: 280, height: 1040 }}
              className="relative flex overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)]"
            >
              <Sidebar />
            </div>
          </main>
        </TooltipProvider>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

void (async () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await tick(1500);
  // The folder puts chats at work first: the rest, the merged and draft pull requests among them, are behind Show more.
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Show more")?.click();
  await tick(400);
  const strays: string[] = [];
  const marks = [...host.querySelectorAll<HTMLElement>("button.chat-row:not(.agent-row)")].flatMap(
    (row) => {
      const mark = [...row.querySelectorAll<HTMLElement>('[role="img"][aria-label]')].at(-1);
      const glyph = mark
        ? ([...mark.children].find((c) => !c.textContent) as HTMLElement | undefined)
        : undefined;
      const title = row.querySelector<HTMLElement>("span.min-w-0");
      return glyph && title
        ? [
            {
              name: title.textContent ?? "",
              glyph: glyph.getBoundingClientRect(),
              title: title.getBoundingClientRect(),
              row: row.getBoundingClientRect(),
            },
          ]
        : [];
    },
  );
  const right = Math.max(...marks.map((m) => m.glyph.right));
  for (const m of marks) {
    if (Math.abs(m.glyph.right - right) > 0.5)
      strays.push(`${m.name}: ends ${(right - m.glyph.right).toFixed(1)}px short`);
    const mid = (r: DOMRect) => r.top + r.height / 2;
    if (Math.abs(mid(m.glyph) - mid(m.title)) > 0.5)
      strays.push(
        `${m.name}: glyph ${(mid(m.glyph) - mid(m.title)).toFixed(1)}px off the title's centre`,
      );
  }
  const titles = [
    ...host.querySelectorAll<HTMLElement>("button.chat-row:not(.agent-row) > span.min-w-0"),
  ].map((t) => t.getBoundingClientRect().left);
  if (new Set(titles.map((x) => x.toFixed(1))).size !== 1)
    strays.push(`titles start on ${[...new Set(titles.map((x) => x.toFixed(1)))].join(", ")}`);
  const rule = host.querySelector<HTMLElement>(".folder-rule")!.getBoundingClientRect();
  // The pull request glyph stands under the folder's icon, the same 16px column.
  const folder = host.querySelector<HTMLElement>(".px-folder")!.getBoundingClientRect();
  const prs = [
    ...host.querySelectorAll<HTMLElement>(
      '.folder-row > div > [role="img"][aria-label^="Pull request"]',
    ),
  ];
  if (prs.length < 4) strays.push(`saw ${prs.length} pull request glyphs on the rule`);
  for (const g of prs) {
    const r = g.getBoundingClientRect();
    if (Math.abs(r.left + r.width / 2 - (rule.left + rule.width / 2)) > 1)
      strays.push(
        `${g.getAttribute("aria-label")}: off the rule by ${(r.left + r.width / 2 - rule.left - rule.width / 2).toFixed(1)}px`,
      );
    if (Math.abs(r.left - folder.left) > 0.5)
      strays.push(
        `${g.getAttribute("aria-label")}: ${(r.left - folder.left).toFixed(1)}px off the folder's icon`,
      );
  }
  result.textContent =
    marks.length < 10
      ? `FAIL: saw ${marks.length} status marks`
      : strays.length
        ? `FAIL\n${strays.join("\n")}`
        : `PASS (${marks.length} rows end on one column)`;
})();
