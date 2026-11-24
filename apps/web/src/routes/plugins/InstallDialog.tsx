// Install. One click installs for what the page is about (useInstall). The dialog is the long way: who gets the
// plugin (just me, everyone on a project, everyone on the team) and, for a project or the team, whether each person
// signs in or one shared account serves everyone. Either way, then one setup step per service it signs in to:
// Connect opens the sign-in, and the step says connected once plugin.read does.
import type { Project, RepositoryLink } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { type CSSProperties, useState, type ReactNode } from "react";
import { useAddProject } from "../../components/ProjectPicker.tsx";
import { Segmented } from "../settings/rows.tsx";
import { ConnectMark, type ConnectState, useLanded } from "../../components/ConnectMark.tsx";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { type ConnectTarget, type InstallPolicy, type InstallScope, type PluginSummary } from "./api.ts";
import { useAccount } from "./data.tsx";
import { connectedLine, displayName, installParams, POLICY_LINE, policyChoices, sharedLine, teamReach } from "./model.ts";
import { PluginLogo } from "./PluginLogo.tsx";
import { useScopeProject } from "./scope.tsx";
import { CONNECT_ELSEWHERE, ErrorLine, focusDialog, message, useCall, useConnectsElsewhere, useHere } from "./shared.tsx";
import { useSignIn } from "./signIn.ts";

type RepoLink = RepositoryLink;
/** The repos a project groups; a project from before projects grouped repos is its own one. */
const reposOf = (p: Project): ReadonlyArray<RepoLink> => (p as { repos?: ReadonlyArray<RepoLink> }).repos ?? (p.repository ? [p.repository] : []);
const repoName = (r: RepoLink) => `${r.host}/${r.full_name}`;

/**
 * Install, the short way: one click installs the plugin for what the page is about (you everywhere, or the project
 * picked in the bar), and only a plugin that signs in to a service opens anything, straight at that sign-in. `ask`
 * opens the long way instead: who gets it (a project, the team), its policy and whose account it uses. Render `dialog`.
 */
export function useInstall(onDone: () => void) {
  const { client } = useRuntimeClient();
  const project = useScopeProject();
  const [asking, setAsking] = useState<PluginSummary | null>(null);
  const [connecting, setConnecting] = useState<{ plugin: PluginSummary; targets: ReadonlyArray<ConnectTarget> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = async (plugin: PluginSummary) => {
    setError(null);
    // The runtime knows a project's plugins by its repository: one with no remote yet has nowhere to keep them.
    if (project && reposOf(project).length === 0) return setError(`${project.name} has no git remote yet, so a plugin can't be only its own. Pick Everywhere in the bar to install ${displayName(plugin)}.`);
    setBusy(plugin.id);
    try {
      // No policy: the runtime picks what this person may set (an admin's default, a member's offer).
      const r = await client!.call("plugin.install", { request_id: requestId(), id: plugin.id, ...(project ? { scope: "project" as const, project_id: project.id, cwd: project.path } : { scope: "me" as const }) });
      if (r.needs_connect.length > 0) setConnecting({ plugin, targets: r.needs_connect });
    } catch (e) {
      setError(`${displayName(plugin)}: ${message(e)}`);
    } finally {
      setBusy(null);
      onDone();
    }
  };
  const dialog = (
    <InstallDialog
      plugin={asking ?? connecting?.plugin ?? null}
      connect={connecting ? { targets: connecting.targets, where: project?.name ?? "the project" } : undefined}
      onOpenChange={(open) => !open && (setAsking(null), setConnecting(null))}
      onDone={onDone}
    />
  );
  return { install: (plugin: PluginSummary) => void install(plugin), ask: setAsking, dialog, busy, error, where: project?.name };
}

/** `connect`: the plugin is installed already and these are its sign-ins, so the dialog opens on them. */
export function InstallDialog({ plugin, connect, onOpenChange, onDone }: { plugin: PluginSummary | null; connect?: { targets: ReadonlyArray<ConnectTarget>; where: string } | undefined; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [asked, setAsked] = useState<{ targets: ReadonlyArray<ConnectTarget>; where: string } | null>(null);
  const setup = asked ?? connect ?? null;
  const close = (open: boolean) => {
    if (open) return;
    setAsked(null);
    onOpenChange(false);
    onDone();
  };
  return (
    <Dialog open={plugin !== null} onOpenChange={close}>
      {/* No first-option focus ring that reads as a second selection: focus starts on the dialog. */}
      <DialogContent size="md" aria-describedby={undefined} onOpenAutoFocus={focusDialog} className="outline-none focus-visible:ring-0">
        {plugin === null ? null : setup === null ? (
          <WhoGetsIt key={plugin.id} plugin={plugin} onInstalled={(targets, where) => (targets.length === 0 ? close(false) : setAsked({ targets, where }))} />
        ) : (
          <Setup plugin={plugin} targets={setup.targets} where={setup.where} onDone={() => close(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WhoGetsIt({ plugin, onInstalled }: { plugin: PluginSummary; onInstalled: (needs: ReadonlyArray<ConnectTarget>, where: string) => void }) {
  const { client } = useRuntimeClient();
  const projects = useRuntimeSelector((v) => v.projects);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const here = useHere();
  const account = useAccount();
  const markets = useCall((c) => c.call("marketplace.list", here).then((r) => r.marketplaces), undefined, here.cwd);
  const picked = useScopeProject();
  const [scope, setScope] = useState<InstallScope>("me");
  const [projectId, setProjectId] = useState<string | null>(picked?.id ?? projects[0]?.id ?? null);
  const [policy, setPolicy] = useState<InstallPolicy>("default");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addProject = useAddProject(async (p) => {
    await refresh();
    setProjectId(p.id);
    setScope("project");
  });
  const project = projects.find((p) => p.id === projectId);
  const signsIn = plugin.includes.connections > 0;
  const market = markets.data?.find((m) => m.name === plugin.marketplace);
  const reach = teamReach(market, account.admin);
  // Only admins turn a plugin on for everyone (Default, Required) or connect a shared account; a member's install is Available.
  const chosenPolicy = account.admin ? policy : "available";
  const isShared = shared && account.admin;
  const where = scope === "team" ? "the team" : (project?.name ?? "the project");

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client!.call("plugin.install", {
        request_id: requestId(),
        ...installParams({ id: plugin.id, scope, projectId, policy: chosenPolicy, shared: isShared, signsIn, addToTeam: reach.ok && reach.addToTeam, cwd: here.cwd }),
      });
      onInstalled(r.needs_connect, where);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <PluginLogo plugin={plugin} />
          <DialogTitle className="text-[15px]">Install {displayName(plugin)}</DialogTitle>
        </div>
      </DialogHeader>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-2 text-[13px] text-muted-foreground">Who gets it?</legend>
        <Choice checked={scope === "me"} onSelect={() => setScope("me")} title="Just me" line="In every project, on this computer" />
        <Choice
          checked={scope === "project"}
          onSelect={() => setScope("project")}
          disabled={projects.length === 0 || !reach.ok}
          title={
            <span className="flex items-center gap-1.5">
              Everyone on
              <Select
                value={projectId ?? ""}
                disabled={!reach.ok}
                onValueChange={(v) => {
                  if (v === "+new") return addProject.start();
                  setProjectId(v);
                  setScope("project");
                }}
              >
                <SelectTrigger aria-label="Project" className="h-7 w-auto gap-1.5 px-2 text-[13px]" onClick={(e) => e.stopPropagation()}>
                  <SelectValue placeholder="a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value="+new">New project…</SelectItem>
                </SelectContent>
              </Select>
            </span>
          }
          line={!reach.ok ? reach.line : project ? <ProjectRepos project={project} /> : "Add a project first"}
        />
        {account.signedIn ? (
          <Choice
            checked={scope === "team"}
            onSelect={() => setScope("team")}
            disabled={!account.admin || !reach.ok}
            title="Everyone on the team"
            line={!account.admin ? "Ask an admin: only admins install for the whole team" : !reach.ok ? reach.line : "Every person in your org, in every project"}
          />
        ) : null}
      </fieldset>
      {scope !== "me" ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="shrink-0">
            <Segmented label="Policy" value={chosenPolicy} options={policyChoices(account.admin)} onChange={setPolicy} />
          </span>
          <p className="min-w-0 text-[12.5px] text-muted-foreground">{POLICY_LINE[chosenPolicy]}</p>
        </div>
      ) : null}
      {signsIn && scope !== "me" ? (
        <fieldset className="mt-3 flex flex-col gap-1.5">
          <legend className="mb-2 text-[13px] text-muted-foreground">Sign-in</legend>
          <Choice checked={!isShared} onSelect={() => setShared(false)} title="Each person connects" line="Everyone signs in with their own account" />
          <Choice
            checked={isShared}
            onSelect={() => setShared(true)}
            disabled={!account.admin}
            title="One shared account"
            line={!account.signedIn ? "Needs a Caveman sign-in" : !account.admin ? "Only an admin can connect a shared account" : sharedLine(where, displayName(plugin))}
          />
        </fieldset>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
      <DialogFooter>
        <Button onClick={() => void install()} disabled={busy || (scope === "project" && !project) || (scope !== "me" && !reach.ok)}>
          {busy ? "Installing…" : scope !== "me" && reach.ok && reach.addToTeam ? `Add ${market?.display_name ?? plugin.marketplace} to the team and install` : "Install"}
        </Button>
      </DialogFooter>
      {addProject.dialog}
    </>
  );
}

/** "2 repos: acme/api-gateway, acme/workers" and an Add a repo menu of the other projects' repos. */
function ProjectRepos({ project }: { project: Project }) {
  const { client } = useRuntimeClient();
  const projects = useRuntimeSelector((v) => v.projects);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const repos = reposOf(project);
  const others = projects.flatMap(reposOf).filter((r, i, all) => !repos.some((x) => repoName(x) === repoName(r)) && all.findIndex((x) => repoName(x) === repoName(r)) === i);
  const [error, setError] = useState<string | null>(null);
  const add = (repository: string) =>
    client!.call("project.add_repo", { request_id: requestId(), project_id: project.id, repository }).then(
      () => refresh(),
      (e) => setError(message(e)),
    );
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span className="truncate">{repos.length === 0 ? "No repo linked" : repos.map((r) => r.full_name).join(", ")}</span>
      {others.length > 0 ? (
        <Select value="" onValueChange={(v) => void add(v)}>
          <SelectTrigger aria-label="Add a repo" className="h-6 w-auto border-0 bg-transparent px-1 text-[12.5px] text-foreground underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
            <SelectValue placeholder="Add a repo" />
          </SelectTrigger>
          <SelectContent>
            {others.map((r) => (
              <SelectItem key={repoName(r)} value={repoName(r)}>
                {r.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {error ? <span className="text-destructive">{error}</span> : null}
    </span>
  );
}

/** One option of a radio group, as a bordered row: its title, one line under it, and what it opens when chosen. */
function Choice(props: { checked: boolean; onSelect: () => void; disabled?: boolean; title: ReactNode; line: ReactNode; children?: ReactNode }) {
  return (
    <div
      role="radio"
      aria-checked={props.checked}
      aria-disabled={props.disabled}
      tabIndex={props.disabled ? -1 : 0}
      onClick={() => !props.disabled && props.onSelect()}
      onKeyDown={(e) => {
        if (!props.disabled && (e.key === " " || e.key === "Enter") && e.target === e.currentTarget) {
          e.preventDefault();
          props.onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border border-border px-3 py-2.5 outline-none transition-colors duration-75 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        props.checked && "border-ring/60 bg-accent/40",
        props.disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-input", props.checked && "border-foreground")}>
        {props.checked ? <span className="size-2 rounded-full bg-foreground" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium">{props.title}</span>
        <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{props.line}</span>
        {props.children}
      </span>
    </div>
  );
}

/** "Setup 1/2: Slack": one sign-in at a time; Skip moves on (it can connect later from its page). */
function Setup({ plugin, targets, where, onDone }: { plugin: PluginSummary; targets: ReadonlyArray<ConnectTarget>; where: string; onDone: () => void }) {
  const [at, setAt] = useState(0);
  return (
    <SignInStep
      key={at}
      plugin={plugin}
      target={targets[at]!}
      where={where}
      step={targets.length > 1 ? `Setup ${at + 1}/${targets.length}` : null}
      next={targets[at + 1]?.title}
      onNext={() => (at + 1 < targets.length ? setAt(at + 1) : onDone())}
    />
  );
}

/**
 * One service to sign in to, drawn as the connection it makes: Caveman on one side, the service on the
 * other, and between them the mark (ConnectMark) on a wire. Connect opens the service's page; while the
 * browser is open the wire carries dashes in, the plus blinks and the caveman thinks; once plugin.read says
 * connected the plus flips into the check, the wire goes solid green and the caveman raises his club. Every state says in words
 * what it is (the caption is a polite live region); the pictures only repeat it.
 */
export function SignInStep({ plugin, target, where, step, next, onNext }: { plugin: PluginSummary; target: ConnectTarget; where: string; step: string | null; next: string | undefined; onNext: () => void }) {
  const signIn = useSignIn({ pluginId: plugin.id, server: target.server, shared: target.shared });
  const { phase } = signIn;
  // Why it cannot be connected here: no app registered for the service, or a Cloud computer that takes no sign-in.
  const elsewhere = useConnectsElsewhere();
  const unavailable = target.unavailable ?? (elsewhere ? CONNECT_ELSEWHERE : undefined);
  const service = target.title;
  const account = target.shared ? `the team's ${service} account` : service;
  const mark: ConnectState = phase === "opening" || phase === "waiting" ? "waiting" : phase === "connected" ? "connected" : phase === "failed" ? "failed" : "add";
  const land = useLanded(mark === "connected");
  const caption =
    phase === "opening"
      ? `Opening ${service}'s sign-in page…`
      : phase === "waiting"
        ? `Waiting for you to sign in to ${service} in your browser`
        : phase === "connected"
          ? connectedLine(signIn.heldBy)
          : target.unavailable
            ? "Not available yet"
            : "Not connected";
  return (
    <>
      <DialogHeader>
        {step ? <p className="text-[12.5px] tabular-nums text-muted-foreground">{step}</p> : null}
        <DialogTitle className="text-[15px]">{phase === "connected" ? `${account.charAt(0).toUpperCase()}${account.slice(1)} is connected` : `Connect ${account}`}</DialogTitle>
        <DialogDescription>
          {phase === "connected" ? `Every engine can use ${displayName(plugin)} now.` : (unavailable ?? (target.shared ? sharedLine(where, service) : `Sign in to ${service} so every engine can use ${displayName(plugin)}.`))}
        </DialogDescription>
      </DialogHeader>
      <div className="caveman-night relative flex h-[132px] flex-col items-center justify-center gap-4 overflow-hidden rounded-xl border border-border text-white">
        <div aria-hidden className="flex items-center gap-3">
          <Mascot cut="bust" scale={3} pose={phase === "connected" ? "done" : phase === "failed" ? "error" : mark === "waiting" ? "thinking" : "idle"} animate={phase !== "idle"} />
          <Wire side="start" mark={mark} land={land} />
          <ConnectMark state={mark} land={land} scale={3} className={mark === "connected" ? "text-success" : "text-white"} />
          <Wire side="end" mark={mark} land={land} />
          <PluginLogo plugin={plugin} size="lg" className="shadow-[0_8px_24px_hsl(0_0%_0%/0.18)]" />
        </div>
        <p aria-live="polite" className="max-w-full truncate px-6 text-[12.5px] text-white/70">
          {caption}
        </p>
      </div>
      <ErrorLine>{phase === "failed" ? signIn.problem : null}</ErrorLine>
      <DialogFooter>
        {phase === "connected" ? (
          <Button autoFocus onClick={onNext}>
            {next ? `Next: ${next}` : "Done"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onNext}>
              Skip
            </Button>
            {signIn.reopen ? (
              <Button variant="secondary" onClick={signIn.reopen}>
                Open the page again
              </Button>
            ) : (
              <Button onClick={() => void signIn.connect()} disabled={mark === "waiting" || unavailable !== undefined}>
                {phase === "failed" ? "Try again" : "Connect"}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}

/** The wire either side of the mark (pixel.css `.px-wire`), on the scene's 3x grid: faint dashes, dashes running in while the sign-in is open, solid green once made. */
function Wire({ side, mark, land }: { side: "start" | "end"; mark: ConnectState; land: boolean }) {
  return (
    <span
      className={cn("px-wire", mark === "connected" ? "text-success" : mark === "waiting" ? "text-white/60" : "text-white/25")}
      style={{ "--px-scale": 3, "--px-len": 20 } as CSSProperties}
      data-side={side}
      data-flow={mark === "waiting" ? "in" : undefined}
      data-state={mark === "connected" ? "made" : undefined}
      data-land={land || undefined}
    />
  );
}
