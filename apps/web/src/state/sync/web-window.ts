// A browser window Caveman Cloud serves has no computer of its own, and nobody picks one for it. Its sidebar is
// Cloud's list of every chat the person has (chats-view.ts); each open chat rides the runtime pool to wherever it
// lives, or reads Cloud's copy while that place sleeps (hub.ts). What has no place of its own (the Settings pages a
// computer answers, the Chief, the pickers of a new chat on a Mac) is asked of one runtime the window quietly uses,
// by the fixed rule below. Nothing here wakes a computer: only a send, or opening something that needs it, does.
import { osOf } from "../../lib/platform.ts";
import type { CloudRuntime } from "../cloud.ts";
import type { ChatListSnapshot, ListStatus } from "./chat-list.ts";
import { heardAt, liveRuntimes } from "./chats-view.ts";
import type { RuntimeState } from "./wire.ts";

type Runtimes = Pick<ChatListSnapshot, "runtimes">;

const NONE: ReadonlySet<string> = new Set();
/** Heard from last first, never heard from last of all; by id among equals, so two windows settle on the same one. */
const newestFirst = (a: RuntimeState, b: RuntimeState) =>
  heardAt(b).localeCompare(heardAt(a)) || a.runtime_id.localeCompare(b.runtime_id);

/**
 * The runtime a web window uses for what has no place of its own, when nothing in the window put it on one (a chat
 * started in Cloud, New chat on a Mac): the one it has while that stays on line; else a Mac of the person's that is on
 * line and has let this browser in before; else a Cloud computer that is running; else none. Never one that sleeps (so
 * nothing is woken for it), and never a Mac that has yet to allow this browser: that Mac asks when one of its chats is
 * opened, and the chat says so. `refused`: runtimes the relay would not connect this window to since Cloud last spoke
 * of them.
 */
export function quietHome(
  list: Runtimes | null,
  current: string | null,
  allowed: (runtimeId: string) => boolean,
  refused: ReadonlySet<string> = NONE,
): string | null {
  if (!list) return null;
  const usable = (r: RuntimeState) =>
    r.online &&
    r.computer_state !== "deleted" &&
    !refused.has(r.runtime_id) &&
    (r.kind === "cloud" || allowed(r.runtime_id));
  const now = current ? list.runtimes.get(current) : undefined;
  if (now && usable(now)) return now.runtime_id;
  const all = [...list.runtimes.values()].filter(usable);
  const mac = all.filter((r) => r.kind === "laptop").sort(newestFirst)[0];
  if (mac) return mac.runtime_id;
  // A Cloud computer wakes under a new runtime id each time: its newest one on line is the one that answers.
  const live = new Set([...liveRuntimes(list.runtimes).values()].map((r) => r.runtime_id));
  return (
    all.filter((r) => r.kind === "cloud" && live.has(r.runtime_id)).sort(newestFirst)[0]
      ?.runtime_id ?? null
  );
}

/**
 * The runtime the Cloud computer of `chosen` runs as now, when Cloud's list names another than the one this window
 * holds (Cloud mints a new runtime id at every wake, CONTRACT §5.3): the window follows its computer there. Undefined:
 * the same one, none on line, or a Mac, whose runtime id is its enrolment.
 */
export function followed(chosen: CloudRuntime, list: Runtimes | null): CloudRuntime | undefined {
  if (!list || chosen.computer_driver === "local") return undefined;
  const now = liveRuntimes(list.runtimes).get(chosen.computer_id);
  if (now === undefined || now.runtime_id === chosen.id) return undefined;
  // The one it holds still answers and is the newer word: stay.
  const held = list.runtimes.get(chosen.id);
  if (held?.online === true && (held.seq ?? 0) >= (now.seq ?? 0)) return undefined;
  return {
    ...chosen,
    id: now.runtime_id,
    name: now.name || chosen.name,
    last_seen_at: now.last_seen_at,
  };
}

/** A runtime in Cloud's chat list as the window's own (state/cloud.ts CloudRuntime): what chooseRuntime keeps. */
export const asCloudRuntime = (r: RuntimeState): CloudRuntime => ({
  id: r.runtime_id,
  name: r.name,
  computer_id: r.computer_id,
  computer_name: r.name,
  computer_driver: r.kind === "laptop" ? "local" : "cloud",
  last_seen_at: r.last_seen_at,
});

// ------------------------------------------------------------------ where a new chat can run

/** A place a new chat can run: Cloud, or a Mac of the person's by its own name. A person never picks a machine in Cloud. */
export type ChatPlace =
  | { readonly kind: "cloud"; readonly name: "Cloud" }
  | {
      readonly kind: "mac";
      readonly name: string;
      readonly runtimeId: string;
      readonly computerId: string;
    };

export interface ChatPlaces {
  /** Every place that takes a new chat now: Cloud first when it is on, then the Macs that are on line, by name. */
  readonly places: ReadonlyArray<ChatPlace>;
  /** Cloud for this organization: null until Cloud has said. */
  readonly cloud: "on" | "off" | null;
  /** What to say when no place can take a chat, one sentence each; empty while one can or Cloud has not said. */
  readonly lines: ReadonlyArray<string>;
}

export const CLOUD_OFF_LINE = "Cloud is off. Ask your admin.";
export const MAC_HERE_LINE =
  "To use your Mac here, turn on Settings > Remote control in Caveman Code on it.";

/**
 * Where a new chat can run from this window: `cloud` is Cloud's own word on whether it runs computers for this
 * organization (GET computers' `cloud_computers`; null until it answers), the Macs are the person's that are on line
 * in Cloud's list. With no place at all the window says so, and what to do, in `lines`.
 */
export function chatPlaces(list: Runtimes | null, cloud: boolean | null): ChatPlaces {
  const macs = [...(list?.runtimes.values() ?? [])]
    .filter((r) => r.kind === "laptop" && r.online)
    .sort((a, b) => a.name.localeCompare(b.name) || a.runtime_id.localeCompare(b.runtime_id))
    .map((r): ChatPlace => ({
      kind: "mac",
      name: r.name || "Your Mac",
      runtimeId: r.runtime_id,
      computerId: r.computer_id,
    }));
  const places: ChatPlace[] = [
    ...(cloud === true ? [{ kind: "cloud", name: "Cloud" } as const] : []),
    ...macs,
  ];
  return {
    places,
    cloud: cloud === null ? null : cloud ? "on" : "off",
    lines: places.length === 0 && cloud === false ? [CLOUD_OFF_LINE, MAC_HERE_LINE] : [],
  };
}

// ------------------------------------------------------------------ the person's Mac, from this browser

/** Where Caveman Code for Mac is downloaded. */
export const DOWNLOAD_URL = "https://caveman.so/download";

/** What a browser on a computer that cannot run the desktop app is told, plainly. */
export const MAC_ONLY_LINE = "The desktop app is Mac only today. The web app works now.";

interface HostNavigator {
  readonly userAgentData?: { readonly platform?: string } | undefined;
  readonly platform?: string;
  readonly userAgent?: string;
  readonly maxTouchPoints?: number;
}

/**
 * Whether this browser is on a Mac, the one computer the desktop app (the DMG) runs on today (caveman.so/download:
 * Windows is built, and not released yet). An iPhone and an iPad type with the Command key, so the shortcuts count them
 * as a Mac (lib/platform.ts osOf); neither runs a Mac app, and an iPad that calls itself MacIntel is told by its touch screen.
 */
export function canGetMacApp(nav: HostNavigator | undefined): boolean {
  if (!nav || osOf(nav) !== "mac") return false;
  const platform = nav.platform ?? "";
  if (/iPhone|iPad/.test(platform) || /iPhone|iPad/.test(nav.userAgent ?? "")) return false;
  return !(platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
}

/** Whether the browser this page runs in can get the desktop app; read when asked, so a test can stand in another computer. */
export const canGetMacHere = (): boolean =>
  canGetMacApp(typeof navigator === "undefined" ? undefined : (navigator as HostNavigator));

/** The free way: run Caveman Code on the person's own computer, on their own subscriptions and keys (no plan, no Cloud). */
export const FREE_WAY_TITLE = "Run it free on your computer";
/**
 * Caveman Code runs on the person's own subscriptions and keys with no plan (caveman.so/download says "Free on your own
 * subscriptions and keys"; D1, 21 Nov). Where the download is for another OS the row says so and offers nothing to press.
 */
export function freeWay(canMac: boolean = canGetMacHere()): {
  readonly title: typeof FREE_WAY_TITLE;
  readonly line: string;
  readonly action: { readonly label: string; readonly url: string } | null;
} {
  return canMac
    ? {
        title: FREE_WAY_TITLE,
        line: "Caveman Code runs on your own subscriptions and keys. No plan needed.",
        action: { label: "Download for Mac", url: DOWNLOAD_URL },
      }
    : { title: FREE_WAY_TITLE, line: MAC_ONLY_LINE, action: null };
}

/** What a Mac last said about this browser (state/device-approval.ts deviceStatusOf), as far as this file reads it. */
export interface MacAnswer {
  readonly status: "pending" | "approved" | "refused";
  /** This browser's own code, which the Mac's question shows too. */
  readonly code?: string | undefined;
}

/**
 * The person's Mac as this browser stands with it. Their Chiefs, plugins and automations live on a Mac, so a window
 * with no computer behind it says where that Mac is and the one thing to do next, never an empty page.
 */
export type MacHere =
  /** No Mac of theirs is signed in to Caveman. */
  | { readonly kind: "none" }
  /** One is, and is not on line: the app is closed, the Mac sleeps, or sync is off there. */
  | { readonly kind: "asleep"; readonly name: string }
  /** On line, and never asked about this browser: connecting makes it ask. */
  | {
      readonly kind: "ask";
      readonly name: string;
      readonly place: Extract<ChatPlace, { kind: "mac" }>;
    }
  /** Its screen is asking now. */
  | { readonly kind: "waiting"; readonly name: string; readonly code?: string | undefined }
  | { readonly kind: "refused"; readonly name: string }
  /** On line and it let this browser in: the window uses it by itself (quietHome). */
  | { readonly kind: "ready"; readonly name: string };

const MAC_RANK = { ready: 0, waiting: 1, ask: 2, refused: 3 } as const;

/**
 * `said`: what each Mac last answered this browser on this page; `allowed`: whether it let it in before. With several
 * Macs on line, the one furthest along is the one the window speaks of (let in, then asking, then not asked yet).
 */
export function macHere(
  list: Runtimes | null,
  said: (runtimeId: string) => MacAnswer | undefined,
  allowed: (runtimeId: string) => boolean,
): MacHere {
  const macs = [...(list?.runtimes.values() ?? [])]
    .filter((r) => r.kind === "laptop" && r.computer_state !== "deleted")
    .sort(newestFirst);
  if (macs.length === 0) return { kind: "none" };
  const on = macs.filter((r) => r.online);
  if (on.length === 0) return { kind: "asleep", name: macs[0]!.name || "your Mac" };
  const stand = (r: RuntimeState): keyof typeof MAC_RANK => {
    const answer = said(r.runtime_id)?.status;
    if (answer === "pending") return "waiting";
    if (answer === "refused") return "refused";
    return allowed(r.runtime_id) ? "ready" : "ask";
  };
  // Stable: among Macs equally far along, the one heard from last.
  const mac = on
    .map((r) => ({ r, kind: stand(r) }))
    .sort((a, b) => MAC_RANK[a.kind] - MAC_RANK[b.kind])[0]!;
  const name = mac.r.name || "your Mac";
  if (mac.kind === "waiting") return { kind: "waiting", name, code: said(mac.r.runtime_id)?.code };
  if (mac.kind === "ask")
    return {
      kind: "ask",
      name,
      place: { kind: "mac", name, runtimeId: mac.r.runtime_id, computerId: mac.r.computer_id },
    };
  return { kind: mac.kind, name };
}

/** The one thing to do next so the Mac shows here: a sentence, and the button when this browser can do it. */
export interface MacNext {
  readonly title: string;
  readonly line: string;
  readonly action:
    | { readonly kind: "download"; readonly label: string }
    | {
        readonly kind: "connect";
        readonly label: string;
        readonly place: Extract<ChatPlace, { kind: "mac" }>;
      }
    | null;
}

/**
 * Null once the Mac let this browser in: nothing is left to do. `canMac`: this browser is on a Mac; on any other
 * computer there is no download to offer, and the step says so and that the web app works now.
 */
export function macNext(mac: MacHere, canMac: boolean = canGetMacHere()): MacNext | null {
  switch (mac.kind) {
    case "none":
      return canMac
        ? {
            title: "Get Caveman Code for Mac",
            line: "Get Caveman Code for Mac, then sign in with this account and turn on sync.",
            action: { kind: "download", label: "Download for Mac" },
          }
        : { title: "The desktop app is Mac only today", line: MAC_ONLY_LINE, action: null };
    case "asleep":
      return {
        title: `Open Caveman Code on ${mac.name}`,
        line: `${mac.name} isn't on line. Open Caveman Code there and keep sync on.`,
        action: null,
      };
    case "ask":
      return {
        title: `Connect this browser to ${mac.name}`,
        line: `${mac.name} asks you once to allow this browser.`,
        action: { kind: "connect", label: `Connect to ${mac.name}`, place: mac.place },
      };
    case "waiting":
      return {
        title: `Allow this browser on ${mac.name}`,
        line: `On ${mac.name}, choose Allow${mac.code ? `, and check it shows ${mac.code}` : ""}. You only do this once.`,
        action: null,
      };
    case "refused":
      return {
        title: `${mac.name} did not allow this browser`,
        line: `Open Settings on ${mac.name}, unblock this browser under Devices, then reload this page.`,
        action: null,
      };
    case "ready":
      return null;
  }
}

export type MacStepId = "get" | "open" | "allow";

/** The way from nothing to a Mac this browser drives, in order, each ticked from what Cloud and the Mac say. */
export function macSteps(
  mac: MacHere,
): ReadonlyArray<{ readonly id: MacStepId; readonly label: string; readonly done: boolean }> {
  const has = mac.kind !== "none";
  const on = has && mac.kind !== "asleep";
  return [
    { id: "get", label: "Get Caveman Code for Mac", done: has },
    {
      id: "open",
      label: mac.kind === "asleep" ? `Open it on ${mac.name}` : "Open it and turn on sync",
      done: on,
    },
    { id: "allow", label: "Allow this browser", done: mac.kind === "ready" },
  ];
}

export type WebStepId = "plan" | "chat";

/**
 * The Getting started steps of a browser window with no computer behind it, for someone who has no Mac to connect:
 * on a computer that is not a Mac, with no Mac of theirs signed in, the Mac steps (open it, allow this browser) point
 * at something they may not have, and the page says the desktop app is Mac only today. What is left is what this
 * window does itself: a plan, which Cloud chats need (the offer the first visit's card makes, `free`: Cloud says the
 * account holds none), and a first chat in Cloud (New chat). With Cloud off nothing here can be done, so nothing is
 * offered. Null: the Mac steps apply (this browser is on a Mac, or a Mac of theirs is signed in, so naming it is true).
 */
export function webSteps(
  mac: MacHere,
  win: WebWindow,
  cloud: ChatPlaces["cloud"],
  free: boolean | null,
  canMac: boolean = canGetMacHere(),
): ReadonlyArray<{
  readonly id: WebStepId;
  readonly label: string;
  readonly done: boolean;
}> | null {
  if (canMac || mac.kind !== "none") return null;
  if (win.kind !== "app" || cloud === "off") return [];
  return [
    ...(free === true ? [{ id: "plan" as const, label: "Choose a plan", done: false }] : []),
    { id: "chat" as const, label: "Start a chat in Cloud", done: !win.nothingYet },
  ];
}

// ------------------------------------------------------------------ what the window shows

export const SIGN_IN_LINE = "Sign in to see your chats.";
export const LIST_FAILED_LINE = "Can't reach Caveman. Trying again.";

export type WebWindow =
  /** Cloud has not said who is signed in, or the first list is on its way. */
  | { readonly kind: "loading" }
  /** Nobody is signed in to Caveman here: one line and one button. */
  | { readonly kind: "signed_out" }
  /** The app itself. */
  | {
      readonly kind: "app";
      /** Cloud's list cannot be read now (it is asked again by itself): the sidebar says so over what it last had. */
      readonly failed: boolean;
      /** A first visit: no chat anywhere. The window opens on New chat. */
      readonly nothingYet: boolean;
    };

/**
 * What a web window shows: `signedIn` is Cloud's answer to who its cookie signs in (null until it answers); `list` the
 * person's chats as this window holds them (null before Cloud's routes are known).
 */
export function webWindow(
  signedIn: boolean | null,
  list: {
    readonly status: ListStatus;
    readonly ready: boolean;
    readonly chats: { readonly size: number };
  } | null,
): WebWindow {
  if (signedIn === false || list?.status === "signed_out") return { kind: "signed_out" };
  if (signedIn === null) return { kind: "loading" };
  const failed = list?.status === "reconnecting";
  // Signed in, and the list neither read nor refused yet.
  if (!list || (!list.ready && !failed)) return { kind: "loading" };
  return { kind: "app", failed, nothingYet: list.ready && list.chats.size === 0 };
}

// ------------------------------------------------------------------ a first visit

/** The quiet line for someone signed in on the web whose Mac does not show here yet. */
export const SYNC_LINE = "Turn on sync on your Mac to see your chats here";

/** One way to start, on the first visit's card. `unlock` opens the plans (components/UnlockPlans.tsx). */
export interface StartRow {
  readonly id: "free" | "mac" | "cloud";
  readonly title: string;
  readonly line: string;
  readonly action:
    | { readonly kind: "download"; readonly label: string }
    | { readonly kind: "unlock"; readonly label: string }
    | null;
}

export interface StartCard {
  readonly title: string;
  readonly rows: ReadonlyArray<StartRow>;
  /** Said quietly under the rows when the person's Mac is not on line to show their chats; never a pop-up. */
  readonly sync: string | null;
}

/**
 * How to start, for a signed-in account with nothing yet (`nothingYet`) and no Mac of theirs on line here: the free way
 * on their own computer (the download for this OS, or where it is Mac only, the plain line), and Cloud with a plan.
 * `free`: Cloud says the account has no plan (null until it does; the plans are then not offered). Null when a Mac of
 * theirs is on line (New chat can run there) or the window has chats of its own.
 */
export function startCard(
  win: WebWindow,
  mac: MacHere,
  { free, canMac = canGetMacHere() }: { readonly free: boolean | null; readonly canMac?: boolean },
): StartCard | null {
  if (win.kind !== "app" || !win.nothingYet) return null;
  if (mac.kind !== "none" && mac.kind !== "asleep") return null;
  const way = freeWay(canMac);
  const first: StartRow =
    mac.kind === "asleep"
      ? {
          id: "mac",
          title: `Open Caveman Code on ${mac.name}`,
          line: `${mac.name} isn't on line. Open Caveman Code there and keep sync on.`,
          action: null,
        }
      : {
          id: "free",
          title: way.title,
          line: way.line,
          action: way.action ? { kind: "download", label: way.action.label } : null,
        };
  const cloud: StartRow = {
    id: "cloud",
    title: "Run it in Cloud",
    line: "Chats in Cloud come with a plan. Connect a repository, then send.",
    action: free === true ? { kind: "unlock", label: "See plans" } : null,
  };
  return { title: "Ways to start", rows: [first, cloud], sync: SYNC_LINE };
}

// ------------------------------------------------------------------ one wait, one line

/** "Waking Cloud… 8s": what a wait says, with its seconds (words.md: one wait, one line). */
export function waitLine(doing: string, sinceMs: number, nowMs: number): string {
  return `${doing}… ${Math.max(0, Math.round((nowMs - sinceMs) / 1000))}s`;
}

/** After this long with no network, a wait says so instead of counting (words.md). */
export const NO_NETWORK_AFTER_MS = 10_000;
export const OPEN_FAILED_LINE = "Cloud couldn't wake. Trying again.";
export const OPEN_OFFLINE_LINE = "No network. Opens when you're back online.";

/**
 * The one line a chat's changes or pull request show while its Cloud computer wakes for them (SyncHub.openWait):
 * "Waking Cloud… 4s"; Cloud's refusal in our words; no network for a while, said so. Never a computer's name, and
 * never something for the person to do: the panel loads by itself once Cloud answers.
 */
export function openWaitLine(
  wait: { readonly since: number; readonly failed: boolean },
  nowMs: number,
  online = true,
): string {
  if (!online && nowMs - wait.since >= NO_NETWORK_AFTER_MS) return OPEN_OFFLINE_LINE;
  if (wait.failed) return OPEN_FAILED_LINE;
  return waitLine("Waking Cloud", wait.since, nowMs);
}
