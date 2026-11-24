// The moments of the Chief's chats, each a card in its conversation (docs/chief.md "Its screen"): the runtime finds
// them in the chats' own events and writes them with no model turn (notification.moment). Each card reads the board
// and the chats as they are now: the chat's mark is where it stands, a question reads settled once nothing waits on
// the person. Built from the parts the conversation already has: the chat as the Chief names it (refs.tsx), the Ask
// card's look (chief-cards.tsx), the pull request chip (work.tsx), screenshots and Open preview (showing.tsx).
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState, type ReactNode } from "react";
import { waitLine } from "../../components/transcript/rows.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import { useActions } from "../chief-cards.tsx";
import { ChatLink } from "./refs.tsx";
import { PreviewChip, ProofStrip } from "./showing.tsx";
import { previewChats, proofImages } from "./showing-model.ts";
import { PrChip } from "./work.tsx";
import { workPullRequest, workTitle } from "./work-model.ts";

export type MomentItem = Extract<TranscriptItem, { kind: "moment" }>;

/**
 * One moment as its card. `chiefWorkspaceId`: the Chief's own workspace, which its screenshots are read with.
 * `superseded`: a later needs-you card of the same chat came after this one, so this one was answered.
 */
export function MomentCard({
  item,
  chiefWorkspaceId,
  superseded = false,
}: {
  item: MomentItem;
  chiefWorkspaceId: string;
  superseded?: boolean;
}) {
  const { workspaces, items } = useActions();
  const m = item.moment;
  const chat = m.workspace_id ? workspaces.find((w) => w.id === m.workspace_id) : undefined;
  const work = m.item_id
    ? items.find((i) => i.id === m.item_id)
    : m.workspace_id
      ? items.find((i) => i.workspace_ids.includes(m.workspace_id!))
      : undefined;
  // A chat no longer here (archived, or on another computer) is named by its work, quietly.
  const named = chat ? (
    <ChatLink chat={chat} />
  ) : (
    <span className="work-link work-link-quiet">{work ? workTitle(work) : "A chat"}</span>
  );
  switch (m.kind) {
    case "reaction":
      // A badge on the person's bubble (Transcript UserBubble), never a card.
      return null;
    case "started":
      return (
        <Line kind="started" lead="Started">
          {named}
        </Line>
      );
    case "plan":
      return (
        <div data-moment="plan" className="flex flex-col py-0.5">
          <Line lead="Plan">{named}</Line>
          {m.text ? (
            <p className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-5 text-muted-foreground">
              {m.text}
            </p>
          ) : null}
        </div>
      );
    case "needs_you":
      return (
        <NeedsYou
          item={item}
          chat={chat}
          named={named}
          // A chat's latest card waits while its chat does; a question asked in its report (no ask) leaves the chat
          // idle, so it waits while its item does.
          waits={
            !superseded &&
            (m.ask && chat ? chat.state === "needs_input" : work?.state === "needs_you")
          }
        />
      );
    case "result": {
      // This chat's own pull request: the item's is a sibling's as often (two builds of one item), so it is read only
      // when the item has no other chat.
      const pr =
        chat?.pullRequest ?? (work?.workspace_ids.length === 1 ? work.pull_request : undefined);
      const images = work ? proofImages(work, undefined, m.workspace_id) : [];
      const previews = m.workspace_id
        ? previewChats({ workspace_ids: [m.workspace_id] }, workspaces)
        : [];
      return (
        <div data-moment="result" className="flex flex-col gap-1.5 py-0.5">
          <Line lead="Result">
            {named}
            {pr ? <PrChip pr={pr} /> : null}
          </Line>
          <ProofStrip images={images} workspaceId={chiefWorkspaceId} />
          {previews.length > 0 ? (
            <div className="flex flex-wrap items-start gap-1.5">
              {previews.map((c) => (
                <PreviewChip key={c.id} chat={c} />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    case "news":
      return (
        <div data-moment="news" className="flex flex-col py-0.5">
          <Line lead="Routine">
            {m.routine ? (
              <span className="min-w-0 truncate text-foreground">{m.routine.name}</span>
            ) : null}
            {m.routine ? <span className="shrink-0">found something</span> : null}
          </Line>
          <p className="whitespace-pre-wrap text-[13px] leading-5 text-foreground">
            {m.text ?? item.text}
          </p>
        </div>
      );
  }
}

/** A moment's line: what happened in a quiet word, then the chat. */
function Line({ kind, lead, children }: { kind?: string; lead: string; children: ReactNode }) {
  return (
    <div
      data-moment={kind}
      className="flex min-h-7 min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground"
    >
      <span className="shrink-0">{lead}</span>
      {children}
    </div>
  );
}

/**
 * A chat waits on the person, drawn as the Chief's own question is (chief-cards.tsx Ask): a question with the answer
 * the chat recommends, which Use this sends to the chat's own card; an approval, a key or a tool's result with what it
 * waits on, and Open. The chat's name opens it too. Once the chat no longer waits, the card reads settled.
 */
function NeedsYou({
  item,
  chat,
  named,
  waits,
}: {
  item: MomentItem;
  chat: WorkspaceView | undefined;
  named: ReactNode;
  waits: boolean;
}) {
  const { open } = useActions();
  const { client } = useRuntimeClient();
  const ask = item.moment.ask;
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settled = sent || !waits;
  const recommended =
    ask?.kind === "question" && ask.question_id && ask.recommended
      ? { question: ask.question_id, ...ask.recommended }
      : null;
  const use = () => {
    if (!client || !chat?.sessionId || !ask || !recommended) return;
    setBusy(true);
    setProblem(null);
    client
      .call("ask.respond", {
        request_id: requestId(),
        session_id: chat.sessionId,
        ask_id: ask.id,
        response: {
          kind: "question",
          answers: [{ question_id: recommended.question, option_ids: [recommended.option_id] }],
        },
      })
      .then(
        () => setSent(true),
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section
      data-moment="needs_you"
      aria-label={`${chat?.title ?? "A chat"} needs you`}
      className={cn(
        "w-full max-w-[560px] rounded-xl border bg-card px-4 py-3",
        settled ? "border-border opacity-70" : "border-warning/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        {named}
        <span className="shrink-0">
          {settled ? "· answered" : ask?.kind === "question" || !ask ? "asks" : waitLine(ask.kind)}
        </span>
        {chat && ask && ask.kind !== "question" && !settled ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => open(chat.id)}
            className="ml-auto shrink-0"
          >
            Open
          </Button>
        ) : null}
      </div>
      {item.moment.text ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-[21px] text-foreground">
          {item.moment.text}
        </p>
      ) : null}
      {recommended ? (
        <div className="mt-2.5 flex items-center gap-3 rounded-lg bg-secondary px-3 py-2">
          <span className="min-w-0 flex-1 text-[13px] leading-5">
            <span className="text-muted-foreground">Recommended </span>
            <span className="text-foreground">{recommended.label}</span>
          </span>
          {settled || !chat?.sessionId ? null : (
            <Button
              type="button"
              disabled={busy}
              onClick={use}
              variant="secondary"
              size="sm"
              className="shrink-0"
            >
              Use this
            </Button>
          )}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
