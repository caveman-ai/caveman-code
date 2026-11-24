import { cn } from "@caveman-app/ui/lib/cn";
import { Switch } from "@caveman-app/ui/components/switch";
import { Icon, ArrowRight01Icon, type IconSvgElement, SourceCodeIcon, Folder01Icon, GitBranchIcon, GitPullRequestIcon, PlugSocketIcon, McpServerIcon, GitCompareIcon, RadioTowerIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useId, useState } from "react";
import { cacheExpiry, type CacheReport } from "../../../state/cache-expiry.ts";
import { Card, Row } from "./Card.tsx";
import { computerIcon } from "../../transcript/marks.tsx";
import { baseName, parentPath, tildify } from "../../../lib/paths.ts";

// The pane's cards: Environment, Context, Connectors, Outputs, Changes. They
// live in the side panel's Overview tab. Presentational: index.tsx feeds it
// from the runtime; the style page feeds it fixtures. Rows follow STYLE.md's
// hierarchy: 16px Hugeicon, value in white, meta in grey.

export interface PaneOutput {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly icon: IconSvgElement;
}

export interface PaneCardsViewProps {
  readonly env: {
    readonly repo: string;
    /** Local checkout path; null for a remote repo. */
    readonly path: string | null;
    readonly branch: string;
    readonly computer: { readonly kind: string; readonly label: string };
    readonly ports: Readonly<Record<string, number>> | null;
    /**
     * A chat in several sources: each one by name, the primary first, with its repository (or that it is a folder).
     * They take the place of `repo` and `path`; absent for a chat in one source.
     */
    readonly sources?: ReadonlyArray<{ readonly name: string; readonly line: string; readonly folder?: boolean }>;
  };
  readonly context: { readonly used: number; readonly window: number } | null;
  readonly cacheReport?: CacheReport | null;
  /** null while loading or when plugin.list failed. */
  readonly connectors: { readonly servers: ReadonlyArray<string>; readonly plugins: ReadonlyArray<{ readonly name: string; readonly description: string | null }> } | null;
  readonly outputs: ReadonlyArray<PaneOutput>;
  readonly changes: { readonly files: number; readonly additions: number; readonly deletions: number };
  /** `list`: a chat in several sources opened one pull request per source it changed; each is a row of its own. */
  readonly pr: { readonly busy: boolean; readonly url: string | null; readonly error: string | null; readonly list?: ReadonlyArray<{ readonly source: string; readonly number: number; readonly url: string }> };
  readonly onOpenOutput: (id: string) => void;
  /** Every output, in the artifact list. */
  readonly onShowOutputs: () => void;
  readonly onShowChanges: () => void;
  readonly onCreatePr: () => void;
  /** Remote control (Settings.remote_control: the runtime's Cloud link). Absent: the row shows it is unavailable. */
  readonly remote?: {
    readonly on: boolean;
    readonly onChange: (on: boolean) => void;
    /** Where the link is, in plain words (cloud.status); default "From your other devices" / "Off". */
    readonly detail?: string;
    readonly busy?: boolean;
    /** A step the person takes here, e.g. Sign in. */
    readonly action?: { readonly label: string; readonly onClick: () => void };
  };
  readonly className?: string;
}

const OUTPUTS_SHOWN = 6;

export function PaneCardsView({ env, context, cacheReport, connectors, outputs, changes, pr, onOpenOutput, onShowOutputs, onShowChanges, onCreatePr, remote, className }: PaneCardsViewProps) {
  const pct = context && context.window > 0 ? Math.min(100, Math.round((context.used / context.window) * 100)) : null;
  const serverCount = connectors?.servers.length ?? 0;
  return (
    <div aria-label="Session details" role="group" className={cn("flex flex-col gap-2", className)}>
      <Card title="Environment" defaultOpen>
        {env.sources ? (
          env.sources.map((s) => <Row key={s.name} icon={s.folder ? Folder01Icon : SourceCodeIcon} label={s.name} meta={s.line} />)
        ) : (
          <>
            <Row icon={SourceCodeIcon} label={env.repo} />
            {env.path ? <Row icon={Folder01Icon} label={baseName(env.path)} meta={middle(tildify(parentPath(env.path)), 18)} title={env.path} /> : null}
          </>
        )}
        {/* A plain folder's chat (Project.no_git) runs in the folder itself: no branch, no worktree. */}
        {env.branch ? <Row icon={GitBranchIcon} label={middle(env.branch, 22)} meta="Worktree" title={env.branch} mono /> : <Row icon={GitBranchIcon} label="No git" meta="In the folder" />}
        <Row icon={computerIcon(env.computer.kind)} label={env.computer.label} meta={env.ports ? Object.entries(env.ports).map(([n, p]) => `${n}:${p}`).join(" ") : undefined} />
        <RemoteRow remote={remote} />
      </Card>

      <Card
        title="Context"
        summary={
          pct === null ? (
            <span className="text-[12px] text-muted-foreground">No reading yet</span>
          ) : (
            <span className="flex items-center gap-2 text-[12px] tabular-nums text-muted-foreground">
              {pct}%
              <span aria-hidden className="h-1 w-7 overflow-hidden rounded-full bg-muted">
                <span className={cn("block h-full rounded-full", pct >= 85 ? "bg-warning" : "bg-foreground/70")} style={{ width: `${Math.max(pct, 4)}%` }} />
              </span>
            </span>
          )
        }
      >
        {context ? (
          <p className="px-1 pb-1 text-[13px] text-muted-foreground">
            <span className="tabular-nums text-foreground">{compact(context.used)}</span> of <span className="tabular-nums">{compact(context.window)}</span> tokens in the window.
          </p>
        ) : (
          <p className="px-1 pb-1 text-[13px] text-muted-foreground">The engine has not reported its context use in this session.</p>
        )}
        <CacheExpiry report={cacheReport} />
      </Card>

      <Card
        title="Connectors"
        summary={
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {connectors === null ? "…" : serverCount === 0 ? "None" : `${serverCount} MCP ${serverCount === 1 ? "server" : "servers"}`}
          </span>
        }
      >
        {connectors && (connectors.plugins.length > 0 || serverCount > 0) ? (
          <>
            {connectors.plugins.map((p) => (
              <Row key={p.name} icon={PlugSocketIcon} label={p.name} meta={p.description ?? undefined} metaInline />
            ))}
            {connectors.servers.map((s) => (
              <Row key={s} icon={McpServerIcon} label={s} meta="MCP" mono />
            ))}
          </>
        ) : (
          <p className="px-1 pb-1 text-[13px] text-muted-foreground">No plugins or MCP servers on this runtime.</p>
        )}
      </Card>

      {outputs.length > 0 ? (
        <Card title="Outputs" defaultOpen summary={<span className="text-[12px] tabular-nums text-muted-foreground">{outputs.length}</span>}>
          {outputs.slice(0, OUTPUTS_SHOWN).map((o) => (
            <button
              type="button"
              key={o.id}
              onClick={() => onOpenOutput(o.id)}
              className="group flex h-8 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] transition-colors duration-75 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon icon={o.icon} className="size-4 shrink-0" />
              <span className="min-w-0 max-w-[60%] shrink-0 truncate text-foreground">{o.title}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{o.meta}</span>
              <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover:translate-x-0.5" />
            </button>
          ))}
          {outputs.length > OUTPUTS_SHOWN ? (
            <button
              type="button"
              onClick={onShowOutputs}
              className="flex h-8 w-full items-center rounded-md px-1 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Show all {outputs.length}
            </button>
          ) : null}
        </Card>
      ) : null}

      {changes.files > 0 ? (
        <Card title="Changes" defaultOpen summary={<span className="text-[12px] tabular-nums text-muted-foreground">{changes.files} {changes.files === 1 ? "file" : "files"}</span>}>
          <div className="flex h-8 items-center gap-2 px-1">
            <button
              type="button"
              onClick={onShowChanges}
              aria-label={`Show the changes: ${changes.additions} lines added, ${changes.deletions} removed`}
              className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={GitCompareIcon} className="size-4 shrink-0" />
              <span className="font-mono text-[12.5px] tabular-nums text-diff-add-ink">+{changes.additions}</span>
              <span className="font-mono text-[12.5px] tabular-nums text-diff-del-ink">−{changes.deletions}</span>
            </button>
            {!env.branch || pr.list ? null : pr.url ? (
              <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-md bg-secondary px-2.5 text-[12.5px] text-secondary-foreground hover:bg-accent">
                View PR
              </a>
            ) : (
              <button
                type="button"
                onClick={onCreatePr}
                disabled={pr.busy}
                title={pr.error ?? undefined}
                className="inline-flex h-7 items-center rounded-md bg-secondary px-2.5 text-[12.5px] text-secondary-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {pr.busy ? "Opening…" : pr.error ? "Retry PR" : "Create PR"}
              </button>
            )}
          </div>
          {/* One pull request per source the chat changed: each opens on its host. */}
          {pr.list?.map((r) => (
            <a
              key={r.source}
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-2 rounded-md px-1 text-[13px] transition-colors duration-75 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon icon={GitPullRequestIcon} className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-foreground">{r.source}</span>
              <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground">#{r.number}</span>
            </a>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

function CacheExpiry({ report }: { report: CacheReport | null | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!report) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [report]);
  const expiry = cacheExpiry(report, now);
  return (
    <div className="mt-2 border-t border-border px-1 pt-2 pb-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[12px]">
        <span className="text-muted-foreground">Cache expiry · estimated</span>
        <span className="tabular-nums text-foreground">{expiry.label}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{expiry.detail}</p>
    </div>
  );
}

/** Remote control: the runtime keeps its Cloud link open so your other devices reach this session. */
function RemoteRow({ remote }: { remote: PaneCardsViewProps["remote"] }) {
  const id = useId();
  return (
    <div className="flex h-8 items-center gap-2 px-1 text-[13px]">
      <Icon icon={RadioTowerIcon} className="size-4 shrink-0" />
      <label htmlFor={id} className="text-foreground">
        Remote control
      </label>
      <span title={remote?.detail} className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {remote ? (remote.detail ?? (remote.on ? "From your other devices" : "Off")) : "Unavailable"}
      </span>
      {remote?.action ? (
        <button type="button" onClick={remote.action.onClick} className="h-6 shrink-0 rounded-md border border-input px-2 text-[12px] hover:bg-secondary">
          {remote.action.label}
        </button>
      ) : null}
      <Switch
        id={id}
        disabled={!remote || remote.busy}
        checked={remote?.on ?? false}
        onCheckedChange={(on) => remote?.onChange(on)}
        aria-describedby={`${id}-why`}
        className="scale-90"
      />
      <span id={`${id}-why`} className="sr-only">
        {remote ? "Keeps this runtime reachable through Caveman from your other devices." : "This runtime cannot share sessions remotely yet."}
      </span>
    </div>
  );
}

/** "claude/article…ity-143eba": keeps both ends of a long name. */
export function middle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/** Token counts as people read them: 950, 41k, 182k, 1.2M (a 1M window, a long session's total), never "41.0k" or "4210k". */
export function compact(n: number): string {
  const short = (v: number, unit: string) => `${v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
  if (n >= 999_500) return short(n / 1_000_000, "M");
  return n >= 1000 ? short(n / 1000, "k") : String(n);
}
