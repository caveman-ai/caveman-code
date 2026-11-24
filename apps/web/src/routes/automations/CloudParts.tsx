// The Cloud pieces of the Automations pages: where an automation runs, the Deploy to Cloud panel with what changed in
// what it may do, a new webhook's one-time URL and secret, an approval gate a run waits on, and the Inbox's group of
// Cloud runs that wait on you. Each view is
// drawn from props (tested by rendering, cloud-parts.test.ts); the containers beside them read and act.
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, LinkSquare02Icon } from "@caveman-app/ui/icons/huge";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { Notices, runPath, say, useActions, useConsoleBase } from "./actions.tsx";
import { CLOUD_INBOX_MS, forgetHooks, useApplied, useAppliedNames, useCloudList, useCloudRuns, useLocalGates, useShownHooks } from "./data.ts";
import {
  afterWord,
  appliedFor,
  authorityWord,
  beforeWord,
  CONSOLE,
  cloudFor,
  cloudRunName,
  cloudTriggerWords,
  consoleHost,
  consoleUrl,
  deployView,
  gateWords,
  isCloud,
  unlistedView,
  unreadView,
  waitingApprovals,
  type Applied,
  type AuthorityChange,
  type CloudAutomation,
  type CloudRun,
  type DeployView,
  type HookShown,
} from "./cloud.ts";
import { ago, defaultBranch, fileRef, problemsOf, subjectLine, subjectView, WHERE_WORD, type Automation, type Where } from "./model.ts";
import { thisComputer } from "../../lib/platform.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

// ------------------------------------------------------------ where it runs

/** Where an automation runs, as its mark: This Mac, Cloud, or GitHub's mark for GitHub Actions. */
export function WhereMark({ where, className }: { where: Where; className?: string }) {
  const label = `Runs on ${WHERE_WORD[where]}`;
  if (where === "github_actions") return <BrandMark name="github" size={16} label={label} className={cn("shrink-0 text-muted-foreground", className)} />;
  return <Glyph name={where === "cloud" ? "computer-cloud" : "computer-this-mac"} label={label} className={cn("text-muted-foreground", className)} />;
}

/** An outside link to a console page, opened in the browser. */
export function ConsoleLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Opens ${consoleHost(href)} in your browser`}
      className={cn("inline-flex items-center gap-1 rounded text-[12.5px] text-muted-foreground outline-none underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {children}
      <Icon icon={LinkSquare02Icon} className="size-3" />
    </a>
  );
}

// ------------------------------------------------------------ what it may do

/** The authority-bearing keys that differ from the revision Cloud runs: what, before, after, and whether it widens. */
export function AuthorityTable({ changes }: { changes: ReadonlyArray<AuthorityChange> }) {
  if (changes.length === 0) return null;
  return (
    <div role="table" aria-label="What changed in what it may do" className="overflow-hidden rounded-lg border border-border">
      <div role="row" className="grid h-8 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_64px] items-center gap-x-3 bg-foreground/[0.02] px-3 text-[12px] text-muted-foreground">
        <span role="columnheader">What</span>
        <span role="columnheader">Cloud runs now</span>
        <span role="columnheader">This file</span>
        <span role="columnheader" className="sr-only">
          Widens
        </span>
      </div>
      {changes.map((c) => (
        <div key={c.key} role="row" className="grid min-h-[34px] grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_64px] items-center gap-x-3 border-t border-border/60 px-3 py-1.5 text-[12.5px]">
          <span role="cell" className="truncate text-foreground" title={c.key}>
            {authorityWord(c.key)}
          </span>
          <span role="cell" className={cn("truncate font-mono text-[12px]", c.before === null ? "text-[hsl(var(--subtle-foreground))]" : "text-muted-foreground")} title={beforeWord(c)}>
            {beforeWord(c)}
          </span>
          <span role="cell" className={cn("truncate font-mono text-[12px]", c.after === null ? "text-[hsl(var(--subtle-foreground))] line-through" : "text-foreground")} title={afterWord(c)}>
            {afterWord(c)}
          </span>
          <span role="cell" className="text-right">
            {c.widens ? <span className="inline-flex h-5 items-center rounded-full bg-warning/10 px-1.5 text-[11.5px] font-medium text-warning ring-1 ring-inset ring-warning/25">Wider</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ the Deploy panel

export interface CloudPanelProps {
  /** null: Cloud's copy is still being read. */
  readonly view: DeployView | null;
  /** This runtime serves no Cloud: the panel says to update instead. */
  readonly unavailable: boolean;
  /** Reading Cloud's copy failed: why. */
  readonly error: string | null;
  /** Its page in the console, once Cloud has it. */
  readonly consoleHref: string | null;
}

/** "On Cloud": not deployed yet, deployed, or waiting for approval with what it may now do that it could not before. */
export function CloudPanelView({ view, unavailable, error, consoleHref }: CloudPanelProps) {
  const pending = view?.kind === "pending";
  return (
    <section aria-label="On Cloud" className={cn("overflow-hidden rounded-xl border bg-card", pending ? "border-warning/30" : "border-border")}>
      <div className="flex items-start gap-3.5 px-4 py-3.5">
        <Glyph name={pending ? "state-needs-input" : "computer-cloud"} className={cn("mt-0.5 shrink-0", pending ? "text-warning" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          {unavailable ? (
            <>
              <p className="text-[14px] font-medium text-foreground">Runs on Cloud</p>
              <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">This version of Caveman Code can't deploy to Cloud yet. Update it to deploy from here.</p>
            </>
          ) : view === null ? (
            <div aria-busy aria-label="Reading Cloud's copy">
              <span className="block h-3.5 w-32 rounded bg-foreground/[0.07]" />
              <span className="mt-2.5 block h-3 w-3/4 rounded bg-foreground/[0.05]" />
            </div>
          ) : (
            <>
              <p className={cn("text-[14px] font-medium", pending ? "text-warning" : "text-foreground")}>{view.title}</p>
              <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">{view.detail}</p>
            </>
          )}
          {error ? (
            <p role="alert" className="mt-1.5 text-[13px] leading-[19px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {consoleHref ? <ConsoleLink href={consoleHref} className="mt-0.5 shrink-0">Open in Platform</ConsoleLink> : null}
      </div>
      {view && view.changes.length > 0 ? (
        <div className="border-t border-border/60 px-4 py-3">
          <p className="mb-2 text-[12.5px] text-muted-foreground">What changed in what it may do{pending ? ", against the version Cloud runs now" : ""}</p>
          <AuthorityTable changes={view.changes} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * One automation as Cloud holds it: Cloud's list once it has caught up with this computer's last Deploy (the same
 * revision, or one applied since); until then, or where Cloud serves no list, what that Deploy answered.
 */
function onCloud(kept: Applied | undefined, listed: CloudAutomation | undefined): Applied | undefined {
  if (!kept || !listed) return kept ?? listed;
  if (listed.revision_id === kept.revision_id) return { ...listed, from_here: true };
  return Date.parse(listed.applied_at ?? "") < Date.parse(kept.applied_at ?? "") ? kept : listed;
}

/** One automation on Cloud (onCloud), and whether this runtime reaches Cloud at all. */
export function useCloudState(a: Automation): CloudPanelProps & { readonly cloud: Applied | undefined } {
  const base = useConsoleBase();
  const projects = useRuntimeSelector((v) => v.projects);
  const repo = projects.find((p) => p.id === a.project_id)?.repository?.full_name;
  // Cloud's runs say whether this runtime reaches Cloud at all; its list (newer runtimes) what Cloud holds.
  const runs = useCloudRuns();
  const list = useCloudList();
  const applied = useApplied(a.project_id);
  const name = fileRef(a.id)?.name ?? a.title;
  const cloud = onCloud(appliedFor(applied, a, name), list.value ? cloudFor(list.value, repo, name) : undefined);
  const settled = (r: { value: unknown; error: string | undefined }) => r.value !== undefined || r.error !== undefined;
  const read = applied.length > 0 || (settled(runs) && settled(list));
  const error = list.error ?? (list.value === null ? runs.error : undefined);
  return {
    cloud,
    view: !read ? null : cloud ? deployView(cloud, Date.now()) : error ? unreadView(error) : list.value === null ? unlistedView(defaultBranch(a)) : deployView(undefined, Date.now()),
    unavailable: runs.value === null && list.value === null && applied.length === 0,
    error: null,
    consoleHref: cloud ? consoleUrl(base, CONSOLE.automation(cloud.id)) : null,
  };
}

/** Cloud's id for an automation, when this computer deployed it or Cloud listed it: how its Cloud runs are found. */
export function useCloudIdOf(a: Automation | undefined): string | undefined {
  const projects = useRuntimeSelector((v) => v.projects);
  const list = useCloudList(a ? isCloud(a) : false);
  const applied = useApplied(a?.project_id ?? null);
  if (!a) return undefined;
  const name = fileRef(a.id)?.name ?? a.title;
  const repo = projects.find((p) => p.id === a.project_id)?.repository?.full_name;
  return onCloud(appliedFor(applied, a, name), list.value ? cloudFor(list.value, repo, name) : undefined)?.id;
}

/** The panel for one automation, at the top of its Overview. */
export function CloudPanel({ automation: a }: { automation: Automation }) {
  const { cloud: _, ...props } = useCloudState(a);
  return <CloudPanelView {...props} />;
}

/** Deploy to Cloud, in the automation's header: sends the repo's .caveman files and keeps what Cloud answered. */
export function DeployButton({ automation: a }: { automation: Automation }) {
  const actions = useActions();
  const state = useCloudState(a);
  const [busy, setBusy] = useState(false);
  if (state.unavailable) return null;
  const blocked = problemsOf(a).errors > 0;
  const again = state.view !== null && state.view.kind !== "none" && state.view.kind !== "unknown";
  return (
    <Button
      size="sm"
      disabled={busy || blocked}
      title={blocked ? "Fix the file's errors first" : "Send this repo's .caveman files to Cloud. Anything that lets it do more waits for its owner's approval."}
      onClick={() => {
        setBusy(true);
        void actions.deploy(a).finally(() => setBusy(false));
      }}
    >
      <Glyph name="computer-cloud" className="size-3.5" />
      {busy ? "Deploying…" : again ? "Deploy again" : "Deploy to Cloud"}
    </Button>
  );
}

// ------------------------------------------------------------ a new webhook's one-time secret

/** One value to copy whole: its label, the value, and a Copy button that says when it worked. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-md bg-foreground/[0.05] px-2 py-1.5 font-mono text-[12px] leading-[18px] text-foreground ring-1 ring-inset ring-foreground/[0.07]">{value}</code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy the ${label.toLowerCase()}`}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => say("The clipboard isn't reachable here. Select the text and copy it.", "error"),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** The webhooks a Deploy just made, each with its URL and the secret a sender signs with, and how to sign. */
export function HookSecretsView({ hooks }: { hooks: ReadonlyArray<HookShown> }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {hooks.map((h) => (
        <section key={h.url} aria-label={`${h.automation}'s webhook`} className="flex min-w-0 flex-col gap-2.5">
          {hooks.length > 1 ? <p className="text-[13px] font-medium text-foreground">{h.automation}</p> : null}
          <CopyRow label="URL" value={h.url} />
          <CopyRow label="Secret" value={h.secret} />
        </section>
      ))}
      <p className="text-[12.5px] leading-[18px] text-muted-foreground">
        POST to the URL and sign each body with the secret, as <code className="whitespace-nowrap font-mono text-[12px] text-foreground">X-Caveman-Signature: sha256=</code> and the HMAC-SHA256 in hex. Give
        each event its own id in <code className="whitespace-nowrap font-mono text-[12px] text-foreground">X-Caveman-Delivery</code>; without one, the same body twice in a minute runs once.
      </p>
    </div>
  );
}

/** "issue-intake's webhook", or "2 new webhooks". */
export const hookTitle = (hooks: ReadonlyArray<HookShown>) => (hooks.length === 1 ? `${hooks[0]!.automation}'s webhook` : `${hooks.length} new webhooks`);

/**
 * After a Deploy that made a webhook: Cloud says its secret this once, so it shows here until the person closes it
 * with the button (a click outside or Escape leaves it open). Closing forgets it; nothing keeps it on this computer.
 */
export function HookSecrets() {
  const hooks = useShownHooks();
  const one = hooks.length === 1;
  return (
    <Dialog open={hooks.length > 0} onOpenChange={(open) => (open ? undefined : forgetHooks())}>
      <DialogContent size="md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Glyph name="computer-cloud" />
            {hooks.length > 0 ? hookTitle(hooks) : null}
          </DialogTitle>
          <DialogDescription>
            Cloud shows {one ? "this secret" : "these secrets"} only now. Copy {one ? "the URL and secret" : "each URL and secret"} to the sender before you close this.
          </DialogDescription>
        </DialogHeader>
        <HookSecretsView hooks={hooks} />
        <DialogFooter>
          <Button size="sm" onClick={forgetHooks}>
            {one ? "I've copied it" : "I've copied them"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ approval gates

export interface GateProps {
  /** "implement waits for the owner's approval". */
  readonly title: string;
  readonly detail?: string | undefined;
  readonly where: "this_mac" | "cloud";
  readonly busy: "allow" | "deny" | null;
  readonly consoleHref?: string | undefined;
  readonly onAnswer: (decision: "allow" | "deny") => void;
}

/** A run stopped at an `approve:` step: Approve lets it go on, Reject stops it there. */
export function GateCard({ title, detail, where, busy, consoleHref, onAnswer }: GateProps) {
  return (
    <div role="group" aria-label={title} className="flex items-center gap-3.5 rounded-xl border border-warning/30 bg-card px-4 py-3">
      <Glyph name="state-needs-input" label="Needs you" className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">{detail ?? (where === "cloud" ? "The run waits on Cloud until someone answers." : `The run waits on ${thisComputer} until you answer.`)}</p>
      </div>
      {consoleHref ? <ConsoleLink href={consoleHref}>Open in Platform</ConsoleLink> : null}
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onAnswer("deny")}>
        {busy === "deny" ? "Rejecting…" : "Reject"}
      </Button>
      <Button size="sm" disabled={busy !== null} onClick={() => onAnswer("allow")}>
        {busy === "allow" ? "Approving…" : "Approve"}
      </Button>
    </div>
  );
}

/** The gates a Cloud automation's runs wait on, above its Runs table. */
export function CloudGates({ runs, name }: { runs: ReadonlyArray<CloudRun>; name: string }) {
  const actions = useActions();
  const base = useConsoleBase();
  const [busy, setBusy] = useState<Record<string, "allow" | "deny">>({});
  const waiting = waitingApprovals(runs);
  if (waiting.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {waiting.map((r) => {
        const about = r.trigger.subject ? subjectLine(subjectView(r.trigger.subject, r.trigger.subject_title)) : cloudTriggerWords(r.trigger);
        return (
          <GateCard
            key={r.run_id}
            title={gateWords(r.requires_action!)}
            detail={`${about} · started ${ago(r.started_at, Date.now())} on Cloud`}
            where="cloud"
            busy={busy[r.run_id] ?? null}
            consoleHref={r.session_id ? consoleUrl(base, CONSOLE.session(r.session_id)) : undefined}
            onAnswer={(d) => {
              setBusy((b) => ({ ...b, [r.run_id]: d }));
              void actions.answerCloud(r, name, d).finally(() => setBusy(({ [r.run_id]: _, ...rest }) => rest));
            }}
          />
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ the Inbox

export interface ApprovalRowProps {
  readonly where: "this_mac" | "cloud";
  /** The automation's name. */
  readonly name: string;
  /** What waits, on what: "ship waits for the owner's approval · #12 · Cut 4.2". */
  readonly line: string;
  readonly since: string;
  readonly now: number;
  readonly busy: "allow" | "deny" | null;
  /** A This Mac run's page here. */
  readonly runHref: string | null;
  /** A Cloud run's session in the console. */
  readonly consoleHref: string | null;
  readonly onAnswer: (decision: "allow" | "deny") => void;
}

/** One run stopped at an approval gate, as an Inbox row: where, which automation, what waits, and the two answers. */
export function ApprovalRow({ where, name, line, since, now, busy, runHref, consoleHref, onAnswer }: ApprovalRowProps) {
  return (
    <div role="listitem" className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-accent/40">
      <span className="flex h-5 items-center gap-2.5">
        <WhereMark where={where} className="shrink-0" />
        {runHref ? (
          <Link to={runHref} className="min-w-0 flex-1 truncate rounded text-[13px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {name}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{name}</span>
        )}
        <time dateTime={since} className="shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
          {ago(since, now).replace(/ ago$/, "")}
        </time>
        <Glyph name="state-needs-input" label="Needs you" className="shrink-0 text-warning" />
      </span>
      <span className="line-clamp-2 pl-[26px] text-[12.5px] leading-[18px] text-muted-foreground">{line}</span>
      <span className="flex items-center gap-1.5 pl-[26px] pt-0.5">
        <Button size="sm" className="h-6 px-2 text-[12px]" disabled={busy !== null} onClick={() => onAnswer("allow")}>
          {busy === "allow" ? "Approving…" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" disabled={busy !== null} onClick={() => onAnswer("deny")}>
          {busy === "deny" ? "Rejecting…" : "Reject"}
        </Button>
        {consoleHref ? <ConsoleLink href={consoleHref} className="ml-auto text-[12px]">Platform</ConsoleLink> : null}
      </span>
    </div>
  );
}

/**
 * The Inbox's approvals: automation runs stopped at an approval gate, on this Mac and on Cloud, asked again every
 * 30 s. Nothing when none wait. Answering one here is answering it on its run's page.
 */
export function Approvals() {
  const local = useLocalGates();
  const cloud = useCloudRuns({ everyMs: CLOUD_INBOX_MS });
  const names = useAppliedNames();
  const actions = useActions();
  const base = useConsoleBase();
  const [busy, setBusy] = useState<Record<string, "allow" | "deny">>({});
  const answer = (id: string, run: (d: "allow" | "deny") => Promise<boolean>) => (d: "allow" | "deny") => {
    setBusy((b) => ({ ...b, [id]: d }));
    void run(d).finally(() => setBusy(({ [id]: _, ...rest }) => rest));
  };
  const now = Date.now();
  const rows: Array<ApprovalRowProps & { key: string }> = [
    ...(local.value ?? []).map((g) => {
      const subject = subjectView(g.trigger.subject, g.trigger.subject_title);
      return {
        key: `mac:${g.run_id}`,
        where: "this_mac" as const,
        name: g.automation,
        line: [gateWords({ step: g.gate.step, by: g.gate.by }), subject.repo || subject.title ? subjectLine(subject) : null].filter(Boolean).join(" · "),
        since: g.started_at,
        now,
        busy: busy[`mac:${g.run_id}`] ?? null,
        runHref: runPath(g.automation_id, g.run_id),
        consoleHref: null,
        onAnswer: answer(`mac:${g.run_id}`, (d) => actions.answerLocal(g.gate, d, g.run_id)),
      };
    }),
    ...waitingApprovals(cloud.value ?? []).map((r) => {
      const name = cloudRunName(r, names);
      const about = r.trigger.subject ? subjectLine(subjectView(r.trigger.subject, r.trigger.subject_title)) : cloudTriggerWords(r.trigger);
      return {
        key: `cloud:${r.run_id}`,
        where: "cloud" as const,
        name,
        line: `${gateWords(r.requires_action!)} · ${about}`,
        since: r.started_at,
        now,
        busy: busy[`cloud:${r.run_id}`] ?? null,
        runHref: null,
        consoleHref: r.session_id ? consoleUrl(base, CONSOLE.session(r.session_id)) : null,
        onAnswer: answer(`cloud:${r.run_id}`, (d) => actions.answerCloud(r, name, d)),
      };
    }),
  ].sort((a, b) => a.since.localeCompare(b.since));
  // The notice line answers land in stays mounted when the last row goes.
  if (rows.length === 0) return <Notices />;
  return (
    <div role="group" aria-label="Automation runs waiting on you" className="px-2 pt-1">
      <Notices />
      <h2 className="flex h-7 items-center gap-2 px-2 text-[12px] font-medium text-muted-foreground">
        <Glyph name="automations" className="text-[hsl(var(--subtle-foreground))]" />
        <span className="text-foreground">Approve</span>
        <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{rows.length}</span>
        <Link to="/automations" className="ml-auto rounded px-1 text-[12px] font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Automations
        </Link>
      </h2>
      <div role="list" className="flex flex-col gap-px">
        {rows.map(({ key, ...row }) => (
          <ApprovalRow key={key} {...row} />
        ))}
      </div>
    </div>
  );
}
