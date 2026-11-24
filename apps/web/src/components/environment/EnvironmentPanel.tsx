// The Computer tab's setup sections for the chat's repo: Status (state, what it boots
// from, services, checks, what broke, CI on that commit, the setup chat's fix to review, changes agents
// proposed), Setup (the computer.toml, its size, Ask Caveman to change it), Versions (earlier Cloud copies,
// Restore), Values (shared build secrets for setup; this person's values, Add from this Mac) and Builds (each
// build, its log, Rebuild). The setup chat opens over it, its own transcript. Opens only when the person opens
// the tab; never a cost.
import type { Environment, EnvironmentBuild, EnvironmentVersion, Project } from "@caveman-app/session-protocol";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState, type ReactNode } from "react";
import { QuietButton, SurfaceEmpty } from "../../panels/chrome.tsx";
import { MARK } from "../../panels/agents/states.ts";
import { openSurface } from "../../panels/store.ts";
import { accountLabel } from "../../state/cloud.ts";
import {
  ago,
  buildDone,
  duration,
  foldLine,
  missingValues,
  runOnLabel,
  savedLine,
  servicesOf,
  sizeOf,
  stepProgress,
  useEnvironment,
  withSize,
  type EnvironmentAnswer,
} from "../../state/environment.ts";
import { runnerFor } from "../../state/runner.ts";
import { requestId, useSession, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { AgentView } from "../pane/cards/AgentView.tsx";
import { AddValue, BuildSecretForm, BuildSecrets, CiNote, DiffView, Dot, FailureNote, MissingValues, ProposalCard, ReviewCard, SavedLine, StepList, useOnMac } from "./parts.tsx";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import { CloudIcon, SourceCodeIcon } from "@caveman-app/ui/icons/huge";

const BY: Record<NonNullable<EnvironmentBuild["by"]>, string> = {
  person: "you",
  background: "Caveman, in the background",
  setup_chat: "the setup chat",
};

/**
 * `workspaceId`: the chat whose Computer tab shows it (Edit in repo opens the file there); none in Settings.
 * `onChange`: something here changed the setup (Settings' row reads it again).
 */
export function EnvironmentPanel({ workspaceId, projectId, onChange }: { workspaceId?: string | undefined; projectId: string | null; onChange?: () => void }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const { answer, error, reload: reloadOwn } = useEnvironment(project?.id ?? null);
  const reload = async () => {
    await reloadOwn();
    onChange?.();
  };
  const [chatOpen, setChatOpen] = useState(false);
  if (!project)
    return (
      <SurfaceEmpty icon={CloudIcon} title="No Cloud setup">
        A Cloud setup belongs to a project, and this chat has none.
      </SurfaceEmpty>
    );
  if (error)
    return (
      <SurfaceEmpty title="Couldn't read this repository's Cloud setup" action={<QuietButton onClick={() => void reload()}>Try again</QuietButton>}>
        {error}
      </SurfaceEmpty>
    );
  if (answer === null) return <SurfaceEmpty title="Reading this repository's Cloud setup…" />;
  if (!answer.available)
    return (
      <SurfaceEmpty icon={CloudIcon} title="Cloud isn't available">
        {answer.reason}
      </SurfaceEmpty>
    );
  if (answer.environment === null)
    return (
      <SurfaceEmpty icon={SourceCodeIcon} title="No GitHub remote">
        Cloud clones from GitHub, and this repository has no GitHub remote.
      </SurfaceEmpty>
    );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EnvironmentSections answer={answer} env={answer.environment} project={project} workspaceId={workspaceId} reload={reload} onOpenChat={() => setChatOpen(true)} />
      {chatOpen && answer.setup_chat ? <SetupChatView chat={answer.setup_chat} onBack={() => setChatOpen(false)} /> : null}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3 first:border-t-0">
      <h3 className="mb-2 flex h-6 items-center gap-2 text-[12px] font-medium text-muted-foreground">
        {title}
        {aside ? <span className="ml-auto flex items-center gap-1.5 font-normal">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 py-0.5 text-[13px] leading-5">
      <span className="w-[88px] shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-foreground", mono && "font-mono text-[12px]")}>{children}</span>
    </div>
  );
}

/** Exported for the style page and the preview, which render it on fixtures. */
export function EnvironmentSections({
  answer,
  env,
  project,
  workspaceId,
  reload,
  onOpenChat,
}: {
  answer: EnvironmentAnswer;
  env: Environment;
  project: Pick<Project, "id" | "path">;
  workspaceId?: string | undefined;
  reload: () => Promise<void>;
  onOpenChat: () => void;
}) {
  const { client } = useRuntimeClient();
  const [org, setOrg] = useState<string | undefined>(undefined);
  const [log, setLog] = useState<{ id: string; text: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addingSecret, setAddingSecret] = useState<string | null>(null);
  useEffect(() => {
    void client?.call("cloud.status", {}).then(
      (s) => setOrg(s.account?.organization_name ?? (s.account ? accountLabel(s.account) : undefined)),
      () => undefined,
    );
  }, [client]);
  const latest = env.build;
  const running = latest !== null && !buildDone(latest);
  const label = runOnLabel(answer);
  const act = async (run: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await run();
      await reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  const fix = (ask?: string) =>
    act(async () => {
      await client!.call("environment.fix", {
        request_id: requestId(),
        project_id: project.id,
        ...(ask ? { ask } : {}),
      });
      onOpenChat();
    });
  const showLog = async (id: string) => {
    setLog({ id, text: null });
    try {
      setLog({
        id,
        text: (await client!.call("environment.build.log", { build_id: id })).text,
      });
    } catch (e) {
      setLog({ id, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const source =
    env.source === "repo"
      ? `From .caveman/computer.toml${env.snapshot ? ` at ${env.snapshot.commit.slice(0, 7)}` : ""}`
      : env.source === "cloud"
        ? `Saved in Cloud${env.updated_by ? ` by ${env.updated_by}` : ""}${env.updated_at ? ` · ${ago(env.updated_at)}` : ""}`
        : "Nothing saved yet";
  const services = servicesOf(env.config);
  const chat = answer.setup_chat;
  // CI answers whether a failing setup or check is the repo's: not for Cloud's side, a token or a clone.
  const askCi =
    latest !== null &&
    !running &&
    ((latest.status === "failed" && latest.failure !== null && ["command", "check", "service", "restore", "timeout"].includes(latest.failure.kind)) || (latest.status === "succeeded" && latest.gaps.length > 0));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
      <Section title="Status">
        <div className="mb-1.5 flex items-center gap-2 text-[13px]">
          <Dot tone={label.tone} />
          {/* One of three states and no more (state/environment.ts runOnLabel); a failed setup shows why on a click. */}
          <span className="font-medium text-foreground">{label.chip}</span>
          {label.failed && latest ? <QuietButton onClick={() => void showLog(latest.id)}>See why</QuietButton> : null}
        </div>
        <Row label="Setup">{source}</Row>
        <Row label="Last save">{env.snapshot ? `${ago(env.snapshot.built_at)} · ${env.snapshot.commit.slice(0, 7)}` : "None yet: chats start with nothing set up"}</Row>
        {services.length > 0 ? (
          <Row label="Services">
            <span className="flex flex-wrap gap-x-3">
              {services.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5">
                  <Dot tone={env.snapshot ? "ok" : "idle"} />
                  {s.name} {s.version}
                </span>
              ))}
            </span>
          </Row>
        ) : null}
        {env.snapshot && env.snapshot.checks.length > 0 ? (
          <Row label="Checks">
            <span className="flex flex-col">
              {env.snapshot.checks.map((c) => (
                <span key={c.command} className="flex items-center gap-1.5 font-mono text-[12px]">
                  <span className={c.ok ? "text-success" : "text-warning"}>{c.ok ? "✓" : "✗"}</span>
                  <span className="truncate">{c.command}</span>
                  <span className="ml-auto pl-2 font-sans tabular-nums text-muted-foreground">{duration(c.seconds * 1000)}</span>
                </span>
              ))}
            </span>
          </Row>
        ) : null}
        {chat?.state === "review" ? (
          <div className="mt-2.5">
            <ReviewCard projectId={project.id} chat={chat} current={env.config} owned={env.source === "repo"} onDone={reload} onOpenChat={onOpenChat} />
          </div>
        ) : null}
        {latest && running ? (
          <div className="mt-2.5 rounded-lg border border-border px-3 py-2">
            <StepList build={latest} config={env.config} />
          </div>
        ) : null}
        {latest?.status === "failed" ? (
          <div className="mt-2.5 rounded-lg border border-warning/40 px-3 py-2.5">
            <FailureNote
              fixing={answer.setup_chat?.state === "working" || answer.setup_chat?.state === "review"}
              build={latest}
              env={env}
              fix={answer.fix}
              onFix={() => void fix()}
              onLog={() => void showLog(latest.id)}
              onUseSize={(size) =>
                void act(() =>
                  client!.call("environment.save", {
                    request_id: requestId(),
                    project_id: project.id,
                    config: withSize(env.config ?? "", size),
                  }),
                )
              }
              onAddValue={setAdding}
              onAddBuildSecret={setAddingSecret}
            />
            {adding ? (
              <div className="mt-2.5">
                <AddValue project={project} name={adding} />
              </div>
            ) : null}
            {addingSecret !== null ? (
              <BuildSecretForm
                projectId={project.id}
                name={addingSecret}
                // The build that asked for it runs again with it.
                onDone={() => {
                  setAddingSecret(null);
                  return act(() => client!.call("environment.build", { request_id: requestId(), project_id: project.id }));
                }}
                onCancel={() => setAddingSecret(null)}
              />
            ) : null}
            {askCi ? <CiNote projectId={project.id} buildId={latest.id} className="mt-2" /> : null}
          </div>
        ) : null}
        {askCi && latest?.status === "succeeded" ? <CiNote projectId={project.id} buildId={latest.id} className="mt-2" /> : null}
        {(answer.proposals ?? []).map((p) => (
          <div key={p.id} className="mt-2.5">
            <ProposalCard projectId={project.id} proposal={p} onDone={reload} onApplied={onOpenChat} />
          </div>
        ))}
        {latest?.status === "succeeded" && env.state !== "setting_up" ? <p className="mt-2 text-[12.5px] text-muted-foreground">{foldLine(latest, env.snapshot)}</p> : null}
        {chat ? (
          <button
            type="button"
            onClick={onOpenChat}
            className="mt-2.5 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[13px] outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className={cn("size-1.5 shrink-0", MARK[chat.state === "working" ? "working" : chat.state === "succeeded" || chat.state === "review" ? "done" : "failed"])} />
            <span className={cn("text-foreground", chat.state === "working" && "lucy-shimmer")}>Setup chat</span>
            <span className="text-muted-foreground">
              {chatStateLine(chat.state)} · {chat.builds} of 5 builds
            </span>
            <span className="ml-auto text-[12px] text-muted-foreground">Open</span>
          </button>
        ) : null}
        {problem ? <p className="mt-2 text-[12.5px] text-warning">{problem}</p> : null}
      </Section>

      <SetupSection answer={answer} env={env} project={project} workspaceId={workspaceId} org={org} act={act} fix={fix} />

      {env.source === "cloud" ? <VersionsSection env={env} project={project} act={act} /> : null}

      <ValuesSection env={env} project={project} reload={reload} />

      <Section
        title="Builds"
        aside={
          <QuietButton
            onClick={() =>
              void act(() =>
                client!.call("environment.build", {
                  request_id: requestId(),
                  project_id: project.id,
                }),
              )
            }
            disabled={running || env.config === null}
          >
            Rebuild
          </QuietButton>
        }
      >
        {(answer.builds ?? []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No builds from {thisComputer} yet.</p>
        ) : (
          <ul className="flex flex-col">
            {(answer.builds ?? []).map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => (log?.id === b.id ? setLog(null) : void showLog(b.id))}
                  aria-expanded={log?.id === b.id}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Dot tone={b.status === "succeeded" ? (b.gaps.length > 0 ? "warn" : "ok") : b.status === "failed" ? "warn" : "busy"} />
                  <span className="text-foreground">
                    {b.status === "succeeded" ? "Passed" : b.status === "failed" ? `Failed at ${b.failure?.step ?? "a step"}` : "Running"}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">{b.by ? `by ${BY[b.by]}` : ""}</span>
                  <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {b.started_at ? ago(b.started_at) : ""}
                    {b.started_at && b.finished_at ? ` · ${duration(Date.parse(b.finished_at) - Date.parse(b.started_at))}` : ""}
                  </span>
                </button>
                {log?.id === b.id ? (
                  <pre className="mx-1 mb-2 mt-1 max-h-72 overflow-auto rounded-md bg-[hsl(var(--foreground)/0.04)] p-2 font-mono text-[11.5px] leading-[1.45] text-muted-foreground">
                    {log.text ?? "Loading the log…"}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function SetupSection({
  answer,
  env,
  project,
  workspaceId,
  org,
  act,
  fix,
}: {
  answer: EnvironmentAnswer;
  env: Environment;
  project: Pick<Project, "id" | "path">;
  workspaceId?: string | undefined;
  org: string | undefined;
  act: (run: () => Promise<unknown>) => Promise<void>;
  fix: (ask?: string) => Promise<void>;
}) {
  const { client } = useRuntimeClient();
  const [text, setText] = useState(env.config ?? "");
  const [evidence, setEvidence] = useState<ReadonlyArray<{ source: string; note: string }>>([]);
  const [ask, setAsk] = useState("");
  useEffect(() => setText(env.config ?? ""), [env.config]);
  const owned = env.source === "repo";
  const dirty = text !== (env.config ?? "");
  const size = sizeOf(text) ?? "4x16";
  const draft = () =>
    act(async () => {
      const d = await client!.call("environment.draft", {
        project_id: project.id,
      });
      setText(d.config);
      setEvidence(d.evidence);
    });
  return (
    <Section
      title="Setup"
      aside={
        owned && workspaceId ? (
          <QuietButton
            onClick={() =>
              openSurface(workspaceId, "file", {
                path: ".caveman/computer.toml",
              })
            }
          >
            Edit in repository
          </QuietButton>
        ) : env.config === null && !dirty ? (
          <QuietButton onClick={() => void draft()}>Draft from this repository</QuietButton>
        ) : null
      }
    >
      {owned ? <p className="mb-2 text-[12.5px] text-muted-foreground">The repository's own file. Changes to it go in a commit.</p> : null}
      {text === "" && !owned ? (
        <p className="text-[13px] text-muted-foreground">No setup yet. Caveman drafts one from the repo, its CI and {thisComputer}.</p>
      ) : (
        <textarea
          aria-label="computer.toml"
          value={text}
          readOnly={owned}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(18, Math.max(6, text.split("\n").length + 1))}
          className="w-full resize-y rounded-lg border border-input bg-[hsl(var(--foreground)/0.025)] px-3 py-2 font-mono text-[12px] leading-[1.5] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:text-muted-foreground"
        />
      )}
      {evidence.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] leading-4 text-muted-foreground">
          {evidence.map((e) => (
            <li key={e.note}>
              <span className="text-[hsl(var(--subtle-foreground))]">{e.source === "mac" ? THIS_COMPUTER : e.source === "ci" ? "CI" : e.source === "devcontainer" ? "Devcontainer" : "Repo"}</span> ·{" "}
              {e.note}
            </li>
          ))}
        </ul>
      ) : null}
      {!owned && text !== "" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            Size
            <select
              value={size}
              onChange={(e) => setText(withSize(text, e.target.value))}
              className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(env.sizes.length > 0 ? env.sizes : ["4x16"]).map((s) => (
                <option key={s} value={s}>
                  {s.replace("x", " vCPU · ")} GB
                </option>
              ))}
            </select>
          </label>
          <QuietButton
            disabled={!dirty && env.config !== null}
            onClick={() =>
              void act(() =>
                client!.call("environment.save", {
                  request_id: requestId(),
                  project_id: project.id,
                  config: text,
                }),
              )
            }
            title="Saves it for everyone in your organization and starts a build."
          >
            Save
          </QuietButton>
          {dirty ? (
            <button type="button" onClick={() => setText(env.config ?? "")} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground">
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
      {env.source === "cloud" && (env.state === "ready" || env.state === "ready_with_gaps") ? (
        <div className="mt-2.5">
          <SavedLine text={savedLine(env.repo, org)} projectId={project.id} />
        </div>
      ) : null}
      {/* The repo's own file changes in a commit, never through a setup chat's save. */}
      {owned ? null : (
        <form
          className="mt-3 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ask.trim()) void fix(ask.trim()).then(() => setAsk(""));
          }}
        >
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask Caveman to change it, e.g. add Redis 7"
            disabled={answer.fix?.ok === false}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <QuietButton type="submit" disabled={answer.fix?.ok === false || ask.trim() === ""} className="h-8">
            Ask
          </QuietButton>
        </form>
      )}
      {answer.fix?.ok === false && !owned ? <p className="mt-1.5 text-[12px] leading-4 text-muted-foreground">{answer.fix.reason}</p> : null}
    </Section>
  );
}

/** The setup chat's state, in the line under Status. */
const chatStateLine = (state: NonNullable<EnvironmentAnswer["setup_chat"]>["state"]) =>
  state === "working" ? "working" : state === "review" ? "fix ready for review" : state === "succeeded" ? "fixed it" : state === "stopped" ? "stopped" : "stopped without a fix";

/** Earlier Cloud copies, newest first: each opens as a diff against the setup in use, and Restore saves it again as the newest. */
function VersionsSection({ env, project, act }: { env: Environment; project: Pick<Project, "id">; act: (run: () => Promise<unknown>) => Promise<void> }) {
  const { client } = useRuntimeClient();
  const [versions, setVersions] = useState<ReadonlyArray<EnvironmentVersion> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (!client) return;
    client.call("environment.versions", { project_id: project.id }).then(
      (r) => {
        setVersions(r.versions);
        setProblem(null);
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  }, [client, project.id, env.config_version]);
  const current = env.config_version ?? versions?.[0]?.version;
  return (
    <Section title="Versions" aside={versions && versions.length > 0 ? <span className="text-[12px] text-muted-foreground">{versions.length === 50 ? "Last 50" : `${versions.length}`}</span> : null}>
      {problem ? (
        <p className="text-[13px] text-muted-foreground">{problem}</p>
      ) : versions === null ? (
        <p className="text-[13px] text-muted-foreground">Reading its versions…</p>
      ) : versions.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No saved versions yet.</p>
      ) : (
        <ul className="flex flex-col">
          {versions.map((v) => (
            <li key={v.version}>
              <div className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-accent/60">
                <button type="button" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="w-8 shrink-0 tabular-nums text-muted-foreground">v{v.version}</span>
                  <span className="min-w-0 truncate text-foreground">{v.updated_by ? `by ${v.updated_by}` : "Saved"}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{ago(v.updated_at)}</span>
                </button>
                {v.version === current ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground">In use</span>
                ) : (
                  <QuietButton
                    className="h-6 px-2 text-[12px]"
                    // Based on the version shown in use: Cloud refuses when someone saved another since.
                    onClick={() =>
                      void act(() =>
                        client!.call("environment.restore", { request_id: requestId(), project_id: project.id, version: v.version, ...(env.config_version !== undefined ? { base_version: env.config_version } : {}) }),
                      )
                    }
                    title={`Saves v${v.version} again as the newest version, for everyone in your organization, and builds it.`}
                  >
                    Restore
                  </QuietButton>
                )}
              </div>
              {open === v.version ? <DiffView className="mx-1 mb-2 mt-1" before={env.config ?? ""} after={v.config} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ValuesSection({ env, project, reload }: { env: Environment; project: Pick<Project, "id" | "path">; reload: () => Promise<void> }) {
  const { client } = useRuntimeClient();
  const [set, setSet] = useState<string[] | null>(null);
  const load = () =>
    void client?.call("secret.list", { repo: { path: project.path } }).then(
      (r) => setSet(r.secrets.map((s) => s.name)),
      () => setSet([]),
    );
  useEffect(load, [client, project.path]);
  const missing = missingValues(env, set ?? []);
  const onMac = useOnMac(project.path, set === null ? [] : missing);
  return (
    <Section title="Values">
      <h4 className="mb-1 text-[12px] text-muted-foreground">For setup · shared</h4>
      <BuildSecrets projectId={project.id} names={env.build_secret_names ?? []} onChange={reload} />
      <h4 className="mb-1 mt-3 text-[12px] text-muted-foreground">On its computers · just me</h4>
      {env.secret_names.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Its computers read no values you supply.</p>
      ) : (
        <ul className="mb-2 flex flex-col">
          {env.secret_names.map((n) => (
            <li key={n} className="flex items-center gap-2 py-0.5 text-[13px]">
              <span className="min-w-0 truncate font-mono text-[12px] text-foreground">{n}</span>
              <span className={cn("ml-auto shrink-0 text-[12px]", set?.includes(n) ? "text-muted-foreground" : "text-warning")}>{set === null ? "" : set.includes(n) ? "Set" : "Missing"}</span>
            </li>
          ))}
        </ul>
      )}
      {set !== null && missing.length > 0 ? <MissingValues project={project} names={missing} onMac={onMac} onDone={load} /> : null}
    </Section>
  );
}

/** The setup chat over the Computer tab (and the setup card): its own transcript, live, with a way back. */
export function SetupChatView({ chat, onBack, backLabel = "Computer" }: { chat: NonNullable<EnvironmentAnswer["setup_chat"]>; onBack: () => void; backLabel?: string }) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const { view } = useSession(chat.session_id);
  const engine = engines.find((e) => e.id === "caveman");
  return (
    <AgentView
      row={{
        key: chat.workspace_id,
        title: "Setup chat",
        state: {
          label: chat.state === "working" ? "Working" : chat.state === "review" ? "Fix ready for review" : chat.state === "succeeded" ? "Fixed the setup" : chat.state === "stopped" ? "Stopped" : "Stopped without a fix",
          mark: chat.state === "working" ? "working" : chat.state === "succeeded" || chat.state === "review" ? "done" : "failed",
        },
        runner: runnerFor(engines, { engine: "caveman" }),
        line: null,
        startedAt: chat.started_at,
        finishedAt: null,
        depth: 1,
      }}
      items={view?.items ?? []}
      running={view?.running ?? chat.state === "working"}
      summary={null}
      engineLabel={engine?.label ?? "Caveman"}
      index={0}
      count={1}
      closing={false}
      at={Date.now()}
      backLabel={backLabel}
      onBack={onBack}
      onStep={() => undefined}
      onClosed={() => undefined}
      onAnswer={async (askId, response) => {
        await client?.call("ask.respond", {
          request_id: requestId(),
          session_id: chat.session_id,
          ask_id: askId,
          response,
        });
      }}
      {...(chat.state === "working"
        ? {
            onStop: () =>
              void client
                ?.call("turn.interrupt", {
                  request_id: requestId(),
                  session_id: chat.session_id,
                })
                .catch(() => undefined),
          }
        : {})}
    />
  );
}
