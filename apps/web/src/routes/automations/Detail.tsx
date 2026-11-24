// One automation (/automations/:id, or one of its runs at /automations/:id/runs/:runId) and its settings
// (/automations/:id/settings). The automation reads like a chat: its name and line, then its last run as that run's
// own thread; one it never ran shows what it was told to do. The bar holds Pause, the menu and Run now; the rail at
// the right holds the facts (status, next and last run, project, schedule, model), every run before, and Open
// settings. Settings is the file as a form (./Form.tsx), the file itself (./FileTab.tsx) and its deliveries; edits
// stay unsaved until Save (or ⌘S), and leaving with some asks first. `?run=1` opens Run now's form.
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Input } from "@caveman-app/ui/components/input";
import { Keycap } from "@caveman-app/ui/components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowRight01Icon, MoreHorizontalIcon, PauseIcon, PlayIcon, FlashIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ProjectBadge } from "../../components/ProjectPicker.tsx";
import { isComposing, keysText, SectionHeader, SurfaceEmpty } from "../../panels/chrome.tsx";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import { chatPath } from "../../panes/store.ts";
import { requestId, useRuntimeSelector } from "../../state/runtime.tsx";
import { detailPath, runPath, say, settingsPath, useActions, useConsoleBase, type Actions } from "./actions.tsx";
import { cloudRunsOf, isCloud, mergeRuns } from "./cloud.ts";
import { CloudPanel, DeployButton, useCloudIdOf } from "./CloudParts.tsx";
import { fileKey, LIST, message, patch, refresh, useAutomation, useAutomations, useCloudRuns, useDeliveries, useExplain, useFileText, useRuns } from "./data.ts";
import { modelWord, readForm, setDescription } from "./draft.ts";
import { FileTab } from "./FileTab.tsx";
import { ChangedOnDisk, SettingsForm, useFileBuffer, useLeaveGuard, useLiveCheck, useSaveKey } from "./Form.tsx";
import { Bar, Page, Pane, RailRow, RailSection } from "../../components/ListFrame.tsx";
import { StateGlyph, WarnDot } from "./marks.tsx";
import {
  ago,
  awaitingAllow,
  budgetUsd,
  budgetWord,
  checkoutOf,
  countsWord,
  defaultBranch,
  deleteWords,
  deliveryView,
  draftWhy,
  fileRef,
  isDraft,
  isLegacy,
  legacyCanBeFile,
  needsForm,
  nextRunWord,
  offMain,
  problemsOf,
  runWho,
  scheduleZoneOf,
  subjectFrom,
  TAKES_WORD,
  triggerKinds,
  triggersOff,
  triggerText,
  WHERE_WORD,
  whereOf,
  type Automation,
} from "./model.ts";
import { RunThread } from "./Thread.tsx";
import { WebhookRules } from "./WebhookRules.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const HOME = { label: "Automations", to: "/automations" };

export function DetailPage({ id, runId }: { id: string; runId?: string | undefined }) {
  const { automation: a, loading, error } = useAutomation(id);
  if (a) return <AutomationView automation={a} runId={runId} />;
  // A run whose automation has no page: an agent run (`caveman-runtime agent run`), or one deleted since.
  if (runId && !loading) {
    return (
      <Page bar={<Bar crumbs={[HOME, { label: "Run" }]} />}>
        <Pane>
          <RunThread runId={runId} />
        </Pane>
      </Page>
    );
  }
  return (
    <Page bar={<Bar crumbs={[HOME]} />}>
      <Pane>
        {loading ? (
          <div aria-busy aria-label="Loading the automation">
            <span className="block h-7 w-1/3 rounded bg-foreground/[0.07]" />
            <span className="mt-3 block h-4 w-1/2 rounded bg-foreground/[0.05]" />
          </div>
        ) : (
          <SurfaceEmpty icon={FlashIcon} title={error ?? "This automation isn't here any more."} className="pt-24" />
        )}
      </Pane>
    </Page>
  );
}

// ------------------------------------------------------------ the automation

function AutomationView({ automation: a, runId }: { automation: Automation; runId: string | undefined }) {
  const actions = useActions();
  const ref = fileRef(a.id);
  const runs = useRuns(ref, (a.runs_running ?? 0) > 0);
  // The run shown: the one asked for, else the newest.
  const shown = runId ?? runs.value?.[0]?.run_id ?? null;
  // The line under the name, unless it only says the name again ("Readme check" under readme-check).
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const line = a.description && words(a.description) !== words(a.title) ? a.description : isLegacy(a) ? triggerText(a.trigger) : null;
  return (
    <Page
      bar={
        <Bar
          crumbs={[HOME, { label: a.title }]}
          actions={
            awaitingAllow(a) ? (
              // An agent set it to run on Cloud: nothing else to do with it until the person allows it.
              <>
                <MoreMenu automation={a} actions={actions} />
                <Button className="ml-1" title="It runs on a Cloud computer of its own, this Mac closed or not, and spends computer time and credits." onClick={() => void actions.allow(a)}>
                  <Glyph name="computer-cloud" className="size-3.5" />
                  Allow
                </Button>
              </>
            ) : (
              <>
                <PauseButton automation={a} actions={actions} />
                <MoreMenu automation={a} actions={actions} />
                <RunNow automation={a} actions={actions} />
              </>
            )
          }
        />
      }
      rail={<Rail automation={a} shown={shown} />}
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">{a.title}</h1>
        {line ? <p className="mt-1 text-[14px] leading-[22px] text-muted-foreground">{line}</p> : null}
        {shown ? <RunThread key={shown} runId={shown} /> : ref && runs.value === undefined && !runs.error ? null : <Instructions automation={a} />}
      </Pane>
    </Page>
  );
}

/** What it was told to do, for one that hasn't run yet: each step's own words, and when it runs first. */
function Instructions({ automation: a }: { automation: Automation }) {
  const file = useFileText(isLegacy(a) ? null : checkoutOf(a), a.path ?? null);
  const read = file.value !== undefined ? readForm(file.value) : null;
  const steps = read && "form" in read ? read.form.steps : null;
  const next = a.enabled && a.next_run_at ? nextRunWord(new Date(a.next_run_at)).replace(/^Next run/, "Its first run is") : null;
  return (
    <div className="mt-8">
      {isLegacy(a) ? (
        <Prompt text={a.prompt ?? ""} />
      ) : steps === null ? (
        file.error ? <p className="text-[13px] text-destructive">Couldn't read {a.path}: {file.error}</p> : <div aria-hidden className="h-24 rounded-lg bg-foreground/[0.03]" />
      ) : (
        <div className="flex flex-col gap-6">
          {steps.map((s) => (
            <section key={s.name}>
              {steps.length > 1 ? (
                <SectionHeader as="h2" className="px-0 pb-1.5">
                  {s.name}
                </SectionHeader>
              ) : null}
              {s.kind === "agent" ? (
                <p className="text-[14.5px] leading-6 text-foreground">
                  <span className="font-medium">{s.agent}</span> <span className="text-muted-foreground">does this, from its own agent file.</span>
                </p>
              ) : s.kind === "run" ? (
                <pre className="whitespace-pre-wrap font-mono text-[13px] leading-[21px] text-foreground">{s.run}</pre>
              ) : s.kind === "wait" ? (
                <p className="text-[14.5px] leading-6 text-muted-foreground">It waits.</p>
              ) : (
                <Prompt text={s.prompt ?? ""} />
              )}
            </section>
          ))}
        </div>
      )}
      <p className="mt-10 border-t border-border/70 pt-4 text-[13px] text-muted-foreground">
        No runs yet. {awaitingAllow(a) ? "It runs on Cloud once you allow it." : next ? `${next}, or press Run now.` : "Press Run now to try it."}
      </p>
    </div>
  );
}

function Prompt({ text }: { text: string }) {
  return text.trim() ? (
    <p className="whitespace-pre-wrap text-[14.5px] leading-6 text-foreground">{text.trim()}</p>
  ) : (
    <p className="text-[14.5px] leading-6 text-[hsl(var(--subtle-foreground))]">No instructions yet. Open settings to write them.</p>
  );
}

// ------------------------------------------------------------ the bar's verbs

/**
 * Its switch, in the bar: Pause as one icon while it runs on its own; Resume in words once paused, so it never sits
 * as a second play mark beside Run now. Paused, nothing starts it; Run now still does.
 */
function PauseButton({ automation: a, actions }: { automation: Automation; actions: Actions }) {
  // A draft has nothing to pause: it turns on when it merges.
  if (isDraft(a)) return null;
  return a.enabled ? (
    <Button variant="ghost" size="icon-sm" aria-label="Pause" title="Pause: its triggers stop until you resume it" onClick={() => void actions.setEnabled(a, false)}>
      <Icon icon={PauseIcon} className="size-4" />
    </Button>
  ) : (
    <Button variant="ghost" size="sm" title="Resume: its triggers start it again" onClick={() => void actions.setEnabled(a, true)}>
      Resume
    </Button>
  );
}

function MoreMenu({ automation: a, actions }: { automation: Automation; actions: Actions }) {
  const all = useAutomations().value ?? [];
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <Icon icon={MoreHorizontalIcon} className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[220px]">
          <DropdownMenuItem onSelect={() => navigate(settingsPath(a.id))}>
            <Glyph name="settings" />
            Settings
          </DropdownMenuItem>
          {isLegacy(a) ? (
            legacyCanBeFile(a) ? (
              <DropdownMenuItem onSelect={() => void actions.saveAsFile(a)}>
                <Glyph name="artifact-file" />
                Save as file
              </DropdownMenuItem>
            ) : null
          ) : (
            <>
              <DropdownMenuItem onSelect={() => navigate(settingsPath(a.id, "file"))}>
                <Glyph name="tool-edit" />
                Edit file
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.duplicate(a, all)}>
                <Glyph name="tool-create" />
                Duplicate
              </DropdownMenuItem>
              {isCloud(a) && !isDraft(a) ? (
                <DropdownMenuItem onSelect={() => void actions.deploy(a)}>
                  <Glyph name="computer-cloud" />
                  Deploy to Cloud
                </DropdownMenuItem>
              ) : null}
              {a.scope === "project" ? (
                <DropdownMenuItem onSelect={() => void actions.openPr(a)} disabled={problemsOf(a).errors > 0}>
                  <Glyph name="artifact-pr" />
                  Commit and open PR
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(a.path ?? "")}>
                <Glyph name="artifact-link" />
                Copy path
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Glyph name="state-failed" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${a.title}?`}
        description={deleteWords(a).confirm}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void actions.remove(a).then((deleted) => deleted && navigate("/automations"))}
      />
    </>
  );
}

/**
 * Run now. A file with `inputs:`, or one whose triggers name an issue or pull request, asks first (the issue's number,
 * its inputs); `?run=1` opens the form (a row's menu, ⌘↩ in the editor). A manual run's outputs wait for Apply on the run.
 */
function RunNow({ automation: a, actions, beforeRun }: { automation: Automation; actions: Actions; beforeRun?: (() => Promise<boolean>) | undefined }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const repo = projects.find((p) => p.id === a.project_id)?.repository?.full_name;
  const [params, setParams] = useSearchParams();
  const inputs = a.inputs ?? [];
  const form = a.source === "file" && needsForm(a);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.flatMap((i) => (i.default ? [[i.name, i.default]] : []))));
  const [about, setAbout] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = problemsOf(a).errors > 0;
  const subject = a.takes_subject ? subjectFrom(about, repo) : null;
  const ready = inputs.every((i) => !i.required || (values[i.name] ?? "").trim() !== "") && !(subject && "error" in subject);

  useEffect(() => {
    if (params.get("run") === null) return;
    if (form && !blocked) setOpen(true);
    const p = new URLSearchParams(params);
    p.delete("run");
    setParams(p, { replace: true });
  }, [params, setParams, form, blocked]);

  const go = async () => {
    setBusy(true);
    // Unsaved edits are saved first: a run reads the file as it is on disk.
    if (beforeRun && !(await beforeRun())) return setBusy(false);
    await actions.runNow(a, { inputs: values, ...(subject && "subject" in subject ? { subject: subject.subject } : {}) });
    setBusy(false);
    setOpen(false);
  };
  const button = (
    <Button
      className="ml-1"
      disabled={blocked || busy}
      title={blocked ? "Fix the file's errors first" : isCloud(a) ? `Run it once on ${thisComputer}. Anything it would post waits on the run for you to apply.` : "Run it now. Anything it would post waits on the run for you to apply."}
      onClick={form ? undefined : () => void go()}
    >
      <Icon icon={PlayIcon} className="size-3.5" />
      {busy ? "Starting…" : "Run now"}
      {form ? <Icon icon={ArrowDown01Icon} className="size-3" strokeWidth={2} /> : null}
    </Button>
  );
  if (!form) return button;
  const takes = a.takes_subject ? TAKES_WORD[a.takes_subject] : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-3">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void go();
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready && void go()}
        >
          {takes ? (
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              <span>
                Run on {takes === "issue" ? "an" : "a"} <span className="text-foreground">{takes}</span>
                {repo ? <span className="text-[hsl(var(--subtle-foreground))]"> in {repo}</span> : null}
              </span>
              <span className="relative flex items-center">
                <span aria-hidden className="pointer-events-none absolute left-2.5 text-[13px] text-[hsl(var(--subtle-foreground))]">
                  #
                </span>
                <Input
                  autoFocus
                  inputMode={repo ? "numeric" : "text"}
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder={repo ? "1841" : "owner/repo#1841"}
                  aria-invalid={subject !== null && "error" in subject}
                  className="pl-6 tabular-nums"
                />
              </span>
              {subject && "error" in subject ? <span className="text-destructive">{subject.error}</span> : null}
            </label>
          ) : null}
          {inputs.map((i, n) => (
            <label key={i.name} className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              <span>
                <span className="font-medium text-foreground">{i.name}</span>
                {i.description ? ` · ${i.description}` : ""}
                {i.required ? "" : " (optional)"}
              </span>
              <Input autoFocus={!takes && n === 0} value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} />
            </label>
          ))}
          <p className="text-[12px] leading-[17px] text-muted-foreground">
            {takes ? `Caveman reads the ${takes} as it would from a trigger. ` : ""}A run by hand posts nothing yet: its comment or pull request waits on the run for you to apply.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Keycap>{keysText("⌘↩", "mod+enter")}</Keycap>
            <Button type="submit" size="sm" disabled={!ready || busy}>
              {subject && "number" in subject ? `Run on #${subject.number}` : takes ? `Run without ${takes === "issue" ? "an" : "a"} ${takes}` : "Run"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------------------ the rail

/** Its state in words and a dot: Active, Paused, or the one thing that keeps it from running, with why. */
function statusOf(a: Automation): { word: string; dot: string; note?: string } {
  const problems = problemsOf(a);
  const off = triggersOff(a);
  if (awaitingAllow(a))
    return {
      word: "Waiting for you",
      dot: "bg-warning",
      note: `An agent set this to run on a Cloud computer of its own, so it runs with this Mac closed. It spends computer time and credits, so it starts once you allow it.${a.last_error ? ` It could not start last time: ${a.last_error}` : ""}`,
    };
  if (problems.errors > 0) return { word: countsWord({ errors: problems.errors, warnings: 0 }), dot: "bg-destructive", note: "Its file has errors, so nothing starts it. Open settings to fix them." };
  if (a.worktree) {
    return { word: "Draft", dot: "bg-warning", note: `${draftWhy(a)}${a.scope === "project" && isCloud(a) ? " Merging also deploys it to Cloud." : ""}` };
  }
  if (!a.enabled) return { word: "Paused", dot: "bg-muted-foreground" };
  if (off && offMain(a)) return { word: off.label, dot: "bg-warning", note: `Not on ${defaultBranch(a)} yet, so its triggers wait. Run now still works.` };
  if (off) return { word: off.label, dot: "bg-warning", note: off.reason };
  return { word: "Active", dot: "bg-success" };
}

function Rail({ automation: a, shown }: { automation: Automation; shown: string | null }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const project = projects.find((p) => p.id === a.project_id);
  const explain = useExplain(a.id);
  const status = statusOf(a);
  const steps = a.steps ?? [];
  const budget = budgetUsd(explain.value?.explanation);
  const now = Date.now();
  return (
    <div className="pb-8">
      <RailSection title="Status" className="pt-4">
        <RailRow label="Status">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
          {status.word}
        </RailRow>
        <RailRow label="Next run">{a.enabled && a.next_run_at ? nextRunWord(new Date(a.next_run_at), scheduleZoneOf(a.trigger)).replace(/^Next run /, "") : <Dash />}</RailRow>
        <RailRow label="Last ran" title={a.last_run_at ? new Date(a.last_run_at).toLocaleString() : undefined}>
          {a.last_run_at ? ago(a.last_run_at, now) : <Dash />}
        </RailRow>
        {status.note ? <StatusNote automation={a} note={status.note} /> : null}
      </RailSection>

      <RailSection title="Details">
        <RailRow label="Project">
          <ProjectBadge github={project?.repository?.host === "github.com"} size={13} />
          <span className="truncate">{project?.name ?? "Missing project"}</span>
        </RailRow>
        <RailRow label="Repeats">
          <span className="text-balance">{triggerText(a.trigger)}</span>
        </RailRow>
        {isLegacy(a) ? null : <RailRow label="Model">{steps.length > 1 ? `${steps.length} steps` : modelWord(steps[0]?.model)}</RailRow>}
        <RailRow label="Runs on">{whereOf(a) === "this_mac" ? THIS_COMPUTER : WHERE_WORD[whereOf(a)]}</RailRow>
        {a.workspace_id ? <ChatRow workspaceId={a.workspace_id} /> : null}
        <RailRow label="Whose">{isLegacy(a) ? "Saved in the app" : a.scope === "project" ? "Everyone on the repo" : "Just me"}</RailRow>
        {budget !== undefined ? <RailRow label="Budget">{budgetWord(budget)} a run</RailRow> : null}
        <Button asChild variant="secondary" className="mt-3 w-full">
          <Link to={settingsPath(a.id)}>
            <Glyph name="settings" className="size-3.5" />
            Open settings
          </Link>
        </Button>
      </RailSection>

      <PreviousRuns automation={a} shown={shown} />
    </div>
  );
}

const Dash = () => <span className="text-[hsl(var(--subtle-foreground))]">—</span>;

/** The chat an agent's schedule reports to: each run wakes it. */
function ChatRow({ workspaceId }: { workspaceId: string }) {
  const title = useRuntimeSelector((v) => v.workspaces.find((w) => w.id === workspaceId)?.title);
  return (
    <RailRow label="Reports to">
      <Link to={chatPath(workspaceId)} className="truncate underline-offset-2 hover:text-foreground hover:underline">
        {title ?? "Its chat"}
      </Link>
    </RailRow>
  );
}

/** Why it isn't running, under its status, with the one thing that fixes it. */
function StatusNote({ automation: a, note }: { automation: Automation; note: string }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const pr = offMain(a) && problemsOf(a).errors === 0;
  return (
    <div className="mt-2 rounded-lg bg-foreground/[0.04] px-3 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
      {note}
      {pr ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => (setBusy(true), void actions.openPr(a).finally(() => setBusy(false)))}
          className="mt-1.5 block rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy ? "Opening the pull request…" : "Open a pull request"}
        </button>
      ) : null}
    </div>
  );
}

const RUNS_SHOWN = 8;

/** Every run, newest first: the one shown is lit; a Cloud run opens in the console. */
function PreviousRuns({ automation: a, shown }: { automation: Automation; shown: string | null }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const repo = projects.find((p) => p.id === a.project_id)?.repository?.full_name;
  const base = useConsoleBase();
  const ref = fileRef(a.id);
  const runs = useRuns(ref, (a.runs_running ?? 0) > 0);
  const onCloud = isCloud(a);
  const cloud = useCloudRuns({ on: onCloud });
  const cloudId = useCloudIdOf(a);
  const cloudRuns = onCloud && cloud.value ? cloudRunsOf(cloud.value, repo, ref?.name ?? a.title, cloudId) : [];
  const rows = runs.value ? mergeRuns(runs.value, cloudRuns, base) : undefined;
  const [all, setAll] = useState(false);
  const now = Date.now();
  if (!ref) return null;
  const list = rows ? (all ? rows : rows.slice(0, RUNS_SHOWN)) : undefined;
  const row = "-mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  return (
    <RailSection title="Previous runs">
      {runs.error && !rows ? (
        <p className="text-[12.5px] text-destructive">{runs.error}</p>
      ) : list === undefined ? (
        <div aria-hidden className="flex flex-col gap-2.5 pt-1">
          {[70, 55, 62].map((w) => (
            <span key={w} className="block h-3 rounded bg-foreground/[0.05]" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="flex flex-col">
          {list.map((r) => {
            const cells = (
              <>
                <StateGlyph status={r.status} />
                <span className={cn("min-w-0 flex-1 truncate", r.status === "failed" ? "text-destructive" : "text-foreground")}>{r.label ?? runWho({ automation: a.title, trigger: r.trigger })}</span>
                {r.where === "cloud" ? <Glyph name="computer-cloud" label="On Cloud" className="size-3.5 text-muted-foreground" /> : null}
                <span className="shrink-0 tabular-nums text-muted-foreground" title={new Date(r.started_at).toLocaleString()}>
                  {ago(r.started_at, now)}
                </span>
              </>
            );
            if (r.where === "this_mac") {
              const on = r.run_id === shown;
              return (
                <Link key={r.run_id} to={runPath(a.id, r.run_id)} aria-current={on ? "true" : undefined} className={cn(row, on ? "bg-accent" : "hover:bg-accent/60")}>
                  {cells}
                </Link>
              );
            }
            return r.console ? (
              <a key={r.run_id} href={r.console} target="_blank" rel="noreferrer" title="Opens its session in Cloud's console" className={cn(row, "hover:bg-accent/60")}>
                {cells}
              </a>
            ) : (
              <div key={r.run_id} className={row}>
                {cells}
              </div>
            );
          })}
          {rows && rows.length > RUNS_SHOWN ? (
            <button type="button" onClick={() => setAll((x) => !x)} className="mt-1 self-start rounded text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          ) : null}
        </div>
      )}
    </RailSection>
  );
}

// ------------------------------------------------------------ settings

type Tab = "settings" | "file" | "deliveries";

export function SettingsPage({ id }: { id: string }) {
  const { automation: a, loading, error } = useAutomation(id);
  if (!a) {
    return (
      <Page bar={<Bar crumbs={[HOME, { label: "Settings" }]} />}>
        <Pane>{loading ? null : <SurfaceEmpty icon={FlashIcon} title={error ?? "This automation isn't here any more."} className="pt-24" />}</Pane>
      </Page>
    );
  }
  return isLegacy(a) ? (
    <Page bar={<Bar crumbs={[HOME, { label: a.title, to: detailPath(a.id) }, { label: "Settings" }]} />}>
      <Pane>
        <LegacyBody automation={a} />
      </Pane>
    </Page>
  ) : (
    <FileSettings key={a.id} automation={a} />
  );
}

/** The one line under the name, edited where it is: it wraps like the text it is, and Enter is done. */
export function LineField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && (e.preventDefault(), e.currentTarget.blur())}
      placeholder={placeholder}
      aria-label="What it does"
      className="-mx-1.5 mt-0.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-md bg-transparent px-1.5 py-0.5 text-[14px] leading-[22px] text-muted-foreground outline-none transition-colors duration-75 placeholder:text-[hsl(var(--subtle-foreground))] hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] focus-visible:text-foreground"
    />
  );
}

/** Pill tabs, the app's own (Plugins'), as a tablist. */
function Tabs({ tabs, value, onChange }: { tabs: ReadonlyArray<{ id: Tab; label: string; count?: ReactNode }>; value: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav role="tablist" aria-label="Settings" className="mt-6 flex items-center gap-1 border-b border-border/70 pb-3">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            value === t.id && "bg-secondary text-foreground",
          )}
        >
          {t.label}
          {t.count !== null && t.count !== undefined ? <span className="text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">{t.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function FileSettings({ automation: a }: { automation: Automation }) {
  const client = useRuntimeSelector((v) => v.client);
  const actions = useActions();
  const [params, setParams] = useSearchParams();
  const path = a.path!;
  const buffer = useFileBuffer(checkoutOf(a), path, {
    label: a.title,
    write: async (text) => {
      await client!.call("automation.file_write", { request_id: requestId(), project_id: checkoutOf(a), path, text });
      patch<string>(fileKey(checkoutOf(a), path), () => text);
      refresh(client, LIST);
      refresh(client, `explain:${a.id}`);
      say(`Saved ${path}.`);
    },
  });
  // The File tab's own unsaved edits: it stays open under the other tabs until they are saved or dropped.
  const [fileDirty, setFileDirty] = useState(false);
  const text = buffer.text;
  const explain = useExplain(a.id);
  const check = useLiveCheck(checkoutOf(a), path, text ?? "", buffer.dirty);
  const hasDeliveries = triggerKinds(a).some((k) => k === "github" || k === "webhook");
  const problems = problemsOf(a);

  const tabs: ReadonlyArray<{ id: Tab; label: string; count?: ReactNode }> = [
    { id: "settings", label: "Settings" },
    {
      id: "file",
      label: "File",
      count: fileDirty ? (
        <span role="img" aria-label="not saved" title="Not saved" className="block size-1.5 rounded-full bg-warning" />
      ) : problems.errors + problems.warnings > 0 ? (
        <span className="flex items-center gap-1" title={countsWord(problems)}>
          {problems.errors > 0 ? <span className="text-destructive">{problems.errors}</span> : null}
          {problems.warnings > 0 ? <span className="text-warning">{problems.warnings}</span> : null}
        </span>
      ) : null,
    },
    ...(hasDeliveries ? [{ id: "deliveries" as const, label: "Deliveries" }] : []),
  ];
  const wanted = params.get("tab");
  const tab: Tab = tabs.some((t) => t.id === wanted) ? (wanted as Tab) : "settings";
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === "settings") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  };

  const save = buffer.save;
  const saving = buffer.saving;
  useSaveKey(tab !== "file", () => void save());
  const guard = useLeaveGuard(buffer.dirty || fileDirty);
  const form = text !== undefined ? readForm(text) : null;
  const off = triggersOff(a);

  return (
    <Page
      bar={
        <Bar
          crumbs={[HOME, { label: a.title, to: detailPath(a.id) }, { label: "Settings" }]}
          actions={
            <>
              {isCloud(a) ? <DeployButton automation={a} /> : null}
              <Button variant="secondary" onClick={() => void save()} disabled={!buffer.dirty || saving} title={buffer.dirty ? `Save (${keysText("⌘S", "mod+s")})` : "Nothing to save"}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <RunNow automation={a} actions={actions} beforeRun={buffer.dirty ? save : undefined} />
            </>
          }
        />
      }
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">{a.title}</h1>
        {form && "form" in form ? (
          <LineField value={form.form.description} onChange={(v) => buffer.set(setDescription(text!, v))} placeholder="Say what it does in one line" />
        ) : (
          <p className="mt-1 text-[14px] leading-[22px] text-muted-foreground">{a.description ?? path}</p>
        )}
        {buffer.changedOnDisk ? <ChangedOnDisk onLoad={buffer.discard} /> : null}
        {off && offMain(a) ? <Note>Not on {defaultBranch(a)}, so its triggers are off. Runs by hand still work; merge the file to turn them on.</Note> : off ? <Note>{off.reason}</Note> : null}
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <div className="pt-7">
          {tab === "settings" ? (
            fileDirty ? (
              <Unsaved what="The File tab" onOpen={() => setTab("file")} />
            ) : text === undefined ? (
              buffer.error ? (
                <p className="text-[13px] text-destructive">Couldn't read {path}: {buffer.error}</p>
              ) : (
                <FormSkeleton />
              )
            ) : (
              <SettingsForm
                text={text}
                onText={buffer.set}
                explanation={explain.value?.explanation}
                nextRunAt={buffer.dirty ? null : a.next_run_at}
                scope={a.scope ?? "project"}
                problems={check.problems}
                onOpenFile={() => setTab("file")}
                lead={isCloud(a) ? <CloudPanel automation={a} /> : null}
              />
            )
          ) : tab === "file" && buffer.dirty ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card py-3 pl-4 pr-3 text-[13px]">
              <WarnDot />
              <span className="min-w-0 flex-1 text-foreground">
                Settings has changes that aren't saved. <span className="text-muted-foreground">Save or drop them to edit the file itself.</span>
              </span>
              <Button size="sm" variant="ghost" onClick={buffer.discard}>
                Drop them
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                Save
              </Button>
            </div>
          ) : tab === "deliveries" ? (
            <Deliveries automation={a} />
          ) : null}
          {/* Mounted while it is open, and after, while it holds edits, so another tab never drops them. */}
          {(tab === "file" && !buffer.dirty) || fileDirty ? (
            <div hidden={tab !== "file"}>
              <FileTab key={a.id} automation={a} explanation={explain.value?.explanation} onDirty={setFileDirty} />
            </div>
          ) : null}
        </div>
        {guard}
      </Pane>
    </Page>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] leading-5 text-foreground">
      <WarnDot className="mt-[7px]" />
      <span>{children}</span>
    </p>
  );
}

/** A tab whose form waits on unsaved edits elsewhere on the page. */
function Unsaved({ what, onOpen }: { what: string; onOpen: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card py-3 pl-4 pr-3 text-[13px]">
      <WarnDot />
      <span className="min-w-0 flex-1 text-foreground">
        {what} has changes that aren't saved. <span className="text-muted-foreground">Save or drop them there to use this form.</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onOpen}>
        Open it
      </Button>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-10">
      {[120, 220, 180].map((h, i) => (
        <div key={i}>
          <span className="block h-3.5 w-24 rounded bg-foreground/[0.07]" />
          <span className="mt-3 block rounded-xl border border-border bg-card" style={{ height: h }} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ deliveries

const TONE_GLYPH = { admitted: "state-done", refused: "state-failed", ignored: "state-sleeping" } as const;

function Deliveries({ automation: a }: { automation: Automation }) {
  const deliveries = useDeliveries(a.id);
  const projects = useRuntimeSelector((v) => v.projects);
  const ownRepo = projects.find((p) => p.id === a.project_id)?.repository?.full_name;
  const now = Date.now();
  if (deliveries.error && !deliveries.value) return <p className="text-[13px] text-destructive">{deliveries.error}</p>;
  const list = deliveries.value?.map((d) => ({ d, v: deliveryView(d) }));
  const started = list?.filter(({ v }) => v.tone === "admitted").length ?? 0;
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted-foreground">
        {list === undefined ? " " : list.length === 0 ? "Nothing has arrived yet." : `${list.length} ${list.length === 1 ? "event" : "events"} arrived; ${started} started a run.`}{" "}
        {triggerKinds(a).includes("github") ? "Caveman Code polls GitHub about once a minute, so an event shows here within a minute of happening." : ""}
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {list === undefined ? (
          <div aria-hidden className="flex flex-col gap-3 px-4 py-3">
            {[70, 58, 46, 34].map((w) => (
              <span key={w} className="block h-3 rounded bg-foreground/[0.06]" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">Events show here as they arrive, with what happened to each.</p>
        ) : (
          list.map(({ d, v }) => {
            const about = [v.subject ? (v.subject.repo && v.subject.repo !== ownRepo ? `${v.subject.repo} ${v.subject.label}` : v.subject.label) : null, v.subject?.title, v.event].filter(Boolean).join(" · ");
            return (
              <div key={d.id} className="grid grid-cols-[20px_minmax(0,1fr)_auto_84px] items-start gap-x-3 border-t border-border/60 px-4 py-2.5 first:border-t-0">
                <Glyph name={TONE_GLYPH[v.tone]} label={v.tone} className={cn("mt-0.5", v.tone === "ignored" && "opacity-60")} />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={cn("shrink-0 text-[13px]", v.tone === "refused" ? "text-destructive" : v.tone === "admitted" ? "text-foreground" : "text-muted-foreground")}>{v.words}</span>
                    {about ? <span className="truncate text-[12.5px] text-muted-foreground">{about}</span> : null}
                  </span>
                  {v.detail && v.detail !== v.words ? <span className="mt-0.5 block text-[12.5px] leading-[18px] text-muted-foreground">{v.detail}</span> : null}
                </span>
                <span className="pt-px">
                  {v.runId ? (
                    <Link to={runPath(a.id, v.runId)} className="inline-flex items-center gap-0.5 rounded px-1 text-[12.5px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                      Open run
                      <Icon icon={ArrowRight01Icon} className="size-3" strokeWidth={2} />
                    </Link>
                  ) : null}
                </span>
                <span className="pt-px text-right text-[12.5px] tabular-nums text-muted-foreground" title={new Date(d.received_at).toLocaleString()}>
                  {ago(d.received_at, now)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ an app-saved automation

function LegacyBody({ automation: a }: { automation: Automation }) {
  const actions = useActions();
  const client = useRuntimeSelector((v) => v.client);
  const hook = a.trigger.type === "webhook" ? a.trigger : null;
  const url = hook ? (hook.url ?? hook.path) : null;
  const rotate = async () => {
    try {
      await client?.call("automation.rotate_url", { request_id: requestId(), id: a.id });
      refresh(client, LIST);
      say("New URL made. The old one stopped working.");
    } catch (e) {
      say(`Couldn't make a new URL: ${message(e)}`, "error");
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">{a.title}</h1>
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-[12.5px] text-muted-foreground">
          <Glyph name="artifact-markdown" className="size-3.5" />
          Its prompt, run as a new chat each time
        </div>
        <p className="whitespace-pre-wrap px-4 py-3 text-[14px] leading-[22px] text-foreground">{a.prompt}</p>
      </div>
      {hook && url ? (
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
          <p className="text-muted-foreground">POST to this URL to start a run{hook.url ? "" : ". It works for callers that reach this computer; there is no public URL yet"}.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/[0.05] px-2 py-1 font-mono text-[12px] text-foreground ring-1 ring-inset ring-foreground/[0.07]">{url}</code>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(url).then(() => say("Copied."))}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void rotate()} title="A new secret token in the URL; the old one stops working at once">
              New URL
            </Button>
          </div>
        </div>
      ) : null}
      {hook ? <WebhookRules automation={a} hook={hook} /> : null}
      {hook ? (
        <section>
          <SectionHeader as="h2" className="px-0">
            Recent requests
          </SectionHeader>
          <Deliveries automation={a} />
        </section>
      ) : null}
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3">
        <span className="min-w-0 flex-1 text-[13px]">
          <span className="block text-foreground">Saved in the app, before automations were files</span>
          <span className="block text-muted-foreground">
            {legacyCanBeFile(a)
              ? "As a file it gets steps, checks, a budget and runs of its own. The app's copy turns off, and nothing is deleted."
              : "Webhook files don't run in Caveman Code yet, so this one stays in the app for now."}
          </span>
        </span>
        {legacyCanBeFile(a) ? (
          <Button size="sm" onClick={() => void actions.saveAsFile(a)}>
            Save as file
          </Button>
        ) : null}
      </div>
    </div>
  );
}
