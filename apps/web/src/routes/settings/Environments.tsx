// Settings > Environments: each GitHub project's Cloud environment, what its chats in Cloud start from, set up
// once for the organization (docs/), and below them the organization's other
// environments, teammates' included (environment.list). Set up repos picks repos the way Codex's Create a cloud
// environment does and sets each up now: a project here with environment.setup, a repo only on GitHub with
// environment.setup_repo (drafted from its manifests, no clone, no project). Details is the Computer tab's own panel
// (EnvironmentPanel): status, the fix to review, the computer.toml, versions, values and builds. A row says when a
// setup chat's fix waits for review or an agent proposed a change. docs/
// A list page (sections.ts `wide`): it fills the pane, rows on hairlines and no box. It stays a page of its own, not a
// line on each project's row in Settings > Projects: it also lists the organization's repositories that are no
// project here, one project can hold several repositories, and Details is a panel the chat's Computer tab shares.
import type { EnvironmentSummary, Project, ProjectCandidate } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import { clickOrigin } from "@caveman-app/ui/components/dialog";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { cn } from "@caveman-app/ui/lib/cn";
import { modalMotion, overlayMotion } from "@caveman-app/ui/motion";
import { Switch } from "@caveman-app/ui/components/switch";
import * as Dialog from "@radix-ui/react-dialog";
import { Icon, Search01Icon } from "@caveman-app/ui/icons/huge";
import { useMemo, useState, type ReactNode } from "react";
import { EnvironmentPanel } from "../../components/environment/EnvironmentPanel.tsx";
import { Dot, ProposalCard } from "../../components/environment/parts.tsx";
import { useDiscovered } from "../../components/ProjectPicker.tsx";
import { thisComputer } from "../../lib/platform.ts";
import { environmentLine, summaryLine, useEnvironmentList, useEnvironments, type EnvironmentAnswer, type Tone } from "../../state/environment.ts";
import { CLOUD_HOSTED, requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";

const onGitHub = (p: Project) => p.repository?.host === "github.com";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Nobody set it up and nothing is building: what Set up and the picker offer. */
const unset = (answer: EnvironmentAnswer | undefined) => answer?.environment?.state === "not_set_up" && answer.environment.build === null;

export function EnvironmentsSettings() {
  const projects = useRuntimeSelector((v) => v.projects);
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const github = useMemo(() => projects.filter(onGitHub), [projects]);
  const ids = useMemo(() => github.map((p) => p.id), [github]);
  const { answers, reload } = useEnvironments(ids);
  const { list, reload: reloadList } = useEnvironmentList();
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Signed out, on a Cloud computer, a Cloud without environments: every repo's answer says the same.
  const unavailable = [...answers.values()].find((a) => !a.available)?.reason ?? (github.length === 0 && list && !list.available ? list.reason : undefined);
  // The organization's environments with no project here: teammates' repos, and ones set up from GitHub only.
  const others = useMemo(() => (list?.available ? list.environments.filter((e) => e.project_id === undefined) : []), [list]);
  return (
    <div className="flex flex-col gap-10">
      <SettingsCard
        title="Each GitHub repository is set up once for your organization. Every chat in Cloud on it starts from that setup."
        actions={
          unavailable ? null : (
            <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
              Set up repositories
            </Button>
          )
        }
      >
        {unavailable ? (
          <Line>{unavailable}</Line>
        ) : github.length === 0 && others.length === 0 ? (
          <Line>No GitHub projects yet. Set up repositories lists yours.</Line>
        ) : (
          <>
            {github.map((p) => (
              <EnvironmentRow key={p.id} project={p} answer={answers.get(p.id)} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} reload={() => reload(p.id)} />
            ))}
            {others.length > 0 ? (
              <>
                <p className="pb-1 pt-3 text-[12px] text-muted-foreground">Your organization's other repositories</p>
                {others.map((e) => (
                  <OrgRow key={`${e.repo}@${e.branch}`} environment={e} />
                ))}
              </>
            ) : null}
          </>
        )}
      </SettingsCard>
      {!CLOUD_HOSTED ? (
        <SettingsCard>
          <SettingRow id="cloud-prepare" label="Set up repositories for Cloud in the background" description={`Drafted from the repository, its CI and ${thisComputer}. It reads tool versions and variable names, never values.`}>
            <Switch id="cloud-prepare" disabled={!settings} checked={settings?.cloud_prepare !== false} onCheckedChange={(on) => void save({ cloud_prepare: on })} />
          </SettingRow>
          <SettingRow id="cloud-auto-fix" label="Fix a failed setup with a setup chat" description="It starts by itself and tries fixes. Nothing changes until you publish its fix.">
            <Switch id="cloud-auto-fix" disabled={!settings} checked={settings?.cloud_auto_fix !== false} onCheckedChange={(on) => void save({ cloud_auto_fix: on })} />
          </SettingRow>
        </SettingsCard>
      ) : null}
      {picking ? (
        <SetUpRepos
          github={github}
          answers={answers}
          listed={list?.available ? list.environments : []}
          onClose={() => {
            setPicking(false);
            void reloadList();
          }}
          onStarted={(id) => (id ? void reload(id) : void reloadList())}
        />
      ) : null}
    </div>
  );
}

function EnvironmentRow({ project, answer, open, onToggle, reload }: { project: Project; answer: EnvironmentAnswer | undefined; open: boolean; onToggle: () => void; reload: () => Promise<void> }) {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const line = environmentLine(answer ?? null);
  const reviewing = answer?.setup_chat?.state === "review";
  const setUp = async () => {
    if (!client) return;
    setBusy(true);
    setProblem(null);
    try {
      await client.call("environment.setup", { request_id: requestId(), project_id: project.id });
      await reload();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow label={project.repository!.full_name} description={<Status tone={line.tone}>{line.text}</Status>}>
        {unset(answer) ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void setUp()}>
            {busy ? "Setting up…" : "Set up"}
          </Button>
        ) : null}
        {answer?.environment ? (
          <Button size="sm" variant={reviewing && !open ? "secondary" : "ghost"} aria-expanded={open} onClick={onToggle}>
            {open ? "Hide" : reviewing ? "Review" : "Details"}
          </Button>
        ) : null}
      </SettingRow>
      {problem ? <Line tone="warn">{problem}</Line> : null}
      {!open && (answer?.proposals ?? []).length > 0 ? (
        <div className="flex flex-col gap-2.5 pb-3.5">
          {answer!.proposals!.map((p) => (
            <ProposalCard key={p.id} projectId={project.id} proposal={p} onDone={reload} flat />
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="flex h-[min(620px,70vh)] min-h-0 flex-col">
          <EnvironmentPanel projectId={project.id} onChange={() => void reload()} />
        </div>
      ) : null}
    </>
  );
}

/** One of the organization's environments with no project here: its state, who set it up. */
function OrgRow({ environment }: { environment: EnvironmentSummary }) {
  const line = summaryLine(environment);
  return (
    <SettingRow
      label={
        <span className="flex items-center gap-2">
          {environment.repo}
          {environment.branch && environment.branch !== "main" ? <span className="font-mono text-[11.5px] text-muted-foreground">{environment.branch}</span> : null}
        </span>
      }
      description={<Status tone={line.tone}>{line.text}</Status>}
    >
      {null}
    </SettingRow>
  );
}

interface Pickable {
  /** owner/name, lower-cased: one row per repository. */
  readonly key: string;
  readonly fullName: string;
  /** Already a project here. */
  readonly project?: Project;
  /** Only on GitHub: set up from its manifests (environment.setup_repo), with no clone and no project. */
  readonly candidate?: ProjectCandidate;
  /** Set up, or building: shown, not offered. */
  readonly taken?: { tone: Tone; text: string };
}

type Outcome = { tone: Tone; text: string };

/** Three at a time: a draft each, and Cloud builds an organization's repos five at a time. */
const AT_ONCE = 3;

/** Set up repos: Codex's Create a cloud environment, on our setup. Pick repos; each is set up now. */
function SetUpRepos({
  github,
  answers,
  listed,
  onClose,
  onStarted,
}: {
  github: ReadonlyArray<Project>;
  answers: ReadonlyMap<string, EnvironmentAnswer>;
  /** The organization's environments: a repo a teammate set up shows as set up. */
  listed: ReadonlyArray<EnvironmentSummary>;
  onClose: () => void;
  /** A project's setup started (its id), or a GitHub-only repo's (undefined). */
  onStarted: (projectId: string | undefined) => void;
}) {
  const { client } = useRuntimeClient();
  const { data } = useDiscovered();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [running, setRunning] = useState<"no" | "yes" | "done">("no");
  // Once Set up is pressed the rows keep their places, though their states change under them.
  const [frozen, setFrozen] = useState<ReadonlyMap<string, number> | null>(null);

  const rows = useMemo<Pickable[]>(() => {
    const out = new Map<string, Pickable>();
    for (const p of github) {
      const answer = answers.get(p.id);
      const fullName = p.repository!.full_name;
      out.set(fullName.toLowerCase(), { key: fullName.toLowerCase(), fullName, project: p, ...(answer && !unset(answer) ? { taken: environmentLine(answer) } : {}) });
    }
    const org = new Map(listed.map((e) => [e.repo.toLowerCase(), e]));
    for (const c of data?.candidates ?? []) {
      const fullName = c.repository?.host === "github.com" ? c.repository.full_name : undefined;
      if (!fullName || out.has(fullName.toLowerCase()) || c.path || c.project_id) continue;
      const known = org.get(fullName.toLowerCase());
      out.set(fullName.toLowerCase(), { key: fullName.toLowerCase(), fullName, candidate: c, ...(known && known.state !== "not_set_up" ? { taken: summaryLine(known) } : {}) });
    }
    // Projects not set up first, then the rest of GitHub, then what is set up already.
    const rank = (r: Pickable) => (frozen ? (frozen.get(r.key) ?? frozen.size) : r.taken ? 2 : r.project ? 0 : 1);
    return [...out.values()].sort((a, b) => rank(a) - rank(b) || a.fullName.localeCompare(b.fullName));
  }, [github, answers, listed, data, frozen]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.key.includes(q)) : rows;

  const toggle = (key: string, on: boolean) => setChosen((s) => (on ? new Set(s).add(key) : new Set([...s].filter((k) => k !== key))));
  const say = (key: string, outcome: Outcome) => setOutcomes((m) => new Map(m).set(key, outcome));

  const setUpOne = async (row: Pickable) => {
    if (!client) return;
    try {
      say(row.key, { tone: "busy", text: row.project ? "Drafting its setup…" : "Reading its manifests from GitHub…" });
      // A repo only on GitHub: drafted from a sparse checkout of its manifests, nothing cloned and no project added.
      const set = row.project
        ? await client.call("environment.setup", { request_id: requestId(), project_id: row.project.id })
        : await client.call("environment.setup_repo", { request_id: requestId(), repo: row.fullName });
      onStarted(row.project?.id);
      say(row.key, set.environment ? environmentLine({ environment: set.environment, available: true }) : { tone: "warn", text: "Not set up: Cloud didn't answer." });
    } catch (e) {
      say(row.key, { tone: "warn", text: message(e) });
    }
  };
  const start = async () => {
    setRunning("yes");
    setFrozen(new Map(rows.map((r, i) => [r.key, i])));
    const queue = rows.filter((r) => chosen.has(r.key));
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) await setUpOne(row);
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
    setRunning("done");
  };

  return (
    <Dialog.Root open onOpenChange={(o) => (!o && running !== "yes" ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-40 bg-black/50 ${overlayMotion}`} />
        <Dialog.Content
          ref={clickOrigin}
          className={`dashboard-scope fixed inset-x-0 top-[10vh] z-50 mx-auto flex max-h-[80vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-overlay outline-none ${modalMotion}`}
        >
          <div className="px-5 pb-3 pt-5">
            <Dialog.Title className="text-[15px] font-medium text-foreground">Set up repositories for Cloud</Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-5 text-muted-foreground">
              Caveman works out what each one installs, builds it once in Cloud and saves it for your organization. Chats in Cloud on it then start in seconds.
            </Dialog.Description>
          </div>
          <label className="mx-5 flex h-8 shrink-0 items-center gap-2 rounded-md border border-border px-2.5 focus-within:ring-2 focus-within:ring-ring">
            <Icon icon={Search01Icon} className="size-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search repositories"
              aria-label="Search repositories"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <ul className="mt-2 min-h-[120px] flex-1 overflow-y-auto px-3 pb-2" aria-label="Repositories">
            {shown.length === 0 ? (
              <li className="px-2 py-3 text-[13px] text-muted-foreground">{data ? (q ? "No repository matches." : "No GitHub repositories found. Add one as a project first.") : "Finding your repositories…"}</li>
            ) : (
              shown.map((r) => {
                const note = outcomes.get(r.key) ?? r.taken;
                const id = `pick-${r.key}`;
                return (
                  <li key={r.key} className="flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/60">
                    <Checkbox id={id} checked={r.taken ? true : chosen.has(r.key)} disabled={r.taken !== undefined || running !== "no"} onCheckedChange={(on) => toggle(r.key, on === true)} />
                    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] text-foreground">
                        <span className="text-muted-foreground">{r.fullName.split("/")[0]}/</span>
                        {r.fullName.split("/").slice(1).join("/")}
                      </span>
                      {note ? (
                        <Status tone={note.tone} small>
                          {note.text}
                        </Status>
                      ) : (
                        <span className="text-[12px] leading-4 text-muted-foreground">
                          {r.candidate ? `On GitHub · set up from its manifests, nothing cloned${r.candidate.private ? " · private" : ""}` : "A project here · not set up yet"}
                        </span>
                      )}
                    </label>
                    {r.candidate ? <BrandMark name="github" size={14} label="On GitHub" className="shrink-0 text-muted-foreground" /> : null}
                  </li>
                );
              })
            )}
          </ul>
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
            <span className="mr-auto text-[12.5px] tabular-nums text-muted-foreground">
              {running === "done" ? "Started. Builds carry on in Cloud." : chosen.size === 0 ? "None selected" : `${chosen.size} selected`}
            </span>
            {running === "done" ? (
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" disabled={running === "yes"} onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" disabled={chosen.size === 0 || running === "yes"} onClick={() => void start()}>
                  {running === "yes" ? "Setting up…" : "Set up"}
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Line({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <p role={tone ? "alert" : undefined} className={cn("py-3 text-[13px] text-muted-foreground", tone === "warn" && "text-warning")}>
      {children}
    </p>
  );
}

/** A status line led by its dot. */
function Status({ tone, small, children }: { tone: Tone; small?: boolean; children: ReactNode }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", small && "text-[12px] leading-4 text-muted-foreground")}>
      <Dot tone={tone} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
