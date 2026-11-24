// Grill mode in the transcript. A round is one card: every question the
// engine can ask now, each with its options (pick one, or several where the
// question says so) and the one it recommends pre-selected, answered together
// with one ask.respond. Once answered it folds to question → answer. When
// nothing is left the engine writes a decisions doc: the finish card opens it
// and offers Build it.
import { ArtifactCard } from "@caveman-app/ui/ai/artifact";
import { textDirection } from "@caveman-app/ui/ai/text-direction";
import { Response } from "@caveman-app/ui/ai/response";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IS_MAC, isComposing } from "../../panels/chrome.tsx";
import { announce } from "../../panes/store.ts";
import { answerText, buildState, choiceKey, roundReply, sendOnce, type AskReply, type RoundDraft } from "../../state/grill.ts";
import type { AskQuestion, TranscriptItem } from "../../state/transcript-model.ts";
import { Icon } from "./marks.tsx";
import { FireIcon, FileTextIcon } from "@caveman-app/ui/icons/huge";

type Ask = Extract<TranscriptItem, { kind: "ask" }>;
type Finished = Extract<TranscriptItem, { kind: "grill_finished" }>;

// aria-disabled (not disabled) while a send is in flight: the focus stays on the button.
const button = "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] outline-none transition-[background-color,color,transform] duration-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";
const primary = cn(button, "bg-primary font-medium text-primary-foreground hover:bg-primary/90");
const quiet = cn(button, "text-muted-foreground hover:bg-accent hover:text-foreground");
const card = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Rounds already said aloud: paging, a second pane or a remount never says one twice. */
const announced = new Set<string>();

/** The control under the focus went away (a round folded, Build it went): keep the reader on this card, not <body>. */
function refocus(el: HTMLElement | null) {
  const at = document.activeElement;
  if (!at || at === document.body) el?.focus({ preventScroll: true });
}

/**
 * A grill round, or any ask with several questions (Claude's AskUserQuestion can hold up to four): each question its
 * own options, answered together. `asker` heads a plain ask ("Opus 5.5 asks") in place of the round's number.
 */
export function RoundCard({
  ask,
  onAnswer,
  pager,
  asker,
}: {
  ask: Ask;
  onAnswer: (askId: string, reply: AskReply) => Promise<void> | void;
  pager?: ReactNode;
  asker?: { readonly mark: ReactNode; readonly who: string };
}) {
  const done = ask.resolution !== null;
  const n = ask.questions.length;
  const name = asker ? `${asker.who} asks` : `Round ${ask.round}`;
  const root = useRef<HTMLElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (done) {
      if (sent.current) refocus(root.current);
    } else if (!announced.has(ask.id)) {
      announced.add(ask.id);
      // A plain ask is announced by its own card (Transcript's AskCard).
      if (!asker) announce(`Round ${ask.round}: ${n} ${n === 1 ? "question" : "questions"} to answer.`);
    }
  }, [done, ask.id]);
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={done ? `${name}, answered` : name}
      className={cn("my-2 overflow-hidden rounded-xl border border-border bg-card", card)}
    >
      <div className="flex h-11 items-center gap-2 border-b border-border pl-4 pr-2 text-[13px]">
        {asker ? (
          <>
            {asker.mark}
            <span className="text-muted-foreground">
              <span className="text-foreground">{asker.who}</span> asks
            </span>
          </>
        ) : (
          <>
            <Icon icon={FireIcon} />
            <span className="font-medium text-foreground">Round {ask.round}</span>
          </>
        )}
        <span className="text-muted-foreground">{done ? (ask.answers ? "Answered" : "") : `${n} ${n === 1 ? "question" : "questions"}`}</span>
        {pager}
      </div>
      {done ? (
        <Answered ask={ask} />
      ) : (
        <Pending
          ask={ask}
          onAnswer={(id, reply) => {
            sent.current = true;
            return onAnswer(id, reply);
          }}
        />
      )}
    </section>
  );
}

const recommendedDrafts = (questions: ReadonlyArray<AskQuestion>): Record<string, RoundDraft> =>
  Object.fromEntries(questions.map((q) => [q.id, { optionIds: q.recommended ? [q.recommended] : [], text: "", own: false }]));

function Pending({ ask, onAnswer }: { ask: Ask; onAnswer: (askId: string, reply: AskReply) => Promise<void> | void }) {
  const { questions } = ask;
  const [drafts, setDrafts] = useState(() => recommendedDrafts(questions));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const groups = useRef<Array<HTMLDivElement | null>>([]);
  const sendButton = useRef<HTMLButtonElement>(null);
  const reply = roundReply(questions, drafts);
  const allRecommended = roundReply(questions, recommendedDrafts(questions));

  const send = (r: AskReply | null) => {
    if (!r || sending) return;
    setSending(true);
    setFailed(null);
    // Stays sending until ask.resolved folds the card; a failed call says why and lets the user try again.
    void Promise.resolve(onAnswer(ask.id, r)).catch((e: unknown) => {
      setSending(false);
      setFailed(e instanceof Error && e.message ? e.message : "The answers didn't send.");
    });
  };
  // Enter in a question's own answer goes on: the next question's choice, then Send.
  const next = (i: number) => (groups.current[i + 1]?.querySelector<HTMLElement>('[data-choice][tabindex="0"]') ?? sendButton.current)?.focus();

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send(reply);
        }
      }}
    >
      <div className="divide-y divide-border">
        {questions.map((q, i) => (
          <Question
            key={q.id}
            ref={(el) => void (groups.current[i] = el)}
            question={q}
            draft={drafts[q.id]!}
            disabled={sending}
            onChange={(d) => setDrafts((all) => ({ ...all, [q.id]: d }))}
            onNext={() => next(i)}
          />
        ))}
      </div>
      {/* On the questions' 16px column: Send ends on it, and the quiet button's words start on it (its fill overhangs,
          pl-1 + its px-3). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border py-2.5 pl-1 pr-4">
        {questions.some((q) => q.recommended) ? (
          <button
            type="button"
            disabled={!allRecommended}
            aria-disabled={sending || undefined}
            onClick={() => {
              if (sending) return;
              setDrafts(recommendedDrafts(questions));
              send(allRecommended);
            }}
            className={quiet}
          >
            Take all recommendations
          </button>
        ) : null}
        {failed ? (
          <span role="alert" className="min-w-0 truncate text-[12px] text-destructive first:ml-3" title={failed}>
            {failed}
          </span>
        ) : null}
        <button
          ref={sendButton}
          type="button"
          disabled={!reply}
          aria-disabled={sending || undefined}
          aria-keyshortcuts={IS_MAC ? "Meta+Enter" : "Control+Enter"}
          onClick={() => send(reply)}
          className={cn(primary, "ml-auto")}
        >
          {sending ? "Sending…" : "Send answers"}
          <kbd aria-hidden className="font-sans text-[11px] text-primary-foreground/60">
            {IS_MAC ? "⌘↵" : "Ctrl ↵"}
          </kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * One question: a radio group (the WAI-ARIA radio pattern) with "Other" as
 * its last choice. One tab stop, the checked choice; ↑↓←→ move and select,
 * Space selects, a number key jumps to its keycap. Typing in Other selects it.
 * A multi-select question is a group of checkboxes instead: ↑↓←→ only move,
 * Space or a number key toggles, and Other's words answer beside the picks.
 */
function Question({
  ref,
  question: q,
  draft,
  disabled,
  onChange,
  onNext,
}: {
  ref: (el: HTMLDivElement | null) => void;
  question: AskQuestion;
  draft: RoundDraft;
  disabled: boolean;
  onChange: (d: RoundDraft) => void;
  onNext: () => void;
}) {
  const id = useId();
  const choices = useRef<HTMLDivElement>(null);
  const n = q.options.length;
  const multi = q.multiSelect;
  const own = draft.own && draft.text.trim().length > 0;
  const picked = own && !multi ? [] : draft.optionIds;
  const stop = own && !multi ? n : Math.max(0, q.options.findIndex((o) => picked.includes(o.id)));

  const focus = (i: number) => choices.current?.querySelectorAll<HTMLElement>("[data-choice]")[i]?.focus();
  // Single choice: moving to an option selects it. Moving to Other focuses its field, which selects it once it holds words.
  const choose = (i: number) => {
    if (disabled) return;
    if (i < n) onChange({ ...draft, optionIds: [q.options[i]!.id], own: false });
    focus(i);
  };
  // Multi-select: an option flips; the picks keep the options' order.
  const toggle = (i: number) => {
    if (disabled) return;
    if (i < n) {
      const id = q.options[i]!.id;
      onChange({ ...draft, optionIds: q.options.filter((o) => (o.id === id) !== draft.optionIds.includes(o.id)).map((o) => o.id) });
    }
    focus(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = Number((e.target as HTMLElement).dataset.choice);
    if (disabled || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || Number.isNaN(from)) return;
    // In the Other field only ↑↓ leave; ←→, digits and Space type.
    if (from === n && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const to = e.key === " " ? from : choiceKey(e.key, from, n);
    if (to === null) return;
    e.preventDefault();
    if (!multi) choose(to);
    else if (e.key.startsWith("Arrow")) focus(to);
    else toggle(to);
  };

  return (
    <div ref={ref} className="px-4 pb-3 pt-3.5">
      <h3 id={`${id}-q`} dir={textDirection(q.prompt)} className="text-[14px] font-medium leading-[22px] text-foreground [text-wrap:pretty]">
        {q.prompt}
      </h3>
      {multi ? <p className="text-[12px] leading-5 text-muted-foreground">Pick any that apply</p> : null}
      {q.detail ? <Detail markdown={q.detail} /> : null}
      <div ref={choices} onKeyDown={onKeyDown} className="-mx-2 mt-2 flex flex-col gap-px">
        <div role={multi ? "group" : "radiogroup"} aria-labelledby={`${id}-q`} aria-disabled={disabled || undefined} className="flex flex-col gap-px">
          {q.options.map((o, i) => {
            const checked = picked.includes(o.id);
            return (
              <div
                key={o.id}
                role={multi ? "checkbox" : "radio"}
                aria-checked={checked}
                aria-keyshortcuts={String(i + 1)}
                tabIndex={i === stop ? 0 : -1}
                data-choice={i}
                onClick={() => (multi ? toggle(i) : choose(i))}
                className="group/opt flex min-h-8 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors duration-75 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-checked:bg-accent"
              >
                <Key checked={checked}>{i + 1}</Key>
                <span dir={textDirection(`${o.label} ${o.description ?? ""}`)} className="min-w-0 flex-1 text-[13px] leading-5 [text-wrap:pretty]">
                  <span className="mr-2 text-foreground">{o.label}</span>
                  {o.description ? <span className="text-muted-foreground">{o.description}</span> : null}
                </span>
                {o.id === q.recommended ? <Tag>Recommended</Tag> : null}
              </div>
            );
          })}
        </div>
        <label
          data-checked={own || undefined}
          className="flex min-h-8 cursor-text items-center gap-2.5 rounded-md px-2 py-1 transition-colors duration-75 hover:bg-accent/50 focus-within:bg-accent/50 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring data-[checked]:bg-accent"
        >
          <Key checked={own}>{n + 1}</Key>
          <input
            data-choice={n}
            tabIndex={stop === n ? 0 : -1}
            aria-keyshortcuts={String(n + 1)}
            value={draft.text}
            readOnly={disabled}
            onFocus={() => !disabled && !draft.own && onChange({ ...draft, own: true })}
            onChange={(e) => onChange({ ...draft, text: e.target.value, own: true })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !isComposing(e)) {
                e.preventDefault();
                onNext();
              }
            }}
            placeholder="Other…"
            aria-label={`Other answer: ${q.prompt}`}
            className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none"
          />
        </label>
      </div>
    </div>
  );
}

/** The option's number: a keycap that fills when it is the answer. */
function Key({ checked, children }: { checked: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px grid size-[18px] shrink-0 place-items-center rounded-[5px] border font-mono text-[11px] tabular-nums",
        checked ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 text-[11px] leading-4 text-muted-foreground">{children}</span>;
}

/** A question's markdown body; a long one folds to a few lines. */
function Detail({ markdown }: { markdown: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [markdown, open]);
  return (
    <div className="mt-1">
      {/* Tabbing into a link or code block under the fold unfolds it (else the clipped box scrolls). */}
      <div ref={box} onFocus={() => setOpen(true)} className={cn(!open && "max-h-[124px] overflow-hidden", !open && long && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}>
        <Response className="text-[13px] leading-[1.6] text-muted-foreground">{markdown}</Response>
      </div>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 rounded-sm text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** The answered round: question → answer, the answers that overrode the recommendation marked. */
function Answered({ ask }: { ask: Ask }) {
  if (!ask.answers) return <div className="px-4 py-3 text-[13px] capitalize text-muted-foreground">{ask.resolution}</div>;
  return (
    <dl className="animate-row-in py-1.5 motion-reduce:animate-none">
      {ask.questions.map((q) => {
        const a = ask.answers!.find((x) => x.questionId === q.id);
        const text = a ? answerText(a, (id) => q.options.find((o) => o.id === id)?.label ?? id) : "—";
        const overrode = q.recommended != null && a !== undefined && !(!a.text && a.optionIds.length === 1 && a.optionIds[0] === q.recommended);
        return (
          <div key={q.id} className="flex min-h-8 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-1.5 text-[13px]">
            {/* Side by side when there is room, stacked in a narrow pane. */}
            <dt className="min-w-0 max-w-full flex-[1_1_16rem] truncate text-muted-foreground" title={q.prompt}>
              {q.prompt}
            </dt>
            <dd className="flex min-w-0 flex-[1_1_14rem] items-baseline gap-2">
              <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{text}</span>
              {overrode ? <Tag>Your call</Tag> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** grill.finished: the summary, the decisions doc, and Build it (which leaves grill mode). */
export function GrillFinishCard({
  item,
  buildKey,
  onOpen,
  onBuild,
}: {
  item: Finished;
  /** Unique per session and card: what Build it sent outlives this mount. */
  buildKey: string;
  onOpen: ((path: string) => void) | null;
  /** Null once built (the user said something after the card). */
  onBuild: ((docPath: string) => Promise<void> | void) | null;
}) {
  const cut = item.docPath.lastIndexOf("/");
  const root = useRef<HTMLElement>(null);
  // ponytail: a card remounted mid-send shows "Sending…" until it is built; subscribe to the key if that matters.
  const [build, setBuild] = useState(() => buildState(buildKey));
  const gone = !onBuild;
  useEffect(() => {
    if (build === "sent" && gone) refocus(root.current);
  }, [build, gone]);
  return (
    <section ref={root} tabIndex={-1} aria-label="Done grilling" className={cn("my-2 rounded-xl border border-border bg-card p-4", card)}>
      <div className="flex items-end gap-3">
        <Mascot pose="done" scale={2} />
        <div className="min-w-0 pb-0.5">
          <h3 className="text-[14px] font-medium text-foreground">Done grilling</h3>
          {/* Engines write the summary in markdown (`code`, **bold**). */}
          {item.summary ? <Response className="line-clamp-3 text-[13px] leading-5 text-muted-foreground [text-wrap:pretty]">{item.summary}</Response> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ArtifactCard
          badge={<Icon icon={FileTextIcon} />}
          title={<span className="font-mono text-[12.5px]">{item.docPath.slice(cut + 1)}</span>}
          meta={cut > 0 ? <span className="font-mono">{item.docPath.slice(0, cut)}</span> : "Decisions"}
          onClick={() => onOpen?.(item.docPath)}
          disabled={!onOpen}
          aria-label={`Open ${item.docPath}`}
          className="min-w-0 max-w-none flex-[1_1_16rem]"
        />
        {onBuild ? (
          <button
            type="button"
            onClick={() => sendOnce(buildKey, () => onBuild(item.docPath), setBuild)}
            aria-disabled={build !== "idle" || undefined}
            title="Leaves grill mode and builds from the doc"
            className={cn(primary, "h-10 px-4")}
          >
            {build === "sending" ? "Sending…" : build === "sent" ? "Sent" : "Build it"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
