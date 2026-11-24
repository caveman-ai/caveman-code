// A new chat in Cloud from the desktop app. The message goes as soon as Cloud knows the repository: a computer is
// never held for its project's setup (it starts from the template when no environment is ready, and the setup builds
// beside it for the next chat). One line while Cloud is asked ("Waking Cloud… 2s"), then the chat opens here, in the
// app, with the message in it: Cloud holds its start, and its computer runs it when it is up (state/sync/hub.ts
// `startQueued`). Where Cloud queues no start, or the chat is several runs or its agent must be connected first, it
// carries on in the Cloud-hosted client as before. A repo nobody set up is drafted here and saved; the setup chat
// (started by itself, or by Fix it) shows its fix here for the person to publish or discard, and a registry's token is
// added as a build secret. Values the chat reads that this Mac's .env files hold are offered before it starts:
// nothing else brings a .env up, so the message waits for that one answer. The first start also carries the one-time
// offer to use a Claude or compact subscription in Cloud too (CloudOffer), beside the start and never in front of it.
// A start that failed says so in one sentence of ours, with Try again and Discard.
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { Bubble, Message } from "@caveman-app/ui/ai/message";
import { Button } from "@caveman-app/ui/components/button";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Dot, MissingValues, SavedLine, StepList, useOnMac } from "../components/environment/parts.tsx";
import { CloudOffer } from "../components/cloud/CloudOffer.tsx";
import { useUseOnCloudPrompt } from "../components/cloud/trust.tsx";
import { KeptLimitLink } from "../components/cloud/KeptLimitLink.tsx";
import { ProjectBadge } from "../components/ProjectPicker.tsx";
import { openExternal } from "../panels/browser/BrowserBar.tsx";
import { chatPath, panes } from "../panes/store.ts";
import { queuedStart, queuedStartParams, startLink, type StartOptions } from "../state/cloud.ts";
import { CLOUD_WAKING } from "../state/cloud-wait.ts";
import { waitLine } from "../state/sync/web-window.ts";
import { buildDone, CLOUD_NEEDS_GITHUB, cloudUnavailable, foldLine, missingValues, savedLine, startWaitsForValues, useEnvironment } from "../state/environment.ts";
import { requestId, useRuntimeClient, useRuntimeSelector, useSyncHub } from "../state/runtime.tsx";
import type { CallState } from "../state/sync/wire.ts";
import { projectSources } from "@caveman-app/session-protocol";
import { cloudSources } from "../state/sources.ts";
import { SidebarMenuButton } from "../shell/SidebarToggle.tsx";
import { startFailure } from "./start-failure.ts";

/** What New chat hands this page in the history entry's state (NewChat.tsx). */
export interface CloudStartState {
  readonly project_id: string;
  readonly text: string;
  readonly engine: string;
  /** The branch New chat's bar picked to start from; absent: the repository's default. */
  readonly base_ref?: string;
  readonly options?: StartOptions;
  /** The project's sources the chat works in, by name, its own first; absent: its own alone. */
  readonly sources?: ReadonlyArray<string>;
  /** The task as this many chats beside each other; absent: one. */
  readonly runs?: number;
  /**
   * The chat's agent runs on any Cloud computer now (Caveman, or an agent with a plan or key connected for Cloud), so
   * Cloud may hold its start; absent: the start carries on in the Cloud-hosted client, where the agent is connected first.
   */
  readonly queue?: true;
}

/**
 * Cloud starts this tab made, by the history entry that asked (location.key). The task rides in that entry's state,
 * which a reload or Back to it brings back with the page's own state gone: the mark says it already started.
 */
const STARTED_KEY = "caveman.cloud.started.";
function startedFor(entry: string): { url: string; bare: boolean } | null {
  try {
    return JSON.parse(sessionStorage.getItem(STARTED_KEY + entry) ?? "null") as { url: string; bare: boolean } | null;
  } catch {
    return null;
  }
}

/**
 * The request id of an entry's start, kept before it is asked: a reload while Cloud still makes the computer asks
 * again with it, and the runtime answers that first start (it runs a call once per request_id) instead of making another.
 */
const REQUEST_KEY = "caveman.cloud.start-request.";
function requestFor(entry: string): string {
  try {
    const kept = sessionStorage.getItem(REQUEST_KEY + entry);
    if (kept) return kept;
    const made = requestId();
    sessionStorage.setItem(REQUEST_KEY + entry, made);
    return made;
  } catch {
    return requestId();
  }
}

export function CloudStartRoute() {
  const { client } = useRuntimeClient();
  const hub = useSyncHub();
  const projects = useRuntimeSelector((v) => v.projects);
  const location = useLocation();
  const navigate = useNavigate();
  const start = location.state as CloudStartState | null;
  const project = projects.find((p) => p.id === start?.project_id) ?? null;
  const { answer, reload } = useEnvironment(project?.id ?? null);
  const useOnCloud = useUseOnCloudPrompt();
  const [evidence, setEvidence] = useState<string[]>([]);
  const [org, setOrg] = useState<string | undefined>(undefined);
  const [set, setSet] = useState<string[] | null>(null);
  /** Missing values the person added from this Mac or skipped here: neither card nor prompt asks again. */
  const [answered, setAnswered] = useState<string[]>([]);
  const [started, setStarted] = useState(() => startedFor(location.key));
  /** What failed, as it was thrown: a refusal at the kept-computer limit links to Settings > Computers (m-21). */
  const [problem, setProblem] = useState<unknown>(null);
  /** When Cloud was asked to start the chat (the line counts from it); null while it is not being asked. */
  const [asking, setAsking] = useState<number | null>(null);
  /** The problem is a start that failed (not the setup's): the line offers Try again and Discard. */
  const [startFailed, setStartFailed] = useState(false);
  /** A failed start's own words, behind a click. */
  const [details, setDetails] = useState(false);
  const [open, setOpen] = useState(false);
  const drafted = useRef(false);
  const starting = useRef(false);
  const env = answer?.environment ?? null;
  const build = env?.build ?? null;
  const repo = project?.repository?.full_name;
  // The repositories the chat works in: the others go to Cloud as its checkouts and to the chat's workspace.create
  // there as its sources. New chat names only what Cloud can have (a folder is left out there, and its pill says so).
  const ticked = project ? projectSources(project).filter((s, i) => i === 0 || (start?.sources ?? []).includes(s.name)) : [];
  const several = cloudSources(ticked);

  useEffect(() => {
    void client?.call("cloud.status", {}).then((s) => setOrg(s.account?.organization_name), () => undefined);
    if (project) void client?.call("secret.list", { repo: { path: project.path } }).then((r) => setSet(r.secrets.map((s) => s.name)), () => setSet([]));
  }, [client, project?.path]);

  // Nobody set the repo up: set it up now (a draft from the repo, its CI and this Mac, saved; or its own file, built).
  useEffect(() => {
    if (!client || !project || !env || drafted.current) return;
    if (env.state !== "not_set_up" || env.build !== null) return;
    drafted.current = true;
    void (async () => {
      try {
        const set = await client.call("environment.setup", { request_id: requestId(), project_id: project.id });
        setEvidence((set.evidence ?? []).filter((e) => e.source !== "repo" || /from/.test(e.note)).map((e) => e.note));
        await reload();
      } catch (e) {
        // Only admins and people who can push to the repository change its Cloud setup: a save Cloud refused this
        // person holds nothing here, since the chat starts without it.
        if (!(e instanceof SessionProtocolError && e.error.data?.reason === "forbidden")) setProblem(e);
      }
    })();
  }, [client, project, env]);

  // Ready: a snapshot serves, even while an update builds beside it.
  const ready = env !== null && (env.state === "ready" || env.state === "ready_with_gaps");
  const missing = set === null ? [] : missingValues(env, set).filter((n) => !answered.includes(n));
  const onMac = useOnMac(project?.path, missing);
  // Nothing brings up a .env before a Cloud start needs it: values this Mac holds for the computer are offered
  // first, ready or not. Values it doesn't hold don't hold the start (the agent asks for one when it needs it).
  const offering = startWaitsForValues(set, missing, onMac);
  const go = async (bare: boolean) => {
    if (!client || !project || !repo || !start || starting.current) return;
    starting.current = true;
    setAsking(Date.now());
    setStartFailed(false);
    setProblem(null);
    const entry = location.key;
    try {
      // Secrets on this Mac reach the Cloud computer only if the person says so now.
      await useOnCloud.ask({ path: project.path }, answered);
      const title = start.text.split("\n")[0]!.slice(0, 80) || repo;
      const base = start.base_ref ? { base_branch: start.base_ref } : {};
      const request = requestFor(entry);
      // The chat's start as its computer runs it: the same call whether Cloud queues it or a window sends it there.
      const pending = (computerId: string) => ({
        computer_id: computerId,
        repo,
        ...(start.base_ref ? { base_ref: start.base_ref } : {}),
        engine: start.engine,
        task: start.text,
        ...(start.options ? { options: start.options } : {}),
        ...(several.sources ? { sources: several.sources } : {}),
      });
      // Cloud holds one chat's start, for an app that can open the chat (the hub has Cloud's list of the person's
      // chats). Several runs are made one after another by the Cloud-hosted client.
      const queue = start.queue === true && hub?.hasCloud() === true && !(start.runs && start.runs > 1);
      const made = await client.call("cloud.workspace.create", {
        request_id: request,
        title,
        repo,
        ...base,
        engine: start.engine as never,
        ...(several.checkouts ? { checkouts: several.checkouts } : {}),
        ...(queue ? { start: { request_id: request, params: queuedStartParams(pending("")) } } : {}),
      });
      const queued =
        queue && hub && made.session_id !== undefined && made.start !== undefined
          ? await queuedStart({ workspace_id: made.workspace_id, computer_id: made.computer_id, session_id: made.session_id, start: made.start as CallState }, pending(made.computer_id), request)
          : null;
      if (queued && hub) {
        // Cloud has the start: the chat opens here, the message in it, and its computer's own events follow in place.
        await hub.startQueued({ ...queued, open_url: made.open_url });
        // Into its pane before the route shows the panes, so the pane never holds the chat it showed before (hold.ts).
        panes.place(queued.workspace_id);
        navigate(chatPath(queued.workspace_id), { replace: true });
        return;
      }
      const { computer_id, ...rest } = pending(made.computer_id);
      const url = startLink(made.open_url, {
        computer_id,
        workspace_id: made.workspace_id,
        ...rest,
        ...(start.runs && start.runs > 1 ? { runs: start.runs } : {}),
        // A start Cloud queued that this app cannot open: the Cloud-hosted client's call is that same call.
        ...(made.start !== undefined ? { request_id: request } : {}),
      });
      openExternal(url);
      sessionStorage.setItem(STARTED_KEY + entry, JSON.stringify({ url, bare }));
      setStarted({ url, bare });
      setAsking(null);
    } catch (e) {
      starting.current = false;
      setAsking(null);
      setStartFailed(true);
      setProblem(e);
    }
  };
  // The message goes as soon as Cloud knows the repository and this Mac's values for the computer are answered. A
  // computer is never held for its project's setup: with no environment ready it starts from the template, and the
  // setup builds beside it. A start that failed waits for the person's Try again.
  const known = env !== null;
  useEffect(() => {
    if (known && !started && !offering && !startFailed) void go(!ready);
  }, [known, ready, started, offering, startFailed]);

  if (!start || !project) {
    return (
      <Page project={null}>
        <p className="text-[13px] text-muted-foreground">
          Nothing is waiting to start here. <Link to="/new" className="text-foreground underline underline-offset-2">New chat</Link>
        </p>
      </Page>
    );
  }
  const answerMissing = () => setAnswered((a) => [...a, ...missing]);
  // Back to New chat with the message in its box again: nothing typed is lost by not starting.
  const back = () => navigate(`/new?project=${encodeURIComponent(project.id)}`, { state: { prompt: { text: start.text }, ...(start.options?.model ? { pick: { engine: start.engine, model: start.options.model } } : {}) } });
  const cancel = (
    <Button type="button" size="sm" variant="ghost" onClick={back}>
      Cancel
    </Button>
  );
  const unfold = (label: string) => (
    <Button type="button" size="sm" variant="ghost" aria-expanded={details} onClick={() => setDetails(!details)} className="gap-1">
      {label}
      <Icon icon={ArrowRight01Icon} className={`size-3.5 transition-transform duration-150 ${details ? "rotate-90" : ""}`} />
    </Button>
  );
  const failure = problem !== null && startFailed ? startFailure(problem) : null;
  const waiting = !started && asking === null && failure === null;
  /** Values the chat reads that this Mac holds: offered before the message goes. */
  const offered = missing.length > 0 && onMac !== null && onMac.size > 0;
  // One line. In order: a start that failed; Cloud being asked; this Mac's values, the one thing the message waits for.
  const line: { readonly tone: "busy" | "warn"; readonly text: ReactNode; readonly buttons?: ReactNode } | null = failure
    ? {
        tone: "warn",
        text: failure.line,
        buttons: (
          <>
            <Button type="button" size="sm" variant="secondary" onClick={() => void go(started?.bare ?? !ready)}>
              Try again
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={back}>
              Discard
            </Button>
            {failure.detail ? unfold("Details") : null}
          </>
        ),
      }
    : asking !== null
      ? { tone: "busy", text: <Starting since={asking} /> }
      : waiting && offered
        ? { tone: "busy", text: "Your message runs once you add these or skip.", buttons: cancel }
        : null;

  return (
    <Page project={project}>
      <Message from="user" className="py-3">
        <Bubble className="whitespace-pre-wrap">{start.text}</Bubble>
      </Message>

      {/* Asked once, the first time a chat starts in Cloud; it never holds the start (components/cloud/CloudOffer.tsx). */}
      <CloudOffer />

      {answer !== null && !answer.available ? <Note>{cloudUnavailable(answer.reason)}</Note> : null}
      {answer?.available && env === null ? <Note>{CLOUD_NEEDS_GITHUB}</Note> : null}

      {line ? (
        <p role={line.tone === "warn" ? "alert" : "status"} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] leading-5 text-foreground">
          <Dot tone={line.tone} />
          <span className="min-w-0">{line.text}</span>
          {line.buttons ? <span className="flex flex-wrap items-center gap-1">{line.buttons}</span> : null}
        </p>
      ) : null}
      {failure ? <KeptLimitLink error={problem} className="mt-1 block text-[13px]" /> : null}
      {failure?.detail && details ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[hsl(var(--foreground)/0.04)] p-2 font-mono text-[11.5px] leading-[1.45] text-muted-foreground">{failure.detail}</pre> : null}

      {waiting && offered ? (
        <section aria-label="Values" className="mt-2 flex flex-col gap-2.5">
          <MissingValues project={project} names={missing} onMac={onMac} onDone={answerMissing} onSkip={answerMissing} />
        </section>
      ) : null}

      {started ? (
        <div className="mt-3 flex flex-col gap-2">
          <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-foreground">
            <Dot tone="ok" />
            {started.bare ? "Started in Cloud without setup. Setup carries on for the next chat." : "Started in Cloud."}
            <Button type="button" size="sm" variant="ghost" onClick={() => openExternal(started.url)}>
              Open
            </Button>
          </p>
          {env && build && ready && buildDone(build) && build.status === "succeeded" ? (
            <div>
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group flex items-center gap-1 rounded-sm text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                {foldLine(build, env.snapshot)}
                <Icon icon={ArrowRight01Icon} className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
              </button>
              {open ? (
                <div className="mt-2 rounded-xl border border-border px-4 py-3">
                  <StepList build={build} config={env.config} evidence={evidence} />
                </div>
              ) : null}
            </div>
          ) : null}
          {env?.source === "cloud" && ready ? <SavedLine text={savedLine(env.repo, org)} projectId={project.id} /> : null}
        </div>
      ) : null}

      {/* A problem that is not the start's (the setup could not be drafted, Fix it was refused): said as it is. */}
      {problem !== null && !startFailed ? (
        <div role="alert" className="flex flex-col gap-1">
          <Note tone="warn">{problem instanceof Error ? problem.message : String(problem)}</Note>
          <KeptLimitLink error={problem} className="text-[13px]" />
        </div>
      ) : null}
      {useOnCloud.dialog}
    </Page>
  );
}

/**
 * "Waking Cloud… 8s": the one line while Cloud is asked for the chat, counting the seconds, in the words the browser
 * window that opens next waits in (CloudWaitLine), so the wait reads as one. Nothing can be stopped here: Cloud has
 * the start.
 */
function Starting({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{waitLine(CLOUD_WAKING, since, now)}</span>;
}

function Page({ project, children }: { project: { name: string; repository?: { host: string } | null | undefined } | null; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 px-4 text-[13px]">
        <SidebarMenuButton />
        {project ? (
          <>
            <ProjectBadge github={project.repository?.host === "github.com"} />
            <span className="text-muted-foreground">{project.name}</span>
            <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">
              /
            </span>
          </>
        ) : null}
        <span className="text-foreground">New chat</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[944px] px-4 pb-10 pt-6">{children}</div>
      </div>
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return <p className={`mt-3 text-[13px] leading-5 ${tone === "warn" ? "text-warning" : "text-muted-foreground"}`}>{children}</p>;
}
