// The style page's Overview section (#/style): the side panel's first tab on
// illustrative data, and one of its agents opened over it.

import type { Runner } from "@caveman-app/ui/components/runner-badge";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { useEffect, useState, type ReactNode } from "react";
import { SUBAGENT_STATE, WORKSPACE_STATE } from "../../../panels/agents/states.ts";
import type { TranscriptItem } from "../../../state/transcript-model.ts";
import { tool } from "../../transcript/ChatStyleSection.tsx";
import { AgentsCard, type AgentRowView } from "./AgentsCard.tsx";
import { AgentView } from "./AgentView.tsx";
import { PaneCardsView } from "./PaneCardsView.tsx";
import { FileTextIcon, File01Icon } from "@caveman-app/ui/icons/huge";

const noop = () => undefined;
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const runner = (engine: string, engineLabel: string, model?: string): Runner => ({ engine, engineLabel, ...(model ? { model, modelLabel: model } : {}) });

const ROWS: ReadonlyArray<AgentRowView> = [
  { key: "s1", title: "Find every caller of Scheduler.Next", state: SUBAGENT_STATE.running, runner: runner("caveman", "Caveman"), line: { text: "Reading webhook/dispatch.go", live: true }, startedAt: ago(48), finishedAt: null, depth: 1 },
  { key: "b1", title: "Breaker tests", state: WORKSPACE_STATE.working, runner: runner("codex", "Codex", "GPT-6"), line: { text: "Running go test -run Breaker", live: true }, startedAt: ago(21), finishedAt: null, depth: 1 },
  { key: "b2", title: "Docs schedule table", state: WORKSPACE_STATE.needs_input, runner: runner("claude-agent", "Claude Agent", "Opus 5.5"), line: { text: "Keep the old table for v1 customers?", live: false }, startedAt: ago(95), finishedAt: null, depth: 1 },
  { key: "s4", title: "Read the incident timeline", state: SUBAGENT_STATE.done, runner: runner("caveman", "Caveman"), line: { text: "Every failure lined up on :00 within 40 ms", live: false }, startedAt: ago(300), finishedAt: ago(230), depth: 1 },
];

const AGENT_ITEMS: ReadonlyArray<TranscriptItem> = [
  tool("a1", "search", "Searched", '"Scheduler.Next("'),
  tool("a2", "read", "Read", "webhook/backfill.go"),
  { kind: "reasoning", id: "a3", text: "Backfill replays go through Next too, so one fix covers both paths.", streaming: false },
  tool("a4", "read", "Reading", "webhook/dispatch.go", { status: "running", finishedAt: null }),
];

export function OverviewStyleSection() {
  const [at, setAt] = useState(Date.now);
  const [cacheReport] = useState(() => ({ model: "claude-sonnet-4-6", at: ago(30) }));
  useEffect(() => {
    const tick = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <section id="overview" aria-labelledby="overview-h" className="border-t border-border py-10">
      <h2 id="overview-h" className="text-[14px] font-medium text-foreground">
        Overview
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        The side panel's first tab: everything around the chat, not in it. The session's cards, then what moves while it works: the agent's browser or computer as a live thumbnail, and every agent
        working for the chat, each saying what it does this second. A row opens that agent over the Overview with its own live transcript; the back arrow or Esc returns, and the pager steps
        through the others.
      </p>
      <TooltipProvider delayDuration={500}>
        <div className="mt-5 flex flex-wrap items-start gap-6">
          <Column label="Overview">
            <div className="flex flex-col gap-2 p-3">
              <PaneCardsView
                env={{ repo: "api-gateway", path: "/Users/you/acme/api-gateway", branch: "caveman/fix-webhook-retry-storm-143eba", computer: { kind: "this_mac", label: "This Mac" }, ports: { web: 4101 } }}
                context={{ used: 26_400, window: 200_000 }}
                cacheReport={cacheReport}
                connectors={{ servers: ["datadog", "linear"], plugins: [{ name: "acme-backend", description: "Migration skill, Datadog and Linear MCP" }] }}
                outputs={[
                  { id: "a1", title: "retry-storm-postmortem.md", meta: "64 lines", icon: FileTextIcon },
                  { id: "a2", title: "breaker.go", meta: "+71", icon: File01Icon },
                ]}
                changes={{ files: 3, additions: 118, deletions: 19 }}
                pr={{ busy: false, url: null, error: null }}
                onOpenOutput={noop}
                onShowOutputs={noop}
                onShowChanges={noop}
                onCreatePr={noop}
              />
              <AgentsCard rows={ROWS} at={at} onOpen={noop} />
            </div>
          </Column>
          <Column label="An agent, opened">
            <div className="relative h-[560px]">
              <AgentView
                row={ROWS[0]!}
                items={AGENT_ITEMS}
                running
                summary={null}
                engineLabel="Caveman"
                index={0}
                count={ROWS.length}
                closing={false}
                at={at}
                onBack={noop}
                onStep={noop}
                onClosed={noop}
                onAnswer={async () => undefined}
                autoFocus={false}
              />
            </div>
          </Column>
        </div>
      </TooltipProvider>
    </section>
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-[360px] flex-col gap-2">
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      <div className="overflow-hidden rounded-xl border border-border bg-background">{children}</div>
    </div>
  );
}
