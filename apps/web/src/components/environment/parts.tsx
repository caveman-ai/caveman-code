// The pieces a repo's Cloud setup shows in, shared by the setup card (routes/CloudStart.tsx), the
// Computer tab (EnvironmentPanel.tsx) and Settings, Environments: the live step list, what broke and its
// buttons, the missing values card, the Saved line, the setup chat's fix to review (a diff, Publish or
// Discard), an agent's proposed change (Apply or Dismiss), CI on the built commit, and the repo's shared
// build secrets (names; values write-only). Copy comes from state/environment.ts.
import type { Environment, EnvironmentBuild, EnvironmentCi, Project, SetupChat, SetupProposal } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState } from "react";
import { QuietButton } from "../../panels/chrome.tsx";
import { ciLine, duration, failureCopy, httpsUrl, lineDiff, listOf, servicesOf, shownSteps, stepLabel, type FailureAction, type Tone } from "../../state/environment.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { thisComputer } from "../../lib/platform.ts";

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-success",
  busy: "bg-foreground/70 animate-pulse",
  warn: "bg-warning",
  idle: "bg-muted-foreground/50",
};

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE_DOT[tone], className)} />;
}

/** What a step does here, from the setup it builds: the first command, the checks, the services. */
function stepDetail(name: string, config: string | null, evidence: ReadonlyArray<string>): string | undefined {
  if (name === "setup") {
    const run = listOf(config, "setup", "run").filter((c) => !c.startsWith("mise "));
    return run[0] ?? (evidence[0] || undefined);
  }
  if (name === "check") return listOf(config, "setup", "check").join(" · ") || undefined;
  if (name === "services") return servicesOf(config).map((s) => `${s.name} ${s.version}`).join(", ") || undefined;
  return undefined;
}

/** A clock that ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * The build's steps as a checklist: done ticks, the running one with its clock, a failed one crossed,
 * the rest waiting in grey. Services the repo has no table for are left out.
 */
export function StepList({ build, config, evidence = [] }: { build: EnvironmentBuild; config: string | null; evidence?: ReadonlyArray<string> }) {
  const running = build.steps.find((s) => s.status === "running");
  const now = useNow(running !== undefined);
  const started = build.started_at ? Date.parse(build.started_at) : null;
  const before = build.steps.filter((s) => s.status === "done").reduce((sum, s) => sum + (s.seconds ?? 0), 0);
  const steps = shownSteps(build, config);
  return (
    <ol className="flex flex-col gap-1 text-[13px]">
      {steps.map((s) => {
        const detail = stepDetail(s.name, config, evidence);
        return (
          <li key={s.name} className="flex min-w-0 items-center gap-2 leading-5">
            <span className="grid size-4 shrink-0 place-items-center">
              {s.status === "done" ? (
                <Icon icon={Tick02Icon} className="size-3.5 text-success" strokeWidth={2.25} />
              ) : s.status === "failed" ? (
                <Icon icon={Cancel01Icon} className="size-3.5 text-warning" strokeWidth={2.25} />
              ) : s.status === "running" ? (
                <Dot tone="busy" className="size-2" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/30" />
              )}
            </span>
            <span className={cn("shrink-0", s.status === "pending" || s.status === "skipped" ? "text-muted-foreground" : "text-foreground", s.status === "running" && "lucy-shimmer")}>
              {s.name === "setup" && s.status === "running" ? "Installing" : stepLabel(s.name)}
            </span>
            {detail ? <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{detail}</span> : null}
            <span className="ml-auto shrink-0 pl-2 text-[12px] tabular-nums text-muted-foreground">
              {s.status === "running" && started !== null ? duration(now - started - before * 1000) : s.seconds !== undefined && s.status !== "pending" ? duration(s.seconds * 1000) : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What broke, in a sentence, and its buttons. */
export function FailureNote({
  build,
  env,
  fix,
  onFix,
  onLog,
  onAddValue,
  onAddBuildSecret,
  onUseSize,
  fixing,
}: {
  /** A setup chat is on it: no second Fix it. */
  fixing?: boolean;
  build: EnvironmentBuild;
  env: Environment;
  fix: { ok: boolean; reason?: string | undefined } | undefined;
  onFix: () => void;
  onLog: () => void;
  onAddValue?: (name: string) => void;
  /** A private registry's token: a shared build secret for the repo, not a person's own value. */
  onAddBuildSecret?: (name: string) => void;
  onUseSize?: (size: string) => void;
}) {
  const found = failureCopy(build, env);
  const copy = fixing ? { ...found, actions: found.actions.filter((a) => a !== "fix") } : found;
  const button = (a: FailureAction) => {
    switch (a) {
      case "fix":
        return (
          <QuietButton key={a} onClick={onFix} disabled={fix?.ok === false} title={fix?.ok === false ? fix.reason : "A Caveman chat repairs the setup with test builds: 20 minutes or 5 builds at most."}>
            Fix it
          </QuietButton>
        );
      case "log":
        return (
          <QuietButton key={a} onClick={onLog}>
            View log
          </QuietButton>
        );
      case "add_value":
        return onAddValue ? (
          <QuietButton key={a} onClick={() => onAddValue(copy.value ?? "")}>
            Add value
          </QuietButton>
        ) : null;
      case "add_build_secret":
        return onAddBuildSecret ? (
          <QuietButton key={a} onClick={() => onAddBuildSecret(copy.value ?? "")} title="Shared for this repo. Only setup and checks read it, while it builds; chats never see it.">
            {copy.value ? `Add build secret ${copy.value}` : "Add build secret"}
          </QuietButton>
        ) : null;
      case "use_size":
        return onUseSize && copy.size ? (
          <QuietButton key={a} onClick={() => onUseSize(copy.size!)}>
            Use {copy.size}
          </QuietButton>
        ) : null;
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] leading-5 text-foreground">{copy.text}</p>
      {copy.actions.length > 0 ? <div className="flex flex-wrap gap-1.5">{copy.actions.map(button)}</div> : null}
      {fix?.ok === false && copy.actions.includes("fix") ? <p className="text-[12px] leading-4 text-muted-foreground">{fix.reason}</p> : null}
    </div>
  );
}

const NONE_ON_MAC: ReadonlyMap<string, string> = new Map();

/**
 * Which of `names` this Mac's git-ignored .env files hold, each with the first file holding it: names only,
 * the runtime reads the files. Null until known for these names, so a caller never acts on an older answer.
 */
export function useOnMac(path: string | undefined, names: ReadonlyArray<string>): ReadonlyMap<string, string> | null {
  const { client } = useRuntimeClient();
  const key = path === undefined || names.length === 0 ? "" : `${path}\n${names.join(",")}`;
  const [found, setFound] = useState<{ key: string; onMac: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!client || key === "") return;
    let live = true;
    client.call("secret.env_files", { repo: { path: path! } }).then(
      (r) => {
        const from = new Map<string, string>();
        for (const file of r.files) for (const name of file.names) if (names.includes(name) && !from.has(name)) from.set(name, file.path);
        if (live) setFound({ key, onMac: from });
      },
      () => live && setFound({ key, onMac: NONE_ON_MAC }),
    );
    return () => {
      live = false;
    };
    // key stands for path and names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  if (key === "") return NONE_ON_MAC;
  return found?.key === key ? found.onMac : null;
}

/**
 * The repo's computer reads values this person hasn't set: names, never values. Every name shows with the
 * git-ignored .env file on this Mac it would come from (`onMac`, from useOnMac; the names come from the shared
 * setup, so the person sees each one before the click). Add from this Mac stores exactly those, for this person
 * and this repository, and makes only those available on its Cloud computers (that click is the opt-in).
 */
export function MissingValues({
  project,
  names,
  onMac,
  onDone,
  onSkip,
}: {
  project: Pick<Project, "path">;
  names: ReadonlyArray<string>;
  onMac: ReadonlyMap<string, string> | null;
  onDone?: () => void;
  onSkip?: () => void;
}) {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const here = onMac?.size ?? 0;
  const add = async () => {
    if (!client || !onMac || here === 0) return;
    setBusy(true);
    try {
      const byFile = new Map<string, string[]>();
      for (const [name, file] of onMac) byFile.set(file, [...(byFile.get(file) ?? []), name]);
      const added: string[] = [];
      for (const [file, wanted] of byFile) {
        const stored = await client.call("secret.import", { request_id: requestId(), repo: { path: project.path }, path: file, names: wanted });
        added.push(...stored.secrets.map((s) => s.name).filter((n) => wanted.includes(n)));
      }
      // Only what was just added goes to Cloud: the repository's other values stay on this Mac.
      if (added.length > 0) await client.call("cloud.secrets.set_available", { request_id: requestId(), repo: { path: project.path }, available: true, names: added });
      setSaid(`${added.length} added`);
      onDone?.();
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (names.length === 0) return null;
  return (
    <div role="group" aria-label="Values this repository reads in Cloud" className="rounded-xl border border-warning/40 px-3 py-2.5">
      <p className="text-[13px] leading-5 text-foreground">
        This repository reads {names.length} {names.length === 1 ? "value" : "values"} you haven't set.
      </p>
      <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto text-[12px] leading-5">
        {names.map((name) => {
          const file = onMac?.get(name);
          return (
            <li key={name} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-mono text-foreground">{name}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{onMac === null ? "" : file ? <span className="font-mono">{file}</span> : `Not on ${thisComputer}`}</span>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <QuietButton onClick={() => void add()} disabled={busy || here === 0} title={here === 0 ? `None of them are in ${thisComputer}'s .env files.` : "Stores the values listed with a file, for you and this repository, and makes only those available on its Cloud computers."}>
          {busy ? "Adding…" : here > 0 && here < names.length ? `Add ${here} from ${thisComputer}` : `Add from ${thisComputer}`}
        </QuietButton>
        {onSkip ? (
          <button type="button" onClick={onSkip} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground">
            Skip
          </button>
        ) : null}
        <span className="text-[12px] text-muted-foreground">{said ?? (onMac === null ? "" : here === 0 ? `Not on ${thisComputer}` : "Just me · this repository")}</span>
      </div>
    </div>
  );
}

/** `Saved as acme/web's Cloud setup for everyone in Acme. [Add to repository]`; the click opens a pull request with only the file. */
export function SavedLine({ text, projectId }: { text: string; projectId: string }) {
  const { client } = useRuntimeClient();
  const [state, setState] = useState<{ busy: boolean; url?: string; error?: string }>({ busy: false });
  const add = async () => {
    if (!client) return;
    setState({ busy: true });
    try {
      const { url } = await client.call("environment.add_to_repo", { request_id: requestId(), project_id: projectId });
      setState({ busy: false, url });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] leading-5 text-muted-foreground">
      <span>{text}</span>
      {state.url ? (
        <a href={state.url} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
          Pull request opened
        </a>
      ) : (
        <button type="button" disabled={state.busy} onClick={() => void add()} className="text-foreground underline-offset-2 hover:underline disabled:opacity-50" title="Opens a pull request with only .caveman/computer.toml. Nothing is pushed until you click.">
          {state.busy ? "Opening…" : "Add to repository"}
        </button>
      )}
      {state.error ? <span className="text-warning">{state.error}</span> : null}
    </p>
  );
}

type AddValueProps = { project: Pick<Project, "path">; name: string; onDone?: () => void };

/**
 * Add value: one value by name, typed or pasted, into this person's write-only store for the repo and its Cloud
 * computers. Another name is another form: nothing typed for one value is ever saved under the next one asked for.
 */
export function AddValue(props: AddValueProps) {
  return <AddValueFields key={props.name} {...props} />;
}

function AddValueFields({ project, name, onDone }: AddValueProps) {
  const { client } = useRuntimeClient();
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy: boolean; said?: string }>({ busy: false });
  const save = async () => {
    if (!client || !value.trim()) return;
    setState({ busy: true });
    try {
      await client.call("secret.set", { request_id: requestId(), repo: { path: project.path }, secrets: [{ name, value: value.trim() }] });
      await client.call("cloud.secrets.set_available", { request_id: requestId(), repo: { path: project.path }, available: true, names: [name] });
      setValue("");
      setState({ busy: false, said: "Added. Rebuild to use it." });
      onDone?.();
    } catch (e) {
      setState({ busy: false, said: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="font-mono text-[12px] text-foreground">{name}</span>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste the value"
        aria-label={`Value of ${name}`}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <QuietButton type="submit" disabled={state.busy || !value.trim()}>
        Save
      </QuietButton>
      <span className="basis-full text-[12px] text-muted-foreground">{state.said ?? "Just me · this repository. Never shown again."}</span>
    </form>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A computer.toml change as a unified diff: removed lines, added lines, a few kept around them. */
export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const lines = lineDiff(before, after);
  return (
    <div role="figure" aria-label="Changes to .caveman/computer.toml" className={cn("max-h-72 overflow-auto rounded-md border border-border bg-[hsl(var(--foreground)/0.025)] py-1 font-mono text-[11.5px] leading-[1.55]", className)}>
      {lines.length === 0 ? (
        <p className="px-2.5 py-0.5 font-sans text-[12px] text-muted-foreground">Same as the current setup.</p>
      ) : (
        lines.map((l, i) =>
          l === null ? (
            <div key={i} aria-hidden className="px-2.5 text-[hsl(var(--subtle-foreground))]">
              ⋯
            </div>
          ) : (
            <div key={i} className={cn("flex whitespace-pre px-2.5", l.kind === "add" && "bg-success/10 text-foreground", l.kind === "del" && "bg-destructive/10 text-muted-foreground line-through decoration-destructive/40", l.kind === "same" && "text-muted-foreground")}>
              <span aria-hidden className={cn("w-4 shrink-0 select-none", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-destructive" : "text-transparent")}>
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
              </span>
              <span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>
              {l.text || " "}
            </div>
          ),
        )
      )}
    </div>
  );
}

/**
 * The setup chat's fix, waiting for the person: its two lines, the change against the current setup, and
 * Publish (a save as this person: their own push rule, their name on the version) or Discard. Publish names the
 * build shown here, so a fix that changed meanwhile is refused rather than published unseen. A repo whose branch
 * owns its file can't take a publish: Add to repo opens a pull request with the fix instead.
 */
export function ReviewCard({
  projectId,
  chat,
  current,
  owned,
  onDone,
  onOpenChat,
}: {
  projectId: string;
  chat: SetupChat;
  /** The setup in use now; null when nothing is saved. */
  current: string | null;
  /** The repo's branch has its own .caveman/computer.toml. */
  owned?: boolean;
  onDone: () => void | Promise<void>;
  onOpenChat?: () => void;
}) {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pr, setPr] = useState<string | null>(null);
  if (!chat.proposal) return null;
  const buildId = chat.proposal.build_id;
  const run = async (what: "publish" | "discard") => {
    if (!client) return;
    setBusy(what);
    setSaid(null);
    try {
      if (what === "discard") await client.call("environment.discard", { request_id: requestId(), project_id: projectId });
      else if (owned) setPr(httpsUrl((await client.call("environment.add_to_repo", { request_id: requestId(), project_id: projectId, build_id: buildId })).url) ?? null);
      else await client.call("environment.publish", { request_id: requestId(), project_id: projectId, build_id: buildId });
      await onDone();
    } catch (e) {
      setSaid(message(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div role="group" aria-label="Setup fix ready for review" className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <Dot tone="ok" />
        Fix ready for review
        <span className="ml-auto text-[12px] font-normal text-muted-foreground">Its test build passed</span>
      </p>
      <p className="whitespace-pre-line text-[13px] leading-5 text-foreground">{chat.proposal.summary}</p>
      <DiffView before={current ?? ""} after={chat.proposal.config} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void run("publish")}
          title={owned ? "The repository's branch has its own .caveman/computer.toml: opens a pull request changing only that file." : "Saves it as this repo's Cloud setup for everyone in your organization, as you, and builds it."}
        >
          {owned ? (busy === "publish" ? "Opening…" : "Add to repository") : busy === "publish" ? "Publishing…" : "Publish"}
        </Button>
        <QuietButton disabled={busy !== null} onClick={() => void run("discard")}>
          {busy === "discard" ? "Discarding…" : "Discard"}
        </QuietButton>
        {onOpenChat ? (
          <button type="button" onClick={onOpenChat} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground">
            Open chat
          </button>
        ) : null}
        {pr ? (
          <a href={pr} target="_blank" rel="noreferrer" className="text-[12px] text-foreground underline underline-offset-2">
            Pull request opened
          </a>
        ) : (
          <span className={cn("text-[12px]", said ? "text-warning" : "text-muted-foreground")}>{said ?? (owned ? "Nothing changes until the pull request merges." : "Nothing changes until you publish.")}</span>
        )}
      </div>
    </div>
  );
}

/** A change an agent proposed mid-chat (propose_setup_change): Apply hands it to the setup chat, Dismiss drops it. */
export function ProposalCard({
  projectId,
  proposal,
  onDone,
  onApplied,
  flat,
  here,
}: {
  projectId: string;
  proposal: SetupProposal;
  onDone: () => void | Promise<void>;
  onApplied?: () => void;
  /** Inside a row that is its frame already: no border of its own. */
  flat?: boolean;
  /** Shown in the chat whose agent wrote it. */
  here?: boolean;
}) {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // Whose words these are: the agent in that chat wrote them, so the person reads all of them before Apply.
  const chatTitle = useRuntimeSelector((v) => v.raw.get(proposal.workspace_id)?.title);
  const run = async (apply: boolean) => {
    if (!client) return;
    setBusy(true);
    setSaid(null);
    try {
      if (apply) await client.call("environment.proposal.apply", { request_id: requestId(), project_id: projectId, proposal_id: proposal.id });
      else await client.call("environment.proposal.dismiss", { request_id: requestId(), project_id: projectId, proposal_id: proposal.id });
      await onDone();
      if (apply) onApplied?.();
    } catch (e) {
      setSaid(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-label="Proposed Cloud setup change" className={cn("flex flex-col gap-1.5", flat ? "border-l-2 border-warning/50 pl-3" : "rounded-xl border border-border px-3 py-2.5")}>
      <p className="text-[12px] leading-4 text-muted-foreground">
        {here ? "A Cloud setup change, proposed by this chat's agent. Its words:" : <>A Cloud setup change, proposed by the agent in {chatTitle ? <span className="text-foreground">“{chatTitle}”</span> : "another chat"}. Its words:</>}
      </p>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">{proposal.summary}</p>
      <p className="whitespace-pre-wrap break-words text-[12px] leading-[18px] text-muted-foreground">
        <span className="text-[hsl(var(--subtle-foreground))]">Why: </span>
        {proposal.why}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <QuietButton disabled={busy} onClick={() => void run(true)} title="Hands it to the repository's setup chat, which test-builds it; you review the result before anything is saved.">
          Apply
        </QuietButton>
        <button type="button" disabled={busy} onClick={() => void run(false)} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50">
          Dismiss
        </button>
        {said ? <span className="text-[12px] text-warning">{said}</span> : null}
      </div>
    </div>
  );
}

/** CI on the commit a failed or gapped check built (environment.ci), read once when shown: is it the repo, or the setup? */
export function CiNote({ projectId, buildId, className }: { projectId: string; buildId: string; className?: string }) {
  const { client } = useRuntimeClient();
  const [ci, setCi] = useState<EnvironmentCi | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    client.call("environment.ci", { project_id: projectId }).then(
      (r) => live && setCi(r.ci),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, projectId, buildId]);
  const line = ciLine(ci);
  if (!line) return null;
  const href = httpsUrl(ci?.url);
  return (
    <p className={cn("flex items-center gap-2 text-[12.5px] leading-5 text-muted-foreground", className)}>
      <Dot tone={line.tone} />
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
          {line.text}
        </a>
      ) : (
        line.text
      )}
    </p>
  );
}

/**
 * The repo's shared build secrets: names only, each settable again or removable; a value goes once to Cloud
 * and is never shown. Only setup and checks read them, while a build runs; chats' computers never get them.
 */
export function BuildSecrets({ projectId, names, adding, onChange }: { projectId: string; names: ReadonlyArray<string>; adding?: string | null; onChange: () => void | Promise<void> }) {
  const { client } = useRuntimeClient();
  const [editing, setEditing] = useState<string | null>(adding ?? null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (adding) setEditing(adding);
  }, [adding]);
  const remove = async (name: string) => {
    if (!client) return;
    setSaid(null);
    try {
      await client.call("environment.build_secret.delete", { request_id: requestId(), project_id: projectId, name });
      await onChange();
    } catch (e) {
      setSaid(message(e));
    }
  };
  return (
    <div className="flex flex-col gap-1">
      {names.length === 0 && editing === null ? <p className="text-[13px] text-muted-foreground">None. A private registry's token goes here.</p> : null}
      {names.length > 0 ? (
        <ul className="flex flex-col">
          {names.map((n) => (
            <li key={n} className="group flex items-center gap-2 py-0.5 text-[13px]">
              <span className="min-w-0 truncate font-mono text-[12px] text-foreground">{n}</span>
              <span className="text-[12px] text-muted-foreground">Set</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => setEditing(n)} className="h-6 rounded px-1.5 text-[12px] text-muted-foreground hover:text-foreground">
                  Replace
                </button>
                <button type="button" onClick={() => void remove(n)} className="h-6 rounded px-1.5 text-[12px] text-muted-foreground hover:text-foreground">
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {editing !== null ? (
        <BuildSecretForm
          projectId={projectId}
          name={editing}
          onDone={async () => {
            setEditing(null);
            await onChange();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <QuietButton onClick={() => setEditing("")}>Add build secret</QuietButton>
        </div>
      )}
      {said ? <p className="text-[12px] text-warning">{said}</p> : null}
    </div>
  );
}

type BuildSecretFormProps = { projectId: string; name: string; onDone: () => void | Promise<void>; onCancel: () => void };

/**
 * One build secret by name (typed, or the one a failed build asked for) and its value, write-only. Another name is
 * another form: nothing typed for one secret is ever saved under the next one asked for.
 */
export function BuildSecretForm(props: BuildSecretFormProps) {
  return <BuildSecretFields key={props.name} {...props} />;
}

function BuildSecretFields({ projectId, name: given, onDone, onCancel }: BuildSecretFormProps) {
  const { client } = useRuntimeClient();
  const [name, setName] = useState(given);
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy: boolean; said?: string }>({ busy: false });
  const valid = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
  const save = async () => {
    if (!client || !valid || !value) return;
    setState({ busy: true });
    try {
      await client.call("environment.build_secret.set", { request_id: requestId(), project_id: projectId, name, value });
      setValue("");
      setState({ busy: false });
      await onDone();
    } catch (e) {
      setState({ busy: false, said: message(e) });
    }
  };
  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {given ? (
        <span className="font-mono text-[12px] text-foreground">{given}</span>
      ) : (
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="NPM_TOKEN"
          aria-label="Build secret name"
          autoComplete="off"
          spellCheck={false}
          className="h-7 w-36 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste the value"
        aria-label={`Value of ${name || "the build secret"}`}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <QuietButton type="submit" disabled={state.busy || !valid || !value}>
        {state.busy ? "Saving…" : "Save"}
      </QuietButton>
      <button type="button" onClick={onCancel} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground">
        Cancel
      </button>
      <span className={cn("basis-full text-[12px]", state.said ? "text-warning" : "text-muted-foreground")}>
        {state.said ?? "Shared for this repo, never shown again. Setup on any branch reads it while it builds, so code pushed to a branch can too, a chat's included: use a read-only token."}
      </span>
    </form>
  );
}
