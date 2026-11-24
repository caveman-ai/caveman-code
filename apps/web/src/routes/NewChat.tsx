import { Button } from "@caveman-app/ui/components/button";
import { ModelPicker, type PickerLock } from "@caveman-app/ui/components/model-picker";
import { Icon, Folder01Icon, Key01Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { duration, ease } from "@caveman-app/ui/motion";
import { Link, useLocation, useNavigate } from "react-router";
import { useSyncExternalStore } from "react";
import { Composer, focusWhenOpened, useTurnChoice, withModelSources, type Attachment, type NewChatPick, type TurnChoice } from "../components/Composer.tsx";
import { GazeMascot } from "../components/GazeMascot.tsx";
import { UnlockPlans } from "../components/UnlockPlans.tsx";
import { WebStartCard } from "../components/WebStartCard.tsx";
import { LAST_PROJECT, ProjectBadge, ProjectPicker, useAddProject, useLastProject } from "../components/ProjectPicker.tsx";
import { useRuntimeTargets } from "../components/RuntimeTargets.tsx";
import { chatPath, panes, windowTabs } from "../panes/store.ts";
import { chatEngine, engineReady, NO_ENGINE, needsEngine } from "../state/engines.ts";
import { chosenRuntime, cloudStartOptions, GITHUB_CONNECT_PATH, hostedAccount } from "../state/cloud.ts";
import { deviceStatusOf, subscribeDeviceStatus } from "../state/device-approval.ts";
import { runOnLabel, useEnvironment } from "../state/environment.ts";
import { thisComputer } from "../lib/platform.ts";
import { requestId, useRuntimeClient, useRuntimeSelector, useSyncHub, useWebWindow } from "../state/runtime.tsx";
import { projectSources, type Params, type Project } from "@caveman-app/session-protocol";
import { cloudLeavesOut, cloudPill, createSources, leftOutSources, rememberLeftOut, sourcesFor, staysOnMacLine, tickedSources, toggleSource, withoutLabel } from "../state/sources.ts";
import { SidebarMenuButton } from "../shell/SidebarToggle.tsx";
import type { CloudStartState } from "./CloudStart.tsx";
import { CloudNeedLine } from "../components/cloud/EngineSignIn.tsx";
import { cloudPickerEngines, shownModel, startModel } from "./cloud-models.ts";
import { CLOUD_ENGINES, cloudStartNeed, type CloudStartNeed } from "./cloud-need.ts";
import { useCloudConnectionList } from "./settings/Connections.tsx";
import { agentsFromCloud, connectLabel, planOf, type PlanEngine } from "./settings/connections-model.ts";
import { NewChatBar, RepoMenu, type Where } from "./new-chat-bar.tsx";
import { NextAction } from "../shell/NeedsMac.tsx";
import { DOWNLOAD_URL, macNext } from "../state/sync/web-window.ts";
import { CONNECT_REPOSITORY, useWebNewChat } from "./new-chat-web.ts";
import { lidMoves } from "./settings/lid-summary.ts";
import { Wallpaper } from "../wallpaper/Wallpaper.tsx";
import { useSaveSettings } from "./settings/rows.tsx";
import { useWallpaper } from "../wallpaper/store.ts";
import { Transcript } from "../components/Transcript.tsx";
import { firstMessage, handOff, type FirstMessage } from "../state/started-chat.ts";

/**
 * A new chat (the sidebar's New chat, a folder's +, ⌘N on desktop), and the one place a chat starts: "What should we
 * build in <project>?" over the composer, on the default agent, the two together in the middle of the page over the
 * person's wallpaper, the companion standing on the box (wallpaper/Wallpaper.tsx; an empty pane keeps the compact
 * layout and the plain panel). The question picks the project; the box's foot
 * (new-chat-bar.tsx) picks the branch it starts from, the repositories it works in, where it runs (this Mac, another
 * Mac of the person's, or Cloud), and the runs of it. One line under that says what the pick still needs, before
 * Send. Sending creates the chat with the message as its first turn and opens it in
 * the split view without taking another chat's pane (tree.place). `?project=` picks the project; otherwise the last
 * one used.
 *
 * In a browser window (new-chat-web.ts) the places are Cloud and the person's Macs that are on line, Cloud first: a
 * chat there starts on a repository Cloud sees, on one of the agents Cloud runs, with no computer asked for anything.
 * Its Send is one request, which Cloud keeps: the chat opens at once with the message in it, as one made here does,
 * and its computer starts it when it is up (state/sync/hub.ts `startQueued`).
 */
export function NewChatRoute() {
  return <NewChat />;
}

const NO_FAVORITES: ReadonlyArray<string> = [];

/** Text the new chat's box opens with (route state `prompt`), after a mention of a plugin when one is named. */
export interface NewChatPrompt {
  readonly plugin?: { readonly id: string; readonly label: string };
  readonly text: string;
}

export interface NewChatProps {
  /**
   * An empty pane's id: the compact layout, the pane's own project pick (not
   * the URL's), no kept draft, and the chat opens in that pane.
   */
  readonly pane?: string;
  /** Focus the message box on mount (a pane: when it is the focused one). */
  readonly autoFocus?: boolean;
  /** The header's right end (a pane's close button). */
  readonly actions?: ReactNode;
  /** Under the question, in a pane: chats to open there instead. */
  readonly children?: ReactNode;
}

/** The new-chat screen: the New chat route, and every empty pane of the split view. */
export function NewChat({ pane, autoFocus = true, actions, children }: NewChatProps) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const projects = useRuntimeSelector((v) => v.projects);
  const identity = useRuntimeSelector((v) => v.identity);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const adopt = useRuntimeSelector((v) => v.adopt);
  const navigate = useNavigate();
  // Try in chat (Plugins): the prompt arrives typed in, after a mention of its plugin; Search's New chat (⇥): what
  // was typed there. Another engine's model picked in a chat (pick): this chat starts on it. All come with the route,
  // never into a pane.
  const routeState = useLocation().state;
  const state = pane ? null : (routeState as { prompt?: NewChatPrompt; pick?: NewChatPick } | null);
  const prompt = state?.prompt;
  const pick = state?.pick;
  const box = useRef<HTMLDivElement>(null);
  const ready = useMemo(() => engines.filter(engineReady), [engines]);
  const [engineId, setEngineId] = useState<string | null>(pick?.engine ?? null);
  const engine = chatEngine(engines, engineId, settings?.default_engine);

  // A browser window: where the chat runs is its own pick of place (Cloud, or a Mac on line). A chat in Cloud there
  // is no runtime's to make, so nothing of the runtime the window quietly uses (its projects, branches, agents) shows.
  const web = useWebWindow();
  const hub = useSyncHub();
  // A chat whose start Cloud queued opens through the hub, which needs Cloud's list of the person's chats for it.
  const webChat = useWebNewChat(web, { opens: () => hub?.hasCloud() === true });
  const webCloud = webChat !== null && webChat.where === "cloud";
  /** The chat is made by this window's runtime: the desktop app's own, or the Mac a browser window is put on. */
  const onRuntime = webChat === null || (webChat.where !== null && !webCloud);
  const last = useLastProject({ inUrl: !pane });
  const project = onRuntime ? last.project : null;
  const focus = () =>
    requestAnimationFrame(() => {
      const ta = box.current?.querySelector("textarea");
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    });
  const choose = (id: string) => {
    last.choose(id);
    focus();
  };
  const add = useAddProject((p) => choose(p.id));
  useEffect(() => {
    if (autoFocus) focus();
  }, []);
  // Sent: the box docks where the chat's box stands and the message shows above it with the turn's working line, laid
 // out as the chat lays them out, while the chat is made (upstream draft hero docking). The chat then opens on
  // the same picture (state/started-chat.ts), so nothing on screen moves. A refused start undocks, the words back in
  // the box.
  const [sent, setSent] = useState<{ readonly first: FirstMessage; readonly model: string | undefined } | null>(null);
  const from = useRef<{ readonly box: DOMRect; readonly field: number } | null>(null);
  const moving = useRef<Animation | null>(null);
  // The model the chat's line will name before its turn says one: the same default its pane works out (PaneFrame).
  const { model: defaultModel } = useTurnChoice(engine?.id, { projectId: project?.id ?? null });
  const measure = () => {
    const el = box.current;
    const field = el?.querySelector<HTMLElement>(".composer-field");
    return el && field ? { box: el.getBoundingClientRect(), field: field.getBoundingClientRect().height } : null;
  };
  const dock = (text: string, attachments: Attachment[], model: string | undefined) => {
    const first = firstMessage(text, attachments);
    from.current = measure();
    flushSync(() => setSent({ first, model: model ?? defaultModel?.id }));
    return first;
  };
  /** The box lands before the chat opens on it: a chat made faster than the move would cut it short. */
  const docked = () => moving.current?.finished.then(() => undefined, () => undefined);
  const undock = () => {
    from.current = measure();
    setSent(null);
  };
  // The box travels from where it was to where it docks (FLIP): its centre, its width and its field's height (a
  // chat's empty box is shorter), never a scale, so its words and keys never stretch. Docked, the box stands on the
  // page's foot: as its field shrinks the box's top comes down with it, so the move starts that much higher.
  useLayoutEffect(() => {
    const el = box.current;
    const field = el?.querySelector<HTMLElement>(".composer-field");
    const was = from.current;
    from.current = null;
    if (!el || !field || !was || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = el.getBoundingClientRect();
    const tall = field.getBoundingClientRect().height;
    const dx = was.box.left + was.box.width / 2 - (now.left + now.width / 2);
    const dy = was.box.top - now.top + (sent ? was.field - tall : 0);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(was.box.width - now.width) < 0.5) return;
    const timing = { duration: duration.slow, easing: ease.snap };
    const move = el.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0)`, width: `${was.box.width}px` },
        { transform: "translate3d(0, 0, 0)", width: `${now.width}px` },
      ],
      timing,
    );
    const grow = Math.abs(was.field - tall) >= 0.5 ? field.animate([{ minHeight: `${was.field}px` }, { minHeight: `${tall}px` }], timing) : null;
    moving.current = move;
    return () => {
      move.cancel();
      grow?.cancel();
    };
  }, [sent]);

  // The page's wallpaper; a pane keeps the plain panel.
  const worn = useWallpaper();
  const wallpaper = pane ? { ...worn, source: "none" } : worn;
  const dressed = wallpaper.source !== "none";
  // Where it runs: this Mac, another Mac of the person's (its own runtime makes the chat), or Cloud (routes/CloudStart.tsx).
  const [ownWhere, setWhere] = useState<"this_mac" | "cloud">("this_mac");
  const other = useRuntimeTargets(web === null);
  const macs = useMemo(() => other.targets.filter((t) => t.kind === "laptop").map((t) => ({ id: t.runtimeId, name: t.name })), [other.targets]);
  const mac = macs.find((m) => m.id === other.target);
  const where: Where = mac ? `mac:${mac.id}` : ownWhere;
  // The branch it starts from, for the project it was picked in; none: the branch the checkout is on.
  const [picked, setPicked] = useState<{ project: string; branch: string } | null>(null);
  const base = picked !== null && picked.project === project?.id ? picked.branch : null;
  // A project with several sources: the chat works in all of them until the person unticks one, and the pick is
  // remembered per project (what was left out, so a source added later starts ticked).
  const sources = project ? projectSources(project) : [];
  const [leftOut, setLeftOut] = useState<Readonly<Record<string, ReadonlyArray<string>>>>({});
  const out = project ? (leftOut[project.id] ?? leftOutSources(localStorage, project.id)) : [];
  const ticked = tickedSources(sources, out);
  const toggle = (name: string) => {
    if (!project) return;
    const next = toggleSource(sources, out, name);
    rememberLeftOut(localStorage, project.id, next);
    setLeftOut((all) => ({ ...all, [project.id]: next }));
  };
  const cloudEnv = useEnvironment(web !== null ? null : (project?.id ?? null));
  const cloud = runOnLabel(cloudEnv.answer);
  // Cloud that cannot be picked for this project (off, signed out, not on GitHub) leaves the chat on this Mac. In a
  // browser window the Mac it is put on is "this Mac" to everything below: its own runtime makes the chat.
  const runsOn: Where = webChat ? (webCloud ? "cloud" : "this_mac") : where === "cloud" && cloud.disabled !== undefined ? "this_mac" : where;
  // Cloud takes repositories on GitHub: a ticked folder (or a repository with no GitHub link) is left out there, and
  // the pill says so. The ticks stay the person's: back on a Mac the chat works in all of them again.
  const leftForCloud = runsOn === "cloud" ? cloudLeavesOut(ticked) : [];
  const worksIn = sourcesFor(ticked, runsOn === "cloud");
  // The task as several chats (runs).
  const [count, setRuns] = useState(1);
  // What the pick still needs, said under the box before Send, one line at a time: Cloud for an agent that has no
  // plan or key there (or does not run there); another Mac that has yet to allow this device; a chat in several
  // repositories that will not keep going in Cloud although the person chose that.
  const now = useMemo(() => Date.now(), [engine, runsOn]);
  // A browser window with no computer behind it asks Cloud's own list of the person's plans and keys.
  const cloudList = useCloudConnectionList(webCloud).list;
  const cloudAgents = useMemo(() => (cloudList ? agentsFromCloud(cloudList) : []), [cloudList]);
  const cloudAgent = webCloud ? cloudAgents.find((a) => a.id === webChat.agent) : engine;
  const need = runsOn === "cloud" ? cloudStartNeed(cloudAgent, now) : null;
  // The picker of a chat this window's runtime does not make (cloud-models.ts): the agents Cloud runs with the models
  // Cloud lists for them, and what cannot be picked yet greyed over the way to it. With no place to run a chat at
  // all, everything is greyed over the step that brings the person's Mac here.
  const macStep = web ? macNext(web.mac) : null;
  const cloudPicker = useMemo(() => {
    if (!webChat || onRuntime) return null;
    const nowhere: PickerLock | undefined =
      webChat.where === null
        ? {
            title: macStep?.title ?? "No place can run a chat now.",
            line: macStep?.line,
            action:
              macStep?.action?.kind === "download"
                ? { label: macStep.action.label, run: () => void window.open(DOWNLOAD_URL, "_blank", "noopener") }
                : macStep?.action?.kind === "connect"
                  ? ((place) => ({ label: macStep.action!.label, run: () => web?.usePlace(place) }))(macStep.action.place)
                  : undefined,
          }
        : undefined;
    const plans = (id: PlanEngine): PickerLock | undefined => {
      const needs = cloudStartNeed(cloudAgents.find((a) => a.id === id), now);
      if (!needs || needs.kind === "unsupported") return undefined;
      const title = needs.kind === "connect" ? `Connect your ${planOf(id)!.name} to use ${id === "codex" ? "Codex" : "Claude Agent"} in Cloud.` : needs.line;
      return { title, action: needs.kind === "admin_off" ? undefined : { label: needs.kind === "reconnect" ? "Reconnect" : connectLabel(id), run: () => navigate("/settings/models") } };
    };
    // A Cloud computer this window is on lists the same agents with their real names, efforts and speeds.
    const live = web?.home?.kind === "cloud" ? withModelSources(engines.filter((e) => CLOUD_ENGINES.has(e.id))) : [];
    const listed = cloudPickerEngines({
      live,
      plan: webChat.plan,
      locks: {
        caveman: nowhere ?? (webChat.free ? { title: "Caveman's models come with a plan.", action: { label: "Unlock", run: () => webChat.unlock.onOpenChange(true) } } : undefined),
        "claude-agent": nowhere ?? plans("claude-agent"),
        codex: nowhere ?? plans("codex"),
      },
    });
    // The person's pick while its agent still lists it; else none, and the box shows what the chat will start on
    // without sending it: a kept pick the list no longer has (the stand-in for an agent's own model, once a Cloud
    // computer lists real ones) must not turn into a model nobody chose.
    const picked = listed.find((e) => e.id === webChat.agent)?.models.some((m) => m.id === webChat.model) ? webChat.model : null;
    return { engines: listed, picked, shown: picked ?? shownModel(listed, webChat.agent, live) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what the picker lists; `webChat`, `web` and `macStep` are fresh objects each render.
  }, [webChat?.where, webChat?.agent, webChat?.model, webChat?.plan, webChat?.free, onRuntime, cloudAgents, macStep?.title, web?.home?.kind, engines, now]);
  const macStatus = useSyncExternalStore(subscribeDeviceStatus, () => (mac ? deviceStatusOf(mac.id)?.status : undefined));
  const notice: { readonly line: string; readonly need?: CloudStartNeed } | null = need
    ? { line: need.line, need }
    : mac
      ? macStatus === "pending"
        ? { line: `Waiting for ${mac.name} to allow this device…` }
        : other.problem
          ? { line: other.problem }
          : null
      : runsOn === "this_mac"
        ? // In a browser window the Mac is named: "this Mac" there is whatever the browser runs on.
          ((line) => (line ? { line } : null))(staysOnMacLine(ticked.length, lidMoves(settings) === "on", webChat?.macs.find((m) => `mac:${m.id}` === webChat.where)?.name))
        : null;
  // While the page is open, the runtime makes this project's next worktree and starts its engine on the options the box
  // would send, so Send runs no git worktree add and no engine start-up (workspace.prewarm: fire-and-forget, one per
  // repository; a runtime from before it says method_not_found). Asked at once as the page opens (Send can follow within
  // a second); each change of options starts the engine again, asked once they have held for 300 ms. The runtime stops
  // that engine a minute after the last ask, so the page asks again as it is used (a key or a click in its box, the
  // window coming back to it), at most every 20 s. Only its own box counts: a New chat pane beside a chat in use would
  // otherwise keep an engine running for a chat nobody is writing. The worktree made ahead starts from the checkout's branch, so a branch picked instead gets none
  // (workspace.create would only throw it away).
  const projectPath = runsOn === "this_mac" && base === null ? project?.path : undefined;
  // By task (Settings.new_chat_by_task): offered for a chat this computer makes, once some task kind is pinned.
  const saveSettings = useSaveSettings();
  const byTask =
    runsOn === "this_mac" && !mac && !webChat && Object.values(settings?.subagent_task_pins ?? {}).some((pin) => pin != null)
      ? { on: settings?.new_chat_by_task === true, set: (on: boolean) => void saveSettings({ new_chat_by_task: on }) }
      : undefined;
  const [choice, setChoice] = useState<string | null>(null);
  const onChoice = useCallback((next: TurnChoice) => setChoice(JSON.stringify(next)), []);
  const warmEngine = engine?.id;
  const warmedPath = useRef<string | null>(null);
  useEffect(() => {
    if (!client || !projectPath || choice === null) return;
    const options = JSON.parse(choice) as TurnChoice;
    let asked = Date.now();
    const ask = () => {
      asked = Date.now();
      void client.call("workspace.prewarm", { request_id: requestId(), repo: { path: projectPath }, ...(warmEngine ? { engine: warmEngine, options } : {}) }).catch(() => undefined);
    };
    const first = warmedPath.current !== projectPath;
    warmedPath.current = projectPath;
    const timer = setTimeout(ask, first ? 0 : 300);
    const inUse = () => {
      if (Date.now() - asked >= 20_000) ask();
    };
    const el = box.current;
    const back = () => {
      if (el?.contains(document.activeElement)) inUse();
    };
    el?.addEventListener("keydown", inUse, true);
    el?.addEventListener("pointerdown", inUse, true);
    window.addEventListener("focus", back);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener("keydown", inUse, true);
      el?.removeEventListener("pointerdown", inUse, true);
      window.removeEventListener("focus", back);
    };
  }, [client, projectPath, warmEngine, choice]);

  // Cloud chosen: the repo's Cloud computer gets ready while the person writes (environment.warm), so Send claims a
  // computer already standing on its snapshot. Asked on choosing Cloud and again as typing starts; the runtime sends
  // Cloud at most one hint per project every 20 s, and sets up a repo nobody set up as background prepare does.
  const cloudProject = runsOn === "cloud" ? (project?.id ?? null) : null;
  const warmCloud = useCallback(() => {
    if (client && cloudProject) void client.call("environment.warm", { request_id: requestId(), project_id: cloudProject }).catch(() => undefined);
  }, [client, cloudProject]);
  useEffect(warmCloud, [warmCloud]);

  // The chat goes into its pane before the route shows the panes, as a sidebar click does: placed after, the pane would
  // take it for a switch on screen and keep the chat it showed before until this one's history is in (hold.ts). The
  // route changes in the same frame as its row lands in the sidebar (flushSync), not as a transition behind it: there is
  // nothing on this page worth keeping on screen while the chat renders.
  const openStarted = (id: string) => {
    panes.place(id);
    void navigate(chatPath(id), { flushSync: true });
  };

  const start = async (text: string, _kind: unknown, options: TurnChoice, attachments: Attachment[]) => {
    // The pane's tab as the message goes: the person may be in another by the time the chat is made.
    const tab = windowTabs.get().active;
    if (webChat) {
      // No place takes a chat now: the line over the page says why, and a send says it again and keeps the message.
      if (webChat.where === null) throw new Error(web?.places.lines[0] ?? "No place can take a chat now.");
      if (webCloud) {
        // Only a model the person picked is named: with none, the Cloud computer starts on its own default.
        const model = startModel(cloudPicker?.picked ?? null);
        const picked = { ...(model ? { model } : {}), ...(webChat.effort ? { effort: webChat.effort } : {}) };
        // Claude Agent and Codex start from Cloud's queue only once a plan or key of theirs works on every Cloud
        // computer: until then the start waits in this tab, which keeps the message in the chat's box for the sign-in.
        const connected = webChat.agent === "caveman" || (need === null && cloudAgent?.auth.everywhere !== undefined);
        const first = dock(text, attachments, model ?? undefined);
        let opened: string;
        try {
          const outcome = await webChat.start(text, { runs: count, files: attachments.length, ...(Object.keys(picked).length > 0 ? { options: picked } : {}), live: !connected });
          if ("held" in outcome || !hub) return undock();
          // Cloud has the start: the chat opens now, the message in it, and its computer's own events follow in place.
          opened = outcome.queued.workspace_id;
          await hub.startQueued(outcome.queued);
        } catch (e) {
          undock();
          throw e;
        }
        handOff(opened, first);
        await docked();
        focusWhenOpened(`chat:${opened}`);
        if (!pane || !panes.fill(pane, opened, tab)) openStarted(opened);
        return;
      }
      // A Mac: the chat is made by its runtime, which this window must be on by now.
      const there = webChat.macs.find((m) => `mac:${m.id}` === webChat.where);
      if (!client || chosenRuntime(localStorage)?.id !== there?.id) throw new Error(`Can't reach ${there?.name ?? "your Mac"} yet. Try again.`);
    }
    if (!client) throw new Error("Can't reach Caveman Code. Try again.");
    if (!project) throw new Error("Add a project to start a chat in.");
    if (!engine) throw new Error(NO_ENGINE);
    if (runsOn === "cloud") {
      // An agent with no CLI in Cloud: the line under the box said so; a send says it again and keeps the message.
      if (need?.kind === "unsupported") throw new Error(need.line);
      // The chat starts there from a #start link, which carries text, never files: refused, the box keeps them.
      if (attachments.length > 0) throw new Error(`Files can't go with a chat started in Cloud yet. Remove them, or run it on ${thisComputer}.`);
      const chosen = cloudStartOptions(options);
      // Cloud holds the start of a chat whose agent runs on any Cloud computer now; one that must be connected first
      // carries on in the Cloud-hosted client, where it is.
      const runsAnywhere = engine.id === "caveman" || (need === null && cloudAgent?.auth.everywhere !== undefined);
      navigate("/cloud/start", {
        state: {
          project_id: project.id,
          text,
          engine: engine.id,
          ...(runsAnywhere ? { queue: true as const } : {}),
          ...(base ? { base_ref: base } : {}),
          ...(chosen ? { options: chosen } : {}),
          ...(worksIn.length > 1 ? { sources: worksIn.map((s) => s.name) } : {}),
          ...(count > 1 ? { runs: count } : {}),
        } satisfies CloudStartState,
      });
      return;
    }
    // Another Mac makes the chat itself, in its own folder of the project (else from the repository's address).
    const there = mac ? macRepo(project, other.projects) : null;
    if (mac && there === null) throw new Error(`${mac.name} doesn't have ${project.name}. Add it there first.`);
    const make = mac ? other.create : (params: Params<"workspace.create">) => client.call("workspace.create", params);
    const first = dock(text, attachments, options.model);
    const made = [];
    try {
      for (let i = 0; i < count; i++) {
        made.push(
          await make({
            request_id: requestId(),
            repo: there ?? { path: project.path },
            ...(base ? { base_ref: base } : {}),
            engine: engine.id,
            task: { text, ...(attachments.length > 0 ? { attachments } : {}) },
            options,
            // Its first message's kind picks the model (Settings > Subagents), where a pin for that kind can run.
            ...(byTask?.on ? { by_task: true } : {}),
            // Only when more than the project's own is ticked: a chat in one repository is asked for as it always was.
            // Another Mac's project is its own to read: a chat there works in the project's own repository.
            ...(mac ? {} : createSources(ticked)),
          }),
        );
      }
      localStorage.setItem(LAST_PROJECT, project.id);
      // The chat opens on the answer; a fixture runtime without adopt, and a chat another Mac made, wait for the list.
      if (adopt && !mac) for (const chat of made) adopt(chat);
      else await refresh();
    } catch (e) {
      // Refused, or made but not listed yet: the page undocks, the words back in the box.
      undock();
      throw e;
    }
    const created = made[0]!;
    handOff(created.id, first);
    await docked();
    // Focus follows the message into its chat, never left on the page behind it.
    focusWhenOpened(`chat:${created.id}`);
    if (!pane || !panes.fill(pane, created.id, tab)) openStarted(created.id);
  };

  // The question names what the chat is built in, and picks it: the project, or in a browser window the repository
  // Cloud starts on. Its name is underlined in dots, the one thing in the sentence that opens.
  const named = cn(
    "rounded-sm underline decoration-foreground/35 decoration-dotted decoration-1 outline-none transition-colors duration-100 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:decoration-foreground",
    pane ? "underline-offset-[5px]" : "underline-offset-[7px]",
  );
  const question = project ? (
    <>
      What should we build in{" "}
      <ProjectPicker value={project.id} onChange={choose}>
        <button type="button" className={named}>
          {project.name}
        </button>
      </ProjectPicker>
      ?
    </>
  ) : webCloud && webChat.repo !== null ? (
    <>
      What should we build in{" "}
      <RepoMenu all={webChat.repos ?? []} value={webChat.repo} onChange={webChat.onRepo} connect={GITHUB_CONNECT_PATH}>
        <button type="button" className={named}>
          {webChat.repo}
        </button>
      </RepoMenu>
      ?
    </>
  ) : (
    "What should we build?"
  );
  const setup = !onRuntime ? (
    // A browser window, a chat in Cloud: Cloud sees no repository yet, and this is where one is connected.
    webCloud && webChat.repos?.length === 0 ? (
      <Button asChild variant="secondary" className="mt-4">
        <a href={GITHUB_CONNECT_PATH} target="_blank" rel="noreferrer">
          <ProjectBadge github />
          {CONNECT_REPOSITORY}
        </a>
      </Button>
    ) : web && webChat?.where === null ? (
      // No place takes a chat: the step that brings the person's Mac here, where this browser can take it.
      <NextAction next={macStep} web={web} size="default" />
    ) : null
  ) : projects.length === 0 ? (
      <Button type="button" variant="secondary" onClick={add.start} className="mt-4">
        <Icon icon={Folder01Icon} className="size-4" />
        Add a project to start
      </Button>
    ) : needsEngine(engines) ? (
      <Button asChild variant="secondary" className="mt-4">
        <Link to="/settings/models">
          <Icon icon={Key01Icon} className="size-4" />
          Set up an agent to start
        </Link>
      </Button>
    ) : null;

  // Docked (sent), the box stands as a chat's does (PaneFrame's composer: its gutters, 912px wide); the box itself
  // has no padding of its own in either place, so its move is its column's.
  const composer = (
    <div className={cn("w-full shrink-0", sent ? "pb-4 pl-10 pr-2 max-md:px-2 max-md:pb-2" : cn("px-4 pb-0.5", !pane && "pt-7"))}>
      <div ref={box} className={cn("mx-auto w-full", sent || pane ? "max-w-[912px]" : "max-w-[720px]")}>
        {sent ? null : <WebStartCard className="mb-16" />}
        {/* The companion stands on the box, its feet on the top edge, as a Chief does on a phone (mobile Perch.tsx). */}
        {pane || sent ? null : (
          <div className="relative">
            <div className="absolute bottom-0 left-6">
              <GazeMascot scale={2} perched />
            </div>
          </div>
        )}
        <Composer
          key={prompt ? `${prompt.plugin?.id ?? ""} ${prompt.text}` : "blank"}
          {...(prompt || pane ? {} : { draftKey: "new-chat" })}
          running={false}
          glass={dressed && !sent}
          {...(engine ? { engineId: engine.id } : {})}
          engineLabel={engine?.label ?? ""}
          canSteer={false}
          onSubmit={start}
          onInterrupt={async () => undefined}
          // Docked, the box reads as the chat's will.
          {...(sent ? {} : { placeholder: onRuntime ? "Describe a task, or @ to add files, chats and plugins…" : "Describe a task…" })}
          projectId={project?.id ?? null}
          // A chat no runtime of this window's makes: the agents Cloud runs, with the models Cloud lists for them.
          {...(cloudPicker && webChat
            ? {
                agentPicker: (
                  <ModelPicker
                    engines={cloudPicker.engines}
                    value={cloudPicker.shown === null ? null : { engine: webChat.agent, model: cloudPicker.shown }}
                    onChange={(r) => {
                      webChat.onModel(r.engine, r.model);
                      focus();
                    }}
                    favorites={NO_FAVORITES}
                    effort={webChat.effort ?? cloudPicker.engines.find((e) => e.id === webChat.agent)?.models.find((m) => m.id === cloudPicker.shown)?.default_effort}
                    onEffortChange={webChat.onEffort}
                    className="max-w-[280px]"
                  />
                ),
              }
            : {})}
          switchEngine={{ engines: ready, onChange: setEngineId }}
          byTask={byTask}
          initialPick={pick?.engine === engine?.id ? pick : undefined}
          onChoice={onChoice}
          onTyping={webCloud ? webChat.warm : warmCloud}
          repo={project ? { path: project.path } : null}
          initialDraft={prompt}
          foot={
            <NewChatBar
              project={project ?? null}
              base={base}
              onBase={(branch) => {
                setPicked(branch && project ? { project: project.id, branch } : null);
                focus();
              }}
              // A browser window has no computer of its own: its places are Cloud and the Macs on line.
              {...(webChat
                ? {
                    where: webChat.where ?? undefined,
                    onWhere: (next: Where) => {
                      webChat.onWhere(next);
                      focus();
                    },
                    macs: webChat.macs,
                    computerName: null,
                    cloud: webChat.cloud,
                  }
                : {
                    where: runsOn,
                    onWhere: (next: Where) => {
                      other.setTarget(next.startsWith("mac:") ? next.slice(4) : null);
                      if (next === "this_mac" || next === "cloud") setWhere(next);
                      focus();
                    },
                    macs,
                    computerName: identity.computerName,
                    cloud: { ...cloud, chip: cloudPill(cloud.chip, withoutLabel(leftForCloud)) },
                  })}
              // Another Mac's project is its own to read: a chat there works in the project's own repository.
              sources={sources.length > 1 && !mac ? { all: sources, ticked, onToggle: toggle, leftOut: leftForCloud.map((s) => s.name) } : undefined}
              // Nothing to run where no place takes a chat.
              runs={webChat?.where !== null ? { value: count, onChange: setRuns } : undefined}
            />
          }
        />
        {/* One line under the foot, with room kept for it and its button so the box does not move when it comes: what
            the pick needs, with its button. Docked, the chat's box has none. */}
        {sent ? null : (
          <div data-wallpaper-reads className="flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1 pl-4 pr-3 pt-1 text-[12.5px] leading-5 text-muted-foreground">
            {notice ? (
              <span role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {/* One click opens the sign-in in the browser; the person stays here, with their words and their pick. */}
                {notice.need && (notice.need.kind === "connect" || notice.need.kind === "reconnect") && (cloudAgent?.id === "claude-agent" || cloudAgent?.id === "codex") ? (
                  <CloudNeedLine engine={cloudAgent.id} need={notice.need} compact />
                ) : (
                  <span className="min-w-0">{notice.line}</span>
                )}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );

  // Docked: the message and the turn's working line, drawn by the chat's own transcript where the chat draws them
  // (PaneFrame's conversation: its gutters, the first row 12px under the header).
  const started = sent ? (
    <Conversation className="pane-conversation" contentClassName="pl-14 pr-6 pt-3 max-md:px-4">
      <div className="mx-auto max-w-[880px] pb-6">
        <Transcript
          items={[sent.first]}
          running
          {...(engine ? { engine: engine.id } : {})}
          engineLabel={engine?.label ?? ""}
          engineIsCaveman={engine?.id === "caveman"}
          model={sent.model}
          onAnswer={() => undefined}
          cavemanVersion={null}
        />
      </div>
    </Conversation>
  ) : null;

  return (
    <Wallpaper pick={wallpaper} gone={sent !== null} className={cn("flex h-full min-h-0 flex-col bg-background", sent && "new-chat-docked")}>
      <header className={cn("flex h-11 shrink-0 items-center gap-2 text-[13px]", actions ? "pl-4 pr-1.5" : "px-4")}>
        <div data-wallpaper-reads className="flex min-w-0 items-center gap-2">
          <SidebarMenuButton />
          {project || (webCloud && webChat.repo) ? (
            <>
              <ProjectBadge github={project ? project.repository?.host === "github.com" : true} />
              <span className="truncate text-muted-foreground">{project ? project.name : webChat?.repo}</span>
              <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">
                /
              </span>
            </>
          ) : null}
          <span className="shrink-0 text-foreground">New chat</span>
        </div>
        {actions ? <span className="ml-auto flex shrink-0 items-center">{actions}</span> : null}
      </header>

      {pane ? (
        <>
          {started ?? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4">
              <div className="mx-auto max-w-[420px] pb-4 pt-[6vh]">
                <h2 className="text-balance text-[17px] font-medium leading-[26px] tracking-[-0.01em] text-foreground">{question}</h2>
                {setup}
                {children}
              </div>
            </div>
          )}
          {composer}
        </>
      ) : (
        // The question ends at a fixed height and the box hangs under it, so the box grows down as it fills and
        // nothing above it moves.
        <div className={cn("flex min-h-0 flex-1 flex-col", !sent && "overflow-y-auto pb-6")}>
          {started ?? (
            <div className="flex shrink-0 basis-[40%] flex-col items-center justify-end px-6 pt-4">
              <h1 data-wallpaper-reads className="max-w-[520px] text-balance text-center text-[22px] font-medium leading-[30px] tracking-[-0.02em] text-foreground">
                {question}
              </h1>
              {setup}
            </div>
          )}
          {composer}
        </div>
      )}
      {add.dialog}
      {/* Always mounted in a browser window: closed during checkout, it still sees the plan land. */}
      {webChat ? <UnlockPlans {...webChat.unlock} source={hostedAccount} /> : null}
    </Wallpaper>
  );
}

/**
 * The repository a chat on another Mac is made in: that Mac's own folder of the project (the same repository on
 * GitHub, else the same name), else the repository's address, which that Mac checks out itself. Null: the project is
 * a folder only this computer has.
 */
function macRepo(project: Project, theirs: ReadonlyArray<Project> | null): Params<"workspace.create">["repo"] | null {
  const full = project.repository?.full_name.toLowerCase();
  const same = (theirs ?? []).find((p) => (full !== undefined ? p.repository?.full_name.toLowerCase() === full : p.name === project.name));
  if (same) return { path: same.path };
  return project.repository ? { url: project.repository.clone_url } : null;
}
