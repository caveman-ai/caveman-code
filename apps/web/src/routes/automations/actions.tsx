// What the Automations pages do, each in one place, so a row's menu, an automation's page and a run say and do the
// same thing. What happened (or why it could not) lands as one notice at the bottom of the window.
import type { AutomationTemplateSummary, Project } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { refEdit } from "../../components/thread-refs.ts";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { HOSTED_CLOUD } from "../../state/cloud.ts";
import { flushDrafts, keepDraft } from "../../state/composer-drafts.ts";
import { chatEngine, NO_ENGINE } from "../../state/engines.ts";
import { requestId, useRuntimeGetter, useRuntimeSelector } from "../../state/runtime.tsx";
import { appliedFor, CONSOLE, consoleUrl, deployedWords, notServed, readApplied, signedOut, type CloudRun, type LocalGateView } from "./cloud.ts";
import { LIST, message, patch, refresh, rememberApplied, showHooks } from "./data.ts";
import { agentPath, agentsUsed, automationPath, canRun, checkoutOf, copyName, deleteWords, fileRef, isDraft, legacyToYaml, needsForm, renamedWords, slug, type Automation, type Scope } from "./model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

// ------------------------------------------------------------ notices

type Notice = { id: number; text: string; tone: "info" | "error"; action?: { label: string; run: () => void } | undefined };
let current: Notice | null = null;
let seq = 0;
const noticeListeners = new Set<() => void>();
const setNotice = (n: Notice | null) => {
  current = n;
  for (const l of noticeListeners) l();
};

/** One line at the bottom of the window for a few seconds; a newer one replaces it. */
export function say(text: string, tone: Notice["tone"] = "info", action?: Notice["action"]): void {
  const id = ++seq;
  setNotice({ id, text, tone, action });
  setTimeout(() => current?.id === id && setNotice(null), tone === "error" ? 9000 : 6000);
}

export function Notices() {
  const n = useSyncExternalStore(
    (l) => (noticeListeners.add(l), () => noticeListeners.delete(l)),
    () => current,
    () => current,
  );
  if (!n) return null;
  return (
    <div
      key={n.id}
      role={n.tone === "error" ? "alert" : "status"}
      className="fixed bottom-5 left-1/2 z-50 flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-[12px] border border-border bg-popover py-1.5 pl-3 pr-1.5 text-[13px] shadow-overlay animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-snap"
    >
      <Glyph name={n.tone === "error" ? "state-failed" : "engine-caveman"} />
      <span className={cn("min-w-0 py-1", n.tone === "error" ? "text-destructive" : "text-foreground")}>{n.text}</span>
      {n.action ? (
        <Button size="sm" variant="secondary" onClick={() => (n.action!.run(), setNotice(null))}>
          {n.action.label}
        </Button>
      ) : null}
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setNotice(null)}>
        <Icon icon={Cancel01Icon} className="size-3.5" />
      </Button>
    </div>
  );
}

// ------------------------------------------------------------ actions

export const detailPath = (id: string) => `/automations/${encodeURIComponent(id)}`;
/** Its settings: the form, or with `tab` the file itself ("file") or its deliveries. */
export const settingsPath = (id: string, tab?: "file" | "deliveries") => `/automations/${encodeURIComponent(id)}/settings${tab ? `?tab=${tab}` : ""}`;
/** Its page with the Run now form open (its inputs, the issue or pull request it is about). */
export const runFormPath = (id: string) => `/automations/${encodeURIComponent(id)}?run=1`;
export const runPath = (id: string, runId: string) => `/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`;

/** The text Build with agent types into a new chat, after the automations skill: the person finishes the sentence. */
export const DESCRIBE_TEXT = "Write an automation for this project that ";
/** The text "New agent" types into a new chat, after the automations skill (it writes agent files too). */
export const DESCRIBE_AGENT_TEXT = "Write an agent for this project, one file in .caveman/agents/, that ";

/** The Cloud this runtime signs in to: where console links go. */
export function useConsoleBase(): string {
  return useRuntimeSelector((v) => v.settings?.cloud_url) ?? HOSTED_CLOUD;
}

/** Why a Cloud action didn't happen, in one sentence that says what to do. */
export function cloudProblem(e: unknown): string {
  if (notServed(e)) return "This version of Caveman Code can't reach Cloud automations yet. Update it, then try again.";
  if (signedOut(e)) return "Caveman needs you to sign in again.";
  return message(e);
}


/** A commit runs the repository's hooks, which the runtime gives 10 minutes (its COMMIT_TIMEOUT_MS): a minute more, so its own answer comes first. */
const COMMIT_TIMEOUT_MS = 11 * 60_000;

const SUGGEST_TEXT =
  "Use the scout agent to find chores in this project that an automation could do for me: it reads the project's memory notes and my chats from the last 30 days. Show me its drafts, and once I pick one, write it with the automations skill and check it.";

export function useActions() {
  const client = useRuntimeSelector((v) => v.client);
  const projects = useRuntimeSelector((v) => v.projects);
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const adopt = useRuntimeSelector((v) => v.adopt);
  const refreshWorkspaces = useRuntimeSelector((v) => v.refresh);
  // Read at click time: subscribing would redraw on every workspace push.
  const getRuntime = useRuntimeGetter();
  const navigate = useNavigate();
  const need = () => {
    if (!client) throw new Error("Not connected to a runtime.");
    return client;
  };
  const projectOf = (id: string): Project => {
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error("That project isn't on this computer.");
    return p;
  };
  const consoleBase = useConsoleBase();
  const startDescribing = (projectId: string | null, text: string) => {
    const pill = refEdit("", 0, 0, { workspace_id: "", title: "automations", skill: "automations" });
    keepDraft("new-chat", { text: pill.insert + text, refs: [pill.ref] });
    flushDrafts("new-chat");
    navigate(projectId ? `/new?project=${encodeURIComponent(projectId)}` : "/new");
  };
  const tryIt = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      say(`${what}: ${message(e)}`, "error");
    }
  };
  const created = (r: { automation: Automation; written: ReadonlyArray<string>; renamed?: ReadonlyArray<{ from: string; to: string }> | undefined }, wrote: string, tab?: "file") => {
    refresh(client, LIST);
    navigate(tab ? settingsPath(r.automation.id, tab) : detailPath(r.automation.id));
    say([wrote, renamedWords(r.renamed)].filter(Boolean).join(" "));
  };

  /** A run outside its triggers, on an issue or pull request when it names one. A file's outputs wait for Apply on the run. */
  const runNow = (a: Automation, opts: { inputs?: Record<string, string>; subject?: string } = {}) =>
    tryIt(`Couldn't start ${a.title}`, async () => {
      const inputs = Object.fromEntries(Object.entries(opts.inputs ?? {}).filter(([, v]) => v.trim() !== ""));
      const r = await need().call("automation.run", { request_id: requestId(), id: a.id, ...(Object.keys(inputs).length > 0 ? { inputs } : {}), ...(opts.subject ? { subject: opts.subject } : {}) });
      refresh(client, LIST);
      refresh(client, "runs:");
      if (r.run_id) navigate(runPath(a.id, r.run_id));
      else say(`${a.title} started a chat.`);
    });

  return {
    /** Shown at once; put back if the runtime refuses, else read again, so a read that crossed the write never lands. */
    setEnabled: async (a: Automation, enabled: boolean) => {
      const flip = (on: boolean) => patch<ReadonlyArray<Automation>>(LIST, (list) => list.map((x) => (x.id === a.id ? { ...x, enabled: on } : x)));
      flip(enabled);
      try {
        await need().call("automation.set_enabled", { request_id: requestId(), id: a.id, enabled });
        refresh(client, LIST);
      } catch (e) {
        flip(!enabled);
        say(`Couldn't turn ${a.title} ${enabled ? "on" : "off"}: ${message(e)}`, "error");
      }
    },

    runNow,

    /** The person allows a schedule an agent set to run on Cloud: it starts there now. */
    allow: (a: Automation) =>
      tryIt(`Couldn't allow ${a.title}`, async () => {
        try {
          await need().call("automation.allow", { request_id: requestId(), id: a.id });
          say(`${a.title} runs on Cloud now.`);
        } finally {
          refresh(client, LIST);
        }
      }),

    /**
     * Run now from a row's menu: at once, or on its page with the form open when it asks for something first. `here`
     * starts it without leaving the page (a Chief's routine); a form still opens on its page.
     */
    startRun: (a: Automation, here?: (a: Automation) => void) =>
      a.source === "file" && needsForm(a) ? navigate(runFormPath(a.id)) : here ? here(a) : void runNow(a),

    /**
     * A Me draft a chat wrote in its worktree, into the project's own checkout and on: the person's yes. Never over a
     * different file of that name in the project (`taken`: its automations, every file of that folder among them). True
     * when on.
     */
    install: async (a: Automation, taken: ReadonlyArray<Automation>): Promise<boolean> => {
      const ref = fileRef(a.id);
      try {
        if (!ref || !a.path || ref.scope !== "me" || !isDraft(a)) throw new Error("Only a Me draft in a chat's worktree is added here.");
        const own = `file:${a.project_id}:me:${ref.name}`;
        if (taken.some((x) => x.id === own)) {
          say(`This project has a different ${ref.name} already. Edit that one, or have the chat give its draft another name.`, "error");
          return false;
        }
        const c = need();
        const { text } = await c.call("automation.file_read", { project_id: checkoutOf(a), path: a.path });
        const r = await c.call("automation.create", { request_id: requestId(), project_id: a.project_id, scope: "me", from: { text, name: ref.name } });
        if (!r.automation.enabled) await c.call("automation.set_enabled", { request_id: requestId(), id: r.automation.id, enabled: true });
        refresh(client, LIST);
        say([`${r.automation.title} is on.`, renamedWords(r.renamed)].filter(Boolean).join(" "));
        return true;
      } catch (e) {
        say(`Couldn't turn ${a.title} on: ${message(e)}`, "error");
        return false;
      }
    },

    /** Out of the list once the runtime has deleted it, never before: a refused delete leaves it there. True when deleted. */
    remove: async (a: Automation): Promise<boolean> => {
      try {
        await need().call("automation.delete", { request_id: requestId(), id: a.id });
      } catch (e) {
        say(`Couldn't delete ${a.title}: ${message(e)}`, "error");
        return false;
      }
      patch<ReadonlyArray<Automation>>(LIST, (list) => list.filter((x) => x.id !== a.id));
      refresh(client, LIST);
      say(deleteWords(a).done);
      return true;
    },

    duplicate: (a: Automation, taken: ReadonlyArray<Automation>) =>
      tryIt(`Couldn't duplicate ${a.title}`, async () => {
        const ref = fileRef(a.id);
        if (!ref || !a.path) throw new Error("Only automation files duplicate.");
        const { text } = await need().call("automation.file_read", { project_id: checkoutOf(a), path: a.path });
        const name = copyName(ref.name, new Set(taken.map((x) => fileRef(x.id)?.name)));
        const r = await need().call("automation.create", { request_id: requestId(), project_id: a.project_id, scope: ref.scope, from: { text, name } });
        created(r, `Wrote ${r.written[0] ?? name}.`, "file");
      }),

    /**
     * An app-saved automation as a Me file. The app's copy turns off so nothing runs twice, unless the file has errors
     * (it would never run, so the schedule would stop); it is never deleted here.
     */
    saveAsFile: (a: Automation) =>
      tryIt(`Couldn't save ${a.title} as a file`, async () => {
        const c = need();
        const r = await c.call("automation.create", {
          request_id: requestId(),
          project_id: a.project_id,
          scope: "me",
          from: { text: legacyToYaml(a, Intl.DateTimeFormat().resolvedOptions().timeZone), name: slug(a.title) },
        });
        const where = r.written[0] ?? "a file";
        if (a.enabled && !canRun(r.automation)) {
          created(r, `Saved as ${where}, but it has errors, so the app's copy stays on until the file works.`, "file");
          return;
        }
        if (a.enabled) await c.call("automation.set_enabled", { request_id: requestId(), id: a.id, enabled: false });
        created(r, `Saved as ${where}. The app's copy is off; delete it once the file works.`, "file");
      }),

    /**
     * A Project file onto a branch of its own and a pull request: a chat's worktree on a new branch, the saved files
     * written there, committed, pushed, and the pull request opened. Answers the pull request's URL.
     */
    openPr: async (a: Automation): Promise<string | null> => {
      try {
        const c = need();
        const ref = fileRef(a.id);
        if (!ref || !a.path) throw new Error("Only automation files go in a pull request.");
        const project = projectOf(a.project_id);
        // The automation, and the project's own agents it names (a step's or an agent check's); a .claude agent stays out.
        const [{ explanation }, types] = await Promise.all([
          c.call("automation.explain", { project_id: checkoutOf(a), name: ref.name, scope: ref.scope }).catch(() => ({ explanation: null })),
          c.call("agent.types", { project_id: a.project_id }).then((r) => r.types, () => []),
        ]);
        const named: Array<{ name: string; from?: string }> = explanation ? agentsUsed(explanation) : (a.steps ?? []).flatMap((st) => (st.agent ? [{ name: st.agent }] : []));
        const agents = named.flatMap((g) => {
          const t = types.find((x) => x.name === g.name);
          if (t && t.source !== "project") return [];
          return t?.path ? [t.path] : g.from?.startsWith("agents/") ? [`.caveman/${g.from}`] : t ? [agentPath(g.name)] : [];
        });
        const read = async (path: string) => ({ path, text: (await c.call("automation.file_read", { project_id: checkoutOf(a), path })).text });
        const list = [await read(a.path), ...(await Promise.all([...new Set(agents)].map((p) => read(p).catch(() => null)))).filter((f) => f !== null)];
        // A second time, the branch and its chat from the first: the new commit lands on the same pull request.
        const branch = `caveman/automation-${ref.name}`;
        const open = getRuntime().workspaces.find((w) => w.projectId === a.project_id && w.branch === branch && w.state !== "archived");
        let id = open?.id;
        if (!id) {
          const w = await c.call("workspace.create", { request_id: requestId(), repo: { path: project.path }, branch, title: `Add the ${a.title} automation` });
          if (adopt) adopt(w);
          else void refreshWorkspaces();
          id = w.id;
        }
        for (const f of list) await c.call("fs.write", { request_id: requestId(), workspace_id: id, path: f.path, content: f.text });
        await c.call("git.commit", { request_id: requestId(), workspace_id: id, message: `feat(automations): ${open ? "update" : "add"} ${ref.name}`, paths: list.map((f) => f.path) }, { timeoutMs: COMMIT_TIMEOUT_MS });
        await c.call("git.push", { request_id: requestId(), workspace_id: id });
        if (open?.pullRequest && (open.pullRequest.state === "open" || open.pullRequest.state === "draft")) {
          say(`Pushed to pull request #${open.pullRequest.number}.`, "info", { label: "Open", run: () => window.open(open.pullRequest!.url, "_blank", "noreferrer") });
          return open.pullRequest.url;
        }
        const pr = await c.call("git.pr", {
          request_id: requestId(),
          workspace_id: id,
          title: `Add the ${a.title} automation`,
          body: `${a.description ?? a.title}\n\nIts triggers start once this merges to the default branch. Files: ${list.map((f) => `\`${f.path}\``).join(", ")}.`,
        });
        say(`Opened pull request #${pr.number}.`, "info", { label: "Open", run: () => window.open(pr.url, "_blank", "noreferrer") });
        return pr.url;
      } catch (e) {
        say(`Couldn't open a pull request: ${message(e)}`, "error");
        return null;
      }
    },

    /** Build with agent: a new chat in the project with the automations skill and the sentence started (or ended with `words`). */
    describe: (projectId: string | null, words = "") => startDescribing(projectId, DESCRIBE_TEXT + words),

    /** "New agent": the same, for one agent file; publishing it is the Agents page's Publish. */
    describeAgent: (projectId: string | null) => startDescribing(projectId, DESCRIBE_AGENT_TEXT),

    /**
     * Deploy to Cloud: the project's `.caveman/` files go to Cloud, which keeps the `host: cloud` ones as automations.
     * What Cloud made of each (its revision, held for approval or not, what changed) stays on the page; a new
     * webhook's URL and secret show once, and only in memory. True when sent.
     */
    deploy: async (a: Automation): Promise<boolean> => {
      try {
        const project = projectOf(a.project_id);
        const r = await need().call("automation.apply", { request_id: requestId(), repo_root: project.path, project_id: a.project_id });
        const { kept, hooks } = readApplied(r, new Date().toISOString(), consoleBase);
        rememberApplied(a.project_id, kept);
        showHooks(hooks);
        refresh(client, "cloud-");
        const mine = appliedFor(r.automations, a, fileRef(a.id)?.name ?? a.title);
        const page = mine ? consoleUrl(consoleBase, CONSOLE.automation(mine.id)) : null;
        say(deployedWords(r.automations), "info", page ? { label: "Open in Platform", run: () => openExternal(page) } : undefined);
        return true;
      } catch (e) {
        say(`Couldn't deploy ${a.title}: ${cloudProblem(e)}`, "error", signedOut(e) ? { label: "Sign in", run: () => navigate("/settings/account") } : undefined);
        return false;
      }
    },

    /** Publish to Cloud: one agent file as a new version of the org's agent (the same file keeps its version). */
    publish: async (projectId: string, path: string, name: string): Promise<boolean> => {
      try {
        const r = await need().call("agent.publish", { request_id: requestId(), project_id: projectId, path });
        refresh(client, "published");
        const page = consoleUrl(consoleBase, CONSOLE.agent(r.agent_id));
        say(r.unchanged ? `Cloud already has this file as ${name} v${r.version}.` : `Published ${name} as v${r.version}.`, "info", { label: "Open in Platform", run: () => openExternal(page) });
        return true;
      } catch (e) {
        say(`Couldn't publish ${name}: ${cloudProblem(e)}`, "error", signedOut(e) ? { label: "Sign in", run: () => navigate("/settings/account") } : undefined);
        return false;
      }
    },

    /** Answers a Cloud run's approval gate: it goes on, or stops at that step. */
    answerCloud: async (run: CloudRun, name: string, decision: "allow" | "deny"): Promise<boolean> => {
      try {
        const askId = run.requires_action?.ask_id;
        if (!askId) throw new Error("This run isn't waiting on anyone now.");
        await need().call("automation.cloud_answer", { request_id: requestId(), run_id: run.run_id, ask_id: askId, decision, ...(run.session_id ? { session_id: run.session_id } : {}) });
        refresh(client, "cloud-runs");
        say(decision === "allow" ? `Approved. ${name} goes on.` : `Rejected. ${name} stops at that step.`);
        return true;
      } catch (e) {
        say(`Couldn't answer ${name}: ${cloudProblem(e)}`, "error");
        return false;
      }
    },

    /** Answers a This Mac run's approval gate: approve lets the step go on, reject fails it there. */
    answerLocal: async (gate: LocalGateView, decision: "allow" | "deny", runId: string): Promise<boolean> => {
      try {
        await need().call("automation.approve", { request_id: requestId(), run_id: runId, step: gate.step, decision: decision === "allow" ? "approve" : "reject" });
        refresh(client, `run:${runId}`);
        refresh(client, "gates");
        refresh(client, LIST);
        say(decision === "allow" ? `Approved. ${gate.step} goes on.` : `Rejected. The run stops at ${gate.step}.`);
        return true;
      } catch (e) {
        say(`Couldn't answer the run: ${message(e)}`, "error");
        return false;
      }
    },

    /** "Suggest some": a chat that asks the scout for drafts, opened at once. */
    suggest: (projectId: string | null) =>
      tryIt("Couldn't start the scout", async () => {
        const project = projectOf(projectId ?? projects[0]?.id ?? "");
        const engine = chatEngine(engines, null, settings?.default_engine);
        if (!engine) throw new Error(NO_ENGINE);
        const w = await need().call("workspace.create", { request_id: requestId(), repo: { path: project.path }, engine: engine.id, title: "Chores to automate", task: { text: SUGGEST_TEXT } });
        if (adopt) adopt(w);
        else await refreshWorkspaces();
        navigate(`/w/${encodeURIComponent(w.id)}`);
      }),

    fromTemplate: (t: AutomationTemplateSummary, scope: Scope, projectId: string) =>
      tryIt(`Couldn't create ${t.title}`, async () => {
        const r = await need().call("automation.create", { request_id: requestId(), project_id: projectId, scope, from: { template: t.id } });
        created(r, `Wrote ${r.written.length === 1 ? r.written[0] : `${r.written.length} files`}.`);
      }),

    /** Start from scratch's Create: the form's file into the project, then its page. True when written. */
    createFile: async (name: string, text: string, scope: Scope, projectId: string): Promise<boolean> => {
      try {
        const r = await need().call("automation.create", { request_id: requestId(), project_id: projectId, scope, from: { text, name } });
        created(r, `Wrote ${r.written[0] ?? automationPath(scope, name)}.`);
        return true;
      } catch (e) {
        say(`Couldn't create ${name}: ${message(e)}`, "error");
        return false;
      }
    },
  };
}

export type Actions = ReturnType<typeof useActions>;
