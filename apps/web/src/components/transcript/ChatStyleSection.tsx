// The style page's Chat section (#/style): the real transcript, artifact
// cards, the artifact side panel and the message rail on illustrative items.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { useState } from "react";
import { SessionModel } from "../../state/transcript.ts";
import type { ToolItem, TranscriptItem } from "../../state/transcript-model.ts";
import { ArtifactPanel } from "../artifacts/ArtifactPanel.tsx";
import { Transcript } from "../Transcript.tsx";

const at = new Date(Date.now() - 20 * 60_000).toISOString();
const later = new Date(Date.now() - 19 * 60_000).toISOString();

export const tool = (id: string, icon: ToolItem["icon"], verb: string, subject: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  verb,
  subject,
  parts: [{ action: icon === "run" ? "command" : icon === "agent" ? "other" : icon, subject }],
  command: null,
  status: "done",
  startedAt: at,
  finishedAt: later,
  added: null,
  removed: null,
  output: "",
  name: icon,
  input: {},
  result: null,
  icon,
  ...extra,
});

/** A patch over several files, as the transcript reads it from tool.started `files`: the reducer builds its line. */
function patchTool(id: string, files: ReadonlyArray<{ path: string; old_path?: string; status: "added" | "modified" | "deleted" | "renamed" }>): ToolItem {
  const model = new SessionModel();
  const event = (cursor: number, when: string, type: "tool.started" | "tool.done", payload: unknown) => ({ session_id: "style", cursor, at: when, item_id: id, type, payload }) as SessionEvent;
  model.apply(event(1, at, "tool.started", { name: "edit", title: files[0]!.old_path ?? files[0]!.path, kind: "edit", input: { path: files[0]!.path }, files }));
  model.apply(event(2, later, "tool.done", { status: "completed" }));
  return model.snapshot().items[0] as ToolItem;
}

/**
 * The runtime's own tools on other threads, as the reducer reads them from their events: a message sent and a question
 * (each opens to its words), a read (it opens that thread) and a new thread started with its prompt.
 */
function threadTools(): ReadonlyArray<TranscriptItem> {
  const model = new SessionModel();
  let cursor = 0;
  const event = (id: string, when: string, type: "tool.started" | "tool.done", payload: unknown) => ({ session_id: "style", cursor: ++cursor, at: when, item_id: id, type, payload }) as SessionEvent;
  const metrics = { workspace_id: "ws-style-metrics", title: "Wire breaker metrics" };
  const call = (id: string, name: string, input: unknown, threads: unknown, done: unknown) => {
    model.apply(event(id, at, "tool.started", { name: `mcp__caveman-code__${name}`, title: `mcp__caveman-code__${name}`, kind: "mcp", input, ...(threads ? { threads } : {}) }));
    if (done) model.apply(event(id, later, "tool.done", done));
  };
  call("th1", "thread_send", { threadId: "b", message: "The breaker opens per endpoint now. Rebase on `main` and add a **metric** for each open." }, [metrics], { status: "completed" });
  call("th2", "thread_read", { threadId: "b", limit: 3 }, [metrics], { status: "completed" });
  call("th3", "thread_launch", { title: "Docs: retry schedule", message: "Rewrite the retry table in docs/webhooks.md to match full jitter." }, null, { status: "completed", threads: [{ workspace_id: "ws-style-docs", title: "Docs: retry schedule" }] });
  call("th4", "thread_send", { threadId: "b", message: "Should the breaker reset on deploy?", expectReply: true }, [metrics], { status: "completed" });
  return model.snapshot().items;
}

const user = (id: string, text: string): TranscriptItem => ({ kind: "user", id, text, at, delivery: "message" });
const answer = (id: string, text: string, streaming = false): TranscriptItem => ({ kind: "assistant", id, text, streaming, at });

/** A stand-in screenshot for the gallery strip: a page in one colour, as the data URL an engine could send. */
const shot = (label: string, w: number, h: number, fill: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/><rect x="24" y="24" width="${Math.round(w * 0.4)}" height="18" rx="4" fill="#fff" opacity=".75"/><rect x="24" y="60" width="${w - 48}" height="${Math.round(h * 0.35)}" rx="8" fill="#fff" opacity=".18"/><text x="24" y="${h - 28}" font-family="sans-serif" font-size="22" fill="#fff">${label}</text></svg>`)}`;

const ITEMS: ReadonlyArray<TranscriptItem> = [
  user("u1", "Retries to slow endpoints fire in lockstep at the top of each minute. Add full jitter and a per-endpoint breaker, and keep the docs' schedule accurate."),
  { kind: "reasoning", id: "r1", text: "Lockstep at :00 smells like rounding. Check Scheduler.Next first.", streaming: false },
  tool("t1", "search", "Searched for", "Truncate(time.Minute) in webhook"),
  tool("t2", "read", "Read", "webhook/retry.go"),
  tool("t3", "edit", "Edited", "webhook/retry.go", {
    added: 3,
    removed: 2,
    name: "Edit",
    input: { old_string: "\twait := time.Duration(1<<attempt) * time.Minute\n\treturn s.now().Add(wait).Truncate(time.Minute)", new_string: "\tceiling := min(base*time.Duration(1<<d.Attempts), maxWait)\n\twait := time.Duration(rand.Int64N(int64(ceiling)))\n\treturn s.now().Add(wait)" },
  }),
  tool("t4", "create", "Created", "webhook/breaker.go", { name: "Write", input: { content: "package webhook\n\n// Breaker opens per endpoint after 20 failures in a row.\ntype Breaker struct{}\n" } }),
  tool("t5", "run", "Tested", "./webhook/...", {
    parts: [{ action: "test", subject: "./webhook/..." }],
    command: "go test ./webhook/... -race",
    output: "ok  \tacme/api-gateway/webhook\t3.412s\n41 passed\n",
  }),
  answer(
    "a1",
    'Found it: `Scheduler.Next` rounded every retry to the minute. Now:\n\n```go title="webhook/retry.go"\nfunc (s *Scheduler) Next(d Delivery) time.Time {\n\tceiling := min(base*time.Duration(1<<d.Attempts), maxWait)\n\twait := time.Duration(rand.Int64N(int64(ceiling)))\n\treturn s.now().Add(wait)\n}\n```\n\n| Attempt | Old wait | New wait |\n|---|---|---|\n| 1 | 1 min | 0 to 30 s |\n| 2 | 2 min | 0 to 1 min |\n| 12+ | 34 h | 0 to 6 h |\n\n- [x] Full jitter\n- [x] Per-endpoint breaker\n- [ ] Docs\n\nOpened https://github.com/acme/api-gateway/pull/482.',
  ),
  { kind: "turn_end", id: "e1", outcome: "completed", at: later, cursor: 9 },
  user("d1", "Write the retry design up as a doc for the team."),
  tool("d1t", "create", "Created", "docs/", {
    name: "Write",
    input: {
      content:
        "# Retries: full jitter and a breaker per endpoint\n\nRetries to slow endpoints fired in lockstep at the top of each minute. Each wait is now drawn from the whole window, and an endpoint that fails 20 times in a row stops getting tries for five minutes.\n\n## Schedule\n\n| Attempt | Wait |\n|---|---|\n| 1 | 0 to 30 s |\n",
    },
  }),
  answer("d1a", "The design is in `docs/`: the lockstep bug, the new schedule, and the breaker. The jitter itself is `webhook/retry.go:42`; the breaker's limits are in [breaker.go](webhook/breaker.go)."),
  { kind: "turn_end", id: "d1e", outcome: "completed", at: later, cursor: 12 },
 // One Codex patch over several files: its line says what happened to each, and opens to every file (upstream #22541).
  user("pt1", "Move the backoff math into its own file, rename scheduler.go, and drop the old shim."),
  patchTool("pt1t", [
    { path: "webhook/backoff.go", status: "added" },
    { path: "webhook/retry.go", status: "modified" },
    { path: "webhook/schedule.go", old_path: "webhook/scheduler.go", status: "renamed" },
    { path: "webhook/legacy_shim.go", status: "deleted" },
  ]),
  answer("pt1a", "Done in one patch: the backoff math lives in `webhook/backoff.go`, and nothing imported the shim."),
  { kind: "turn_end", id: "pt1e", outcome: "completed", at: later, cursor: 16 },
  user("u2", "why not equal jitter?"),
  // Web steps: a search opens to its sources, a page read to its page; the run counts them.
  tool("w1", "web", "Searched the web for", "exponential backoff full jitter vs equal jitter", {
    name: "web_search",
    parts: [{ action: "web_search", subject: "exponential backoff full jitter vs equal jitter" }],
    sources: [
      { title: "Exponential Backoff And Jitter | AWS Architecture Blog", url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/" },
      { title: "Exponential Backoff And Jitter", url: "https://brooker.co.za/blog/2015/03/21/backoff.html" },
      { title: "Retry with jitter · App-vNext/Polly Wiki", url: "https://github.com/App-vNext/Polly/wiki/Retry-with-jitter" },
      { title: "Retry strategy | Cloud Storage | Google Cloud", url: "https://cloud.google.com/storage/docs/retry-strategy" },
      { title: null, url: "https://sre.google/sre-book/addressing-cascading-failures/" },
    ],
  }),
  tool("w2", "web", "Fetched", "aws.amazon.com", {
    name: "web_fetch",
    sources: [{ title: "Exponential Backoff And Jitter | AWS Architecture Blog", url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/" }],
  }),
  tool("w3", "web", "Searched the web for", "decorrelated jitter thundering herd", {
    name: "web_search",
    parts: [{ action: "web_search", subject: "decorrelated jitter thundering herd" }],
    sources: [{ title: "Thundering herd problem - Wikipedia", url: "https://en.wikipedia.org/wiki/Thundering_herd_problem" }],
  }),
  tool("w4", "web", "Fetched", "brooker.co.za", { name: "web_fetch", sources: [{ title: null, url: "https://brooker.co.za/blog/2015/03/21/backoff.html" }] }),
  tool("w5", "web", "Fetched", "sre.google", { name: "web_fetch", sources: [{ title: null, url: "https://sre.google/sre-book/addressing-cascading-failures/" }] }),
  answer("a2", "Equal jitter keeps half of each wait fixed, so retries still cluster around the midpoint. Full jitter spreads them across the whole window."),
  user("u3", "ok"),
  answer("a3", "Next: the breaker metrics."),
  // UI work ends with proof: the screenshots gather in one strip under the reply and open the chat's viewer.
  user("u5", "Make the delivery log fit a phone, and show me."),
  answer(
    "a4",
    `The log stacks under 640 px and the filters fold into one menu.\n\n![Delivery log, wide](${shot("Delivery log, wide", 1280, 800, "#3b5bdb")})\n![Delivery log, phone](${shot("Phone", 390, 844, "#0b7285")})\n![Filters menu, phone](${shot("Filters", 390, 844, "#5f3dc4")})`,
  ),
  // Another thread's agent wrote this one: a "From" pill over an outlined bubble.
  {
    ...user("p1", "x/net moved in [Go 1.26 upgrade](t3-context://v1/thread/go126): rebase before you touch webhook/."),
    from: { workspace_id: "go126", title: "Go 1.26 upgrade" },
  } as TranscriptItem,
  // A sender with no workspace to open (a delegated child): a quiet pill, not a link.
  { ...user("p2", "Breaker metrics are wired; 41 tests pass."), from: { title: "Wire breaker metrics" } } as TranscriptItem,
  user("u4", "Have an agent review the diff against [Idempotency keys on /send](t3-context://v1/thread/idem), then update docs/webhooks.md."),
  {
    kind: "subagent",
    id: "s1",
    title: "Review the retry change",
    workspaceId: null,
    agent: null,
    runner: null,
    summary: null,
    startedAt: later,
    finishedAt: later,
    status: "done",
    items: [tool("s1t1", "read", "Read", "webhook/retry.go"), tool("s1t2", "read", "Read", "webhook/breaker.go"), answer("s1a", "Looks good; nothing blocking.")],
  },
  {
    kind: "subagent",
    id: "s2",
    title: "Find every caller of retry.Schedule",
    workspaceId: "ws-delegated",
    agent: "codex",
    runner: { engine: "codex", instance_id: "codex-work", account_tag: "WRK", model: "gpt-6.1-sol", effort: "high", pick: { by: "auto", kind: "research" } },
    summary: "Three callers: webhook/send.go:88, webhook/replay.go:41 and jobs/backfill.go:120. Only send.go passes a custom backoff.",
    startedAt: later,
    finishedAt: later,
    status: "done",
    items: [],
  },
  tool("t6", "edit", "Editing", "docs/webhooks.md", { status: "running", finishedAt: null, startedAt: new Date().toISOString() }),
  answer("a4", "Updating the schedule table so it matches the new ", true),
];

const STATES: ReadonlyArray<{ label: string; running: boolean; items: () => ReadonlyArray<TranscriptItem> }> = [
  { label: "Sent, nothing back yet", running: true, items: () => [{ kind: "user", id: "x", text: "Fix the flaky test", at: new Date().toISOString(), delivery: "message" }] },
  { label: "Thinking", running: true, items: () => [{ kind: "reasoning", id: "x", text: "", streaming: true }] },
  { label: "Compacting", running: true, items: () => [{ kind: "compaction", id: "x", status: "running", before: null, after: null, at: new Date().toISOString() }] },
  { label: "Compacted", running: true, items: () => [{ kind: "compaction", id: "x", status: "done", before: 182_000, after: 31_000, at: new Date().toISOString() }] },
  { label: "Routed", running: true, items: () => [{ kind: "route", id: "x", model: "claude-opus-5-5", at: new Date().toISOString() }] },
  { label: "Retrying", running: true, items: () => [{ kind: "retry", id: "x", attempt: 2, max: 5, message: "Overloaded" }] },
  { label: "Agent working", running: true, items: () => [{ kind: "subagent", id: "x", title: "Wire breaker metrics", workspaceId: null, agent: null, runner: null, summary: null, status: "running", startedAt: new Date().toISOString(), finishedAt: null, items: [] }] },
  {
    label: "Subagents working",
    running: true,
    items: () => {
      const now = Date.now();
      const ago = (s: number) => new Date(now - s * 1000).toISOString();
      const sub = (id: string, title: string, status: "running" | "done", startedAt: string, items: ReadonlyArray<TranscriptItem>, summary: string | null = null): TranscriptItem => ({
        kind: "subagent",
        id,
        title,
        workspaceId: null,
        agent: "claude-agent",
        runner: null,
        summary,
        status,
        startedAt,
        finishedAt: status === "done" ? ago(20) : null,
        items,
      });
      return [
        sub("g1", "Find every caller of Scheduler.Next", "running", ago(48), [tool("g1t", "read", "Reading", "webhook/dispatch.go", { status: "running", finishedAt: null })]),
        sub("g2", "Read the incident timeline", "done", ago(95), [tool("g2t", "read", "Read", "docs/incidents/0412.md")], "Every failure lined up on :00 within 40 ms."),
        sub("g3", "Check the breaker tests", "running", ago(12), [tool("g3t", "run", "Running", "go test ./webhook -run Breaker", { status: "running", finishedAt: null })]),
      ];
    },
  },
  // Full access, and the engine asked anyway: why, in its words, and a hint that explains the cause.
  {
    label: "Approval in full access",
    running: true,
    items: () => [
      tool("fa1", "run", "Running", 'rm -r -- "$rr/$h"', { status: "running", finishedAt: null, command: 'rm -r -- "$rr/$h"' }),
      {
        kind: "ask",
        id: "fa-ask",
        askKind: "approval",
        prompt: 'Claude wants to run rm -r -- "$rr/$h"',
        reason: "Dangerous rm on a path built from a variable",
        fullAccessOverride: "engine_check",
        toolItemId: "fa1",
        options: [
          { id: "accept", label: "Approve", description: null, decision: "allow" },
          { id: "decline", label: "Decline", description: null, decision: "deny" },
        ],
        resolution: null,
        questions: [],
        round: null,
        answers: null,
      },
    ],
  },
 // Claude Agent's approvals take a note with the deny, which the call that asked reads (upstream #23657).
  {
    label: "Approval that takes a note",
    running: true,
    items: () => [
      tool("fb1", "run", "Running", "rm -rf build/ dist/", { status: "running", finishedAt: null, command: "rm -rf build/ dist/" }),
      {
        kind: "ask",
        id: "fb-ask",
        askKind: "approval",
        prompt: "Claude wants to run rm -rf build/ dist/",
        acceptsFeedback: true,
        toolItemId: "fb1",
        options: [
          { id: "accept", label: "Allow", description: null, decision: "allow" },
          { id: "acceptForSession", label: "Allow for this chat", description: null, decision: "allow" },
          { id: "decline", label: "Deny", description: null, decision: "deny" },
        ],
        resolution: null,
        questions: [],
        round: null,
        answers: null,
      },
    ],
  },
 // A question whose options show what each looks like (Claude's previews, upstream #21932): the pointed-at one's below.
  {
    label: "Question with previews",
    running: true,
    items: () => [
      {
        kind: "ask",
        id: "pv-ask",
        askKind: "question",
        prompt: "Where should the delivery log's filters go?",
        options: [
          { id: "rail", label: "A rail on the left", description: "Always visible; costs width", preview: "┌────────┬───────────────────┐\n│ Status │ 12:04  push  ok   │\n│ ☑ ok   │ 12:03  push  ok   │\n│ ☐ fail │ 12:01  issue skip │\n│ Event  │ 11:58  push  fail │\n└────────┴───────────────────┘" },
          { id: "menu", label: "One Filters menu", description: "Folds away on a phone", preview: "┌────────────────────────────┐\n│ [Filters ▾]          3 of 9│\n│ 12:04  push   ok           │\n│ 12:03  push   ok           │\n│ 11:58  push   fail         │\n└────────────────────────────┘" },
          { id: "none", label: "No filters", description: "Search only" },
        ],
        resolution: null,
        questions: [{ id: "layout", prompt: "Where should the delivery log's filters go?", detail: null, options: [], recommended: null, multiSelect: false }],
        round: null,
        answers: null,
      },
    ],
  },
  // Claude's AskUserQuestion with several questions: each its own options, all answered in one reply.
  {
    label: "Question with several questions",
    running: true,
    items: () => {
      const where = [
        { id: "Here or Cloud", label: "Here or Cloud", description: "The agent picks: this computer, or Cloud so it fires with the laptop closed." },
        { id: "Wherever it runs", label: "Wherever it runs", description: "Only the computer the chat is on, but reliable." },
      ];
      const ask = [
        { id: "Ask first", label: "Ask first", description: "A card like this one before anything is scheduled." },
        { id: "Just tell me", label: "Just tell me", description: "It schedules, and says so in the chat." },
      ];
      return [
        {
          kind: "ask",
          id: "mq-ask",
          askKind: "question",
          prompt: "Where should an agent be able to put scheduled work?\n\nWhen an agent schedules work that runs while nobody is watching, should it ask you first?",
          options: where,
          resolution: null,
          questions: [
            { id: "Where should an agent be able to put scheduled work?", prompt: "Where should an agent be able to put scheduled work?", detail: null, options: where, recommended: null, multiSelect: false },
            { id: "Should it ask you first?", prompt: "When an agent schedules work that runs while nobody is watching, should it ask you first?", detail: null, options: ask, recommended: null, multiSelect: false },
          ],
          round: null,
          answers: null,
        },
      ];
    },
  },
  // What another chat's agent sent, and a scheduled task's prompt: one line each until opened.
  {
    label: "From other agents and schedules",
    running: false,
    items: () => [
      { kind: "user", id: "m-agent", text: "Review finished\n\nThe migration drops the index before backfilling it.", at, delivery: "message", from: { title: "Review the migration" } },
      { kind: "user", id: "m-sched", text: "Triage the inbox\n\nLabel every new issue and close duplicates.", at, delivery: "message", scheduled: { taskId: "task-1", title: "Nightly triage" } },
    ],
  },
  { label: "Talking to other threads", running: false, items: threadTools },
  // A turn's edits outside the chat's folder: no checkpoint saw them, so its Changes card lists them without Undo and Keep.
  {
    label: "Changed files elsewhere",
    running: false,
    items: () => [
      tool("c1", "edit", "Edited", "/Users/me/code/billing/src/invoice/totals.ts", { name: "Edit", added: 6, removed: 2 }),
      tool("c2", "create", "Created", "/Users/me/code/billing/src/invoice/rounding.ts", { name: "Write", added: 14 }),
      tool("c3", "edit", "Edited", "/Users/me/code/billing/README.md", { name: "Edit" }),
      { kind: "turn_end", id: "c-end", outcome: "completed", at: new Date().toISOString(), cursor: 4 },
    ],
  },
  {
    label: "Delegated working",
    running: true,
    items: () => [
      {
        kind: "subagent",
        id: "x",
        title: "A1 session correlation + measured savings",
        workspaceId: "ws-delegated-live",
        agent: "codex",
        runner: { engine: "codex", instance_id: "codex", account_tag: "JU", model: "gpt-6.1-sol", effort: "high", pick: { by: "user" } },
        summary: null,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        items: [],
      },
    ],
  },
];

/** Every live agent state on its own; Replay remounts them so the one-shots land again. */
export function AgentStatesSection() {
  const [run, setRun] = useState(0);
  return (
    <section id="agent-states" aria-labelledby="agent-states-h" className="border-t border-border py-10">
      <div className="flex items-center gap-3">
        <h2 id="agent-states-h" className="text-[14px] font-medium text-foreground">
          Agent states
        </h2>
        <button type="button" onClick={() => setRun((n) => n + 1)} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Replay
        </button>
      </div>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">Each state the agent can be in, as its transcript line. A running line's title shimmers for as long as the state lasts.</p>
      <div className="mt-5 grid grid-cols-3 gap-3">
        {STATES.map((s) => (
          <div key={`${s.label}:${run}`} className="rounded-xl border border-border px-4 py-3">
            <div className="mb-1 text-[12px] text-[hsl(var(--subtle-foreground))]">{s.label}</div>
            <Transcript items={s.items()} engine="caveman" engineLabel="Caveman" engineIsCaveman running={s.running} onAnswer={() => {}} cavemanVersion={null} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ChatStyleSection() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section id="chat" aria-labelledby="chat-h" className="border-t border-border py-10">
      <h2 id="chat-h" className="text-[14px] font-medium text-foreground">
        Chat
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        AI Elements on the deck: the user's words in a bubble, the engine's answer as streamed markdown under its mark, tool runs as trace lines that fold into a summary, and every artifact one click from the side panel. Paths in an answer are file chips; a turn that writes a document ends with its card. Hover the rail on the left; Tab to it and use the arrows.
      </p>
      <div className="mt-5 flex h-[640px] overflow-hidden rounded-xl border border-border">
        <Conversation className="min-w-0" contentClassName="pb-6 pl-14 pr-6 pt-4">
          {/* A workspace id, so paths in answers draw as file chips and doc cards can open (into a panel this page doesn't show). */}
          <Transcript items={ITEMS} engine="caveman" engineLabel="Caveman" engineIsCaveman running onAnswer={() => {}} cavemanVersion={null} sessionId="style-demo" workspaceId="style-demo" onOpenArtifact={setOpen} openArtifactId={open} />
        </Conversation>
        <div className="flex w-[400px] shrink-0 flex-col border-l border-border">
          <ArtifactPanel sessionId="style-demo" workspaceId="style-demo" selected={open} onSelect={setOpen} />
        </div>
      </div>
    </section>
  );
}
