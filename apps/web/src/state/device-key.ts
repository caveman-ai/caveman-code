// This device's own key for driving a Mac through Caveman Cloud (DESIGN S13; the wire is session-protocol devices.ts).
// In a browser: a P-256 key WebCrypto made non-extractable, kept in IndexedDB, so page code can sign with it but never
// read it out. In the desktop app: the shell's key, sealed with the system keychain (safeStorage) in the main
// process, which signs only device-approval payloads. Each Mac allows the key once, on its own screen.
import {
  agentsStatementFor,
  cleanDeviceName,
  deviceIdOf,
  newDeviceKeyPair,
  publicKeyOf,
  webCryptoDeviceKey,
  type Bytes,
  type DeviceFamily,
  type DeviceKey,
} from "@caveman-app/session-protocol/devices";
import type { Params, Result } from "@caveman-app/session-protocol";
import type { DesktopDeviceKey } from "@caveman-app/desktop/bridge";

import { indexedDbKv, type Kv } from "./sync/kv.ts";

const KEY = "device";
const LOCK = "caveman-device-key";

/** "iPhone, Safari", "Mac, Chrome": what a Mac shows when this browser asks to drive it. */
export function deviceName(userAgent: string, touchPoints = 0): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android phone"
          : "Android tablet"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows PC"
              : /Linux/.test(ua)
                ? "Linux"
                : "A device";
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/.test(ua)
      ? "Firefox"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Chrome|CriOS/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : "";
  return cleanDeviceName(browser ? `${device}, ${browser}` : device);
}

/** The key in `kv`, made (once, even with several tabs open) when there is none. */
export async function loadDeviceKey(kv: Kv, name: string, locks?: { request<T>(name: string, run: () => Promise<T>): Promise<T> }): Promise<DeviceKey> {
  const load = async () => {
    const stored = await kv.get<{ privateKey?: CryptoKey; public_key?: unknown }>(KEY);
    const public_key = publicKeyOf(stored?.public_key);
    if (stored?.privateKey && public_key) return webCryptoDeviceKey({ privateKey: stored.privateKey, public_key, name });
    const pair = await newDeviceKeyPair();
    await kv.put(KEY, { privateKey: pair.privateKey, public_key: pair.public_key });
    return webCryptoDeviceKey({ ...pair, name });
  };
  return locks ? locks.request(LOCK, load) : load();
}

/**
 * The desktop shell's key as a DeviceKey: a Mac's (kind "mac"), so its hellos say so and its screen's Allow and Remove
 * are signed for the person's other Macs.
 */
export async function desktopDeviceKey(bridge: DesktopDeviceKey): Promise<DeviceKey> {
  const { name, public_key } = await bridge.describe();
  const key = publicKeyOf(public_key);
  if (!key) throw new Error("the desktop's device key is not a P-256 key");
  return { device_id: await deviceIdOf(key), name: cleanDeviceName(name), public_key: key, kind: "mac", sign: (data: Bytes) => bridge.sign(data) };
}

let mine: Promise<DeviceKey> | undefined;

/** This device's key, made on first use. A failure is not kept: the next connection tries again. */
export function thisDevice(): Promise<DeviceKey> {
  mine ??= (async () => {
    const bridge = globalThis.window?.cavemanDesktop?.device;
    // The shell's keychain-sealed key when it has one; else (no keychain, an older shell) a WebCrypto key here.
    if (bridge) {
      const sealed = await desktopDeviceKey(bridge).catch(() => undefined);
      if (sealed) return sealed;
    }
    const nav = globalThis.navigator as (Navigator & { locks?: { request<T>(name: string, run: () => Promise<T>): Promise<T> } }) | undefined;
    const locks = nav?.locks ? { request: <T,>(name: string, run: () => Promise<T>) => nav.locks!.request(name, run) } : undefined;
    return loadDeviceKey(indexedDbKv("caveman-device"), deviceName(nav?.userAgent ?? "", nav?.maxTouchPoints ?? 0), locks);
  })();
  mine.catch(() => (mine = undefined));
  return mine;
}

/** The two calls this Mac's runtime answers its own screen for its agents key (session-protocol devices.ts). */
export interface AgentsKeyClient {
  call(method: "device.agents", params: Params<"device.agents">): Promise<Result<"device.agents">>;
  call(method: "device.vouch", params: Params<"device.vouch">): Promise<Result<"device.vouch">>;
}

/** Runtimes whose agents key this window vouched for (or found vouched, or that have none), by person. */
const vouchedFor = new WeakMap<object, Set<string>>();

/**
 * In the desktop app, this Mac's screen vouches for its own runtime's agents key by itself, once the runtime's sign-in
 * names the person (`family`): the person's other Macs then take the mail this Mac's chats sign with it (session-protocol
 * macMail.ts). Only a Mac's desktop key signs one. Once per runtime and person: after that (or when the log already holds
 * it) nothing is asked again; a failure is tried again on the next call.
 */
export async function vouchAgentsKey(client: AgentsKeyClient, family: DeviceFamily, own: () => Promise<DeviceKey> = thisDevice): Promise<void> {
  const person = `${family.organization_id}:${family.user_id}`;
  const done = vouchedFor.get(client) ?? new Set<string>();
  vouchedFor.set(client, done);
  if (done.has(person)) return;
  const device = await own();
  const view = device.kind === "mac" ? await client.call("device.agents", {}) : undefined;
  const statement = view?.agents === undefined || view.vouched ? undefined : await agentsStatementFor(device, family, view.agents, view.name);
  if (statement !== undefined) await client.call("device.vouch", { request_id: `vouch-${crypto.randomUUID()}`, statement });
  done.add(person);
}

/**
 * vouchAgentsKey until it goes: a failure (the keychain locked, the runtime busy) is tried again `waitMs` later, twice as
 * long each time up to `maxMs`. Until a Mac's vouch is in Cloud its chats send no mail to the person's other Macs.
 * Answers a stop, for when the screen goes or the person changes.
 */
export function keepVouching(client: AgentsKeyClient, family: DeviceFamily, options: { readonly own?: () => Promise<DeviceKey>; readonly waitMs?: number; readonly maxMs?: number } = {}): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (wait: number): Promise<void> =>
    vouchAgentsKey(client, family, options.own).catch(() => {
      if (live) timer = setTimeout(() => void attempt(Math.min(wait * 2, options.maxMs ?? 5 * 60_000)), wait);
    });
  void attempt(options.waitMs ?? 5_000);
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
