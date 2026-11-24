// New chat in a browser window Caveman Cloud serves (state/sync/web-window.ts). The window has no computer of its
// own, so a chat runs in Cloud or on a Mac of the person's that is on line, and Cloud comes first: a first visit is
// New chat on a repository, running in Cloud. A chat in Cloud needs no runtime at all: its repository is one Cloud
// sees, its agent one of the three Cloud runs, and Send is one request that places the chat and queues its start in
// Cloud (state/cloud.ts sendCloudStart), so the chat opens at once and starts whether or not this window stays. Where
// Cloud queues no start, or the start is several runs or needs its agent connected first, the start is held in this
// tab instead, and the window's one-line wait carries it to the chat (state/cloud-wait.ts). Typing with Cloud picked
// tells Cloud a chat is coming (a ready hint), so its computer is up by Send. A Mac picked instead puts the window on
// that Mac, whose projects, branches and agents are then New chat's own. A Free account has nothing that runs in
// Cloud: its Send opens the Unlock sheet and the message goes as soon as a plan lands.
import type { AccountSummary } from "@caveman-app/session-protocol";
import type { PickerModel } from "@caveman-app/ui/components/model-picker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { offersUnlock } from "../components/unlock-model.ts";
import {
  awaitedStart,
  chosenRuntime,
  CLOUD_START_ENGINE,
  failedStart,
  hostedAccount,
  isLaptop,
  listCloudRepos,
  sendCloudStart,
  startOnNewCloudComputer,
  type CloudRuntime,
  type CloudStartOutcome,
  type StartOptions,
} from "../state/cloud.ts";
import { CLOUD_OFF } from "../state/environment.ts";
import type { WebWindowValue } from "../state/runtime.tsx";
import { canGetMacHere, type ChatPlaces } from "../state/sync/web-window.ts";
import { planModels } from "./cloud-models.ts";
import { CLOUD_AGENTS } from "./cloud-need.ts";
import type { CloudChoice, OtherMac, Where } from "./new-chat-bar.tsx";
import { startFailure } from "./start-failure.ts";

/** What Send says while Cloud sees no repository of the person's. */
export const CONNECT_REPOSITORY = "Connect a repository to start";
/** One start waits in a tab at a time: a second would take the first one's place, and its message with it. */
export const STILL_STARTING = "A chat is still starting in Cloud. Send this once it opens.";
export const NO_FILES_IN_CLOUD =
  "Files can't go with a chat started in Cloud yet. Remove them to send.";
/**
 * What a send says when the Unlock sheet closes with no plan bought: the message is back in the box. Where this browser
 * can get the desktop app it also names the free way (the Mac app on the person's own subscriptions and keys, no
 * plan); on any other computer there is no free way to point at, so it says no more than it did.
 */
export const planToSend = (canMac: boolean): string =>
  `Chats in Cloud come with a plan. Pick one to send this${canMac ? ", or run it free on your computer" : ""}.`;
/** What it says in this browser as it loads; a send reads the browser again (planToSend). */
export const PLAN_TO_SEND = planToSend(canGetMacHere());

/**
 * Where a new chat runs from a browser window: the person's pick while that place can still take a chat, else the Mac
 * the window is already on (New chat on that Mac put it there), else Cloud when it is on, else the first Mac on line.
 * Null: no place takes a chat now (the shell says why, AppShell's NoPlace).
 */
export function webWhere(
  places: ChatPlaces,
  pick: Where | null,
  on: Pick<CloudRuntime, "id" | "computer_driver"> | null,
): Where | null {
  const macs = places.places.flatMap((p) =>
    p.kind === "mac" ? [`mac:${p.runtimeId}` as const] : [],
  );
  // Cloud's word has not come yet: Cloud is offered meanwhile, and Cloud itself refuses a start it cannot take.
  const cloud = places.cloud !== "off";
  if (pick === "cloud" && cloud) return pick;
  if (pick !== null && macs.includes(pick as `mac:${string}`)) return pick;
  const here = on && isLaptop(on) ? (`mac:${on.id}` as const) : null;
  if (here && macs.includes(here)) return here;
  return cloud ? "cloud" : (macs[0] ?? null);
}

/** Cloud as the run-on control draws it in a browser window: a place, or the reason it is not one. */
export const webCloud = (places: ChatPlaces): CloudChoice =>
  places.cloud === "off"
    ? { chip: "Cloud", tone: "idle", disabled: CLOUD_OFF }
    : { chip: "Cloud", tone: "ok" };

const LAST_REPO = "caveman.new-chat.repo";
const LAST_AGENT = "caveman.new-chat.agent";
const LAST_MODEL = "caveman.new-chat.model";

/** A ready hint for one repository goes to Cloud at most this often: the bound the desktop's own hint keeps (environment.warm). */
export const HINT_EVERY_MS = 20_000;

/**
 * Tells Cloud the person is about to start a chat in Cloud on `repo` (POST /code/computers/ready-hint, CONTRACT
 * §6.7), so the computer it lands on is up by Send. Nothing is shown for it and nothing waits on it: what stands in
 * a start's way is said by the start.
 */
export function readyHint(repo: string, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl("/api/v1/code/computers/ready-hint", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-cave-csrf": "1", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ repo }),
  }).catch(() => undefined);
}

/** What the Caveman plan serves, as Cloud lists it for the signed-in person; nothing where Cloud sells no models. */
export async function listPlanModels(fetchImpl: typeof fetch = fetch): Promise<PickerModel[]> {
  const response = await fetchImpl("/api/v1/code/credits/models", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  return response.ok ? planModels(await response.json()) : [];
}

export interface WebNewChat {
  readonly where: Where | null;
  readonly onWhere: (where: Where) => void;
  readonly macs: ReadonlyArray<OtherMac>;
  readonly cloud: CloudChoice;
  /** The repositories Cloud sees for the person; null while it is asked. */
  readonly repos: ReadonlyArray<string> | null;
  readonly repo: string | null;
  readonly onRepo: (repo: string) => void;
  readonly agent: string;
  readonly onAgent: (id: string) => void;
  /** The model picked for it, by the id its agent knows; null: none, and the agent starts on its own (cloud-models.ts shownModel). */
  readonly model: string | null;
  /** Its effort, where the picked model's list names levels; undefined: the model's own. */
  readonly effort: string | undefined;
  /** A model picked in the picker, with its agent: the effort goes back to that model's own. */
  readonly onModel: (agent: string, model: string) => void;
  readonly onEffort: (effort: string) => void;
  /** The models the Caveman plan serves, from Cloud; null until it answers. */
  readonly plan: ReadonlyArray<PickerModel> | null;
  /** A Free account, which has nothing that runs in Cloud until a plan lands; null until Cloud says. */
  readonly free: boolean | null;
  /**
   * Starts the chat in Cloud. `queued`: Cloud holds its start, and the chat opens now. `held`: the start waits in this
   * tab, and the window's wait takes it from there (several runs; `live`, an agent with no plan or key in Cloud yet,
   * whose message waits in the chat's box; a Cloud that queues no start). Throws what to say instead.
   */
  readonly start: (
    text: string,
    more: {
      readonly runs: number;
      readonly files: number;
      readonly options?: StartOptions | undefined;
      readonly live?: boolean | undefined;
    },
  ) => Promise<CloudStartOutcome>;
  /** The person is about to start a chat in Cloud (Cloud picked, typing): a ready hint, at most one per repository every HINT_EVERY_MS. */
  readonly warm: () => void;
  /** The Unlock sheet a Free account's Send opens (components/UnlockPlans.tsx, on Caveman Cloud's account). */
  readonly unlock: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onUnlocked: () => void;
  };
}

interface Deps {
  readonly repos?: () => Promise<ReadonlyArray<string>>;
  readonly models?: () => Promise<ReadonlyArray<PickerModel>>;
  readonly local?: Pick<Storage, "getItem" | "setItem">;
  readonly session?: Pick<Storage, "getItem" | "setItem">;
  readonly fetch?: typeof fetch;
  readonly account?: () => Promise<AccountSummary>;
  /** Whether a chat Cloud queued the start of can open in this window now (the sync hub has Cloud's list). Absent: yes. */
  readonly opens?: () => boolean;
  readonly requestId?: () => string;
  readonly now?: () => number;
}

/** New chat's own state in a browser window; null in the desktop app. */
export function useWebNewChat(web: WebWindowValue | null, deps: Deps = {}): WebNewChat | null {
  const on = web !== null;
  const local = deps.local ?? localStorage;
  const [pick, setPick] = useState<Where | null>(null);
  const where = on ? webWhere(web.places, pick, chosenRuntime(local)) : null;
  const usePlace = web?.usePlace;
  const places = web?.places.places;
  const onWhere = useCallback(
    (next: Where) => {
      setPick(next);
      // A Mac's projects and agents become the window's own; Cloud lets a Mac go again.
      usePlace?.(
        next === "cloud"
          ? { kind: "cloud", name: "Cloud" }
          : (places?.find((p) => p.kind === "mac" && `mac:${p.runtimeId}` === next) ?? null),
      );
    },
    [usePlace, places],
  );
  const macs = useMemo(
    () =>
      (places ?? []).flatMap((p) => (p.kind === "mac" ? [{ id: p.runtimeId, name: p.name }] : [])),
    [places],
  );

  // Cloud's repositories: read when Cloud is where the chat runs, and again when the window comes back to the front
  // (a repository connected in another tab is then there).
  const [repos, setRepos] = useState<ReadonlyArray<string> | null>(null);
  const [repoPick, setRepoPick] = useState<string | null>(() =>
    on ? local.getItem(LAST_REPO) : null,
  );
  const inCloud = where === "cloud";
  const list = deps.repos ?? listCloudRepos;
  useEffect(() => {
    if (!inCloud) return;
    let live = true;
    const read = () =>
      void list().then(
        (next) => live && setRepos(next),
        () => live && setRepos((was) => was ?? []),
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [inCloud, list]);
  const repo = repos === null ? null : (repos.find((r) => r === repoPick) ?? repos[0] ?? null);

  const [agent, setAgent] = useState<string>(() => {
    const kept = on ? local.getItem(LAST_AGENT) : null;
    return CLOUD_AGENTS.some((a) => a.id === kept) ? kept! : CLOUD_START_ENGINE;
  });
  const [model, setModel] = useState<string | null>(() => (on ? local.getItem(LAST_MODEL) : null));
  const [effort, setEffort] = useState<string | undefined>(undefined);
  // What the plan serves: Cloud's own list, read with the repositories and again when the window comes back. Read
  // with no place to run a chat too: the picker then lists them greyed, over the step that brings the Mac here.
  const [plan, setPlan] = useState<ReadonlyArray<PickerModel> | null>(null);
  const readModels = deps.models ?? listPlanModels;
  const listsModels = on && (inCloud || where === null);
  useEffect(() => {
    if (!listsModels) return;
    let live = true;
    const read = () =>
      void readModels().then(
        (next) => live && setPlan(next),
        () => live && setPlan((was) => was ?? []),
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [listsModels, readModels]);

  // Send on a Free account opens Unlock and waits: a plan landing sends the message, closing without one gives it back.
  const [unlocking, setUnlocking] = useState(false);
  const waiting = useRef<{ readonly go: () => void; readonly back: () => void } | null>(null);
  const readAccount = deps.account ?? hostedAccount.get;
  // Whether the account is Free, for the picker: its models are listed greyed over Unlock. Unread, nothing is greyed.
  const [free, setFree] = useState<boolean | null>(null);
  /** The account as it was last read here: what Send goes by, with no read of its own in its way. */
  const account = useRef<AccountSummary | null>(null);
  useEffect(() => {
    if (!inCloud) return;
    let live = true;
    void readAccount().then(
      (read) => {
        if (!live) return;
        account.current = read;
        setFree(offersUnlock(read));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // Read again once the Unlock sheet closes: a plan may have landed.
  }, [inCloud, readAccount, unlocking]);
  const planFirst = async () => {
    // The read New chat made when Cloud was picked answers; only when it never did is the account read now. Unread,
    // Cloud decides: its own refusal is said as it is.
    const known = account.current ?? (await readAccount().catch(() => null));
    if (!offersUnlock(known)) return;
    await new Promise<void>((go, back) => {
      waiting.current = { go, back: () => back(new Error(planToSend(canGetMacHere()))) };
      setUnlocking(true);
    });
  };
  const settleWait = useCallback((sent: boolean) => {
    const wait = waiting.current;
    waiting.current = null;
    if (sent) wait?.go();
    else wait?.back();
  }, []);
  // Stable, so the sheet's look for the plan during checkout is not started again at every render.
  const unlock = useMemo(
    () => ({
      open: unlocking,
      onOpenChange: (open: boolean) => {
        setUnlocking(open);
        if (!open) settleWait(false);
      },
      onUnlocked: () => {
        // A plan landed: the account read before it no longer says what this person has.
        account.current = null;
        settleWait(true);
      },
    }),
    [unlocking, settleWait],
  );

  // Typing with Cloud picked: Cloud gets the chat's computer ready. Not on opening New chat alone: a window left
  // open wakes nothing. Never for a Free account, which nothing runs in Cloud for.
  const hinted = useRef(new Map<string, number>());
  const hintFetch = deps.fetch;
  const clock = deps.now;
  const warm = useCallback(() => {
    if (!inCloud || repo === null || free === true) return;
    const now = clock?.() ?? Date.now();
    if (now - (hinted.current.get(repo) ?? Number.NEGATIVE_INFINITY) < HINT_EVERY_MS) return;
    hinted.current.set(repo, now);
    readyHint(repo, hintFetch ?? fetch);
  }, [inCloud, repo, free, hintFetch, clock]);

  if (!on) return null;
  return {
    unlock,
    where,
    onWhere,
    macs,
    cloud: webCloud(web.places),
    repos,
    repo,
    onRepo: (next) => {
      setRepoPick(next);
      local.setItem(LAST_REPO, next);
    },
    agent,
    onAgent: (id) => {
      setAgent(id);
      local.setItem(LAST_AGENT, id);
    },
    model,
    effort,
    onModel: (nextAgent, nextModel) => {
      setAgent(nextAgent);
      setModel(nextModel);
      setEffort(undefined);
      local.setItem(LAST_AGENT, nextAgent);
      local.setItem(LAST_MODEL, nextModel);
    },
    onEffort: setEffort,
    plan,
    free,
    warm,
    start: async (text, more) => {
      const session = deps.session ?? sessionStorage;
      if (repo === null) throw new Error(`${CONNECT_REPOSITORY}.`);
      if (more.files > 0) throw new Error(NO_FILES_IN_CLOUD);
      if (awaitedStart(session) !== null) throw new Error(STILL_STARTING);
      await planFirst();
      // A start that failed waits for Try again or Discard (its card says so): Cloud's own words for it go as they are.
      const held = failedStart(session) !== null;
      const title = text.split("\n")[0]!.slice(0, 80) || repo;
      const input = { title, repo, engine: agent };
      const pending = (computerId: string) => ({
        computer_id: computerId,
        repo,
        engine: agent,
        task: text,
        ...(more.options ? { options: more.options } : {}),
      });
      try {
        // Cloud queues one chat's start. Several runs are made one after another by this window, and an agent that
        // must be connected first keeps the message in its chat's box: both wait in this tab, as does any start
        // while this window cannot open a chat no computer has made yet.
        if (more.runs > 1 || more.live === true || deps.opens?.() === false)
          return {
            held: await startOnNewCloudComputer(
              input,
              (computerId) => ({
                ...pending(computerId),
                ...(more.runs > 1 ? { runs: more.runs } : {}),
              }),
              session,
              deps.fetch ?? fetch,
            ),
          };
        return await sendCloudStart(
          input,
          pending,
          (deps.requestId ?? (() => crypto.randomUUID()))(),
          session,
          deps.fetch ?? fetch,
        );
      } catch (error) {
        // Cloud's own refusal (a plan with nothing left, a limit) is said as it is; anything else in our words.
        throw held ? error : new Error(startFailure(error).line);
      }
    },
  };
}
