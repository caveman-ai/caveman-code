import { heldNotShown, SessionProtocolError, type Client, type CloudComputerRow, type Params, type Result, type Workspace } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { CloudIcon, GitBranchIcon, LaptopIcon } from "@caveman-app/ui/icons/huge";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { useEffect, useReducer, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { chooseRuntime, followLink, holdFollow } from "../../state/cloud.ts";
import { connectsOnce } from "../../state/engines.ts";
import { CLOUD_HOSTED, repoLabel, repoOnGitHub, requestId, useChatList, useRuntime, useRuntimeClient, useRuntimeSelector, useSyncHub } from "../../state/runtime.tsx";
import { deviceHooks, type DeviceHooks } from "../../state/sync/device-hooks.ts";
import { useCloudComputers } from "../../state/useCloudComputers.ts";
import { FootLabel, PlaceChip, type Place } from "../composer-foot.tsx";
import { ProjectBadge } from "../ProjectPicker.tsx";
import { useRemoteControl } from "../RemoteControl.tsx";
import { otherRuntimes } from "../RuntimeTargets.tsx";
import { computerIcon, Icon } from "../transcript/marks.tsx";
import { COMPUTER, THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import { signMove, signStop, type DeviceKey } from "@caveman-app/session-protocol/devices";
import { thisDevice } from "../../state/device-key.ts";
import { DiffRows } from "../../panels/diff/FileDiff.tsx";
import { parsePatch, type DiffFile } from "../../panels/diff/parsePatch.ts";

// Moves (Caveman Cloud the spec, amended 2026-10-21): a chat moves between This Mac, the person's other Macs and Cloud
// computers as one session, whatever its engine: Caveman, and Claude Agent and Codex with their CLI's own session.

/** The engines whose chats move between computers. */
export const MOVABLE_ENGINES: ReadonlySet<string> = new Set(["caveman", "claude-agent", "codex"]);

type MoveTo = Params<"session.move">["to"];
type Login = "vault_key" | "computer_sign_in" | "followed_sign_in" | null;
/** What a computer answered about taking the chat (session.move.check). */
export type MoveCheck =
  | { readonly state: "ok"; readonly login: Login; readonly left?: ReadonlyArray<string>; readonly context?: MoveContext }
  | { readonly state: "refused"; readonly message: string };
/** session.move.check's answer as the move card shows it: the login that pays there, and the preflight's notes. */
const checkedOk = (r: Result<"session.move.check">): MoveCheck => ({ state: "ok", login: r.login, left: r.preflight?.work.left ?? [], ...(r.preflight?.context ? { context: r.preflight.context } : {}) });

/**
 * What pays where the chat lands, for the move card; null for the Caveman engine (its own keys travel with the person).
 * `followed_sign_in` is the person's plan, kept sealed by Caveman and never inside a computer; `computer_sign_in` is a
 * login made on the computer itself (another Mac's own, or a Cloud computer's from before plans connected once).
 */
export function loginLine(engine: string, login: Login): string | null {
  if (login === null || (engine !== "claude-agent" && engine !== "codex")) return null;
  const vendor = engine === "codex" ? "OpenAI" : "Anthropic";
  if (login === "vault_key") return `It runs there on your ${vendor} API key, kept by Caveman.`;
  if (login === "followed_sign_in") return `It runs there on your ${engine === "codex" ? "ChatGPT" : "Claude"} plan, kept by Caveman.`;
  return `It runs there on the ${engine === "codex" ? "Codex" : "Claude"} sign-in made on that computer.`;
}

/**
 * The secret-shaped files git does not ignore that stay where the chat leaves (session.move.check's preflight.work.left,
 * decision 24), for the move card; null when none. Where they stay is the chat's computer: This Mac only when that is
 * the window's own (`here`), else that computer by its name (m-e: another Mac, or a Mac seen from a browser).
 */
export function leftLine(left: ReadonlyArray<string> | undefined, workspace: Workspace, here = true): string | null {
  if (left === undefined || left.length === 0) return null;
  // Three named, as the lid summary names them; a folder of them comes named once (`.env/`).
  const named = left.length <= 3 ? left.join(", ") : `${left.slice(0, 3).join(", ")} and ${left.length - 3} more`;
  const computer = workspace.computer;
  // A Mac's own runtime names itself "This Mac": seen from anywhere else, that is its Mac.
  const where = computer.kind === "caveman_cloud" ? computer.label : here ? THIS_COMPUTER : computer.kind === "this_mac" || !computer.label ? "its Mac" : computer.label;
  return `Left on ${where}: ${named}.`;
}

/** session.move.check's preflight.context (decision 28). */
export type MoveContext = NonNullable<NonNullable<Result<"session.move.check">["preflight"]>["context"]>;

const HANDOFF_WHY: Record<NonNullable<MoveContext["why"]>, string> = {
  over_cap: "Its session grew too big to copy, so a new session there gets the conversation and can read the rest.",
  no_session: "Its engine has no session of it yet, so a new one there gets the conversation.",
  other_account: "That Mac signs in with its own login, so a new session there gets the conversation.",
};

/** How the conversation goes on where the chat lands, for the move card; null when the runtime does not say. */
export function contextLine(context: MoveContext | undefined): string | null {
  if (context === undefined) return null;
  if (context.mode === "native") return "Context: native. Its own session carries on there.";
  return `Context: handoff. ${context.why === undefined ? "A new session there gets the conversation." : HANDOFF_WHY[context.why]}`;
}

/**
 * The move card's one action (decision 29): a working chat is "Stop this turn and move" (nothing adopts a turn in
 * flight: its turn stops here, then it moves, and lands idle); an idle chat just moves. `stops`: whether this move stops
 * the turn at all (stopsTurn); one asked through Cloud waits for the turn to end there, and says so (m-16).
 */
export function moveAction(workspace: Pick<Workspace, "status">, stops = true): { readonly label: string; readonly line: string | null } {
  // At work as its computer counts it (atWork): Move to's pull to This Mac signs the stop on the same rule.
  if (atWork(workspace) && !stops) return { label: "Move when this turn ends", line: "Its turn there runs to its end first, then it moves." };
  if (atWork(workspace))
    return { label: "Stop this turn and move", line: "Its turn stops here first, then it moves. The rest of that turn doesn't run there; follow-ups you queued do." };
  return { label: "Move", line: null };
}

/**
 * Whether Move to's move stops the chat's turn (m-16): the chat's own runtime makes it (`client`, the pane's, is this
 * window's runtime, `own`, which holds the chat), or This Mac pulls the chat with a signed stop (pullToThisMac). A move
 * asked for a chat on another computer goes through Cloud (the sync hub's client), as mail that computer acts on once
 * the turn ends.
 */
export function stopsTurn(chosen: Pick<MoveOption, "to">, client: Pick<Client, "call">, own: Pick<Client, "call"> | null | undefined): boolean {
  return chosen.to === "this_mac" ? !!own : client === own;
}

/** The move card while a move asked through Cloud waits for the chat's turn to end (m-16). */
export function moveWaitingLine(workspace: Workspace): string {
  return `Waiting for its turn on ${computerName(workspace) || "its computer"} to end. It moves then.`;
}

/**
 * The move card (MoveTo): the computer chosen, what its check said, and whether the move asked waits for the turn there
 * (m-16), asked while the chat was on computer `from`.
 */
export interface MoveCard {
  readonly chosen: MoveOption | null;
  readonly check: { readonly state: "checking" } | MoveCheck | null;
  readonly waiting: boolean;
  readonly from?: string;
}
export const MOVE_CARD_START: MoveCard = { chosen: null, check: null, waiting: false };
export type MoveCardStep =
  | { readonly kind: "choose"; readonly option: MoveOption; readonly check: NonNullable<MoveCard["check"]> }
  | { readonly kind: "checked"; readonly option: MoveOption; readonly check: MoveCheck }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "waiting"; readonly from: string }
  | { readonly kind: "back" }
  | { readonly kind: "moved"; readonly computerId: string };

/**
 * The move card's steps. A move waiting for the turn is asked already: Cloud keeps it and moves the chat when the turn
 * ends, whatever this card does (m-d). So it stays the card until the chat moves: Back and closing the card leave it
 * waiting, and another computer can't be chosen meanwhile (a second move asked). Before that, Back is the list again. A
 * check answers only for the computer it was asked of; the chat landing on another computer clears the wait.
 */
export function moveCard(card: MoveCard, step: MoveCardStep): MoveCard {
  switch (step.kind) {
    case "choose":
      return card.waiting ? card : { chosen: step.option, check: step.check, waiting: false };
    case "checked":
      return card.chosen === step.option ? { ...card, check: step.check } : card;
    case "refused":
      return { ...card, check: { state: "refused", message: step.message } };
    case "waiting":
      return { ...card, waiting: true, from: step.from };
    case "back":
      return card.waiting ? card : MOVE_CARD_START;
    case "moved":
      return card.waiting && card.from !== step.computerId ? MOVE_CARD_START : card;
  }
}

/** The moves waiting for a turn to end, by chat, so the card says so again however often it is closed and opened (m-d). */
const waitingMoves = new Map<string, MoveCard>();
/** The move card a chat opens with: its move waiting for the turn, while the chat is still on the computer it was asked on. */
export function openingCard(sessionId: string, computerId: string): MoveCard {
  const waiting = waitingMoves.get(sessionId);
  if (waiting !== undefined && waiting.from === computerId) return waiting;
  waitingMoves.delete(sessionId);
  return MOVE_CARD_START;
}
/** The card as it changes, kept for the chat while its move waits (openingCard). */
export function keepWaiting(sessionId: string, card: MoveCard): void {
  if (card.waiting) waitingMoves.set(sessionId, card);
  else waitingMoves.delete(sessionId);
}

/** Whether a refusal is "no Cloud login for this engine there" (session.move.check), as opposed to any other reason. */
const loginNeeded = (error: unknown) => error instanceof SessionProtocolError && error.error.data?.capability === "engine_login";
/** Whether a refusal is "that Mac has no checkout of the chat's repository" (its heartbeat said so; decision 30). */
export const repoMissing = (error: unknown) => error instanceof SessionProtocolError && error.error.data?.capability === "repo";

const computerName = (workspace: Workspace) => (workspace.computer.kind === "caveman_cloud" ? "Cloud" : workspace.computer.label);

/**
 * Where the chat is, in the foot of its box (composer-foot.tsx), all through the chat: its repository, the branch its
 * changes land on (Claude's "main → claude/…", compact "Current checkout · main"; so Keep, Undo and a commit say
 * where), and the computer it runs on. The computer is the one that opens: the places the chat can move to, mid-chat
 * too (MoveTo). A chat that can't move names its computer as a fact.
 */
export function WhereItRuns({ client, workspace, movedFrom = null }: { client: Client; workspace: Workspace; movedFrom?: string | null }) {
  const project = useRuntimeSelector((v) => (workspace.project_id ? v.projects.find((p) => p.id === workspace.project_id) : undefined));
  // Its project here, else its own repository's name: a chat read from another computer, or an archived one opened
  // from search (neither is in the live list), may have no project on this one.
  const name = project?.name ?? repoLabel(workspace.repo);
  const branch = workspace.branch;
  const place: Place = { id: workspace.computer.id, name: computerName(workspace), icon: computerIcon(workspace.computer.kind), high: workspace.computer.kind === "caveman_cloud" };
  return (
    <div role="group" aria-label="Where the chat is" className="flex min-w-0 flex-1 items-center gap-x-1">
      {name ? (
        <FootLabel mark={<ProjectBadge github={project ? project.repository?.host === "github.com" : repoOnGitHub(workspace.repo)} />} className="shrink-[2]">
          {name}
        </FootLabel>
      ) : null}
      {/* The branch gives way first: a chat's own is long, and its tooltip says it whole. */}
      {branch ? (
        <FootLabel
          icon={GitBranchIcon}
          title={branch !== workspace.base_ref ? `Changes land on ${branch}, a copy of ${workspace.base_ref || "your checkout"}: your own checkout stays as it is` : `Changes land on ${branch}`}
          className="shrink-[4]"
        >
          {branch}
        </FootLabel>
      ) : null}
      {canMove(workspace) ? (
        <MoveTo client={client} workspace={workspace} movedFrom={movedFrom}>
          <PlaceChip place={place} aria-label={`Runs on ${place.name}. Move this chat`} className="shrink-0" />
        </MoveTo>
      ) : (
        <PlaceChip place={place} fixed className="shrink-0" />
      )}
    </div>
  );
}

/**
 * Continue on This Mac: on the desktop this window's own runtime pulls the chat to its own computer (pullToThisMac),
 * whichever Mac it came from. In the browser, `back` names the Mac it goes back to (backTo), signed by this browser as
 * any move to a Mac is; without one, `this_mac` to the runtime that holds the chat's record, which is its own Mac.
 * Pending while the chat's computer finishes with it. It signs no stop: its label promises none (a chat at work on a
 * Cloud computer comes at its turn's end; Move to's "Stop this turn and move" is the one that stops it there), and this
 * Mac's record of a chat that moved away is parked here, so never at work as this window sees it.
 */
function useContinueOnThisMac(client: Client, workspace: Workspace, back: MoveOption | null = null) {
  // This Mac's own runtime: the window's, not the chat client the pane reads a chat elsewhere through.
  const own = useRuntimeSelector((v) => v.client);
  const [state, setState] = useState<"idle" | "busy" | "pending">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // It arrived, or moved again: the way back is offered afresh.
  useEffect(() => setState("idle"), [workspace.status, workspace.computer.id]);
  // Still where it was a while after: its computer refused (its chat says why) or is mid-turn. The person may ask again.
  usePendingTimeout(state, setState, setProblem, computerName(workspace) || "that computer");
  // What coming back would set aside on this Mac, while the person is asked (session.move `needs_confirmation`).
  const [aside, setAside] = useState<SetAside | null>(null);
  const go = (replace = false) => {
    setState("busy");
    setProblem(null);
    setAside(null);
    const session_id = workspace.session_id;
    const yes = replace ? { replace: true as const } : {};
    const moved =
      !CLOUD_HOSTED && own
        ? pullToThisMac(own, session_id, { replace })
        : back
          ? moveParams(session_id, back, deviceHooks().moveFields).then((params) => client.call("session.move", { ...params, ...yes }))
          : client.call("session.move", { request_id: requestId(), session_id, to: "this_mac", ...yes });
    moved.then(
      (r) => {
        setState(r.pending ? "pending" : "idle");
        if (r.needs_confirmation) setAside(r.needs_confirmation);
      },
      (e: unknown) => {
        setState("idle");
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const confirm = <SetAsideDialog aside={aside} onCancel={() => setAside(null)} onConfirm={() => go(true)} />;
  return { state, problem, go: () => go(), confirm };
}

/** What a move back to this Mac would set aside there (session.move `needs_confirmation`). */
type SetAside = NonNullable<Result<"session.move">["needs_confirmation"]>;

/** How the question names what changed: the files, or the commits when only those differ. */
export function setAsideLine(aside: SetAside): string {
  const shown = aside.files.slice(0, 5).join(", ");
  const more = aside.total - Math.min(aside.files.length, 5);
  const files = aside.total === 0 ? "" : `${shown}${more > 0 ? ` and ${more} more` : ""}`;
  const commits = aside.commits === 0 ? "" : `${aside.commits} commit${aside.commits === 1 ? "" : "s"}`;
  return [files, commits].filter((part) => part !== "").join(", and ");
}

/**
 * Asked once before a chat comes back over changes made in its folder on this Mac while it was away: what would be set
 * aside, and where it is kept. Nothing moves on Cancel.
 */
function SetAsideDialog({ aside, onCancel, onConfirm }: { aside: SetAside | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={aside !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Set aside the changes made here?</DialogTitle>
          <DialogDescription>
            This chat's folder on {THIS_COMPUTER} changed while the chat was away: {aside ? setAsideLine(aside) : ""}. Bringing it back replaces them with the chat's files. They are kept in git on{" "}
            <span className="font-mono text-[12px]">{aside?.kept_ref}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Bring it back</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * In the header of a chat that moved here from a Mac and runs on a Cloud computer: the way back. On the desktop, to this
 * Mac; in the browser, to the Mac it came from by name, only when Cloud lists that runtime as one of the person's Macs.
 */
export function ContinueOnThisMac({ client, workspace, movedFrom }: { client: Client; workspace: Workspace; movedFrom: string | null }) {
  const list = useChatList(useSyncHub());
  const back = CLOUD_HOSTED ? backTo(movedFrom, list?.runtimes.values() ?? []) : null;
  const pull = useContinueOnThisMac(client, workspace, back);
  if (CLOUD_HOSTED && !back) return null;
  const where = back ? back.label : THIS_COMPUTER;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[12px]" disabled={pull.state !== "idle"} onClick={pull.go}>
        {pull.state === "busy" ? `Moving to ${where}…` : pull.state === "pending" ? `Coming to ${where}…` : back ? `Back to ${where}` : `Continue on ${THIS_COMPUTER}`}
      </Button>
      <PullProblem problem={pull.problem} />
      {pull.confirm}
    </>
  );
}

/** Continue on This Mac's problem, said where the person looks (not only in a tooltip): a refusal, or still not here. */
function PullProblem({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <span role="alert" className="min-w-0 truncate text-[12px] text-destructive" title={problem}>
      {problem}
    </span>
  );
}

/** A pull still pending after PULL_PENDING_MS: offered again, saying where the chat still is and where to look. */
function usePendingTimeout(state: "idle" | "busy" | "pending", setState: (s: "idle") => void, setProblem: (p: string) => void, there: string) {
  useEffect(() => {
    if (state !== "pending") return;
    const timer = setTimeout(() => {
      setState("idle");
      setProblem(`Still on ${there}. If it did not let the chat go, the chat there says why.`);
    }, PULL_PENDING_MS);
    return () => clearTimeout(timer);
  }, [state, there]);
}

/**
 * Continue on This Mac from this Mac's own window in the desktop app: this window's own runtime (`own`) pulls the chat
 * to its own computer, signed by this Mac's desktop key over exactly that move (continueHereParams), whether the chat
 * runs on a Cloud computer or another Mac, and whether or not this Mac ever had it. "This Mac" is always the window's
 * own computer: never sent to the chat's computer, which would read it as the Mac the chat came from (audit C2).
 */
export async function pullToThisMac(own: Client, sessionId: string, options: { readonly stop?: boolean; readonly device?: () => Promise<DeviceKey>; readonly replace?: boolean } = {}) {
  const computer = (await own.call("cloud.status", {})).computer_id;
  if (!computer) throw new Error(`Sign ${thisComputer} in to Caveman first (Settings, Remote control).`);
  // `replace`: the person said yes to setting aside what changed here (outside what the device signs: the move is the same).
  return own.call("session.move", { ...(await continueHereParams(sessionId, computer, await (options.device ?? thisDevice)(), { stop: options.stop === true })), ...(options.replace ? { replace: true as const } : {}) });
}

/** A runtime as Cloud's runtimes list has it (the sync hub's chat list). */
type ListedRuntime = { readonly runtime_id: string; readonly computer_id: string; readonly name: string; readonly kind: "laptop" | "cloud"; readonly online: boolean };

/** In the browser, the way back for a chat on a Cloud computer: the Mac it came from, by its computer and name, when Cloud lists that runtime as a Mac. */
export function backTo(movedFrom: string | null, runtimes: Iterable<ListedRuntime>): MoveOption | null {
  if (!movedFrom) return null;
  for (const r of runtimes) if (r.runtime_id === movedFrom) return r.kind === "laptop" ? { to: { computer_id: r.computer_id }, label: r.name, mac: true } : null;
  return null;
}

/**
 * Continue on This Mac for a chat on another of the person's Macs, from this Mac's own screen: `to` is this Mac's own
 * computer, signed by this Mac's desktop key over exactly that move, which the chat's Mac checks before it lets the
 * chat go (it takes it only from a key it allowed); this Mac's runtime pulls it, whether or not it ever had it.
 */
export async function continueHereParams(sessionId: string, ownComputerId: string, device: DeviceKey, options: { readonly stop?: boolean } = {}): Promise<Params<"session.move">> {
  const request_id = requestId();
  const to = { computer_id: ownComputerId };
  return {
    request_id,
    session_id: sessionId,
    to,
    device: await signMove(device, { session_id: sessionId, request_id, to }),
    // Decision 32, on a chat at work only (the button said "Stop and continue"): the chat's Mac stops its running turn
    // on this same key's word for this move, and the chat comes at that boundary instead of when the turn would end.
    ...(options.stop ? { stop: await signStop(device, { session_id: sessionId, move_request_id: request_id }) } : {}),
  };
}

/**
 * A chat at work on its computer, as its Mac counts one busy (handlers BUSY_STATUSES), a turn waiting on an approval
 * there included: Continue on This Mac stops its turn there (decision 32), or the pull would wait for that turn's end.
 */
const atWork = (workspace: Pick<Workspace, "status">) => workspace.status === "working" || workspace.status === "starting" || workspace.status === "waiting" || workspace.status === "needs_input";

/**
 * Continue on This Mac's label: it stops a turn running on the chat's Mac (decision 32), so it says so then. `missing`:
 * the chat's repository (owner/name) when Cloud said This Mac has no checkout of it (lacksRepoHere): open it first.
 */
export function continueLabel(workspace: Pick<Workspace, "status">, state: "idle" | "busy" | "pending", where: string, there: string, missing?: string): string {
  const working = atWork(workspace);
  if (missing !== undefined && state === "idle") return `Open ${missing} on ${where} first`;
  if (state === "busy") return `Moving to ${where}…`;
  if (state === "pending") return working ? `Stopping on ${there}…` : `Coming to ${where}…`;
  return working ? `Stop and continue on ${where}` : `Continue on ${where}`;
}

/** Whether a chat runs on another of the person's Macs that is up, and this window is that person's desktop app: Continue on This Mac. */
export function continuesHere(workspace: Workspace, hosted = CLOUD_HOSTED): boolean {
  return !hosted && workspace.computer.kind === "pool" && workspace.computer.status === "online" && canMove(workspace);
}

/** How long Continue on This Mac shows the chat on its way before it may be asked again. */
const PULL_PENDING_MS = 30_000;
/** While This Mac lacks the chat's repository, how often Continue on This Mac asks again (m-17). */
const REPO_LOOK_MS = 30_000;

/**
 * Runs `look` each time the window comes back to the front (`target`'s focus) and every `every` ms, until the returned
 * stop: Continue on This Mac's look at the repository, while This Mac lacks it, so opening it here frees the button.
 */
export function lookAgainWhileMissing(look: () => void, target: Pick<EventTarget, "addEventListener" | "removeEventListener">, every = REPO_LOOK_MS): () => void {
  const timer = setInterval(look, every);
  target.addEventListener("focus", look);
  return () => {
    clearInterval(timer);
    target.removeEventListener("focus", look);
  };
}

/**
 * Whether This Mac has no checkout of the chat's repository, as Cloud says at Move to's look (decision 30): the chat's
 * Mac asks Cloud about This Mac's own computer (session.move.check through `chat`, the client the pane reads the chat
 * with). False when Cloud does not say so: it may take it, or another refusal that the click shows.
 */
export async function lacksRepoHere(own: Pick<Client, "call">, chat: Pick<Client, "call">, sessionId: string): Promise<boolean> {
  const computer = (await own.call("cloud.status", {})).computer_id;
  if (!computer) return false;
  return chat.call("session.move.check", { session_id: sessionId, to: { computer_id: computer } }).then(
    () => false,
    (error: unknown) => repoMissing(error),
  );
}

/** In the header of a chat on another of the person's Macs that is up: Continue on This Mac, signed by this Mac's key. */
export function ContinueHere({ workspace }: { workspace: Workspace }) {
  // This Mac's own runtime: the window's, not the chat client the pane reads a chat on another Mac through.
  const client = useRuntimeSelector((v) => v.client);
  const hub = useSyncHub();
  const [state, setState] = useState<"idle" | "busy" | "pending">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // Decision 30, before the click: This Mac without a checkout of the chat's repository says so on the button.
  const [missing, setMissing] = useState(false);
  useEffect(() => setState("idle"), [workspace.computer.id]);
  const shown = !!client && continuesHere(workspace);
  useEffect(() => {
    if (!shown || !client || !hub) return;
    let live = true;
    lacksRepoHere(client, hub.clientFor(workspace.session_id), workspace.session_id).then(
      (lacks) => live && setMissing(lacks),
      () => live && setMissing(false),
    );
    return () => {
      live = false;
    };
  }, [shown, client, hub, workspace.session_id, workspace.computer.id]);
  // Missing here: asked again when the window comes back and every 30 s, so opening the repository frees the button (m-17).
  useEffect(() => {
    if (!missing || !shown || !client || !hub || typeof window === "undefined") return;
    let live = true;
    const stop = lookAgainWhileMissing(
      () =>
        void lacksRepoHere(client, hub.clientFor(workspace.session_id), workspace.session_id).then(
          (lacks) => live && setMissing(lacks),
          () => undefined,
        ),
      window,
    );
    return () => {
      live = false;
      stop();
    };
  }, [missing, shown, client, hub, workspace.session_id]);
  // Still on its Mac a while after: that Mac refused (its chat says why) or is mid-turn. The person may ask again.
  const there = workspace.computer.label || "that Mac";
  usePendingTimeout(state, setState, setProblem, there);
  if (!client || !shown) return null;
  const repo = missing ? hub?.summary(workspace.session_id)?.repo || "its repository" : undefined;
  const go = async () => {
    setState("busy");
    setProblem(null);
    try {
      // Signed to stop the chat's turn only when the button said so (the chat at work as it rendered).
      const r = await pullToThisMac(client, workspace.session_id, { stop: atWork(workspace) });
      setState(r.pending ? "pending" : "idle");
    } catch (e) {
      setState("idle");
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[12px]" disabled={state !== "idle" || repo !== undefined} onClick={() => void go()}>
        {continueLabel(workspace, state, THIS_COMPUTER, there, repo)}
      </Button>
      <PullProblem problem={problem} />
    </>
  );
}

/** Instead of the parked card, for a chat that moved away from this computer: where it went, and the way back. */
export function MovedCard({ client, workspace, to }: { client: Client; workspace: Workspace; to: "cloud" | "this_mac" }) {
  const back = useContinueOnThisMac(client, workspace);
  // The runtime names no computer when Cloud moved the chat while this Mac slept (handlers.ts markMovedAway): the picker.
  const computer = workspace.computer.id === "caveman-cloud" ? null : workspace.computer.id;
  const openInCloud = async () => {
    const follow = computer ? { computer_id: computer, workspace_id: workspace.id } : null;
    if (CLOUD_HOSTED) {
      if (follow) holdFollow(window, follow);
      else chooseRuntime(localStorage, null);
      return window.location.reload();
    }
    const status = await client.call("cloud.status", {});
    if (status.cloud_url) openExternal(follow ? followLink(`${status.cloud_url}/code/`, follow) : `${status.cloud_url}/code/`);
  };
  // On the desktop, a chat this Mac let go to another of the person's Macs: the runtime names it (markMovedAway).
  const otherMac = !CLOUD_HOSTED && to === "this_mac" && workspace.computer.label !== THIS_COMPUTER ? workspace.computer.label : "";
  const line =
    to === "this_mac"
      ? `It continues in Caveman Code on ${otherMac || `your ${COMPUTER}`}.`
      : back.state === "pending"
        ? `Bringing it back to ${THIS_COMPUTER} once the Cloud computer finishes its turn.`
        : `It keeps going on a Cloud computer while ${thisComputer} is away.`;
  return (
    <div className="mt-6 flex items-end gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <Mascot pose={to === "cloud" ? "working" : "idle"} scale={2} />
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex items-center gap-1.5 text-[13px] text-foreground">
          <Icon icon={to === "cloud" ? CloudIcon : LaptopIcon} />
          {to === "cloud" ? "On Cloud" : `On ${otherMac || THIS_COMPUTER}`}
        </div>
        {/* Polite: "Bringing it back…" and where it went are heard as they change. */}
        <div role="status" aria-live="polite" className="text-[13px] text-muted-foreground">
          {line}
        </div>
        {back.problem ? (
          <div role="alert" className="text-[12.5px] text-destructive">
            {back.problem}
          </div>
        ) : null}
      </div>
      {to === "cloud" ? (
        <div className="mb-1 flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void openInCloud()}>
            Open in Cloud
          </Button>
          {/* aria-disabled, not disabled: focus stays on it while it moves the chat (a disabled button drops it). */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-disabled={back.state !== "idle" || undefined}
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
            onClick={() => back.state === "idle" && back.go()}
          >
            {back.state === "busy" ? `Moving to ${THIS_COMPUTER}…` : "Bring it back"}
          </Button>
          {back.confirm}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Once, in a chat on This Mac, before anything is copied: moves to Cloud are on by default where Cloud
 * computers run, and nothing leaves this Mac until the person keeps them on (cloud.status `moves: "ask"`).
 */
export function MovesNotice({ workspace }: { workspace: Workspace }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const { status } = useRemoteControl();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const eligible = !CLOUD_HOSTED && MOVABLE_ENGINES.has(workspace.engine) && workspace.computer.kind === "this_mac" && workspace.kind === undefined && workspace.runner === undefined;
  // The sync prompt asks for both while sync is unanswered (components/SyncPrompt.tsx).
  if (!eligible || status?.moves !== "ask" || status.sync?.ask === true || !client) return null;
  const answer = (on: boolean) => {
    setBusy(true);
    setProblem(null);
    void client
      .call("settings.set", { request_id: requestId(), settings: { move_to_cloud: on } })
      .then(refresh)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-6 flex items-end gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <Mascot pose="idle" scale={2} />
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex items-center gap-1.5 text-[13px] text-foreground">
          <Icon icon={CloudIcon} />
          Moves to Cloud when the lid closes
        </div>
        <div className="text-[13px] text-muted-foreground">
          After each turn, this chat's history and uncommitted changes go to Caveman, sealed with your organization's key, so a Cloud computer can carry on when you close the lid. Nothing is copied until you choose.
        </div>
        {problem ? (
          <div role="alert" className="text-[12.5px] text-destructive">
            {problem}
          </div>
        ) : null}
      </div>
      <div className="mb-1 flex shrink-0 gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => answer(false)}>
          Turn off
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => answer(true)}>
          Keep on
        </Button>
      </div>
    </div>
  );
}

/**
 * Move to: This Mac (the Mac a chat on a Cloud computer came from), Cloud (the chat's own Cloud computer, or a new
 * one), each of the person's Cloud computers and, for a chat on a Mac, each of their other Macs that is online.
 * Choosing one asks the runtime first (session.move.check), which says why it can't go (no GitHub repository, no Cloud login for a Claude
 * Agent or Codex chat, with the fix) or which login it runs on there; then Move moves it as the same chat.
 */
export function canMove(workspace: Workspace): boolean {
  // A chat in a plain folder (its branch empty) has no branch to carry.
  return MOVABLE_ENGINES.has(workspace.engine) && workspace.branch !== "" && workspace.status !== "parked" && workspace.status !== "archived" && workspace.kind === undefined;
}

/** A place Move to offers: where the chat goes, by name, and whether it is another of the person's Macs. */
export interface MoveOption {
  readonly to: MoveTo;
  readonly label: string;
  /** Another of the person's Macs: it takes the chat only on the word of a device it allowed (moveParams signs it). */
  readonly mac?: true;
  /** Why it can't take the chat (a Mac without its repository: "Open <repo> on <Mac> first"): shown, not chosen. */
  readonly unavailable?: string;
}

/**
 * Move to's places with the Macs that can't take the chat marked so: `missing` holds, by computer, why a Mac refused
 * it at a look (session.move.check: no checkout of the chat's repository there). Each stays in the list, disabled, with
 * the reason, so the person sees where to open the repository.
 */
export function withUnavailable(options: ReadonlyArray<MoveOption>, missing: ReadonlyMap<string, string>): Array<MoveOption> {
  return options.map((o) => {
    const why = o.mac && typeof o.to === "object" && "computer_id" in o.to ? missing.get(o.to.computer_id) : undefined;
    return why === undefined ? o : { ...o, unavailable: why };
  });
}

/**
 * Move to's places for a chat: This Mac or Cloud as before, the person's other Cloud computers, then, for a chat on a
 * Mac that is up, each other Mac of theirs that is online in Cloud's runtimes list, by name. Only the chat's own Mac
 * lets it go to another (and names it where it went); Cloud moving it while that Mac sleeps could not. Never the
 * chat's own computer. On the desktop never the Mac this window is on (`own`): a Mac does not pull a chat to itself
 * from this menu. In the browser that Mac is one more place, unless the chat runs on it (its record there names it
 * this-mac, not its Cloud id).
 */
export function moveOptions(
  workspace: Workspace,
  computers: ReadonlyArray<CloudComputerRow> | null,
  runtimes: Iterable<ListedRuntime>,
  own: ReadonlyArray<string | null | undefined>,
  hosted = CLOUD_HOSTED,
  movedFrom: string | null = null,
): Array<MoveOption> {
  const onCloud = workspace.computer.kind === "caveman_cloud";
  const listed = [...runtimes];
  // On a Cloud computer: This Mac is the desktop window's own (pullToThisMac); a browser is no Mac, and offers the Mac
  // the chat came from by name instead, when there is one (audit C2).
  const back = onCloud && hosted ? backTo(movedFrom, listed) : null;
  return [
    ...(!onCloud ? [{ to: "cloud" as const, label: "Cloud" }] : hosted ? (back ? [back] : []) : [{ to: "this_mac" as const, label: THIS_COMPUTER }]),
    ...(computers ?? []).filter((c) => c.id !== workspace.computer.id && c.desired_state !== "deleted").map((c) => ({ to: { computer_id: c.id }, label: c.name || "Cloud computer" })),
    ...(onCloud || workspace.computer.status !== "online" ? [] : otherRuntimes(listed, !hosted || workspace.computer.kind === "this_mac" ? own : []))
      .filter((r) => r.kind === "laptop" && r.computerId !== workspace.computer.id)
      .map((r) => ({ to: { computer_id: r.computerId }, label: r.name, mac: true as const })),
  ];
}

/**
 * session.move's params for a place Move to offers, under one request id. A Mac takes a chat only on the word of a
 * device it allowed, so a move to one carries this device's signature over exactly that move (devices.ts signMove: the
 * session, the request id and `to`); a Cloud computer needs none. Without a key to sign with, it goes unsigned, and
 * the Mac says why it refuses.
 */
export async function moveParams(sessionId: string, option: MoveOption, sign: DeviceHooks["moveFields"]): Promise<Params<"session.move">> {
  const params = { request_id: requestId(), session_id: sessionId, to: option.to };
  const to = option.to;
  if (!option.mac || !sign || typeof to !== "object" || !("computer_id" in to)) return params;
  return { ...params, ...(await sign({ session_id: sessionId, request_id: params.request_id, to }).catch(() => undefined)) };
}

/** Opened by `children`, the chat's computer in the foot of its box (WhereItRuns), upward as that foot's pickers do. */
export function MoveTo({ client, workspace, movedFrom = null, children }: { client: Client; workspace: Workspace; movedFrom?: string | null; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  // This Mac's own runtime: This Mac is pulled by it (pullToThisMac), never asked of the chat's computer.
  const own = useRuntimeSelector((v) => v.client);
  const cloud = useCloudComputers({ enabled: open, every: 15_000 });
  // The person's runtimes as Cloud lists them (the sync hub's chat list): their other Macs, and whether each is online.
  const hub = useSyncHub();
  const list = useChatList(hub);
  // `waiting`: a move asked through Cloud that waits for the chat's turn to end there (m-16): the card says so until it
  // moves, kept for the chat however often the card closes (m-d).
  const [card, step] = useReducer(moveCard, undefined, () => openingCard(workspace.session_id, workspace.computer.id));
  const { chosen, check, waiting } = card;
  const [moving, setMoving] = useState(false);
  useEffect(() => step({ kind: "moved", computerId: workspace.computer.id }), [workspace.computer.id]);
  useEffect(() => keepWaiting(workspace.session_id, card), [workspace.session_id, card]);
  const listed = canMove(workspace) ? moveOptions(workspace, cloud.view.state === "ready" ? cloud.view.computers : null, list?.runtimes.values() ?? [], [hub?.homeRuntimeId(), cloud.runtimeId], CLOUD_HOSTED, movedFrom) : [];
  // Each other Mac is asked once a look whether it can take the chat, and its answer kept for that look: one without its
  // repository shows disabled, with why, and picking one uses the answer it gave. A look closed forgets them.
  const [checks, setChecks] = useState<ReadonlyMap<string, MoveCheck & { readonly missing?: true }>>(new Map());
  const macs = listed.flatMap((o) => (o.mac && typeof o.to === "object" && "computer_id" in o.to ? [o.to.computer_id] : [])).join(",");
  useEffect(() => {
    if (!open) return setChecks((all) => (all.size === 0 ? all : new Map()));
    if (macs === "") return;
    let live = true;
    for (const computer of macs.split(",")) {
      client.call("session.move.check", { session_id: workspace.session_id, to: { computer_id: computer } }).then(
        (r) => live && setChecks((all) => new Map([...all, [computer, checkedOk(r)]])),
        (e: unknown) => live && setChecks((all) => new Map([...all, [computer, { state: "refused", message: e instanceof Error ? e.message : String(e), ...(repoMissing(e) ? { missing: true as const } : {}) }]])),
      );
    }
    return () => {
      live = false;
    };
  }, [open, macs, client, workspace.session_id]);
  // What the move would set aside on this Mac, while the person is asked (session.move `needs_confirmation`).
  const [aside, setAside] = useState<SetAside | null>(null);
  if (!canMove(workspace)) return null;
  const options = withUnavailable(listed, new Map([...checks].flatMap(([id, c]) => (c.state === "refused" && c.missing ? [[id, c.message] as const] : []))));
  const choose = (option: MoveOption) => {
    // This Mac answers for itself as the pull goes (its own accept: a checkout of the repository, its engine signed in).
    if (option.to === "this_mac") return step({ kind: "choose", option, check: { state: "ok", login: null } });
    const known = typeof option.to === "object" && "computer_id" in option.to ? checks.get(option.to.computer_id) : undefined;
    if (known !== undefined) return step({ kind: "choose", option, check: known.state === "ok" ? known : { state: "refused", message: known.message } });
    step({ kind: "choose", option, check: { state: "checking" } });
    client.call("session.move.check", { session_id: workspace.session_id, to: option.to }).then(
      (r) => step({ kind: "checked", option, check: checkedOk(r) }),
      (e: unknown) => step({ kind: "checked", option, check: { state: "refused", message: e instanceof Error ? e.message : String(e) } }),
    );
  };
  const move = (replace = false) => {
    if (!chosen) return;
    setMoving(true);
    setAside(null);
    const waits = atWork(workspace) && !stopsTurn(chosen, client, own);
    (chosen.to === "this_mac" && own
      ? pullToThisMac(own, workspace.session_id, { stop: atWork(workspace), replace })
      : moveParams(workspace.session_id, chosen, deviceHooks().moveFields).then((params) => client.call("session.move", { ...params, ...(replace ? { replace: true as const } : {}) }))
    ).then(
      (result: Result<"session.move">) => {
        setMoving(false);
        if (result.needs_confirmation) return setAside(result.needs_confirmation);
        // Through Cloud, it comes at the turn's end: the card stays, saying so, until the chat moves (or is closed).
        if (waits && result.pending === true) step({ kind: "waiting", from: workspace.computer.id });
        else reset(false);
      },
      (e: unknown) => {
        setMoving(false);
        step({ kind: "refused", message: e instanceof Error ? e.message : String(e) });
      },
    );
  };
  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) step({ kind: "back" });
  };
  const line = check?.state === "ok" ? loginLine(workspace.engine, check.login) : null;
  // The chat's computer is the window's own only when this window's runtime holds it (m-e).
  const left = check?.state === "ok" ? leftLine(check.left, workspace, !CLOUD_HOSTED && client === own) : null;
  const context = check?.state === "ok" ? contextLine(check.context) : null;
  const action = moveAction(workspace, chosen === null || stopsTurn(chosen, client, own));
  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        {chosen === null ? (
          // A labelled group of buttons, reached with Tab: role="menu" promised arrow keys nothing here handles.
          <div className="flex flex-col gap-1" role="group" aria-label="Move this chat to">
            <div aria-hidden className="pb-1 text-[12px] text-muted-foreground">
              Move this chat to
            </div>
            {options.map((o) => (
              <button
                key={typeof o.to === "string" ? o.to : "computer_id" in o.to ? o.to.computer_id : o.to.runtime_id}
                type="button"
                disabled={o.unavailable !== undefined}
                aria-disabled={o.unavailable !== undefined}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent"
                onClick={() => choose(o)}
              >
                <Icon icon={o.to === "this_mac" || o.mac ? LaptopIcon : CloudIcon} {...(o.unavailable !== undefined ? { className: "opacity-50" } : {})} />
                <span className="flex min-w-0 flex-col">
                  <span className={`truncate ${o.unavailable !== undefined ? "text-muted-foreground" : ""}`}>{o.label}</span>
                  {o.unavailable !== undefined ? <span className="text-[12px] text-muted-foreground">{o.unavailable}</span> : null}
                </span>
              </button>
            ))}
            {cloud.view.state === "loading" ? (
              <div role="status" className="px-2 py-1 text-[12px] text-muted-foreground">
                Looking for your Cloud computers…
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-foreground">Move to {chosen.label}</div>
            {/* Polite: the check's answer is heard where "Checking…" was. */}
            <div role="status" aria-live="polite" className="text-[12.5px] text-muted-foreground">
              {check?.state === "checking"
                ? "Checking that it can go there…"
                : check?.state === "refused"
                  ? null
                  : `It continues there as the same chat, with its history and uncommitted changes.${line ? ` ${line}` : ""}`}
            </div>
            {context ? <div className="text-[12.5px] text-muted-foreground">{context}</div> : null}
            {left ? <div className="text-[12.5px] text-muted-foreground">{left}</div> : null}
            {waiting ? (
              <div role="status" className="text-[12.5px] text-muted-foreground">
                {moveWaitingLine(workspace)}
              </div>
            ) : action.line && check?.state === "ok" ? (
              <div className="text-[12.5px] text-muted-foreground">{action.line}</div>
            ) : null}
            {check?.state === "refused" ? (
              <div role="alert" className="text-[12.5px] text-destructive">
                {check.message}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              {/* A move waiting for the turn is asked already (m-d): the card only closes, and says so again when opened. */}
              <Button type="button" variant="ghost" size="sm" onClick={() => (waiting ? setOpen(false) : step({ kind: "back" }))}>
                {waiting ? "Close" : "Back"}
              </Button>
              {/* Moving or waiting for the turn: aria-disabled, so focus stays on it (and "Moving…" or "Waiting…" is read there) rather than dropping to the page. */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={check?.state !== "ok" && !moving && !waiting}
                aria-disabled={moving || waiting || undefined}
                className="aria-disabled:cursor-default aria-disabled:opacity-50"
                onClick={() => !moving && !waiting && move()}
              >
                {moving ? "Moving…" : waiting ? "Waiting for this turn…" : action.label}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
      <SetAsideDialog aside={aside} onCancel={() => setAside(null)} onConfirm={() => move(true)} />
    </Popover>
  );
}

/** Asked once per engine, on this device: the person chose Not now. */
const ASKED_KEY = (engine: string) => `caveman:moves:cloud-login-asked:${engine}`;

/**
 * Where the notice's button goes: what a Cloud computer runs the engine on is connected in Settings > Models & keys
 * (a plan or a key, once for every computer). A Cloud from before that (connectsOnce false) signs each computer in,
 * from Settings > Computers.
 */
export const cloudLoginFix = (once: boolean): { readonly label: string; readonly to: string } =>
  once ? { label: "Models & keys", to: "/settings/models" } : { label: "Cloud computers", to: "/settings/computers" };

/**
 * Once, in a Claude Agent or Codex chat on This Mac while its chats copy to Cloud: with nothing connected that runs
 * the engine on a Cloud computer (a plan or a key, kept in Caveman Cloud), closing the lid would pause the chat
 * instead of moving it. Asked before the first lid close, never after.
 */
export function CloudLoginNotice({ client, workspace }: { client: Client; workspace: Workspace }) {
  const { status } = useRemoteControl();
  const navigate = useNavigate();
  const fix = cloudLoginFix(connectsOnce(useRuntimeSelector((v) => v.engines)));
  const [needed, setNeeded] = useState<string | null>(null);
  const [asked, setAsked] = useState(() => (typeof localStorage === "undefined" ? true : localStorage.getItem(ASKED_KEY(workspace.engine)) !== null));
  const eligible =
    !CLOUD_HOSTED && (workspace.engine === "claude-agent" || workspace.engine === "codex") && workspace.computer.kind === "this_mac" && workspace.kind === undefined && status?.moves === "on";
  useEffect(() => {
    if (!eligible || asked) return;
    let live = true;
    client.call("session.move.check", { session_id: workspace.session_id, to: "cloud" }).then(
      () => live && setNeeded(null),
      (e: unknown) => live && setNeeded(loginNeeded(e) ? (e as Error).message : null),
    );
    return () => {
      live = false;
    };
  }, [client, workspace.session_id, eligible, asked]);
  if (!eligible || asked || needed === null) return null;
  const dismiss = () => {
    localStorage.setItem(ASKED_KEY(workspace.engine), new Date().toISOString());
    setAsked(true);
  };
  return (
    <div className="mt-6 flex items-end gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <Mascot pose="idle" scale={2} />
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex items-center gap-1.5 text-[13px] text-foreground">
          <Icon icon={CloudIcon} />
          Pauses when the lid closes
        </div>
        <div className="text-[13px] text-muted-foreground">{needed}</div>
      </div>
      <div className="mb-1 flex shrink-0 gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => navigate(fix.to)}>
          {fix.label}
        </Button>
      </div>
    </div>
  );
}

/**
 * The person kept this Mac's versions of what one return held back, on this device: that hold, by its commit (F-6), so
 * a later return that holds the same paths under a new commit shows the card again. A runtime from before commits: by
 * its paths. Keep is this device's word only: the held ref stays for a later review or git (the founder's open call on
 * what Keep means; the safe default loses nothing).
 */
const KEPT_KEY = (sessionId: string, held: Pick<Held, "paths" | "commit">) => `caveman:moves:held-kept:${sessionId}:${held.commit ?? held.paths.join("\n")}`;
/** Whether the person kept this Mac's versions of exactly this hold here (KEPT_KEY). */
export const heldKept = (storage: Pick<Storage, "getItem">, sessionId: string, held: Pick<Held, "paths" | "commit">) => held.paths.length > 0 && storage.getItem(KEPT_KEY(sessionId, held)) !== null;
/** Keep this Mac's, for this hold. */
export const keepHeld = (storage: Pick<Storage, "setItem">, sessionId: string, held: Pick<Held, "paths" | "commit">) => storage.setItem(KEPT_KEY(sessionId, held), new Date().toISOString());

type Held = Result<"session.move.held">;
type HeldFile = NonNullable<Held["files"]>[number];

/** The card's title: agent and tool config, files that look like secrets, or both (the runtime's note says the same). */
export function heldTitle(held: Held): string {
  const secret = held.files?.some((file) => file.secret === true) ?? false;
  const config = held.files === undefined || held.files.some((file) => file.secret !== true) || held.files.length < held.paths.length;
  if (secret && !config) return "Cloud changed files that look like secrets: review before they apply here";
  if (secret) return "Cloud changed agent settings and files that look like secrets: review before they apply here";
  return "Cloud changed agent settings: review before they apply here";
}

/**
 * Whether "Apply Cloud's" may be pressed (A-8): only once the changes are in front of the person, and only for what the
 * runtime could show whole and name (its review of every file, none binary, too big, cut short or running more than it
 * names, F-4; and the held commit, which the apply checks). The runtime's apply refuses the rest on the same rule.
 */
export const heldApplyReady = (held: Held, reviewing: boolean) => reviewing && held.commit !== undefined && heldNotShown(held) === undefined;

const HELD_CHANGE: Record<HeldFile["change"], string> = {
  changed: "Changed on Cloud",
  added: "New on Cloud",
  removed: "Deleted on Cloud",
  link: "A link: shown by where it points, never followed",
  submodule: "A submodule link",
  binary: "A binary file: not shown",
  too_big: "Too big to show here",
};

/** One held file as the person reviews it: what Cloud did, what it would run here, and the diff of this Mac's version against Cloud's. */
function HeldFileReview({ file }: { file: HeldFile }) {
  const lines = parsePatch(file.diff);
  const diff: DiffFile = {
    path: file.path,
    status: file.change === "added" ? "added" : file.change === "removed" ? "deleted" : "modified",
    additions: lines.filter((l) => l.kind === "add").length,
    deletions: lines.filter((l) => l.kind === "del").length,
    patch: file.diff,
  };
  return (
    <li className="rounded-lg border border-border">
      <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5 text-[12.5px]">
        <span className="min-w-0 truncate font-mono text-foreground">{file.path}</span>
        <span className="shrink-0 text-muted-foreground">{HELD_CHANGE[file.change]}</span>
      </div>
      {file.runs !== undefined && file.runs.length > 0 ? (
        <div className="border-b border-border px-3 py-1.5 text-[12.5px]">
          <div className="text-warning">Would run on this Mac:</div>
          <ul>
            {file.runs.map((command, i) => (
              <li key={i} className="whitespace-pre-wrap font-mono text-foreground [overflow-wrap:anywhere]">
                {command}
              </li>
            ))}
            {file.more_runs ? <li className="text-warning">and {file.more_runs} more not shown</li> : null}
          </ul>
        </div>
      ) : null}
      {lines.length > 0 ? (
        <div className="max-h-64 overflow-auto">
          <DiffRows file={diff} lines={lines} wrap />
        </div>
      ) : null}
      {file.truncated ? <div className="px-3 py-1 text-[12px] text-[hsl(var(--subtle-foreground))]">The rest of this file's changes are not shown.</div> : null}
    </li>
  );
}

/**
 * The held-back card as it renders (HeldSettingsCard keeps its state): the paths, and once the person asks to review
 * them, each one's changes. Apply Cloud's waits for the review (A-8), and only for what it could show whole (F-4); the
 * rest says how to apply it in git. Nothing takes focus as the card appears (a space typed in the composer never
 * presses Keep, F-6); once the review opens, Keep this Mac's, the safe answer, is focused.
 */
export function HeldReview({
  held,
  sessionId,
  reviewing,
  busy,
  problem,
  onKeep,
  onReview,
  onApply,
}: {
  held: Held;
  sessionId: string;
  reviewing: boolean;
  busy: boolean;
  problem: string | null;
  onKeep: () => void;
  onReview: () => void;
  onApply: () => void;
}) {
  const ready = heldApplyReady(held, reviewing);
  const unshown = reviewing ? heldNotShown(held) : undefined;
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (reviewing) keepRef.current?.focus();
  }, [reviewing]);
  return (
    <div className="mt-6 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-end gap-4">
        <Mascot pose="idle" scale={2} />
        <div className="min-w-0 flex-1 pb-1">
          <div className="flex items-center gap-1.5 text-[13px] text-foreground">
            <Icon icon={CloudIcon} />
            {heldTitle(held)}
          </div>
          <div className="text-[13px] text-muted-foreground">This Mac kept its own versions of these files. Cloud's versions can make an agent or a tool run code here, so look at them before you apply them:</div>
          {reviewing ? null : (
            <ul className="mt-1 text-[12.5px] text-muted-foreground">
              {held.paths.map((file) => (
                <li key={file} className="truncate font-mono">
                  {file}
                </li>
              ))}
            </ul>
          )}
          {problem ? (
            <div role="alert" className="text-[12.5px] text-destructive">
              {problem}
            </div>
          ) : null}
          {unshown !== undefined ? (
            <div className="text-[12.5px] text-muted-foreground">
              {unshown}, so they can't be applied from here. Keep this Mac's, or look at them and apply them in git from <span className="font-mono">refs/caveman/held/{sessionId}</span>.
            </div>
          ) : null}
        </div>
        <div className="mb-1 flex shrink-0 gap-2">
          {/* The safe answer, focused once the review opens: never on the card's own mount (F-6). */}
          <Button ref={keepRef} type="button" variant="ghost" size="sm" onClick={onKeep}>
            Keep this Mac's
          </Button>
          {reviewing ? (
            <Button type="button" variant="secondary" size="sm" disabled={busy || !ready} onClick={onApply}>
              {busy ? "Applying…" : "Apply Cloud's"}
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={onReview}>
              Review changes
            </Button>
          )}
        </div>
      </div>
      {reviewing && held.files !== undefined ? (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Cloud's changes">
          {held.files.map((file) => (
            <HeldFileReview key={file.path} file={file} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * On This Mac, in a chat that came back from Cloud: the agent and tool config Cloud changed (settings, hooks, MCP
 * servers, CLAUDE.md, AGENTS.md, symlinks) and the files that look like secrets it changed, which this Mac kept its own
 * versions of. Cloud's versions go into the worktree only when the person has reviewed them and applies them here.
 */
export function HeldSettingsCard({ client, workspace }: { client: Client; workspace: Workspace }) {
  const [held, setHeld] = useState<Held>({ paths: [] });
  // The held commit the person opened the review of: something else held since is reviewed afresh.
  const [reviewed, setReviewed] = useState<string | null | undefined>(undefined);
  const reviewing = reviewed !== undefined && reviewed === (held.commit ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const eligible = !CLOUD_HOSTED && workspace.computer.kind === "this_mac" && MOVABLE_ENGINES.has(workspace.engine);
  useEffect(() => {
    if (!eligible) return;
    let live = true;
    client.call("session.move.held", { session_id: workspace.session_id }).then(
      (out) => {
        if (!live) return;
        setHeld(out);
        setKept(heldKept(localStorage, workspace.session_id, out));
      },
      () => live && setHeld({ paths: [] }),
    );
    return () => {
      live = false;
    };
  }, [client, workspace.session_id, workspace.updated_at, eligible]);
  if (!eligible || held.paths.length === 0 || kept) return null;
  const keep = () => {
    keepHeld(localStorage, workspace.session_id, held);
    setKept(true);
  };
  const apply = () => {
    if (!heldApplyReady(held, reviewing)) return;
    setBusy(true);
    setProblem(null);
    client.call("session.move.apply_held", { request_id: requestId(), session_id: workspace.session_id, ...(held.commit !== undefined ? { commit: held.commit } : {}) }).then(
      () => {
        setBusy(false);
        setHeld({ paths: [] });
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return <HeldReview held={held} sessionId={workspace.session_id} reviewing={reviewing} busy={busy} problem={problem} onKeep={keep} onReview={() => setReviewed(held.commit ?? null)} onApply={apply} />;
}
