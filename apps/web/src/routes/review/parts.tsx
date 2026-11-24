// Small pieces every Review screen shares: who, how big, what state, how its checks stand.
import type { PrActor, PrCheck, PrSummary } from "@caveman-app/session-protocol";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, CircleIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Tick02Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import type { MouseEvent, ReactNode } from "react";
import { useNavigate } from "react-router";
import { editorClick } from "../../panels/files/FileChip.tsx";
import { prPath, type PrAddress } from "./model.ts";
import { IS_MAC } from "../../lib/platform.ts";
import type { WorkspaceView } from "../../state/model.ts";

export function Avatar({ actor, size = 18, className }: { actor?: PrActor | undefined; size?: number; className?: string }) {
  const login = actor?.login ?? "?";
  return actor?.avatar_url ? (
    <img src={actor.avatar_url} alt="" width={size} height={size} loading="lazy" className={cn("shrink-0 rounded-full bg-secondary", className)} style={{ width: size, height: size }} />
  ) : (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full bg-secondary font-semibold uppercase text-muted-foreground", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {login.slice(0, 1)}
    </span>
  );
}

/** +a −d in the deck's state colours; nothing when the host has not said. `atLeast`: the host counted only part of the change. */
export function Stat({ additions, deletions, atLeast = false, className }: { additions: number; deletions: number; atLeast?: boolean; className?: string }) {
  if (additions === 0 && deletions === 0) return null;
  const more = atLeast ? "+" : "";
  return (
    <span className={cn("shrink-0 font-mono text-[12px] tabular-nums", className)} title={atLeast ? "At least this many lines: GitHub counted only part of the change" : undefined}>
      <span className="text-diff-add-ink">+{short(additions)}{more}</span> <span className="text-diff-del-ink">−{short(deletions)}{more}</span>
    </span>
  );
}

const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));

const STATE: Record<PrSummary["state"], { icon: IconSvgElement; tone: string; word: string }> = {
  open: { icon: GitPullRequestIcon, tone: "text-success", word: "Open" },
  draft: { icon: GitPullRequestDraftIcon, tone: "text-muted-foreground", word: "Draft" },
  merged: { icon: GitMergeIcon, tone: "text-foreground/75", word: "Merged" },
  closed: { icon: GitPullRequestClosedIcon, tone: "text-destructive", word: "Closed" },
};

export function StateIcon({ state, className }: { state: PrSummary["state"]; className?: string }) {
  const s = STATE[state];
  return <Icon icon={s.icon} aria-label={s.word} className={cn("size-4 shrink-0", s.tone, className)} />;
}

/**
 * A chat's pull request, one glyph: its state's icon in its state's colour, its number and state on hover. A click
 * opens it in Review (the row it sits on is not clicked), or wherever `onOpen` says (a chat's side panel); ⌘-click
 * opens it on its host. Without a project to read it through, it only tells. `source`: one of several sources a chat
 * works in, which the hover names first; its `repo` and `host` when the pull request is in another repository than
 * the project's own.
 */
export function PrMark({
  pr,
  projectId,
  onOpen,
  source,
  className,
}: {
  pr: { readonly number: number; readonly url: string; readonly state: PrSummary["state"] };
  projectId: string | null;
  onOpen?: ((pr: PrAddress) => void) | undefined;
  source?: { readonly name: string; readonly repo?: string | undefined; readonly host?: string | undefined } | undefined;
  className?: string;
}) {
  const { icon, tone, word } = STATE[pr.state];
  const navigate = useNavigate();
  const review = projectId
    ? (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const address: PrAddress = { project_id: projectId, number: pr.number, ...(source?.repo ? { repo: source.repo, ...(source.host ? { host: source.host } : {}) } : {}) };
        if (editorClick(e)) window.open(pr.url, "_blank", "noreferrer");
        else if (onOpen) onOpen(address);
        else navigate(prPath(address));
      }
    : undefined;
  const named = source ? `${source.name}: pull request #${pr.number}, ${word.toLowerCase()}` : `Pull request #${pr.number}, ${word.toLowerCase()}`;
  return (
    <span
      role="img"
      aria-label={named}
      title={`${named}${review ? `. Click to review, ${IS_MAC ? "⌘" : "Ctrl"}-click to open on GitHub` : ""}`}
      onClick={review}
      className={cn("inline-grid size-4 shrink-0 place-items-center rounded-[4px]", tone, review && "cursor-pointer transition-colors duration-75 hover:bg-foreground/10", className)}
    >
      <Icon icon={icon} className="size-3.5" strokeWidth={2} />
    </span>
  );
}

/**
 * A chat row's pull request glyph. A chat in one source: its PrMark, as it always was. A chat in several
 * (WorkspaceView.sources): one glyph per source that has a pull request, the primary's first, each naming its source
 * on hover; `projectId` null: they only tell.
 */
export function ChatPrMarks({ workspace, projectId, className }: { workspace: Pick<WorkspaceView, "pullRequest" | "sources">; projectId: string | null; className?: string }) {
  if (!workspace.sources) return workspace.pullRequest ? <PrMark pr={workspace.pullRequest} projectId={projectId} {...(className ? { className } : {})} /> : null;
  const open = workspace.sources.filter((s) => s.pullRequest);
  if (open.length === 0) return null;
  return (
    <span data-chat-prs className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {open.map((s) => (
        <PrMark key={s.name} pr={s.pullRequest!} projectId={projectId} source={{ name: s.name, repo: s.repo, host: s.host }} />
      ))}
    </span>
  );
}

export function StatePill({ state }: { state: PrSummary["state"] }) {
  const s = STATE[state];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/[0.05] px-2 text-[12.5px] font-medium ring-1 ring-inset ring-foreground/10", s.tone)}>
      <Icon icon={s.icon} className="size-3.5" strokeWidth={2} />
      {s.word}
    </span>
  );
}

/** The one-glyph rollup a queue row wears. */
export function ChecksGlyph({ checks }: { checks: PrSummary["checks"] }) {
  if (!checks) return null;
  return checks === "passing" ? (
    <Icon icon={Tick02Icon} aria-label="Checks pass" className="size-3.5 shrink-0 text-success" strokeWidth={2.25} />
  ) : checks === "failing" ? (
    <Icon icon={Cancel01Icon} aria-label="Checks fail" className="size-3.5 shrink-0 text-destructive" strokeWidth={2.25} />
  ) : (
    <Icon icon={CircleIcon} aria-label="Checks running" className="size-2.5 shrink-0 fill-warning text-warning" strokeWidth={0} />
  );
}

/** Checks as a count and a split bar: passed green, failed red, pending amber. */
/** `bar`: the coloured track beside the count (false where room is short). */
export function ChecksBar({ checks, bar = true }: { checks: ReadonlyArray<PrCheck>; bar?: boolean }) {
  if (checks.length === 0) return null;
  const n = (s: PrCheck["status"]) => checks.filter((c) => c.status === s).length;
  const passed = n("passed") + n("skipped");
  const failed = n("failed");
  const pending = n("pending");
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {passed}/{checks.length}
      </span>
      {bar ? (
        <span className="flex h-1.5 w-14 overflow-hidden rounded-full bg-foreground/10" aria-hidden>
          <span className="bg-success" style={{ width: `${(passed / checks.length) * 100}%` }} />
          <span className="bg-destructive" style={{ width: `${(failed / checks.length) * 100}%` }} />
          <span className="bg-warning" style={{ width: `${(pending / checks.length) * 100}%` }} />
        </span>
      ) : null}
    </span>
  );
}

export const REVIEW_WORD: Record<NonNullable<PrSummary["review"]>, { word: string; tone: string }> = {
  approved: { word: "Approved", tone: "text-success" },
  changes_requested: { word: "Changes asked", tone: "text-destructive" },
  review_required: { word: "Review wanted", tone: "text-muted-foreground" },
};

/** Inline `code` in guide prose as mono chips; the rest stays text. */
export function Prose({ text, className }: { text: string; className?: string | undefined }): ReactNode {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="rounded-[4px] bg-foreground/[0.06] px-1 py-px font-mono text-[0.88em] text-foreground">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}

const LABEL = /^(before|after|why|what|checked):\s*/i;
const LABEL_TONE: Record<string, string> = { before: "text-muted-foreground", after: "text-foreground", why: "text-foreground/75", what: "text-foreground", checked: "text-foreground/75" };

/**
 * A guide's lines in its standard format: `before:` / `after:` / `why:` (an overview's `what:` / `why:`, a skim's
 * `checked:`) as a two-column grid, label left; any other line as a plain paragraph.
 */
export function GuideLines({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1", className)}>
      {lines.map((line, i) => {
        const m = LABEL.exec(line);
        const label = m?.[1]?.toLowerCase();
        return label ? (
          <p key={i} className="contents">
            <span className="select-none pt-[3px] font-mono text-[11.5px] leading-5 text-[hsl(var(--subtle-foreground))]">{label}</span>
            <Prose text={line.slice(m![0].length)} className={LABEL_TONE[label]} />
          </p>
        ) : (
          <p key={i} className="col-span-2">
            <Prose text={line} />
          </p>
        );
      })}
    </div>
  );
}

/** How big a change reads, by lines of code and tests (lockfiles and generated files not counted). */
export const SIZES = [
  { label: "XS", max: 30 },
  { label: "S", max: 150 },
  { label: "M", max: 500 },
  { label: "L", max: 1500 },
  { label: "XL", max: Number.POSITIVE_INFINITY },
] as const;

export const sizeOf = (lines: number) => SIZES.findIndex((s) => lines <= s.max);

/** The change's size as compact Review's pill: four rising bars filled to its size, then XS to XL. */
export function SizePill({ lines, className }: { lines: number; className?: string }) {
  const at = sizeOf(lines);
  const size = SIZES[at]!;
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-muted-foreground ring-1 ring-inset ring-foreground/10", className)}
      title={`${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} of code and tests changed (lockfiles and generated files not counted)`}
    >
      <span aria-hidden className="flex h-2.5 items-end gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("w-[2.5px] rounded-[1px]", i <= Math.min(at, 3) ? "bg-foreground/75" : "bg-foreground/15")} style={{ height: `${40 + i * 20}%` }} />
        ))}
      </span>
      <span className="sr-only">Size </span>
      {size.label}
    </span>
  );
}
