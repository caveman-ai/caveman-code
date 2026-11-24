// Device approval on this device (DESIGN S13): the handshake each connection to a laptop runtime runs (registered on
// the sync layer's device hooks), and what each Mac last said about this device, for the waiting screen.
import { deviceHandshake, type DeviceStatusParams, type RuntimeKind } from "@caveman-app/session-protocol/device-client";
import { queuedCallFields, signMove, type DeviceKey } from "@caveman-app/session-protocol/devices";
import type { Handshake } from "@caveman-app/session-protocol/client";

import { deviceName, thisDevice } from "./device-key.ts";
import { registerDeviceHooks } from "./sync/device-hooks.ts";

const statuses = new Map<string, DeviceStatusParams>();
const listeners = new Set<() => void>();
const handshakes = new Map<string, Handshake>();

/** What runtime `runtimeId` last said about this device on any connection; undefined until one asked. */
export const deviceStatusOf = (runtimeId: string | null | undefined): DeviceStatusParams | undefined =>
  runtimeId ? statuses.get(runtimeId) : undefined;

export function subscribeDeviceStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

let answers = 0;
/** Counts every change to what a Mac said: a snapshot for a reader of several Macs at once (useSyncExternalStore). */
export const deviceAnswers = (): number => answers;

export function noteDeviceStatus(runtimeId: string, status: DeviceStatusParams): void {
  const last = statuses.get(runtimeId);
  if (last?.status === status.status && last.code === status.code && last.runtime_name === status.runtime_name) return;
  statuses.set(runtimeId, status);
  answers++;
  rememberAllowed(runtimeId, status.status === "approved");
  for (const listener of listeners) listener();
}

/**
 * The Macs that let this browser in, by runtime id (a Mac's is its enrolment), kept across page lives. Only a hint for
 * which Mac a web window may use without the person opening one of its chats (sync/web-window.ts quietHome): every
 * connection still runs the handshake, and a Mac that changed its mind says so there and leaves this list.
 */
const ALLOWED_KEY = "caveman.device.allowed";
const MAX_ALLOWED = 32;
function readAllowed(): string[] {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(ALLOWED_KEY) ?? "[]") as unknown;
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
function rememberAllowed(runtimeId: string, allowed: boolean): void {
  try {
    const kept = readAllowed();
    if (kept.includes(runtimeId) === allowed) return;
    const next = allowed ? [...kept, runtimeId].slice(-MAX_ALLOWED) : kept.filter((id) => id !== runtimeId);
    globalThis.localStorage?.setItem(ALLOWED_KEY, JSON.stringify(next));
  } catch {
    // No storage: the Mac is asked again when one of its chats is opened.
  }
}

/** Whether Mac `runtimeId` let this browser in, on this page life or an earlier one; false once it said otherwise. */
export function allowedBefore(runtimeId: string): boolean {
  const now = statuses.get(runtimeId)?.status;
  return now !== undefined ? now === "approved" : readAllowed().includes(runtimeId);
}

/**
 * Registers this device's handshake for every runtime connection the app opens. `kindOf` says what a runtime is from
 * Cloud's list (a Cloud computer never challenges, so it is not waited for).
 */
export function installDeviceHooks(options: { readonly kindOf: (runtimeId: string) => RuntimeKind | undefined; readonly device?: typeof thisDevice }): void {
  handshakes.clear();
  registerDeviceHooks({
    handshake: (runtimeId) => {
      let handshake = handshakes.get(runtimeId);
      if (!handshake) {
        handshake = deviceHandshake({
          device: options.device ?? thisDevice,
          kind: () => options.kindOf(runtimeId),
          onStatus: (status) => noteDeviceStatus(runtimeId, status),
        });
        handshakes.set(runtimeId, handshake);
      }
      return handshake;
    },
    // A call queued in Cloud for a chat on a Mac carries this device's signature over exactly that call, so the Mac
    // runs it (and a Cloud computer, which needs none, ignores it).
    callFields: async (call) => queuedCallFields(await (options.device ?? thisDevice)(), call),
    // Whether a Mac still has to allow this device, in the waiting screen's words: the sync hub reads such a Mac's
    // chats from Cloud's copy meanwhile and holds sends for it (K4).
    approval: (runtimeId) => {
      const status = deviceStatusOf(runtimeId);
      const copy = waitingCopy(status, deviceName(globalThis.navigator?.userAgent ?? "", globalThis.navigator?.maxTouchPoints ?? 0));
      return status && copy ? { state: status.status === "pending" ? "pending" : "refused", ...copy } : null;
    },
    onApproval: subscribeDeviceStatus,
    // A move from this device of a chat on a Mac, likewise: the Mac lets the chat go only for a device it allowed.
    moveFields: async (move) => ({ device: await signMove(await (options.device ?? thisDevice)(), move) }),
  });
}

/**
 * The waiting screen's words for a status, or null when there is nothing to say (approved, or never asked). The code
 * it asks the person to check is this device's own (deviceHandshake reports only that), never one the Mac's answer
 * carried through the relay (A-1).
 */
export function waitingCopy(status: DeviceStatusParams | undefined, deviceName: string): { readonly title: string; readonly detail: string } | null {
  if (!status || status.status === "approved") return null;
  const mac = status.runtime_name || "your Mac";
  const what = deviceName.split(",")[0]?.trim() || "this device";
  const kind = /iPhone|Android phone/.test(what) ? "phone" : /iPad|tablet/.test(what) ? "tablet" : "browser";
  if (status.status === "pending")
    return {
      title: `Waiting for ${mac} to allow this ${kind}`,
      detail: `On ${mac}, choose Allow when it asks${status.code ? `, and check it shows ${status.code}` : ""}. You only do this once.`,
    };
  return {
    title: `${mac} did not allow this ${kind}`,
    detail: `To try again, open Settings on ${mac}, unblock this ${kind} under Devices, then reload this page. You can still read its chats here.`,
  };
}

/**
 * How long a Join waits, after its connection is let in, for that Mac's sealed answer that it took this Mac as one of
 * the person's Macs (m-h): a Mac that never says so (an older one, or a relay that made the "approved" up) took nothing.
 */
export const JOIN_ANSWER_MS = 15_000;

/**
 * Join your other Mac (decision 31), in this Mac's desktop app: a connection of its own to that Mac's runtime (`open`,
 * outside the pool, with this handshake) whose first hello proves the code that Mac's screen shows, then that Mac's
 * answer: pending while its screen asks, then its first sealed frame, which names the role "mac" with a proof under the
 * same code (deviceHandshake). Resolves only on that (m-h): a plain "approved" can come from the relay; rejects on a
 * refusal (a wrong, used or old code), a dropped connection (the code had its one try), or no sealed answer within
 * JOIN_ANSWER_MS of being let in. The connection closes either way.
 */
export function joinMac(
  open: (handshake: Handshake) => { close(): void } | null,
  code: string,
  options: { readonly onStatus?: (status: DeviceStatusParams) => void; readonly device?: () => Promise<DeviceKey>; readonly answerMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let connection: { close(): void } | null = null;
    let done = false;
    let answerTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(answerTimer);
      queueMicrotask(() => connection?.close());
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    };
    const handshake = deviceHandshake({
      device: options.device ?? thisDevice,
      kind: () => "laptop",
      pairing: code,
      onStatus: (status) => {
        options.onStatus?.(status);
        const mac = status.runtime_name || "That Mac";
        // Taken only on the Mac's sealed answer, proved under the code (deviceHandshake reports only that as "mac").
        if (status.role === "mac") finish();
        else if (status.status === "approved")
          answerTimer ??= setTimeout(
            () => finish(new Error(`${mac} let this Mac in but never said it took it as one of your Macs: update Caveman Code there, then show a new code and join again.`)),
            options.answerMs ?? JOIN_ANSWER_MS,
          );
        else if (status.status === "refused") finish(new Error(`${mac} did not take this Mac.`));
      },
    });
    connection = open(async (link) => {
      try {
        const out = await handshake(link);
        // No challenge came: an older runtime, or not a Mac at all. Nothing was joined.
        if (out === undefined) finish(new Error("That computer did not ask this Mac anything: open Caveman Code there, update it, and show a new code."));
        return out;
      } catch (error) {
        finish(error);
        throw error;
      }
    });
    if (connection === null) finish(new Error("Caveman cannot reach that Mac from here: sign this Mac in to Caveman first (Settings, Remote control)."));
  });
}
