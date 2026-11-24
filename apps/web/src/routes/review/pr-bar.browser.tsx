// The pull request's bar at side-panel and page widths: every control stays inside the bar, none cut off at its edge.
// Run the web dev server and open /src/routes/review/pr-bar.browser.html; #result says PASS or what overflowed.
import type { Client, PrDetail } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { invalidatePr } from "./data.ts";
import { PrPage } from "./PrPage.tsx";
import "../../styles.css";

const WIDTHS = [320, 420, 560, 709, 900, 1300];
const checks = Array.from({ length: 13 }, (_, i) => ({ name: `check ${i + 1}`, status: i < 7 ? ("passed" as const) : ("pending" as const) }));
let detail: PrDetail = {
  project_id: "p1",
  repo: "acme/app",
  host: "github.com",
  number: 63,
  title: "⌘K and the composer's menus at the menu row's scale",
  url: "https://github.com/acme/app/pull/63",
  head_branch: "menus",
  base_branch: "main",
  state: "draft",
  additions: 120,
  deletions: 40,
  created_at: "2026-11-10T09:00:00Z",
  updated_at: "2026-11-10T09:00:00Z",
  review_requested: false,
  mine: true,
  body: "",
  mergeable: "clean",
  checks_list: checks,
  reviewers: [],
  commits: 3,
  files: Array.from({ length: 2000 }, (_, i) => ({ path: `src/f${i}.ts`, status: "modified" as const, additions: 1, deletions: 0, viewed: false })),
  can: { merge: true, review: true, comment: true, merge_methods: ["squash", "merge"], ready: true },
};
const client = {
  call: (method: string) => (method === "pr.get" ? Promise.resolve(detail) : method === "pr.discussion" ? Promise.resolve({ items: [] }) : new Promise(() => undefined)),
} as unknown as Client;
const chat = { id: "w1", title: "Fix the menus", projectId: "p1", branch: "menus", state: "working", engine: { id: "caveman", label: "Caveman" } };
const runtime = { client, engines: [], workspaces: [chat], projects: [], settings: { review_guides: false }, raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;

const host = document.getElementById("bars")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <RuntimeContext.Provider value={runtime}>
        <TooltipProvider>
          {WIDTHS.map((w) => (
            <section key={w} data-width={w} className="flex h-[96px] flex-col overflow-hidden rounded-lg border border-border bg-background" style={{ width: w }}>
              <PrPage pr={{ project_id: "p1", number: 63 }} embedded />
            </section>
          ))}
        </TooltipProvider>
      </RuntimeContext.Provider>
    </MemoryRouter>,
  ),
);

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** What overflows in one bar: a control past its edge, or the bar wider than itself. */
function problemsOf(section: HTMLElement, at: string): string[] {
  const problems: string[] = [];
  const bar = section.querySelector("header")!;
  const edge = bar.getBoundingClientRect();
  for (const control of bar.querySelectorAll<HTMLElement>("button, a")) {
    if (control.closest("[role=tablist]")) continue;
    const r = control.getBoundingClientRect();
    if (r.right > edge.right + 0.5 || r.left < edge.left - 0.5) problems.push(`${at}: "${control.textContent || control.getAttribute("aria-label")}" is cut off`);
  }
  if (bar.scrollWidth > bar.clientWidth + 1) problems.push(`${at}: the bar overflows by ${bar.scrollWidth - bar.clientWidth}px`);
  // The tabs never squeeze to nothing: the narrowest still shows its first tab whole.
  const tabs = bar.querySelector<HTMLElement>("[role=tablist]")!;
  const first = tabs.querySelector<HTMLElement>("[role=tab]");
  if (first && first.getBoundingClientRect().right > tabs.getBoundingClientRect().right + 0.5) problems.push(`${at}: the tabs are squeezed`);
  return problems;
}
async function check() {
  for (let i = 0; i < 20 && !document.querySelector("header button[aria-label='Merge method']"); i++) await frame();
  await frame();
  const problems: string[] = [];
  const sections = [...document.querySelectorAll<HTMLElement>("section[data-width]")];
  for (const section of sections) {
    problems.push(...problemsOf(section, `${section.dataset.width}px`));
    section.dataset.fit = section.querySelector("header")!.dataset.fit ?? "";
  }
  const fits = sections.map((s) => `${s.dataset.width}:${s.dataset.fit}`).join(" ");
  // Live: one bar dragged narrower step by step, then wider again (a side panel resized), measured after each step.
  const live = sections.at(-1)!;
  const steps = [1100, 900, 700, 500, 360, 500, 700, 900, 1100, 1300];
  const seen: string[] = [];
  for (const w of steps) {
    live.style.width = `${w}px`;
    await frame();
    await frame();
    problems.push(...problemsOf(live, `live ${w}px`));
    seen.push(`${w}:${live.querySelector("header")!.dataset.fit}`);
  }
  // Wide again, it shows everything again.
  if (live.querySelector("header")!.dataset.fit !== "0") problems.push(`live: back at 1300px the bar still gives up room (fit ${live.querySelector("header")!.dataset.fit})`);
  // Its controls go (the draft is merged) on a bar that had wrapped: it gives the room back at the same width.
  live.style.width = "560px";
  await frame();
  await frame();
  const wrapped = live.querySelector("header")!.dataset.fit;
  detail = { ...detail, state: "merged", can: { ...detail.can, merge: false, ready: false, review: false } };
  invalidatePr(client, { project_id: "p1", number: 63 }, "detail");
  for (let i = 0; i < 30 && document.querySelector("section[data-width] header button[aria-label='Merge method']"); i++) await frame();
  await frame();
  await frame();
  const merged = live.querySelector("header")!.dataset.fit;
  if (wrapped !== "3" || merged === "3") problems.push(`merged: the bar kept its wrapped fit once its actions went (${wrapped} → ${merged})`);
  seen.push(`merged@560:${wrapped}→${merged}`);
  result.textContent = problems.length === 0 ? `PASS ${fits} | live ${seen.join(" ")}` : `FAIL\n${problems.join("\n")}`;
}
void check();
