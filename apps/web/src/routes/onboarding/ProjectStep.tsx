// 3. Project: GitHub as this computer sees it, the same chooser Add project uses (Suggested on this computer, On
// GitHub), then setting the project up from what is already in it: instructions (setup.scan), the stack, install,
// checks and secrets (environment.draft, drafted here with no network and no model), a Cloud computer building on a
// paid plan, and first tasks from its open issues (github.issues). Rows land as each answer comes back; nothing is
// shown as run that only was found. docs/ "3. Project".

import type { Project, Result } from "@caveman-app/session-protocol";
import { ACCESS, DEFAULT_ACCESS } from "@caveman-app/ui/components/access-picker";
import { Button } from "@caveman-app/ui/components/button";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { Icon, CircleDotIcon, Copy01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GazeMascot } from "../../components/GazeMascot.tsx";
import { ProjectChooserPanel } from "../../components/ProjectPicker.tsx";
import { UnlockButton } from "../../components/UnlockPlans.tsx";
import { offersUnlock, paidPlan } from "../../components/unlock-model.ts";
import { funnelStep } from "../../state/desktop.ts";
import { chatEngine, credentialsOutside } from "../../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { rememberRepo } from "../../state/recent-repos.ts";
import { useAccount, useConnectGithub, useGithubStatus } from "./data.ts";
import { GitTools } from "./GitTools.tsx";
import { ghFirst } from "./github-way.ts";
import { bringingLine, readDraft, type Bringing, type FirstRunEnd, type Setup } from "./model.ts";
import { Card, Caveman, Head, Nav, Page, Ready, Row, Working } from "./parts.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/**
 * `onDone(end)`: Show me around (the project, whose Chief opens under the tour), or a first task started (its chat), or
 * no project yet (Skip for now: null). `bringing`: the setup coming over in the background since Your setup, said in
 * the footer.
 */
export function ProjectStep({ onBack, onDone, onUnlock, plans, bringing = null }: { onBack: () => void; onDone: (end: FirstRunEnd) => void; onUnlock: () => void; plans: number; bringing?: Bringing | null }) {
  const [project, setProject] = useState<Project | null>(null);
  const status = bringing ? <BringingStatus bringing={bringing} /> : undefined;
  if (project) return <SettingUp project={project} onBack={() => setProject(null)} onDone={onDone} onUnlock={onUnlock} plans={plans} status={status} />;
  return <Pick onBack={onBack} onPicked={setProject} onSkip={() => onDone(null)} status={status} />;
}

/** The setup coming over: turning while it runs, a tick once here, the reason when some or all of it didn't come. */
function BringingStatus({ bringing }: { bringing: Bringing }) {
  const line = bringingLine(bringing);
  return (
    <span role="status" aria-live="polite" title={line} className="animate-in fade-in duration-150 ease-snap">
      {bringing.state === "running" ? <Working text={line} /> : bringing.state === "done" && bringing.failed.length === 0 ? <Ready text={line} /> : <span className="text-warning">{line}</span>}
    </span>
  );
}

function Pick({ onBack, onPicked, onSkip, status }: { onBack: () => void; onPicked: (p: Project) => void; onSkip: () => void; status?: ReactNode }) {
  const github = useGithubStatus(true);
  const input = useRef<HTMLInputElement>(null);
  // Projects added before (an earlier run, the CLI) come first; a new person sees only what to add.
  const hasProjects = useRuntimeSelector((v) => v.projects.length > 0);
  // Connecting through Caveman needs an owner or admin; signed-out people and members get the gh CLI way instead.
  const { account } = useAccount(true);
  const viaGh = ghFirst(account);
  return (
    <Page
      width={540}
      head={<Head figure={<GazeMascot scale={3} />} title="Pick a project" desc="Each chat works in its own copy of the repo, so your checkout stays exactly as it is." />}
      // Never a dead end: a project can be added any time from the sidebar.
      foot={<Nav onBack={onBack} aside={status} skip={{ label: "Skip for now", onClick: onSkip }} />}
    >
      <div className="mt-7 flex w-full flex-col gap-3">
        {github === null ? null : github.login ? (
          <div className="flex min-h-8 items-center gap-2 px-[15px] text-[13px] animate-in fade-in duration-150 ease-snap">
            {/* px-[15px]: a Card's words start 15px in (its 1px edge, p-1, then px-2.5); a line beside the cards starts there too. */}
            <BrandMark name="github" size={16} />
            <span className="text-muted-foreground">Connected as</span>
            <span>@{github.login}</span>
            {github.source === "cloud" ? (
              <span className="ml-auto text-[12px] text-[hsl(var(--subtle-foreground))]">Through Caveman</span>
            ) : (
              <AlsoInCloud source={github.source} canConnect={!viaGh} />
            )}
          </div>
        ) : (
          <Card>
            {/* GitHub's own refusal of a login says what to do; with no login at all, the row says it. */}
            <ConnectGithub problem={github.source ? github.problem : undefined} viaGh={viaGh} />
          </Card>
        )}
        {/* Without git no project can be added: say what's missing, and how to get it, before the picker. */}
        <GitTools />
        <Card className="flex h-[min(420px,52vh)] flex-col overflow-hidden p-0">
          <ProjectChooserPanel hasProjects={hasProjects} inputRef={input} onPicked={onPicked} />
        </Card>
      </div>
    </Page>
  );
}

/** A login from this computer (gh, GH_TOKEN): Cloud computers can't use it, so connecting it in Cloud is offered. */
function AlsoInCloud({ source, canConnect }: { source: "gh" | "env" | null; canConnect: boolean }) {
  const connect = useConnectGithub();
  return (
    <span className="ml-auto flex items-center gap-2 text-[12px] text-[hsl(var(--subtle-foreground))]">
      {source === "env" ? "From GH_TOKEN" : "From the GitHub CLI"}
      {canConnect ? (
        <button
          type="button"
          title={connect.error ?? "Connect it to Caveman, so Cloud computers can use it"}
          className="text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline"
          disabled={connect.busy}
          onClick={connect.start}
        >
          {connect.error ? "Couldn't open the page" : connect.opened ? "Finish in your browser" : "Use it on Cloud computers"}
        </button>
      ) : null}
    </span>
  );
}

/** In a window on a Cloud computer that keeps nothing of its person's: GitHub is connected from the person's own device. */
export const GITHUB_ELSEWHERE = "Connect GitHub on your own device.";

/**
 * No GitHub login anywhere: connect it through Caveman Cloud (it then works on Cloud computers too), or with gh on this
 * computer. The row turns Connected by itself (github.status is polled). A Cloud computer that keeps nothing of its
 * person's takes neither (github.connect is refused there, and a gh login would be one kept inside it): the row
 * says where it is connected, and offers no button.
 * `viaGh`: for signed-out people and members below admin (github-way.ts), the gh way is the only one offered: Caveman's
 * GitHub App needs an admin, so its Connect button would only fail for them.
 */
export function ConnectGithub({ problem, viaGh = false }: { problem?: string | undefined; viaGh?: boolean }) {
  const connect = useConnectGithub();
  const outside = credentialsOutside(useRuntimeSelector((v) => v.engines));
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText("gh auth login").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Row
      icon={<BrandMark name="github" size={16} />}
      label="Connect GitHub"
      desc={
        connect.error && !viaGh ? (
          <span className="text-destructive">{connect.error}</span>
        ) : connect.opened && !viaGh ? (
          "Finish in your browser; this updates by itself"
        ) : (
          (problem ?? (outside ? GITHUB_ELSEWHERE : viaGh ? "Run gh auth login in a terminal; this updates by itself" : "Through Caveman, or run gh auth login in a terminal"))
        )
      }
      right={
        outside ? null : viaGh ? (
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? "Copied" : "Copy command"}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" aria-label="Copy gh auth login" title="Copy gh auth login" onClick={copy}>
              <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
            </Button>
            <Button size="sm" variant="secondary" disabled={connect.busy} onClick={connect.start}>
              {connect.opened ? "Open again" : "Connect"}
            </Button>
          </>
        )
      }
    />
  );
}

// ------------------------------------------------------------------ setting it up

type Found = { instructions: string[] | null; setup: Setup | null; issues: Result<"github.issues">["issues"] | null; failed: string | null };

function SettingUp({ project, onBack, onDone, onUnlock, plans, status }: { project: Project; onBack: () => void; onDone: (end: FirstRunEnd) => void; onUnlock: () => void; plans: number; status?: ReactNode }) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const { account, reload } = useAccount(true);
  useEffect(() => {
    if (plans > 0) reload();
  }, [plans, reload]);
  const paid = paidPlan(account) !== null;
  const offer = offersUnlock(account);
  const onGithub = project.repository?.host === "github.com";
  const [found, setFound] = useState<Found>({ instructions: null, setup: null, issues: null, failed: null });
  // The Cloud computer as environment.setup answered: asked, building, ready, or left for Settings.
  const [cloud, setCloud] = useState<"idle" | "asked" | "building" | "ready" | "later">("idle");
  const [details, setDetails] = useState(false);
  // The first task starting, or why it could not.
  const [starting, setStarting] = useState<{ key: string; error?: string } | null>(null);
  // The first run ends once: Show me around, or a first task's chat, whichever comes first.
  const finished = useRef(false);
  const finish = (end: FirstRunEnd) => {
    if (finished.current) return;
    finished.current = true;
    onDone(end);
  };

  useEffect(() => {
    if (!client) return;
    let live = true;
    rememberRepo(project.path);
    client.call("setup.scan", { repo_path: project.path }).then(
      // The repo's own (AGENTS.md, CLAUDE.md), not the ones in a home folder every repo gets.
      (r) => live && setFound((f) => ({ ...f, instructions: [...new Set(r.items.filter((i) => i.kind === "instructions" && i.source === "repo").map((i) => i.name))] })),
      () => live && setFound((f) => ({ ...f, instructions: [] })),
    );
    client.call("environment.draft", { project_id: project.id }).then(
      (r) => live && setFound((f) => ({ ...f, setup: readDraft(r) })),
      (e) => live && setFound((f) => ({ ...f, setup: { stack: [], install: null, checks: [], secrets: [], moreSecrets: 0 }, failed: e instanceof Error ? e.message : String(e) })),
    );
    client.call("github.issues", { project_id: project.id, limit: 3 }).then(
      (r) => live && setFound((f) => ({ ...f, issues: r.issues })),
      () => live && setFound((f) => ({ ...f, issues: [] })),
    );
    return () => {
      live = false;
    };
  }, [client, project]);

  // A paid plan sets the Cloud computer up too, in the background; Free offers it instead.
  useEffect(() => {
    if (!client || !paid || !onGithub || cloud !== "idle") return;
    setCloud("asked");
    client.call("environment.setup", { request_id: requestId(), project_id: project.id }).then(
      (r) => {
        const state = r.environment?.state;
        setCloud(state === "setting_up" ? "building" : state === "ready" || state === "ready_with_gaps" ? "ready" : "later");
      },
      () => setCloud("later"),
    );
  }, [client, paid, onGithub, cloud, project.id]);

  // What the repo holds, read for the rows below. Never waited on: the project is added already, and the rows land as
  // they come whether or not the person stays to watch.
  const ready = found.instructions !== null && found.setup !== null;
  useEffect(() => {
    if (ready) funnelStep("project_ready");
  }, [ready]);

  const engine = chatEngine(engines, null, settings?.default_engine)?.id;
  const start = async (key: string, text: string) => {
    if (!client || !engine) return;
    setStarting({ key });
    try {
      const chat = await client.call("workspace.create", { request_id: requestId(), repo: { path: project.path }, engine, task: { text } });
      finish({ chat: chat.id });
    } catch (e) {
      setStarting({ key, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const s = found.setup;
  const secrets = s ? s.secrets.length + s.moreSecrets : 0;
  const rows: ReactNode[] = [];
  if (found.instructions !== null)
    rows.push(<Row key="read" icon={<Glyph name="artifact-markdown" />} label="Instructions" desc={found.instructions.length ? found.instructions.join(", ") : "None yet"} right={found.instructions.length ? <Ready text="Read" /> : <span className="text-[hsl(var(--subtle-foreground))]">Optional</span>} />);
  if (s && s.stack.length) rows.push(<Row key="stack" icon={<Glyph name="repo" />} label="Stack" desc={s.stack.join(", ")} right={<Ready text="Found" />} />);
  if (s?.install) rows.push(<Row key="install" icon={<Glyph name="tool-run" />} label="Install" desc={s.install} mono right={<Ready text="Found" />} />);
  if (s && s.checks.length) rows.push(<Row key="checks" icon={<Glyph name="tool-run" />} label="Checks" desc={s.checks.join(", ")} mono right={<Ready text="Found" />} />);
  const secretsRow =
    s && secrets > 0 ? <Row key="secrets" icon={<Glyph name="secret" />} label={`${secrets} secret${secrets === 1 ? "" : "s"}`} desc={s.secrets.length ? s.secrets.join(", ") : "Names the code reads that nothing here sets"} mono={s.secrets.length > 0} right={<span className="text-[hsl(var(--subtle-foreground))]">Add in Settings</span>} /> : null;
  if (secretsRow) rows.push(secretsRow);
  const cloudRow = !onGithub ? null : paid ? (
    <Row
      key="cloud"
      icon={<Glyph name="computer-cloud" />}
      label="Cloud computer"
      desc="A snapshot, so Cloud chats start in seconds"
      right={cloud === "ready" ? <Ready /> : cloud === "later" ? <span className="text-[hsl(var(--subtle-foreground))]">Set up later in Settings</span> : <Working text={cloud === "building" ? "Building" : "Starting"} />}
    />
  ) : offer ? (
    <Row key="cloud" icon={<Glyph name="computer-cloud" />} label="Keep going with your laptop shut" desc="Cloud computers" right={<UnlockButton variant="secondary" onClick={onUnlock} />} />
  ) : null;
  // environment.draft could not read how the repo installs: said, never shown as nothing to do.
  const failedRow = found.failed ? <Row key="failed" icon={<Glyph name="state-failed" />} label="Install and checks" desc={found.failed} right={<span className="text-[hsl(var(--subtle-foreground))]">Not found</span>} /> : null;
  if (failedRow) rows.push(failedRow);

  // With a task to start, Start is the one filled button and Show me around the secondary one beside it (the only way
  // to the tour from here; it is also in Help); with no engine (Set up later) there is no task, and the tour is the way on.
  const around = () => finish({ project: project.id });
  const startingNow = starting !== null && !starting.error;
  const footer = engine ? { skip: { label: "Show me around", variant: "secondary" as const, onClick: () => (startingNow ? undefined : around()) } } : { onNext: around, next: "Show me around" };
  // What a new chat runs with, in the permissions picker's own words (packages/ui access-picker.tsx), said before the
  // first task starts: the project's own default, else Settings > General, else Full access.
  const mode = ACCESS[project.default_access ?? settings?.default_access ?? DEFAULT_ACCESS];
  const checks = s?.checks.length ? `${s.checks.length} check${s.checks.length === 1 ? "" : "s"}` : null;
  return (
    <Page
      width={540}
      head={
        <Head
          figure={<Caveman pose={ready ? "done" : "working"} />}
          title={ready ? `${project.name} is ready` : `Setting up ${project.name}`}
          desc={ready ? "Here's what Caveman found in it." : "Reading the repo: its instructions, how it installs and how it checks itself."}
        />
      }
      foot={<Nav onBack={onBack} {...footer} aside={ready && paid && onGithub && cloud === "building" ? "The Cloud computer keeps building in the background" : status} />}
    >
      <div className="mt-7 flex w-full flex-col gap-3">
        <Card
          title="Setup"
          aside={
            ready ? (
              <button type="button" className="-my-[3px] py-[3px] outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={() => setDetails(!details)}>
                {details ? "Hide details" : "Show details"}
              </button>
            ) : undefined
          }
        >
          {!ready || details ? (
            <>
              {rows}
              {!ready ? <Row icon={<Working text="" />} label={<span className="text-muted-foreground">Reading {project.name}</span>} /> : null}
            </>
          ) : (
            <>
              {s?.install || checks ? (
                <Row
                  icon={<Glyph name="tool-run" />}
                  label={s?.install && checks ? "Installs and checks" : s?.install ? "Installs" : "Checks"}
                  desc={s?.install ?? s?.checks.join(", ")}
                  mono
                  right={<Ready />}
                />
              ) : found.instructions?.length ? (
                <Row icon={<Glyph name="artifact-markdown" />} label="Instructions" desc={found.instructions.join(", ")} right={<Ready text="Read" />} />
              ) : (
                <Row icon={<Glyph name="artifact-markdown" />} label="Nothing to read yet" desc="No instructions, install or checks found" />
              )}
              {failedRow}
              {secretsRow}
            </>
          )}
          {ready ? cloudRow : null}
        </Card>

        {/* No engine yet (Set up later): no task to start, only the tour. */}
        {ready && engine ? (
          <div className="animate-in fade-in duration-150 ease-snap">
            <Card title="Start with one of these" aside={found.issues && found.issues.length ? "From GitHub issues and the repo" : undefined}>
              {(found.issues ?? []).map((i, at) => (
                <Suggestion
                  key={i.number}
                  primary={at === 0}
                  icon={<Icon icon={CircleDotIcon} className="size-4" />}
                  label={`#${i.number} ${i.title}`}
                  desc={i.assigned_to_me ? "Assigned to you" : "Open issue"}
                  busy={starting !== null && !starting.error}
                  error={starting?.key === `#${i.number}` ? starting.error : undefined}
                  onStart={() => void start(`#${i.number}`, `Fix issue #${i.number}: ${i.title}\n${i.url}`)}
                />
              ))}
              <Suggestion primary={!found.issues?.length} icon={<Glyph name="engine-caveman" />} label="Explain how this repo fits together" desc="A good first chat" busy={starting !== null && !starting.error} error={starting?.key === "explain" ? starting.error : undefined} onStart={() => void start("explain", "Explain how this repository fits together: its parts, how they talk, and where to start reading.")} />
            </Card>
            <p className="mt-2 px-[15px] text-[12px] text-[hsl(var(--subtle-foreground))]">
              New chats run on {mode.label}: {mode.line.charAt(0).toLowerCase() + mode.line.slice(1)}. Change it in Settings.
            </p>
          </div>
        ) : null}
      </div>
    </Page>
  );
}

/** `primary`: the first suggestion, whose Start is the view's one filled button. */
function Suggestion({ primary = false, icon, label, desc, busy, error, onStart }: { primary?: boolean; icon: ReactNode; label: string; desc: string; busy: boolean; error: string | undefined; onStart: () => void }) {
  return (
    <Row
      icon={icon}
      label={label}
      desc={error ? <span className="text-destructive">{error}</span> : desc}
      right={
        <Button size="sm" variant={primary ? "default" : "secondary"} disabled={busy} onClick={onStart}>
          Start
        </Button>
      }
    />
  );
}
