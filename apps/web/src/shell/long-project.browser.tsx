// A project with 40 chats in the sidebar, through the production Sidebar on fixture data: its folder opens a step at a
// time, never all 40 at once. No runtime and no Cloud. It checks what it draws, and prints PASS or what is missing.
// /src/shell/long-project.browser.html?view=<state> (?light for the light theme). States:
//   folded   the first 8 chats and Show more
//   more     after one Show more: 23 chats, Show more and Show less; then 9 newer arrive at once, 5 old leave and 5
//            arrive, and chats behind the fold and shown ones become active: none moves, hides or comes into view
//   all      Show more until none are left: all 40 and Show less only, still all after 14 newer chats arrive
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
const view = query.get("view") ?? "folded";
if (query.has("light")) document.documentElement.classList.remove("dark");

const CREATED = {
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};
const APP: Project = {
  id: "p-app",
  name: "app",
  path: "/Users/ada/code/app",
  ...CREATED,
} as Project;
const MAC = {
  id: "this_mac",
  kind: "this_mac",
  label: "This Mac",
  status: "online",
} as Workspace["computer"];
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const TOPICS = [
  "Fix the login redirect",
  "Tidy the settings page",
  "Speed up the invoice query",
  "Rename the billing route",
  "Document the webhook retries",
];
const chat = (id: string, title: string, minutesAgo: number): Workspace =>
  ({
    id,
    session_id: `s-${id}`,
    title,
    status: "idle",
    engine: "claude-agent",
    repo: { path: APP.path },
    base_ref: "main",
    branch: `caveman/${id}`,
    project_id: APP.id,
    created_at: at(minutesAgo),
    updated_at: at(minutesAgo),
    computer: MAC,
  }) as Workspace;
let CHATS: Workspace[] = Array.from({ length: 40 }, (_, i) =>
  chat(`c${i}`, `${TOPICS[i % TOPICS.length]} (${i + 1})`, 60 * (i + 1)),
);
/** The `n` oldest chats leave the folder (archived, say). */
const leave = (n: number) => {
  CHATS = CHATS.slice(0, CHATS.length - n);
  draw();
};
let clock = 0;
/** `n` newer chats arrive, sorting above every chat already there. */
const arrive = (n: number) => {
  const fresh = Array.from({ length: n }, () => {
    const id = `n${clock++}`;
    return chat(id, `Just started (${id})`, -clock);
  });
  CHATS = [...fresh, ...CHATS];
  draw();
};
/** Chats become active, in turn: none moves, the folder keeps the order they were started in. */
const use = (...ids: string[]) => {
  for (const id of ids)
    CHATS = CHATS.map((w) => (w.id === id ? { ...w, updated_at: at(-clock++) } : w));
  draw();
};
/** The chats as the folder sorts them: most recently started first. */
const ordered = () => [...CHATS].sort((a, b) => b.created_at.localeCompare(a.created_at));

const client = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  call: async (method: string) => {
    if (method.startsWith("chief."))
      throw new SessionProtocolError({
        code: -32601,
        message: "method not found",
      });
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
    settings: {
      default_engine: "claude-agent",
      engines: {},
      model_defaults: {},
    },
    workspaces: CHATS.map((w) => workspaceView(w, "Claude Agent")),
    raw: new Map(CHATS.map((w) => [w.id, w])),
    projects: [APP],
    refresh: async () => undefined,
    markSeen: () => undefined,
  }) as unknown as RuntimeContextValue;

localStorage.setItem("caveman.sidebarQueue", "0");
localStorage.removeItem("caveman.closedFolders");

const host = document.getElementById("long-project")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const draw = () =>
  flushSync(() =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <RuntimeFixture value={runtime()}>
          <TooltipProvider>
            <main className="p-5 text-foreground">
              <div
                data-case={view}
                style={{ width: 300, height: 520 }}
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
draw();

const tick = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const rows = () => CHATS.filter((w) => (host.textContent ?? "").includes(w.title)).length;

void (async () => {
  // The sidebar's first reads settle before anything is pressed.
  await tick(1500);
  const missing: string[] = [];
  const expect = (ok: boolean, what: string) => void (ok || missing.push(what));
  if (view === "folded") {
    expect(rows() === 8, `8 chats (saw ${rows()})`);
    expect(!!button("Show more") && !button("Show less"), "Show more alone");
  }
  if (view === "more" || view === "all") {
    button("Show more")?.click();
    await tick();
    if (view === "more") {
      expect(rows() === 23, `23 chats (saw ${rows()})`);
      expect(!!button("Show more") && !!button("Show less"), "Show more and Show less");
      const top = (n: number) => {
        const text = (host.textContent ?? "").replace(/\s+/g, " ");
        return (
          rows() === n &&
          ordered()
            .slice(0, n)
            .every((w) => text.includes(w.title))
        );
      };
      // More than its first eight arrive at once: all show, above the 23, no gap.
      arrive(9);
      await tick();
      expect(top(32), `9 arrive: the top 32, no gap (saw ${rows()})`);
      // The 5 oldest leave, then 5 more arrive: none it showed slips out.
      leave(5);
      await tick();
      arrive(5);
      await tick();
      expect(top(37), `5 leave, 5 arrive: the top 37 (saw ${rows()})`);
      // "Speed up the invoice query (31)", behind the fold, becomes active, then every chat shown does: none moves,
      // and c30 stays behind the fold.
      use("c30");
      await tick();
      use(
        ...ordered()
          .slice(0, 37)
          .map((w) => w.id),
      );
      await tick();
      expect(top(37), `chats that become active keep their place: the top 37 (saw ${rows()})`);
    } else {
      while (button("Show more")) {
        button("Show more")!.click();
        await tick();
      }
      expect(rows() === 40, `40 chats (saw ${rows()})`);
      expect(!!button("Show less"), "Show less alone");
      button("Show less")!.click();
      await tick();
      expect(rows() === 8, `Show less folds back to 8 (saw ${rows()})`);
      button("Show more")?.click();
      button("Show more")?.click();
      await tick();
      while (button("Show more")) {
        button("Show more")!.click();
        await tick();
      }
      // Opened to the end, it stays open to the end as newer chats arrive.
      arrive(14);
      await tick();
      expect(rows() === 54, `all 54 after 14 arrive (saw ${rows()})`);
      expect(!button("Show more"), "no Show more once opened to the end");
    }
  }
  // The list scrolled to its end, where the folder's Show more and Show less sit.
  const list = host
    .querySelector('section[aria-label="Projects"]')
    ?.closest<HTMLElement>(".overflow-y-auto");
  if (list) list.scrollTop = list.scrollHeight;
  if (/[0-9]+ more/.test(host.textContent ?? "")) missing.push("no count on Show more");
  result.textContent = missing.length ? `MISSING: ${missing.join("; ")}` : "PASS";
})();
