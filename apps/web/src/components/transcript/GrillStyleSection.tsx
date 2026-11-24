// The style page's Grill mode section (#/style): the real round card, its
// answered fold, the finish card and the composer with Grill on, on fixture
// data. The waiting round answers for real: send it and it folds.
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { useMemo, useState, type ReactNode } from "react";
import { answerText, type AskReply } from "../../state/grill.ts";
import { RuntimeFixture, useRuntime } from "../../state/runtime.tsx";
import type { AskAnswer, AskQuestion, TranscriptItem } from "../../state/transcript-model.ts";
import { Composer } from "../Composer.tsx";
import { Transcript } from "../Transcript.tsx";
import { tool } from "./ChatStyleSection.tsx";
import { formatChord } from "../../panels/chrome.tsx";

const at = new Date(Date.now() - 6 * 60_000).toISOString();

const WHERE = `Today the API is stateless: every request carries a JWT, and nothing can revoke one before it expires. A session needs a home.

- **Postgres**: one \`sessions\` table next to \`users\`, a row per device. Signing out is a \`DELETE\`.
- **Redis**: faster reads, but a new service in every environment, the VPC chart included.
- **Signed cookie**: no storage, so no way to revoke.

\`\`\`sql
create table sessions (
  id uuid primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null
);
\`\`\`

Most requests already read Postgres, so one more indexed lookup costs little.`;

const QUESTIONS: AskQuestion[] = [
  {
    id: "store",
    prompt: "Where do sessions live?",
    detail: WHERE,
    options: [
      { id: "pg", label: "Postgres", description: "One table, rows expire" },
      { id: "redis", label: "Redis", description: "Fast, one more service to run" },
      { id: "cookie", label: "Signed cookie", description: "No storage, can't revoke" },
    ],
    recommended: "pg",
    multiSelect: false,
  },
  {
    id: "ttl",
    prompt: "How long does a session last?",
    detail: "Mobile users sign in rarely; the dashboard is open all day.",
    options: [
      { id: "30d", label: "30 days, sliding", description: "Renews on use" },
      { id: "24h", label: "24 hours", description: "Sign in daily" },
      { id: "forever", label: "Until sign out", description: null },
    ],
    recommended: "30d",
    multiSelect: false,
  },
  {
    id: "pw",
    prompt: "What happens on a password change?",
    detail: null,
    options: [
      { id: "all", label: "Sign out everywhere", description: null },
      { id: "others", label: "Keep this device", description: "Sign out the rest" },
      { id: "none", label: "Nothing", description: null },
    ],
    recommended: "all",
    multiSelect: false,
  },
  {
    id: "clients",
    prompt: "Which clients get sessions?",
    detail: "Pick every one that should stay signed in.",
    options: [
      { id: "web", label: "Web", description: null },
      { id: "desktop", label: "Desktop", description: null },
      { id: "mobile", label: "Mobile", description: "Needs a refresh flow" },
    ],
    recommended: "web",
    multiSelect: true,
  },
];

const ANSWERS: AskAnswer[] = [
  { questionId: "store", optionIds: ["pg"], text: null },
  { questionId: "ttl", optionIds: [], text: "7 days, sliding" },
  { questionId: "pw", optionIds: ["all"], text: null },
  { questionId: "clients", optionIds: ["web", "desktop"], text: null },
];

const roundOf = (id: string, n: number, questions: ReadonlyArray<AskQuestion>, answers: ReadonlyArray<AskAnswer> | null): TranscriptItem => ({
  kind: "ask",
  id,
  askKind: "question",
  prompt: questions.map((q) => q.prompt).join("\n\n"),
  options: questions[0]!.options,
  resolution: answers ? "answered" : null,
  questions,
  round: n,
  answers,
});
const round = (answers: ReadonlyArray<AskAnswer> | null) => roundOf("round-2", 2, QUESTIONS, answers);

const ASKED: TranscriptItem = { kind: "user", id: "u1", text: "Add login sessions to the API.", at, delivery: "message" };

const FINISHED: Extract<TranscriptItem, { kind: "grill_finished" }> = {
  kind: "grill_finished",
  id: "done",
  docPath: "docs/",
  summary: "Sessions live in Postgres, last 7 days and renew on use. A password change signs out every device.",
};

// A whole grill, start to Build it: facts from a builder, Round 1 answered,
// Round 2 waiting. Answering it writes the doc; Build it hands over.
const ROUND_1: AskQuestion[] = [
  {
    id: "who",
    prompt: "Who signs in with a session?",
    detail: "API keys already authenticate machines and never expire.",
    options: [
      { id: "people", label: "People only", description: "API keys stay as they are" },
      { id: "both", label: "People and API keys", description: "One mechanism for both" },
    ],
    recommended: "people",
    multiSelect: false,
  },
  {
    id: "list",
    prompt: "Can people see and end their sessions?",
    detail: null,
    options: [
      { id: "devices", label: "Yes, a device list", description: "Settings → Sessions" },
      { id: "everywhere", label: "Sign out everywhere only", description: null },
      { id: "no", label: "No", description: null },
    ],
    recommended: "devices",
    multiSelect: false,
  },
];

const say = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, text, streaming: false, at });

const CONVO_START: ReadonlyArray<TranscriptItem> = [
  ASKED,
  say("c-a0", "Grilling first. An agent is mapping how auth works today."),
  {
    kind: "subagent",
    id: "c-s1",
    title: "Map how auth works today",
    workspaceId: null,
    agent: null,
    runner: null,
    summary: null,
    status: "done",
    startedAt: at,
    finishedAt: at,
    items: [tool("c-t1", "search", "Searched", '"jwt.verify"'), tool("c-t2", "read", "Read", "src/auth/middleware.ts"), tool("c-t3", "read", "Read", "db/schema.sql")],
  },
  say("c-a1", "Auth today is one stateless JWT check in `src/auth/middleware.ts`. Nothing is stored, so nothing can be revoked."),
  roundOf("c-round-1", 1, ROUND_1, [
    { questionId: "who", optionIds: ["people"], text: null },
    { questionId: "list", optionIds: ["devices"], text: null },
  ]),
  say("c-a2", "People only, with a device list. Now where they live and how long they last."),
];

/** The doc and summary say what was actually answered in Round 2. */
const convoEnd = (answers: ReadonlyArray<AskAnswer>, run: number): ReadonlyArray<TranscriptItem> => {
  const said = (qid: string) => {
    const a = answers.find((x) => x.questionId === qid);
    const options = QUESTIONS.find((q) => q.id === qid)?.options ?? [];
    return a ? answerText(a, (id) => options.find((o) => o.id === id)?.label ?? id) : "—";
  };
  const [store, ttl, pw, clients] = [said("store"), said("ttl"), said("pw"), said("clients")];
  const doc = `# Login sessions\n\n- **Who**: people only; API keys stay as they are.\n- **Clients**: ${clients}.\n- **Store**: ${store}.\n- **Lifetime**: ${ttl}.\n- **Password change**: ${pw}.\n- **Device list**: Settings → Sessions, each one revocable.\n`;
  return [
    say("c-a3", "That's everything. Writing it down."),
    tool("c-t4", "create", "Created", FINISHED.docPath, { name: "Write", added: 7, input: { content: doc } }),
    // A new id per run: Build it remembers what each finish card sent.
    { ...FINISHED, id: `c-done-${run}`, summary: `Sessions: ${store}, ${ttl}. Password change: ${pw}.` },
  ];
};

function SampleConversation() {
  const [answers, setAnswers] = useState<ReadonlyArray<AskAnswer> | null>(null);
  const [built, setBuilt] = useState(false);
  const [run, setRun] = useState(0);
  const items = [
    ...CONVO_START,
    roundOf("c-round-2", 2, QUESTIONS, answers),
    ...(answers ? convoEnd(answers, run) : []),
    ...(built ? [{ kind: "user", id: "c-u2", text: "Build what we agreed in docs/", at, delivery: "message" } as const] : []),
  ];
  const answer = (_id: string, reply: AskReply) => {
    if (reply.kind === "question") setAnswers(reply.answers.map((a) => ({ questionId: a.question_id, optionIds: a.option_ids, text: a.text ?? null })));
  };
  return (
    <Demo label="A whole grill (answer Round 2, then Build it)" action={answers ? () => { setAnswers(null); setBuilt(false); setRun(run + 1); } : undefined}>
      <Transcript items={items} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={answer} cavemanVersion={null} workspaceId="style-grill-convo" onBuild={() => setBuilt(true)} />
    </Demo>
  );
}

/** Claude Agent with grill mode on, for the composer. */
const ENGINE = {
  id: "claude-agent",
  label: "Claude Agent",
  capabilities: { structured: true, fork: true, steer: true, interrupt: true, tool_hooks: true, resume_across_machines: false, approvals: true, plans: true, subagents: true, images: true, mcp: true, grill_mode: true },
  models: [{ id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" }],
  auth: { state: "signed_in", accounts: [] },
} as EngineDescriptor;

const noop = () => undefined;
const noopAsync = async () => undefined;

export function GrillStyleSection() {
  const [answers, setAnswers] = useState<ReadonlyArray<AskAnswer> | null>(null);
  const answer = (_id: string, reply: AskReply) => {
    if (reply.kind === "question") setAnswers(reply.answers.map((a) => ({ questionId: a.question_id, optionIds: a.option_ids, text: a.text ?? null })));
  };
  const runtime = useRuntime();
  const withEngine = useMemo(() => ({ ...runtime, engines: [ENGINE] }), [runtime]);
  return (
    <section id="grill" aria-labelledby="grill-h" className="border-t border-border py-10">
      <h2 id="grill-h" className="text-[14px] font-medium text-foreground">
        Grill mode
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        It asks in rounds, its pick pre-selected; you answer the round at once. Tab moves between questions, arrows or number keys pick, typing picks Other, {formatChord("mod+enter")} sends. When nothing is left it writes the decisions down.
      </p>
      <div className="mt-5 flex flex-col gap-8">
        <SampleConversation />
        <Demo label={answers ? "A round, answered here (Reset to ask again)" : "A round, waiting"} action={answers ? () => setAnswers(null) : undefined}>
          <Transcript items={[ASKED, round(answers)]} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={answer} cavemanVersion={null} />
        </Demo>
        <Demo label="The same round, answered">
          <Transcript items={[round(ANSWERS)]} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={noop} cavemanVersion={null} />
        </Demo>
        <Demo label="Finished: the decisions doc and Build it">
          <Transcript items={[FINISHED]} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={noop} cavemanVersion={null} workspaceId="style-grill" onBuild={noop} />
        </Demo>
        <Demo label="The composer, Grill on">
          <RuntimeFixture value={withEngine}>
            <Composer running={false} engineId="claude-agent" engineLabel="Claude Agent" canSteer onSubmit={noopAsync} onInterrupt={noopAsync} mode="grill" />
          </RuntimeFixture>
        </Demo>
      </div>
    </section>
  );
}

function Demo({ label, action, children }: { label: string; action?: (() => void) | undefined; children: ReactNode }) {
  return (
    <div className="max-w-[720px]">
      <div className="mb-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {label}
        {action ? (
          <button type="button" onClick={action} className="rounded px-1 text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Reset
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
