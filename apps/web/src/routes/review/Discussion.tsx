// Discussion: the author's description, then comments, reviews and line threads, oldest first. Open threads show
// their lines and take a reply, a resolve, or "Fix with agent" (a chat on the head with the thread as its brief);
// resolved ones fold to one line. Every body is drawn the way the host draws it (AuthorNote.tsx HostText).
import type { PrDetail, PrDiscussionItem } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon, Tick02Icon, Wrench01Icon } from "@caveman-app/ui/icons/huge";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../../panels/diff/parsePatch.ts";
import { rowAge } from "../../state/model.ts";
import { AuthorNote, HostText } from "./AuthorNote.tsx";
import { readableBody, type Passage } from "./model.ts";
import { CodeRows } from "./Excerpt.tsx";
import { Avatar } from "./parts.tsx";
import { useReviewOffers } from "./source.ts";
import { keysText, SurfaceEmpty } from "../../panels/chrome.tsx";
import { KeptLimitLink } from "../../components/cloud/KeptLimitLink.tsx";

type Thread = Extract<PrDiscussionItem, { type: "thread" }>;
type Comment = Extract<PrDiscussionItem, { type: "comment" }>;

const VERDICT: Record<NonNullable<Comment["verdict"]>, { word: string; tone: string }> = {
  approved: { word: "approved", tone: "text-success" },
  changes_requested: { word: "asked for changes", tone: "text-destructive" },
  commented: { word: "reviewed", tone: "text-muted-foreground" },
};

export function Discussion({
  pr,
  items,
  loading,
  error,
  canComment,
  onComment,
  onReply,
  onResolve,
  onFix,
  onOpenGuide,
}: {
  pr: PrDetail;
  items: ReadonlyArray<PrDiscussionItem> | undefined;
  loading: boolean;
  error: string | undefined;
  canComment: boolean;
  onComment: (body: string) => Promise<unknown>;
  onReply: (thread: Thread, body: string) => Promise<unknown>;
  onResolve: (thread: Thread, resolved: boolean) => Promise<unknown>;
  onFix: (passage: Passage, text: string) => Promise<unknown>;
  /** Show the Guide tab, where a posted guide comment is drawn in full; absent while guides are off. */
  onOpenGuide?: (() => void) | undefined;
}) {
  const now = Date.now();
  const open = items?.filter((i) => i.type === "thread" && !i.resolved).length ?? 0;
  return (
    <div className="max-w-[860px] pb-24">
      <AuthorNote pr={pr} mode="open" className="mb-8 border-b border-border/60 pb-8" />
      {items === undefined ? (
        error ? (
          <SurfaceEmpty title="Couldn't read the discussion">{error}</SurfaceEmpty>
        ) : loading ? (
          <SurfaceEmpty title="Reading the discussion…" />
        ) : null
      ) : items.length === 0 ? (
        <SurfaceEmpty title="No comments yet">Comments, reviews and line threads on this pull request show here.</SurfaceEmpty>
      ) : (
        <>
          {open > 0 ? <p className="pb-4 text-[12.5px] text-muted-foreground">{open === 1 ? "1 open thread" : `${open} open threads`}</p> : null}
          <ol className="space-y-5">
            {items.map((item) => (
              <li key={item.id}>{item.type === "comment" ? <CommentItem c={item} url={pr.url} now={now} onOpenGuide={onOpenGuide} /> : <ThreadCard t={item} url={pr.url} now={now} canComment={canComment} onReply={onReply} onResolve={onResolve} onFix={onFix} />}</li>
            ))}
          </ol>
        </>
      )}
      {canComment ? <Composer placeholder="Say something on the pull request" action="Comment" onSubmit={onComment} className="mt-8" /> : null}
    </div>
  );
}

function CommentItem({ c, url, now, onOpenGuide }: { c: Comment; url: string; now: number; onOpenGuide?: (() => void) | undefined }) {
  const verdict = c.verdict ? VERDICT[c.verdict] : null;
  // The review guide, posted for reviewers on the host: one line here, since the Guide tab draws it in full.
  if (c.guide && onOpenGuide) {
    return (
      <article className="flex items-center gap-3" data-passage={`${c.author?.login ?? "someone"}'s review guide comment`}>
        <Avatar actor={c.author} size={26} />
        <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <span className="font-semibold text-foreground">{c.author?.login ?? "unknown"}</span>
          <span className="text-muted-foreground">posted the review guide</span>
          <span className="text-[hsl(var(--subtle-foreground))]">{rowAge(c.at, now)}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={onOpenGuide}>
          Open the guide
        </Button>
      </article>
    );
  }
  return (
    <article className="flex gap-3" data-passage={`${c.author?.login ?? "someone"}'s ${c.verdict ? "review" : "comment"}`}>
      <Avatar actor={c.author} size={26} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-[13px]">
          <span className="font-semibold text-foreground">{c.author?.login ?? "unknown"}</span>
          {verdict ? <span className={cn("font-medium", verdict.tone)}>{verdict.word}</span> : null}
          <span className="text-[hsl(var(--subtle-foreground))]">{rowAge(c.at, now)}</span>
        </p>
        {readableBody(c.body) ? (
          <Clamp className="mt-1 text-[14px] leading-[1.6] text-foreground/90">
            <HostText source={c.body} url={url} />
          </Clamp>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A line thread: where it is, its lines, the comments, and a reply, a resolve or a fix. `inline` under its own line in
 * Files: the place and the lines are already there, so the card is only the conversation.
 */
export function ThreadCard({
  t,
  url,
  now,
  canComment,
  onReply,
  onResolve,
  onFix,
  inline = false,
}: {
  t: Thread;
  url: string;
  now: number;
  canComment: boolean;
  onReply: (thread: Thread, body: string) => Promise<unknown>;
  onResolve: (thread: Thread, resolved: boolean) => Promise<unknown>;
  onFix: (passage: Passage, text: string) => Promise<unknown>;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(!t.resolved);
  // From Cloud a thread's resolved state is GitHub's GraphQL only: no Resolve to press (source.ts).
  const offers = useReviewOffers();
  const [busy, setBusy] = useState<"resolve" | "fix" | null>(null);
  const [fixed, setFixed] = useState(false);
  /** Why the last resolve or fix failed, as it was thrown: a refusal at the kept-computer limit links past it. */
  const [error, setError] = useState<unknown>(null);
  const where = `${t.path}${t.line ? `:${t.line}` : ""}`;
  const hunk = useMemo(() => (t.hunk ? parsePatch(t.hunk).filter((r) => r.kind !== "hunk").slice(-5) : []), [t.hunk]);
  const first = t.comments[0];
  const passage: Passage = {
    where: `the review thread on ${where}`,
    quote: t.comments.map((c) => `${c.author?.login ?? "someone"}: ${readableBody(c.body)}`).join("\n\n"),
  };
  const act = async (kind: "resolve" | "fix") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "resolve") await onResolve(t, !t.resolved);
      else {
        await onFix(passage, "Address this review thread; reply on it with what you changed.");
        setFixed(true);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className={cn("overflow-hidden rounded-xl border border-border", inline ? "bg-popover shadow-[0_2px_8px_hsl(0_0%_0%/0.18)]" : "bg-card/30")} data-passage={passage.where}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
        {inline ? (
          <span className="shrink-0 text-[12.5px] font-medium text-foreground/90">{t.comments.length === 1 ? "1 comment" : `${t.comments.length} comments`}</span>
        ) : (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground/90">{where}</span>
        )}
        {t.resolved ? <span className="shrink-0 text-[12px] text-success">Resolved</span> : null}
        {t.outdated ? <span className="shrink-0 text-[12px] text-muted-foreground">Outdated</span> : null}
        {!open && first ? <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{first.author?.login}: {readableBody(first.body)}</span> : <span className="flex-1" />}
        {inline ? null : <span className="shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">{t.comments.length}</span>}
      </button>
      {open ? (
        <>
          {hunk.length > 0 && !inline ? <CodeRows rows={hunk} path={t.path} className="border-y border-border/70 py-1 text-[12px]" /> : null}
          <div className={cn("space-y-4 px-3 py-3", inline && "border-t border-border/70")}>
            {t.comments.map((c) => (
              <div key={c.id} className="flex gap-2.5">
                <Avatar actor={c.author} size={22} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-1.5 text-[13px]">
                    <span className="font-semibold text-foreground">{c.author?.login ?? "unknown"}</span>
                    <span className="text-[hsl(var(--subtle-foreground))]">{rowAge(c.at, now)}</span>
                  </p>
                  <Clamp className="mt-0.5 text-[13.5px] leading-[1.6] text-foreground/90">
                    <HostText source={c.body} url={url} />
                  </Clamp>
                </div>
              </div>
            ))}
          </div>
          {canComment ? (
            <div className="border-t border-border/70 px-3 py-2.5">
              <Composer placeholder="Reply" action="Reply" compact onSubmit={(body) => onReply(t, body)} />
              <div className="mt-2 flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={busy !== null || fixed} onClick={() => void act("fix")}>
                  <Icon icon={Wrench01Icon} className="size-3.5" />
                  {fixed ? "Agent on it" : busy === "fix" ? "Starting…" : "Fix with agent"}
                </Button>
                {offers.resolve ? (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("resolve")}>
                    <Icon icon={Tick02Icon} className="size-3.5" />
                    {t.resolved ? "Unresolve" : "Resolve"}
                  </Button>
                ) : null}
              </div>
              {error !== null ? (
                <div role="alert" className="mt-1.5 flex flex-col items-end gap-1 text-[12px]">
                  <p className="text-destructive">{error instanceof Error ? error.message : String(error)}</p>
                  <KeptLimitLink error={error} />
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

/** A long comment (bots write essays) shows its first lines and opens on a click. */
function Clamp({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => setLong((ref.current?.scrollHeight ?? 0) > CLAMP_PX + 40), [children]);
  return (
    <div className={className}>
      <div ref={ref} style={long && !open ? { maxHeight: CLAMP_PX, maskImage: "linear-gradient(to bottom, black 70%, transparent)" } : undefined} className={cn(long && !open && "overflow-hidden")}>
        {children}
      </div>
      {long ? (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

const CLAMP_PX = 168;

function Composer({ placeholder, action, onSubmit, compact = false, className }: { placeholder: string; action: string; onSubmit: (body: string) => Promise<unknown>; compact?: boolean; className?: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={compact ? 1 : 3}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          "w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[13.5px] leading-5 text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "min-h-[36px]" : "min-h-[76px]",
        )}
      />
      {body.trim() || error ? (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          {error ? <p className="mr-auto text-[12px] text-destructive">{error}</p> : null}
          <span className="text-[11.5px] text-muted-foreground">{keysText("⌘↩", "mod+enter")}</span>
          <Button size="sm" onClick={() => void send()} disabled={busy}>
            {busy ? "Sending…" : action}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
