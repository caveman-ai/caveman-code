// The Review page in a browser window with no Mac, read from Cloud (routes/review/source.ts), through the production
// components on scripted state: no runtime, no Cloud and no GitHub. It checks what it draws and prints PASS or what
// is missing.
// /src/shell/review-cloud.browser.html?view=<state> (?light for the light theme, ?frame=480 for a phone's width). States:
//   queue     what waits on the person: two repositories, one asking for their review, one they cannot reach
//   pr        a pull request: its checks, its files, no guide (Cloud runs none)
//   talk      its discussion: a thread with Reply and Fix with agent, and no Resolve
//   approve   the Review menu open on Approve
//   merge     Merge pressed: the confirmation, squash and merge
//   merged    the merge confirmed: Cloud merged it, and the pull request reads merged
//   github    GitHub not connected: Connect GitHub with its button
import type { PrDetail, PrDiscussionItem, PrSummary } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { PrRoute, ReviewRoute } from "../routes/Review.tsx";
import { CLOUD_OFFERS, ReviewSourceFixture } from "../routes/review/source.ts";
import { RuntimeFixture, WebWindowFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "queue";
if (query.has("light")) document.documentElement.classList.remove("dark");

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const summary = (
  over: Partial<PrSummary> & Pick<PrSummary, "number" | "title" | "repo">,
): PrSummary => ({
  project_id: "p-cloud",
  host: "github.com",
  url: `https://github.com/${over.repo}/pull/${over.number}`,
  author: { login: "bob" },
  head_branch: "fix-login",
  base_branch: "main",
  state: "open",
  additions: 12,
  deletions: 3,
  created_at: ago(26 * 60),
  updated_at: ago(40),
  review_requested: false,
  mine: false,
  ...over,
});
const PRS: PrSummary[] = [
  summary({
    number: 7,
    title: "Stop the login redirect loop",
    repo: "acme/api",
    review_requested: true,
    checks: "failing",
    labels: [{ name: "bug", color: "d73a4a" }],
  }),
  summary({
    number: 12,
    title: "Rate limit the password reset",
    repo: "acme/api",
    author: { login: "carol" },
    head_branch: "reset-limit",
    updated_at: ago(180),
    review_requested: true,
    checks: "passing",
    additions: 48,
    deletions: 6,
  }),
  summary({
    number: 8,
    title: "Document the session cookie",
    repo: "acme/api",
    author: { login: "ada" },
    head_branch: "ada-docs",
    mine: true,
    updated_at: ago(60 * 20),
    additions: 30,
    deletions: 0,
  }),
  summary({
    number: 31,
    title: "Move the settings rows to the new kit",
    repo: "acme/web",
    author: { login: "dan" },
    head_branch: "settings-rows",
    state: "draft",
    updated_at: ago(60 * 5),
    additions: 210,
    deletions: 160,
  }),
];
const PATCH = `diff --git a/src/auth/login.ts b/src/auth/login.ts
@@ -10,9 +10,12 @@ export async function login(req: Request): Promise<Response> {
   const session = await readSession(req);
-  if (!session) return redirect("/login");
+  // A session that expired mid-redirect sent the browser back here forever.
+  if (!session || session.expired) {
+    return redirect("/login?next=" + encodeURIComponent(req.url));
+  }
   const user = await loadUser(session.userId);
-  return redirect("/");
+  return redirect(nextOf(req) ?? "/");
 }
`;
const PATCH_2 = `diff --git a/src/auth/next.ts b/src/auth/next.ts
@@ -0,0 +1,6 @@
+/** Where to go after signing in: only a path on this site. */
+export function nextOf(req: Request): string | null {
+  const next = new URL(req.url).searchParams.get("next");
+  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
+}
+
`;
let merged = false;
const detail = (): PrDetail => ({
  ...PRS[0]!,
  state: merged ? "merged" : "open",
  body: "A session that expired between the redirect and the callback sent the browser round the login page forever. This checks the expiry before redirecting, and keeps where the person was going.",
  head_sha: HEAD,
  mergeable: "clean",
  checks_list: [
    { name: "test", status: "failed", url: "https://github.com/acme/api/actions/runs/1" },
    { name: "lint", status: "passed" },
    { name: "typecheck", status: "passed" },
  ],
  reviewers: [
    { login: "carol", state: merged ? "approved" : "commented" },
    { login: "ada", state: view === "merge" ? "approved" : "pending" },
  ],
  commits: 2,
  files: [
    { path: "src/auth/login.ts", status: "modified", additions: 4, deletions: 2, viewed: false },
    { path: "src/auth/next.ts", status: "added", additions: 5, deletions: 0, viewed: false },
  ],
  can: {
    merge: !merged,
    review: !merged,
    comment: true,
    merge_methods: ["squash", "merge"],
    ready: false,
  },
});
const TALK: PrDiscussionItem[] = [
  {
    type: "comment",
    id: "51",
    author: { login: "bob" },
    body: "Ready for a look. The second file is new.",
    at: ago(25 * 60),
  },
  {
    type: "comment",
    id: "review-91",
    author: { login: "carol" },
    body: "Looks close. One question on the redirect.",
    at: ago(24 * 60),
    verdict: "commented",
  },
  {
    type: "thread",
    id: "61",
    path: "src/auth/login.ts",
    line: 14,
    side: "new",
    resolved: false,
    outdated: false,
    comments: [
      {
        id: "61",
        author: { login: "carol" },
        body: "Should `next` be checked here too, or only in nextOf?",
        at: ago(24 * 60),
      },
      {
        id: "62",
        author: { login: "bob" },
        body: "Only in nextOf: this one builds it from the request.",
        at: ago(23 * 60),
      },
    ],
  },
];

/** Cloud's Review routes as the page's client sees them (source.ts cloudReviewClient), scripted. */
const sent: string[] = [];
const cloud = {
  call: async (method: string, params: Record<string, unknown>) => {
    sent.push(method);
    switch (method) {
      case "pr.list":
        return view === "github"
          ? {
              prs: [],
              viewers: {},
              errors: [],
              unavailable: "Connect GitHub to review pull requests here.",
              github: "not_connected",
              connect_url: "/cave-agent/code",
            }
          : {
              prs: PRS,
              viewers: { "github.com": "ada" },
              errors: [
                {
                  project_id: "p-mobile",
                  repo: "acme/mobile",
                  message: "Connect GitHub to see its pull requests.",
                },
              ],
              github: "connected",
            };
      case "pr.get":
        return detail();
      case "pr.diff":
        return {
          head_sha: HEAD,
          files: [
            {
              path: "src/auth/login.ts",
              status: "modified",
              additions: 4,
              deletions: 2,
              patch: PATCH,
            },
            {
              path: "src/auth/next.ts",
              status: "added",
              additions: 5,
              deletions: 0,
              patch: PATCH_2,
            },
          ],
          omitted: [],
        };
      case "pr.discussion":
        return { items: TALK };
      case "pr.merge":
        merged = params.method === "squash";
        return {};
      case "pr.review":
      case "pr.comment":
        return {};
    }
    throw new Error("Do this on your Mac (Review), or on GitHub.");
  },
} as unknown as Client;

/** The runtime this window would quietly use: none (a browser with no Mac). Cloud's computers answer for Ask. */
const nobody = {
  call: (method: string) => {
    if (method === "cloud.status")
      return Promise.resolve({ runtime_id: "rt-none", cloud_url: "https://cloud.test" });
    if (method === "cloud.computers") return Promise.resolve({ available: true, computers: [] });
    return new Promise(() => undefined);
  },
  on: () => () => undefined,
};
const runtime = {
  status: "connected",
  client: nobody,
  connection: 1,
  engines: [],
  settings: { default_engine: "caveman", engines: {} },
  workspaces: [],
  projects: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const web = {
  home: null,
  mac: { kind: "none" as const },
  window: {} as never,
  places: {} as never,
  usePlace: () => undefined,
};

const entry =
  view === "queue" || view === "github"
    ? "/review"
    : `/review/p-cloud/7?repo=acme%2Fapi&host=github.com${view === "talk" ? "&tab=discussion" : ""}`;
const host = document.getElementById("review");
const result = document.getElementById("result");
if (host && result)
  flushSync(() =>
    createRoot(host).render(
      <MemoryRouter initialEntries={[entry]}>
        <RuntimeFixture value={runtime}>
          <WebWindowFixture value={web}>
            <ReviewSourceFixture value={{ client: cloud, from: "cloud", offers: CLOUD_OFFERS }}>
              <TooltipProvider>
                <main
                  data-case={view}
                  className="flex h-full min-h-0 flex-col bg-background text-foreground"
                >
                  <Routes>
                    <Route path="/review" element={<ReviewRoute />} />
                    <Route path="/review/:projectId/:number" element={<PrRoute />} />
                  </Routes>
                </main>
              </TooltipProvider>
            </ReviewSourceFixture>
          </WebWindowFixture>
        </RuntimeFixture>
      </MemoryRouter>,
    ),
  );

const said = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const press = (label: string | RegExp) => {
  const button = [...document.querySelectorAll("button")].find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""),
  );
  button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  button?.click();
  return button !== undefined;
};
const SAYS: Record<string, ReadonlyArray<string>> = {
  queue: [
    "Needs your review",
    "Stop the login redirect loop",
    "Rate limit the password reset",
    "Could not read acme/mobile: Connect GitHub to see its pull requests.",
  ],
  pr: ["Stop the login redirect loop", "login.ts", "next.ts", "Checks", "Review", "Ask"],
  talk: ["be checked here too, or only in nextOf", "Fix with agent", "Looks close."],
  approve: ["Approve", "Request changes", "Comment", "Submit review"],
  merge: ["Squash and merge #7?", "fix-login into main on acme/api. Some checks fail."],
  merged: ["Merged"],
  github: [
    "GitHub isn't connected",
    "Connect GitHub to review pull requests here.",
    "Connect GitHub",
  ],
};
const NEVER: Record<string, ReadonlyArray<string>> = {
  pr: ["TL;DR", "Mark ready", "Show the whole file", "Caveman is reading the change"],
  talk: ["Resolve"],
  approve: ["Mark ready"],
  github: ["gh auth login", "Sign in to GitHub"],
};

async function run() {
  if (view === "approve" || view === "merge" || view === "merged") {
    for (let i = 0; i < 60 && !said().includes("Stop the login redirect loop"); i++) await tick(50);
    await tick(200);
    if (view === "approve") press("Review");
    else {
      // The button says its method on a wide window and Merge on a narrow one: both are in its text.
      press(/Merge$/);
      await tick(300);
      if (view === "merged") {
        press(/^Squash and merge$/);
        await tick(300);
      }
    }
  }
  for (let i = 0; i < 60 && SAYS[view]!.some((text) => !said().includes(text)); i++) await tick(50);
  const problems: string[] = [];
  for (const text of SAYS[view] ?? [])
    if (!said().includes(text)) problems.push(`does not say: ${text}`);
  for (const text of [
    ...(NEVER[view] ?? []),
    "on your Mac (Review)",
    "Cloud computer",
    "Claude Code",
  ])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  if (/[$€£]\s?\d/.test(said())) problems.push("an amount of money is on the page");
  const refused = sent.filter(
    (m) =>
      ![
        "pr.list",
        "pr.get",
        "pr.diff",
        "pr.discussion",
        "pr.merge",
        "pr.review",
        "pr.comment",
      ].includes(m),
  );
  if (refused.length > 0)
    problems.push(`asked Cloud for what it does not do: ${[...new Set(refused)].join(", ")}`);
  if (view === "merged" && !sent.includes("pr.merge"))
    problems.push("the merge never reached Cloud");
  result!.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
  document.documentElement.dataset.result = problems.length === 0 ? "passed" : "failed";
}
if (host && result) void run();
