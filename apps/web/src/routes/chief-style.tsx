// The style page's Chief section (#/style): every card its tool calls become,
// and both halves of the board, on fixtures. Nothing here talks to a runtime.
import type { ChiefItem } from "@caveman-app/session-protocol";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { useState } from "react";
import { type InlineRefs, Transcript } from "../components/Transcript.tsx";
import type { WorkspaceView } from "../state/model.ts";
import type { ToolItem, TranscriptItem } from "../state/transcript-model.ts";
import { Board } from "./Chief.tsx";
import { ChiefActionsProvider, ChiefToolCards, isChiefTool, type ChiefActions } from "./chief-cards.tsx";
import type { WorkGroup } from "./chief/work-model.ts";
import { WorkMark } from "./chief/work.tsx";
import { doneToday, stacksForInbox } from "./inbox-model.ts";

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const ws = (id: string, title: string, repo: string, state: WorkspaceView["state"], min: number, over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  title,
  repo,
  repoRef: { path: `/Users/you/${repo}` },
  branch: null,
  state,
  asleep: false,
  detail: null,
  engine: { id: "caveman", label: "Caveman" },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: null,
  projectId: null,
  createdAt: at(min + 20),
  updatedAt: at(min),
  unread: false,
  ...over,
});

const WORKSPACES: WorkspaceView[] = [
  ws("renum", "Renumber migration 0391 to 0394", "Caveman Cloud", "working", 2, { computer: { kind: "caveman_cloud", label: "Cloud computer" } }),
  ws("gemini", "Gemini wrap drops tool results", "caveman-v4", "needs_input", 1),
  ws("rail", "Chief rail UI", "caveman-code", "working", 6, { engine: { id: "claude-agent", label: "Claude Agent" } }),
  ws("hub", "Plugins page copy", "caveman-code", "completed", 12, { unread: true, engine: { id: "codex", label: "Codex" } }),
  ws("broker", "Broker credit windows", "Caveman Cloud", "completed", 40),
];

const item = (id: string, text: string, state: ChiefItem["state"], rank: number, over: Partial<ChiefItem> = {}): ChiefItem => ({
  id,
  text,
  state,
  rank,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: [],
  created_at: at(30),
  updated_at: at(2),
  ...over,
});

const ITEMS: ChiefItem[] = [
  item("rail", "build the chief rail", "started", 0, { title: "Chief rail UI", workspace_ids: ["rail"] }),
  item("lego", "reply to the LEGO thread", "queued", 1, { title: "Reply to the LEGO pilot thread", pinned: true }),
  item("codex", "bench the codex arm", "proposed", 2, { title: "Bench the Codex arm on TB4", project_ids: ["bench"] }),
  item("claude", "and the claude arm", "proposed", 3, { title: "Bench the Claude Agent arm on TB4", project_ids: ["bench"] }),
  item("dark", "dark mode for runs", "blocked", 4, { title: "Dark mode for runs", blocked_on: { kind: "item", item_id: "rail" } }),
  item("cap", "re-run the nightly bench", "blocked", 5, { title: "Re-run the nightly bench", blocked_on: { kind: "capacity" } }),
  item("new", "the settings toggle looks off on 1x screens", "unsorted", 6, { source: "capture" }),
];

const PROJECTS: Record<string, string> = { cloud: "Caveman Cloud", v4: "caveman-v4", bench: "caveman-bench" };

const tool = (id: string, name: string, input: unknown, result: unknown, status: ToolItem["status"] = "done"): ToolItem => ({
  kind: "tool",
  id,
  verb: "Ran",
  subject: name,
  parts: [{ action: "mcp", subject: name }],
  command: null,
  status,
  startedAt: at(3),
  finishedAt: null,
  added: null,
  removed: null,
  output: "",
  name,
  input,
  result,
  icon: "other",
});

const TRANSCRIPT: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "the broker 0391 collides, renumber it. also the gemini wrap bug. and remember we never push agent-sdk origin", at: at(4), delivery: "message" },
  tool("t1", "chat_start", { title: "Renumber migration 0391 to 0394", project_ids: ["cloud"] }, { state: "started", item_id: "renum", chats: [{ workspace_id: "renum", title: "Renumber migration 0391 to 0394", project_id: "cloud" }] }),
  tool("t2", "chat_start", { title: "Gemini wrap drops tool results", project_ids: ["v4"] }, { state: "started", item_id: "gemini", chats: [{ workspace_id: "gemini", title: "Gemini wrap drops tool results", project_id: "v4" }] }),
  tool("t3", "chat_start", { title: "Changelog for rc.29" }, null, "running"),
  tool("t4", "remember", { text: "Never push the public agent-sdk origin; SDK changes go to the private remote." }, { id: "n1", vid: "v1" }),
  { kind: "assistant", id: "a1", text: "Started two chats and remembered the agent-sdk rule.", streaming: false, at: at(3) },
  { kind: "user", id: "u2", text: "bench the codex arm and the claude arm tonight. dark mode for runs after the rail", at: at(3), delivery: "message" },
  tool("t5", "chat_start", { title: "Bench the Codex arm on TB4", project_ids: ["bench"], brief: "Run the TB4 benchmark on the Codex arm and compare with last night's numbers. Done when the table is in the report." }, { state: "proposed", item_id: "codex", reason: "two chats on one note" }),
  tool("t6", "chat_start", { title: "Bench the Claude Agent arm on TB4", project_ids: ["bench"], brief: "Same benchmark on the Claude Agent arm.", guess: true }, { state: "proposed", item_id: "claude", reason: "The project is a guess, so the person confirms it (Suggested chats)." }),
  tool("t7", "queue_add", { title: "Dark mode for runs" }, { item_id: "dark" }),
  tool("t8", "chat_send", { workspace_id: "renum", text: "also bump the README", mode: "steer" }, {}),
  tool("t9", "schedule", { item_id: "lego", at: at(-600) }, {}),
  tool("t10", "chat_start", { title: "Nightly bench" }, { state: "blocked", item_id: "cap", reason: "capacity" }),
  { kind: "user", id: "u3", text: "reply to the LEGO thread", at: at(2), delivery: "message" },
  tool("t11", "ask", { question: "There are two LEGO threads: the pilot scope and the pricing follow-up. Which one should the reply go to?", recommended: "The pilot scope thread" }, {}),
];

// How the Chief explains (prompt.ts, the result and catch_up playbooks): finished work as a lead line, a few bullets and
// at most one diagram; work under way as the decision it took; a catch-up as one message per chat, running ones sharing
// one. Its numbers as the prompt's own examples use them, so the catch-up below is that one.
const EXPLAINED: Readonly<Record<number, { readonly title: string; readonly group: WorkGroup }>> = {
  4: { title: "Group chat list by work type", group: "working" },
  12: { title: "Login wrap on mobile", group: "review" },
  15: { title: "Cache for the orders page", group: "needs" },
  16: { title: "Slow start", group: "review" },
  17: { title: "Deploy to staging", group: "blocked" },
  18: { title: "Paginate GET /orders", group: "working" },
  19: { title: "Flaky upload test", group: "working" },
  20: { title: "One-button private bug reports", group: "review" },
  21: { title: "Docs search", group: "working" },
};

const explainedRefs: InlineRefs = {
  pattern: /\[\[\d+\]\]/,
  render: (ref) => {
    const work = EXPLAINED[Number(ref.slice(2, -2))];
    if (!work) return <span>{ref}</span>;
    return (
      <a href="#chief-explains" className="work-link" onClick={(e) => e.preventDefault()}>
        <WorkMark group={work.group} className="mr-1 inline-block size-3.5 -translate-y-px align-middle" />
        {work.title}
      </a>
    );
  },
};

const EXPLAINING: TranscriptItem[] = [
  {
    kind: "assistant",
    id: "e1",
    text: [
      "[[20]] makes bug reports one button: the report and its logs go to Cloud privately, and none is lost before Cloud is live. PR #104 (app) and #955 (Cloud).",
      "",
      "- The app keeps each report on disk until Cloud accepts it.",
      "- Until #955 is deployed Cloud answers `not_found`; the app says \"Bug reports aren't available yet\" and retries daily for a week.",
      "- Deploying #955 needs its database migration and the Terraform permission change.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[Report button] --> B[Saved on disk]",
      "  B --> C{Cloud accepts?}",
      "  C -- yes --> D[Sent with its logs]",
      "  C -- not yet --> E[Retry daily, up to a week]",
      "  E --> C",
      "```",
    ].join("\n"),
    streaming: false,
    at: at(9),
  },
  { kind: "assistant", id: "e2", text: "[[4]] chose to tag each chat's kind of work in the title writer's call, over a second model call: that call already reads the chat's first message. Next it mocks assigning a kind to a Chief.", streaming: false, at: at(6) },
  { kind: "user", id: "e3", text: "catch me up", at: at(2), delivery: "message" },
  {
    kind: "assistant",
    id: "e4",
    text: [
      "[[15]] waits on you: one cache per user or shared? Per user is my pick: the data is private.",
      "[[17]] is blocked: it needs a GitHub token for acme/staging.",
      "[[12]] is fixed: a fixed width clipped the button under 380px. PR #88.",
      "[[16]] traced it to adapter loading; start is 0.5s now. PR #91.",
      "[[18]] chose cursor pagination: offsets skip rows mid-scroll.",
      "Still running: [[19]], [[21]].",
    ].join("\n\n"),
    streaming: false,
    at: at(1),
  },
];

export function ChiefStyleSection() {
  const [items, setItems] = useState(ITEMS);
  const actions: ChiefActions = {
    workspaces: WORKSPACES,
    items,
    projectName: (id) => PROJECTS[id] ?? id,
    name: "Chief",
    answered: new Set(),
    open: () => undefined,
    startAll: async (ids) => setItems((all) => all.map((i) => (ids.includes(i.id) ? { ...i, state: "started" } : i))),
    dismiss: (id) => setItems((all) => all.map((i) => (i.id === id ? { ...i, state: "dropped" } : i))),
    setProjects: async (id, project_ids) => setItems((all) => all.map((i) => (i.id === id ? { ...i, project_ids } : i))),
    reply: async () => undefined,
    undo: async () => "changed",
  };
  const stacks = stacksForInbox(WORKSPACES, null);
  const done = doneToday(WORKSPACES, stacks);
  return (
    <section id="chief" aria-labelledby="chief-h" className="border-t border-border py-10">
      <h2 id="chief-h" className="text-[14px] font-medium text-foreground">
        Chief
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        One place to type. Its tool calls become cards: a started chat opens it, Suggested chats start with one click, a remembered note can be undone while it is still the
        Chief's, a question carries its recommended answer, and queue edits are one quiet line. No card shows cost. The rail is the board: Running over the Queue.
      </p>
      <TooltipProvider delayDuration={500}>
        <ChiefActionsProvider value={actions}>
          <div className="mt-5 flex h-[760px] overflow-hidden rounded-xl border border-border">
            <Conversation className="min-w-0" contentClassName="pb-6 pl-14 pr-6 pt-4">
              <Transcript
                items={TRANSCRIPT}
                engine="caveman"
                engineLabel="Chief"
                engineIsCaveman
                running={false}
                onAnswer={() => undefined}
                cavemanVersion={null}
                toolCards={(tools) => (tools.every(isChiefTool) ? <ChiefToolCards tools={tools} /> : null)}
              />
            </Conversation>
            <aside aria-label="Board" className="flex w-[360px] shrink-0 flex-col border-l border-border">
              <Board
                stacks={done ? [...stacks, done] : stacks}
                queue={items.filter((i) => ["unsorted", "queued", "proposed", "blocked", "scheduled"].includes(i.state))}
                items={items}
                onOpen={() => undefined}
                onStart={(i) => setItems((all) => all.map((x) => (x.id === i.id ? { ...x, state: "started" } : x)))}
                onDrop={(i) => setItems((all) => all.map((x) => (x.id === i.id ? { ...x, state: "dropped" } : x)))}
                onMove={() => undefined}
                onBox={() => undefined}
              />
            </aside>
          </div>
        </ChiefActionsProvider>
      </TooltipProvider>
      <h3 id="chief-explains" className="mt-8 text-[13px] font-medium text-foreground">
        Explaining work
      </h3>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        Never a status line. Finished work: what it does and why it matters, then how it works in a few bullets, and one diagram only when it is a flow. Work under way: the
        decision it took and why. A catch-up only when asked: one message per chat, what waits on you first, running chats with nothing decided share one.
      </p>
      <TooltipProvider delayDuration={500}>
        <div className="mt-4 overflow-hidden rounded-xl border border-border">
          <Conversation className="min-w-0" contentClassName="pb-6 pl-14 pr-6 pt-4">
            <div className="mx-auto max-w-[760px]">
              <Transcript items={EXPLAINING} engine="caveman" engineLabel="Chief" engineIsCaveman running={false} onAnswer={() => undefined} cavemanVersion={null} inlineRefs={explainedRefs} />
            </div>
          </Conversation>
        </div>
      </TooltipProvider>
    </section>
  );
}
