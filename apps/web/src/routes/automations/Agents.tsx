// Agents (/automations/agents): every project's own agent files (`.caveman/agents/*.md`) in the list column, each with
// the version Caveman Cloud runs; one open on the right (/automations/agents/:projectId/:name) shows its engine, model
// and file, edited in place, with Publish. Nothing open: New agent, which opens a chat that writes one.
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { EngineLogo, shortModel } from "@caveman-app/ui/components/runner-badge";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, MoreHorizontalIcon, UserGroupIcon } from "@caveman-app/ui/icons/huge";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ProjectBadge, useLastProject } from "../../components/ProjectPicker.tsx";
import { keysText } from "../../panels/chrome.tsx";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeSelector } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard } from "../settings/rows.tsx";
import { say, useActions, useConsoleBase } from "./actions.tsx";
import { agentView, CONSOLE, consoleUrl, type AgentFileView, type PublishedAgent } from "./cloud.ts";
import { ConsoleLink } from "./CloudParts.tsx";
import { fileKey, patch, refresh, shaKey, useAgentFiles, useFileSha, usePublished, type AgentFile } from "./data.ts";
import { CodeEditor } from "./FileTab.tsx";
import { ChangedOnDisk, useFileBuffer, useLeaveGuard, useLiveCheck, useSaveKey } from "./Form.tsx";
import { Bar, Column, ColumnCard, ColumnEmpty, ColumnSkeleton, Page, Pane, PaneHeader } from "../../components/ListFrame.tsx";
import { Frame } from "./Frame.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** What the page knows of Cloud: reachable, not served by this runtime, or refused (signed out) with why. */
export type CloudReach = { readonly kind: "loading" } | { readonly kind: "ok"; readonly agents: ReadonlyArray<PublishedAgent> } | { readonly kind: "unavailable" } | { readonly kind: "error"; readonly message: string };

export const agentPath = (f: Pick<AgentFile, "project_id" | "name">) => `/automations/agents/${encodeURIComponent(f.project_id)}/${encodeURIComponent(f.name)}`;

function useCloudReach(): CloudReach {
  const published = usePublished();
  return published.value === null ? { kind: "unavailable" } : published.value ? { kind: "ok", agents: published.value } : published.error ? { kind: "error", message: published.error } : { kind: "loading" };
}

export function AgentsPage({ open }: { open: { projectId: string; name: string } | null }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const actions = useActions();
  const { project: last } = useLastProject({ inUrl: false });
  const files = useAgentFiles(projects.map((p) => p.id));
  const cloud = useCloudReach();
  const [query, setQuery] = useState("");
  const byName = new Map((cloud.kind === "ok" ? cloud.agents : []).map((a) => [a.name, a]));
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (files.value ? files.value.filter((f) => !q || `${f.name} ${f.description} ${f.model ?? ""}`.toLowerCase().includes(q)) : undefined), [files.value, q]);
  const current = open ? files.value?.find((f) => f.project_id === open.projectId && f.name === open.name) : undefined;
  return (
    <Frame
      section="agents"
      column={
        <Column query={query} onQuery={setQuery} placeholder="Filter agents" add={{ label: "New agent", to: "/automations/agents" }} label="Agents" busy={files.value === undefined}>
          <AgentsView
            files={shown}
            error={files.error ?? null}
            cloud={cloud}
            card={(f, published) => <AgentCard key={`${f.project_id}:${f.path}`} file={f} published={published} cloud={cloud} selected={f === current} />}
            byName={byName}
          />
        </Column>
      }
    >
      <Page bar={<Bar crumbs={[{ label: "Agents", to: "/automations/agents" }, ...(open ? [{ label: open.name }] : [])]} />}>
      {open ? (
        current ? (
          <AgentPane key={`${current.project_id}:${current.name}`} file={current} published={byName.get(current.name)} cloud={cloud} />
        ) : files.value === undefined ? null : (
          <Pane>
            <p className="pt-16 text-center text-[14px] text-foreground">This agent isn't here any more.</p>
          </Pane>
        )
      ) : (
        <NewAgent cloud={cloud} onNew={() => actions.describeAgent(last?.id ?? null)} />
      )}
      </Page>
    </Frame>
  );
}

export interface AgentsViewProps {
  /** undefined: still reading. */
  readonly files: ReadonlyArray<AgentFile> | undefined;
  readonly error: string | null;
  readonly cloud: CloudReach;
  readonly byName: ReadonlyMap<string, PublishedAgent>;
  /** One file's card, given its published copy. */
  readonly card: (file: AgentFile, published: PublishedAgent | undefined) => ReactNode;
}

/** The column's body: loading, an error, none yet, or the cards, with a line when Cloud can't take a publish. */
export function AgentsView({ files, error, cloud, byName, card }: AgentsViewProps) {
  return (
    <>
      {error && files === undefined ? (
        <ColumnEmpty title="Couldn't read the agent files">{error}</ColumnEmpty>
      ) : files === undefined ? (
        <ColumnSkeleton />
      ) : files.length === 0 ? (
        <ColumnEmpty icon={UserGroupIcon} title="No agents yet">An agent is one Markdown file in .caveman/agents. Describe one on the right and Caveman writes it.</ColumnEmpty>
      ) : (
        files.map((f) => card(f, byName.get(f.name)))
      )}
      <CloudLine cloud={cloud} />
    </>
  );
}

/** Whether publishing works from here, in one quiet line under the cards. */
function CloudLine({ cloud }: { cloud: CloudReach }) {
  if (cloud.kind === "unavailable") return <p className="px-3 pt-4 text-[12px] leading-[17px] text-muted-foreground">This version of Caveman Code can't publish to Cloud yet. Update it to publish from here.</p>;
  if (cloud.kind === "error")
    return (
      <p className="px-3 pt-4 text-[12px] leading-[17px] text-muted-foreground">
        <span className="text-foreground">Cloud didn't answer:</span> {cloud.message}{" "}
        <Link to="/settings/account" className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Account settings
        </Link>
      </p>
    );
  return null;
}

/** The version Cloud runs, in words and a mark: "v3", "v3, changed here", "Not published". */
function CloudState({ view, cloud }: { view: AgentFileView | null; cloud: CloudReach }) {
  if (cloud.kind === "loading" || (cloud.kind === "ok" && view === null)) return <span aria-hidden className="h-3 w-12 rounded bg-foreground/[0.05]" />;
  if (cloud.kind !== "ok" || !view) return null;
  return (
    <span className={cn("flex items-center gap-1.5 tabular-nums", view.tone === "none" ? "text-muted-foreground" : view.tone === "changed" ? "text-warning" : "text-foreground")}>
      {view.tone === "none" ? null : <Glyph name="computer-cloud" className="size-3.5" />}
      {view.label}
    </span>
  );
}

export interface AgentCardProps {
  readonly file: AgentFile;
  readonly projectName: string | undefined;
  readonly projectGithub?: boolean | undefined;
  readonly view: AgentFileView | null;
  readonly cloud: CloudReach;
  readonly selected: boolean;
  /** The engine's name as the app shows it ("Claude Agent"); its id when the runtime doesn't list it. */
  readonly engineLabel?: string | undefined;
}

/** One agent file in the column: its engine and model, its name, its project and the version Cloud runs. */
export function AgentCardView({ file: f, projectName, projectGithub = false, view, cloud, selected, engineLabel }: AgentCardProps) {
  const model = f.model ? shortModel(undefined, f.model) || f.model : null;
  return (
    <ColumnCard
      to={agentPath(f)}
      selected={selected}
      top={
        <>
          <EngineLogo engine={f.engine ?? "caveman"} label={f.engine ?? "caveman"} />
          <span className="truncate">{[engineLabel ?? f.engine ?? "Caveman", model].filter(Boolean).join(" · ")}</span>
        </>
      }
      title={f.name}
      bottom={
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <ProjectBadge github={projectGithub} size={12} />
            <span className="truncate">{projectName ?? "Missing project"}</span>
          </span>
          <span className="ml-auto shrink-0">
            <CloudState view={view} cloud={cloud} />
          </span>
        </>
      }
    />
  );
}

/** Whether Cloud has this exact file: a published one waits for the file's sha256 before it says changed or up to date. */
function useAgentView(f: AgentFile, published: PublishedAgent | undefined, cloud: CloudReach): AgentFileView | null {
  const sha = useFileSha(f.project_id, cloud.kind === "ok" && published ? f.path : undefined);
  return cloud.kind !== "ok" ? null : !published ? agentView(null, undefined) : sha.value !== undefined || sha.error ? agentView(sha.value ?? null, published) : null;
}

function AgentCard({ file: f, published, cloud, selected }: { file: AgentFile; published: PublishedAgent | undefined; cloud: CloudReach; selected: boolean }) {
  const project = useRuntimeSelector((v) => v.projects.find((p) => p.id === f.project_id));
  const engineLabel = useRuntimeSelector((v) => v.engines.find((e) => e.id === (f.engine ?? "caveman"))?.label);
  return <AgentCardView file={f} projectName={project?.name} projectGithub={project?.repository?.host === "github.com"} view={useAgentView(f, published, cloud)} cloud={cloud} selected={selected} engineLabel={engineLabel} />;
}

/** Publish, as the version it would make: "Publish", "Publish v4"; "Up to date" when Cloud has this exact file. */
export function PublishView({ view, cloud, busy, onPublish }: { view: AgentFileView | null; cloud: CloudReach; busy: boolean; onPublish: () => void }) {
  if (cloud.kind !== "ok" || !view) return null;
  if (!view.action) return <span className="px-1 text-[13px] text-muted-foreground">Up to date</span>;
  return (
    <Button variant={view.tone === "changed" ? "default" : "secondary"} disabled={busy} onClick={onPublish} title="Send this file to Cloud as the agent's newest version">
      <Glyph name="computer-cloud" className="size-3.5" />
      {busy ? "Publishing…" : view.action}
    </Button>
  );
}

// ------------------------------------------------------------ one agent

function AgentPane({ file: f, published, cloud }: { file: AgentFile; published: PublishedAgent | undefined; cloud: CloudReach }) {
  const client = useRuntimeSelector((v) => v.client);
  const actions = useActions();
  const base = useConsoleBase();
  const view = useAgentView(f, published, cloud);
  const path = f.path!;
  const file = useFileBuffer(f.project_id, path, {
    label: f.name,
    write: async (text) => {
      await client!.call("automation.file_write", { request_id: requestId(), project_id: f.project_id, path, text });
      patch<string>(fileKey(f.project_id, path), () => text);
      refresh(client, "agent-files:");
      refresh(client, shaKey(f.project_id, path));
      say(`Saved ${path}.`);
    },
  });
  const check = useLiveCheck(f.project_id, path, file.text ?? "", file.dirty);
  const [publishing, setPublishing] = useState(false);
  const consoleHref = published ? consoleUrl(base, CONSOLE.agent(published.id)) : null;
  const model = f.model ? shortModel(undefined, f.model) || f.model : "The engine's default";
  const publish = async () => {
    setPublishing(true);
    // Cloud gets the file as it is on disk: unsaved edits are saved first.
    if (await file.save()) await actions.publish(f.project_id, path, f.name);
    setPublishing(false);
  };
  // The code editor saves on its own ⌘S; anywhere else on the page, this one does.
  useSaveKey(true, () => void file.save());
  const guard = useLeaveGuard(file.dirty, f.name);

  return (
    <Pane>
      <header>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[20px] font-semibold leading-8 tracking-[-0.01em] text-foreground">{f.name}</h1>
            <p className="mt-0.5 text-[13.5px] leading-[21px] text-muted-foreground">{f.description || "No description yet: say what it does on the file's description line."}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PublishView view={view} cloud={cloud} busy={publishing} onPublish={() => void publish()} />
            <Button variant={view?.tone === "changed" ? "secondary" : "default"} onClick={() => void file.save()} disabled={!file.dirty || file.saving} title={file.dirty ? `Save (${keysText("⌘S", "mod+s")})` : "Nothing to save"}>
              {file.saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <AgentProject projectId={f.project_id} />
          <span aria-hidden className="h-4 w-px bg-border" />
          <span className="flex items-center gap-1.5 text-foreground">
            <EngineLogo engine={f.engine ?? "caveman"} label={f.engine ?? "caveman"} />
            {model}
          </span>
          <span aria-hidden className="h-4 w-px bg-border" />
          <span className="font-mono text-[12.5px]">{path}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${f.name}`}>
                <Icon icon={MoreHorizontalIcon} className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px]">
              {consoleHref ? (
                <DropdownMenuItem onSelect={() => openExternal(consoleHref)}>
                  <Glyph name="computer-cloud" />
                  Open in Platform
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(path)}>
                <Glyph name="artifact-link" />
                Copy path
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {file.changedOnDisk ? <ChangedOnDisk onLoad={file.discard} /> : null}

      <div className="mt-7 flex flex-col gap-10 border-t border-border/70 pt-7">
        <SettingsCard title="On Cloud" description="Steps and chats use the file here. Publish it, and Cloud runs that version on its own computers.">
          <SettingRow label="Version Cloud runs" description={view?.tone === "changed" ? "The file changed since. Publish to send the new one." : view?.tone === "none" ? "Not on Cloud yet." : cloud.kind === "ok" ? "The same file as here." : "Cloud isn't reachable from here."}>
            <CloudState view={view} cloud={cloud} />
            {consoleHref ? <ConsoleLink href={consoleHref}>Open in Platform</ConsoleLink> : null}
          </SettingRow>
          {f.decides && f.decides.length > 0 ? (
            <SettingRow label="Decides" description="The words its last line may end with; steps after it run on them.">
              <span className="font-mono text-[12.5px] text-foreground">{f.decides.join(" or ")}</span>
            </SettingRow>
          ) : null}
        </SettingsCard>

        <section className="flex flex-col gap-3" aria-label="The file">
          <header className="flex items-end justify-between gap-4">
            <div>
              <h3 className="text-[14px] font-medium">The file</h3>
              <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">Its engine and model at the top, then its instructions. Check runs as you type.</p>
            </div>
            {check.problems.length > 0 ? (
              <span className={cn("shrink-0 text-[12.5px]", check.problems.some((d) => d.severity === "error") ? "text-destructive" : "text-warning")}>
                {check.problems.length} {check.problems.length === 1 ? "problem" : "problems"}
              </span>
            ) : null}
          </header>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {file.text !== undefined ? (
              <CodeEditor path={path} value={file.text} onChange={file.set} diagnostics={check.problems} onSave={() => void file.save()} />
            ) : file.error ? (
              <p className="px-4 py-3 text-[13px] text-destructive">Couldn't read {path}: {file.error}</p>
            ) : (
              <div aria-hidden className="flex flex-col gap-2 px-14 py-4">
                {[62, 40, 78, 30, 55].map((w, i) => (
                  <span key={i} className="block h-3 rounded bg-foreground/[0.05]" style={{ width: `${w}%` }} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {guard}
    </Pane>
  );
}

function AgentProject({ projectId }: { projectId: string }) {
  const project = useRuntimeSelector((v) => v.projects.find((p) => p.id === projectId));
  return (
    <span className="flex min-w-0 items-center gap-2 text-foreground">
      <ProjectBadge github={project?.repository?.host === "github.com"} />
      <span className="truncate">{project?.name ?? "Missing project"}</span>
    </span>
  );
}

// ------------------------------------------------------------ none open

function NewAgent({ cloud, onNew }: { cloud: CloudReach; onNew: () => void }) {
  const base = useConsoleBase();
  return (
    <Pane>
      <PaneHeader title="New agent" lead="An agent is one Markdown file in .caveman/agents: what it does, its engine and its model. Steps and chats use it here; publish one and Cloud runs it on its own." />
      <button
        type="button"
        onClick={onNew}
        className="px-play-hover mt-7 flex w-full items-start gap-4 rounded-xl border border-dashed border-foreground/[0.16] p-5 text-left outline-none transition-colors duration-150 hover:border-foreground/30 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-10 shrink-0 place-items-center">
          <Glyph name="tool-subagent" scale={2} />
        </span>
        <span className="min-w-0 pt-0.5">
          <span className="block text-[14.5px] font-semibold text-foreground">Describe it</span>
          <span className="mt-1 block text-[13.5px] leading-5 text-muted-foreground">Say what it should do. Caveman writes the file in a chat, checks it, and it shows on the left.</span>
        </span>
      </button>
      {cloud.kind === "ok" ? (
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          <ConsoleLink href={consoleUrl(base, CONSOLE.agents)}>Agents in Platform</ConsoleLink>
        </p>
      ) : null}
    </Pane>
  );
}
