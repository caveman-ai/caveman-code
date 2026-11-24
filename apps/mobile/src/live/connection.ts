// The phone's connection to one of the person's computers: Session Protocol's own client (connect, its reconnect with
// backoff, its outbox) and its own device handshake (deviceHandshake: the hello this phone's key signs, the wait while
// the Mac asks its person, then every frame sealed both ways), through Caveman Cloud's relay. Nothing of the protocol
// is written again here; this file only says where the relay is, which key answers, and what the connection is doing
// now, in the states a screen shows.
//
// The relay comes first because it works everywhere. The same-network path (a WebRTC data channel straight to the
// Mac, S14) is the protocol's connectDirect, which this already uses: it stays on the relay while the platform has no
// RTCPeerConnection, as a phone's JavaScript engine has none, and switches by itself once one is given (`direct.rtc`,
// or a global one). Frames are sealed the same on either path, under the same handshake.
import {
  ConnectionClosed,
  SessionProtocolError,
  type ConnectionState,
  type Outbox,
} from "@caveman-app/session-protocol/client";
import {
  deviceHandshake,
  type DeviceStatusParams,
} from "@caveman-app/session-protocol/device-client";
import type { DeviceKey } from "@caveman-app/session-protocol/devices";
import {
  connectDirect,
  DEFAULT_ICE_SERVERS,
  type DirectClient,
  type DirectOptions,
  type RtcPeerConstructor,
} from "@caveman-app/session-protocol/direct";

import {
  CloudError,
  SignedOut,
  type Computer,
  type DirectAdvert,
  type PhoneCloud,
} from "./cloud.ts";

/** What the connection is doing, as a screen says it. */
export type Link =
  /** Reaching the computer. `again`: it was open before (the link dropped; the client is back by itself). */
  | { readonly phase: "connecting"; readonly again: boolean }
  /** The Mac is asking its person about this phone: `code` is this phone's own, to compare with the Mac's dialog. */
  | { readonly phase: "waiting"; readonly code: string }
  /** Open: an approved Mac (every frame sealed), or a Cloud computer. `path`: through the relay, or direct on this network. */
  | { readonly phase: "open"; readonly path: "relay" | "direct" }
  /** The Mac's person chose Don't allow, or removed this phone: nothing more is tried until they unblock it there. */
  | { readonly phase: "refused"; readonly code: string }
  /** A Mac the relay cannot reach: asleep, off, or Remote control off there. Tried again by itself. */
  | { readonly phase: "asleep" }
  /**
   * A Cloud computer on its way up: Cloud was asked to wake it. `step`, once Cloud says more: "starting", its machine
   * is being started; "up", its machine runs and its runtime is linking. Tried again by itself.
   */
  | { readonly phase: "waking"; readonly step?: "starting" | "up" }
  /**
   * Cloud will not wake it now (nothing pays for its time, a limit), in Cloud's own words. `resetsAt`: when the plan
   * that is used up serves again, where Cloud said. Ended until the person asks again.
   */
  | { readonly phase: "held"; readonly reason: string; readonly resetsAt?: string }
  /** Cloud cannot be reached (no network, the relay down). Tried again by itself. */
  | { readonly phase: "unreachable" }
  /** The computer is no longer one of the person's (signed out of Caveman, or deleted). Ended. */
  | { readonly phase: "gone" }
  /** The phone's Caveman sign-in ended. Ended. */
  | { readonly phase: "signed-out" };

export interface Connection {
  readonly client: DirectClient;
  state(): Link;
  subscribe(listener: (state: Link) => void): () => void;
  close(): void;
}

export interface ConnectionOptions {
  readonly computer: Pick<Computer, "runtime_id" | "computer_id" | "kind">;
  readonly cloud: Pick<PhoneCloud, "relay" | "renew" | "wake" | "computers">;
  /** This phone's key (deviceKey.ts), asked for when a Mac challenges. */
  readonly device: () => Promise<DeviceKey>;
  /**
   * The same-network path to a Mac: what the install says about it (`advert`, Cloud's list), and the WebRTC
   * implementation where the platform has no global one (a phone: a native module the app does not ship yet).
   */
  readonly direct?: {
    readonly advert?: () => DirectAdvert | undefined;
    readonly rtc?: RtcPeerConstructor;
    readonly network?: DirectOptions["network"];
  };
  /** Where sends wait until answered. Default: memory (they survive a reconnect, not a relaunch). */
  readonly outbox?: Outbox;
  /**
   * The Cloud computer runs as another runtime now (Cloud mints a new runtime id at every wake, and refuses the old
   * one once the computer has stopped): this connection has ended, and whoever follows the computer connects to
   * `computer`, the same one under its new id. Without it such a computer reads as waking until it is followed again.
   */
  readonly onWoke?: (computer: Computer) => void;
  /**
   * Whether this connection may ask Cloud to wake a Cloud computer that does not answer. Default: it does, as a tap
   * on a computer once meant. The app passes false: an open phone never wakes anything by itself (only a message
   * does, and Cloud wakes the computer for it), so a computer that was put to sleep reads asleep and stays so.
   */
  readonly wakes?: boolean;
}

/** A Cloud computer is asked to wake at most this often while the relay cannot reach it. */
const WAKE_EVERY_MS = 60_000;
/** After a refused connection, Cloud is asked what became of the computer at most this often. */
const PROBE_EVERY_MS = 10_000;
/**
 * A Cloud computer's socket counts as open once it has held this long. The relay takes a socket before it says the
 * computer is away (its 4404 follows at once), and a Cloud computer has no handshake to show it is there, as a Mac's
 * hello does.
 */
const CLOUD_OPEN_HOLDS_MS = 500;

/**
 * What a wake Cloud refused ends the wait as; undefined for a refusal that passes (no network, Cloud busy, too many
 * hints this minute), which is tried again. 404: Cloud knows no such computer any more. Any other refusal is Cloud's
 * own sentence for why it will not wake it now: nothing pays for its time (402), or a limit on computers awake (409).
 */
function wakeRefusal(
  error: unknown,
): Extract<Link, { phase: "gone" | "held" | "signed-out" }> | undefined {
  if (error instanceof SignedOut) return { phase: "signed-out" };
  if (!(error instanceof CloudError)) return undefined;
  if (error.status === 404) return { phase: "gone" };
  if (error.status < 400 || error.status >= 500 || error.status === 408 || error.status === 429)
    return undefined;
  const resets = error.details?.resets_at;
  return {
    phase: "held",
    reason: error.message,
    ...(typeof resets === "string" && resets !== "" ? { resetsAt: resets } : {}),
  };
}

/** How often a wait for a Cloud computer asks Cloud what became of it. */
const WAKING_LOOK_MS = 2_000;

/**
 * The wait for a Cloud computer that has no runtime to connect to (it sleeps: Cloud ends its runtime's key at every
 * stop, so only its computer id is good across a wake). Cloud is asked to wake it, and the person's computers are read
 * until that computer runs as a runtime that is on line: `onWoke` hands it over, and the wait has ended. Meanwhile its
 * state says what is happening, in the same words a connection's does: waking, then starting, then up.
 */
export function wakeComputer(options: {
  readonly computer: Pick<Computer, "computer_id">;
  readonly cloud: Pick<PhoneCloud, "wake" | "computers">;
  readonly onWoke: (computer: Computer) => void;
  /** How often Cloud is asked what became of it (tests wait less). */
  readonly every?: number;
}): Pick<Connection, "state" | "subscribe" | "close"> {
  const { computer, cloud } = options;
  let link: Link = { phase: "waking" };
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let askedAt = 0;
  const listeners = new Set<(state: Link) => void>();
  const set = (next: Link) => {
    if (ended || JSON.stringify(link) === JSON.stringify(next)) return;
    link = next;
    for (const listener of [...listeners]) listener(next);
  };
  const end = (next?: Link) => {
    if (next) set(next);
    ended = true;
    clearTimeout(timer);
  };
  const step = (state: Computer["state"] | undefined) => {
    if (state === "starting" || state === "running")
      set({ phase: "waking", step: state === "running" ? "up" : "starting" });
  };
  const look = async () => {
    if (Date.now() - askedAt >= WAKE_EVERY_MS) {
      askedAt = Date.now();
      try {
        step((await cloud.wake(computer.computer_id)).state);
      } catch (error) {
        const refused = wakeRefusal(error);
        if (refused) return end(refused);
        // It passes: asked again on the next look, not a minute on.
        askedAt = 0;
      }
    }
    if (ended) return;
    try {
      const now = (await cloud.computers()).computers.find(
        (c) => c.computer_id === computer.computer_id,
      );
      if (ended) return;
      if (now && now.runtime_id !== "" && now.online) {
        end();
        return options.onWoke(now);
      }
      if (link.phase === "unreachable") set({ phase: "waking" });
      step(now?.state);
    } catch (error) {
      if (ended) return;
      if (error instanceof SignedOut) return end({ phase: "signed-out" });
      set({ phase: "unreachable" });
    }
  };
  const loop = () => {
    void look().finally(() => {
      if (!ended) timer = setTimeout(loop, options.every ?? WAKING_LOOK_MS);
    });
  };
  loop();
  return {
    state: () => link,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      listeners.clear();
      end();
    },
  };
}

export function openConnection(options: ConnectionOptions): Connection {
  const { computer, cloud } = options;
  let link: Link = { phase: "connecting", again: false };
  let ended = false;
  const listeners = new Set<(state: Link) => void>();
  const same = (a: Link, b: Link) => a.phase === b.phase && JSON.stringify(a) === JSON.stringify(b);
  const set = (next: Link) => {
    if (ended || same(link, next)) return;
    link = next;
    for (const listener of [...listeners]) listener(next);
  };
  /** Ends the connection in `phase`: nothing is tried again. */
  const end = (next: Link) => {
    set(next);
    ended = true;
    client.close();
  };

  const onStatus = (status: DeviceStatusParams) => {
    // The code is this phone's own key's (deviceHandshake reports only that), never one the relay carried (A-1).
    if (status.status === "pending") set({ phase: "waiting", code: status.code });
    else if (status.status === "refused") set({ phase: "refused", code: status.code });
  };

  let wokeAt = 0;
  let probedAt = 0;
  let lookedAt = 0;
  /**
   * The runtime this Cloud computer runs as now, looked up by its computer id among `computers`, when it is not the
   * one this connection was opened to. `up`: only one that is on line (the old id may come back; a new one that is
   * not up yet is waited for). A Mac's runtime id is its enrolment and is never looked up this way.
   */
  const wokeAs = (computers: ReadonlyArray<Computer>, up: boolean) =>
    computer.kind !== "cloud"
      ? undefined
      : computers.find(
          (c) =>
            c.kind === "cloud" &&
            c.computer_id === computer.computer_id &&
            c.runtime_id !== "" &&
            c.runtime_id !== computer.runtime_id &&
            (c.online || !up),
        );
  /** What Cloud says the computer is doing, while this id stays unanswered. */
  const stepTo = (state: Computer["state"] | undefined) => {
    if (!ended && link.phase === "waking" && (state === "starting" || state === "running"))
      set({ phase: "waking", step: state === "running" ? "up" : "starting" });
  };
  /** Ends this connection for the one to `next`: nothing more is tried here, and the phase stays as it read. */
  const follow = (next: Computer) => {
    if (ended || options.onWoke === undefined) return false;
    ended = true;
    client.close();
    options.onWoke(next);
    return true;
  };
  /** The relay cannot reach the computer: a Mac sleeps until it is back; a Cloud computer is asked to wake. */
  const away = () => {
    if (computer.kind === "laptop") return set({ phase: "asleep" });
    // Not to be woken from here: it sleeps until a message wakes it, and whoever follows it reads Cloud's list.
    if (options.wakes === false) return set({ phase: "asleep" });
    if (link.phase !== "waking") set({ phase: "waking" });
    // Once it is up it may run under a new runtime id: looked up by its computer while this id stays unanswered.
    if (Date.now() - lookedAt >= PROBE_EVERY_MS) {
      lookedAt = Date.now();
      void cloud.computers().then(
        ({ computers }) => {
          if (ended || link.phase === "open") return;
          const next = wokeAs(computers, true);
          if (next) return void follow(next);
          stepTo(computers.find((c) => c.computer_id === computer.computer_id)?.state);
        },
        () => undefined,
      );
    }
    if (Date.now() - wokeAt < WAKE_EVERY_MS) return;
    wokeAt = Date.now();
    void cloud.wake(computer.computer_id).then(
      ({ state }) => stepTo(state),
      (error: unknown) => {
        if (ended || link.phase === "open") return;
        const refused = wakeRefusal(error);
        if (refused) end(refused);
      },
    );
  };
  /**
   * The relay refused the connection before it opened, and no client can read why. So the bearer is dropped (the next
   * attempt mints another) and Cloud is asked: signed out, the computer gone, the computer away, or Cloud out of reach.
   */
  const probe = () => {
    cloud.renew();
    if (Date.now() - probedAt < PROBE_EVERY_MS) return;
    probedAt = Date.now();
    cloud.computers().then(
      ({ computers }) => {
        if (ended || link.phase === "open") return;
        const now = computers.find((c) => c.runtime_id === computer.runtime_id);
        if (!now) {
          // A Cloud computer's runtime id is refused once the computer has stopped. It runs as another now, or is
          // not up yet and is woken; only a Mac that signed out, or a computer Cloud no longer knows, is gone.
          const next = wokeAs(computers, false);
          if (next && follow(next)) return;
          return computer.kind === "cloud" ? away() : end({ phase: "gone" });
        }
        if (!now.online) return away();
        set({ phase: "unreachable" });
      },
      (error: unknown) => {
        if (ended || link.phase === "open") return;
        if (error instanceof SignedOut) return end({ phase: "signed-out" });
        set({ phase: "unreachable" });
      },
    );
  };

  let holding: ReturnType<typeof setTimeout> | undefined;
  const onState = (state: ConnectionState, error?: Error) => {
    clearTimeout(holding);
    if (ended) return;
    if (state === "open") {
      if (computer.kind === "laptop") return set({ phase: "open", path: client.path() });
      holding = setTimeout(() => set({ phase: "open", path: client.path() }), CLOUD_OPEN_HOLDS_MS);
      return;
    }
    if (error instanceof ConnectionClosed) {
      // The relay's close codes (the client keeps retrying): 4401 the bearer was refused; 4404 the runtime is not
      // connected; 1006 the upgrade itself was refused.
      if (error.code === 4401) return void cloud.renew();
      if (error.code === 4404) return away();
      if (error.code === 1006) return probe();
      return set({
        phase: "connecting",
        again: link.phase === "open" || (link.phase === "connecting" && link.again),
      });
    }
    // The Mac said no for good (deviceHandshake's refusal ends the client).
    if (
      state === "closed" &&
      error instanceof SessionProtocolError &&
      error.error.data?.reason === "device_not_approved"
    ) {
      const code = link.phase === "waiting" || link.phase === "refused" ? link.code : "";
      set({ phase: "refused", code });
      ended = true;
      return;
    }
    // Every retry says "connecting" again: only a link that was open has something new to say.
    if (link.phase === "open") set({ phase: "connecting", again: true });
  };

  const endpoint = cloud.relay(computer.runtime_id);
  const token = async () => {
    try {
      return await endpoint.token();
    } catch (error) {
      if (error instanceof SignedOut) end({ phase: "signed-out" });
      else if (link.phase !== "open") set({ phase: "unreachable" });
      throw error;
    }
  };
  const advert = () => options.direct?.advert?.();
  const client: DirectClient = connectDirect(endpoint.url, token, onState, {
    handshake: deviceHandshake({ device: options.device, kind: () => computer.kind, onStatus }),
    ...(options.outbox ? { outbox: options.outbox } : {}),
    direct: {
      // Only a Mac offers a direct path, and only where the install allows it (it said so, or said nothing).
      enabled: () => computer.kind === "laptop" && advert()?.enabled !== false,
      iceServers: () => advert()?.stun_servers.map((urls) => ({ urls })) ?? DEFAULT_ICE_SERVERS,
      onPath: (path) => {
        if (link.phase === "open") set({ phase: "open", path });
      },
      ...(options.direct?.rtc ? { rtc: options.direct.rtc } : {}),
      ...(options.direct?.network ? { network: options.direct.network } : {}),
    },
  });

  return {
    client,
    state: () => link,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      clearTimeout(holding);
      if (ended) return;
      ended = true;
      listeners.clear();
      client.close();
    },
  };
}
