// What Settings, Devices and the "Allow?" dialog say, and the statements this Mac's screen signs when it allows or
// removes a device for the person's other Macs (docs/). Only a Mac's desktop key signs one
// (kind "mac": keychain-sealed, in the app's own code); a browser's key, whose page Cloud serves, never does, so there
// the Allow counts on this Mac only.
import type { DeviceList, DeviceRequest } from "@caveman-app/session-protocol";
import { allowStatementFor, removeStatementFor, type DeviceKey, type DeviceStatement } from "@caveman-app/session-protocol/devices";

type Entry = DeviceList["devices"][number];
type Blocked = DeviceList["blocked"][number];

/** How a device came to be allowed here: on this screen (signed for the person's other Macs, or not), or through another Mac. */
export function allowedCopy(device: Pick<Entry, "allowed_by" | "shared">): string {
  if (device.allowed_by) return `Allowed through ${device.allowed_by.name}`;
  return device.shared ? "Allowed here" : "This Mac only";
}

/**
 * A statement this screen signed that Caveman Cloud would not carry: it counts on this Mac only, and the row says why.
 * One still waiting on this Mac to go (it has not reached Caveman since): the other Macs do not have it yet (m-j).
 */
export function notSharedCopy(entry: { readonly not_shared?: string | undefined; readonly waiting?: boolean | undefined }): string {
  if (entry.not_shared) return ` Your other Macs did not get it: ${entry.not_shared.replace(/\.$/, "")}.`;
  return entry.waiting ? " Not yet sent to your other Macs: it goes once this Mac reaches Caveman." : "";
}

/** Why a device is refused here: removed on this screen, or on another of the person's Macs. */
export function removedCopy(device: Pick<Blocked, "removed_by">): string {
  return device.removed_by ? `Removed on ${device.removed_by.name}` : "Removed here";
}

/**
 * The device a waiting request comes from, when this Mac lets it in already (allowed here, or through another of the
 * person's Macs) and it joined with this Mac's code to count as a Mac here (decision 31): the device as listed.
 */
export function upgradeOf(list: Pick<DeviceList, "devices">, request: Pick<DeviceRequest, "device_id" | "role">): Entry | undefined {
  return request.role === "mac" ? list.devices.find((d) => d.device_id === request.device_id) : undefined;
}

/** Where a Mac's own code is to be checked: the device asking already drives this Mac, so it shows no waiting code. */
const ownCode = (code: string) => `the Caveman Code app there shows ${code} as This Mac's code (Settings, Devices)`;

/**
 * The "Allow?" question: a Mac's app that joined with the code this Mac showed (decision 31) is named so, in words,
 * with what allowing it also lets it do. Anything else asks as a device, a Mac's app without the code too. `upgrade`:
 * a device this Mac lets in already, joining now to count as a Mac (upgradeOf).
 */
export function requestCopy(request: Pick<DeviceRequest, "name" | "code" | "role">, upgrade = false): { readonly title: string; readonly detail: string } {
  const control = "It could send to your chats here, answer their questions, open terminals and read files, through Caveman.";
  const approver = "As a Mac it could also allow other devices to control this Mac and your Macs that take this Mac's approvals. Removing it later removes those devices too.";
  if (request.role === "mac" && upgrade)
    return {
      title: `Let ${request.name} allow devices for this Mac?`,
      detail: `${request.name} controls this Mac already, as a device, and joined with this Mac's code to count as one of your Macs. ${approver} Let it only if you typed this Mac's code into it and ${ownCode(request.code)}.`,
    };
  if (request.role === "mac")
    return {
      title: `${request.name} joined with this Mac's code. Allow it as one of your Macs?`,
      detail: `${control} ${approver} Allow it only if you typed this Mac's code into it and it shows ${request.code}.`,
    };
  return { title: `${request.name} wants to control this Mac. Allow?`, detail: `${control} Allow it only if you are holding it and it shows ${request.code}.` };
}

/**
 * Which waiting request the "Allow?" dialog shows (A-2): the one it shows already (`shown`, by device id) while it still
 * waits and was not dismissed, so a request that arrives meanwhile never takes the button; else the oldest. With its
 * place among those waiting, and `key`, which changes only when the shown request does (another device, or the same
 * one asking as another kind): the dialog remounts on it, so focus starts on Don't allow, and its Allow waits a moment.
 */
export function promptPick<R extends Pick<DeviceRequest, "device_id" | "at" | "role">>(
  waiting: ReadonlyArray<R>,
  dismissed: ReadonlySet<string>,
  shown: string | null,
): { readonly request: R; readonly index: number; readonly total: number; readonly key: string } | null {
  const open = waiting.filter((r) => !dismissed.has(r.device_id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.device_id.localeCompare(b.device_id));
  const request = open.find((r) => r.device_id === shown) ?? open[0];
  if (request === undefined) return null;
  return { request, index: open.indexOf(request) + 1, total: open.length, key: `${request.device_id}:${request.role ?? "device"}` };
}

/** Under the "Allow?" question when more than one device waits: which of them this is. */
export function waitingCountCopy(index: number, total: number): string | null {
  if (total <= 1) return null;
  return total === 2 ? `Another device is also waiting (${index} of 2).` : `${total - 1} other devices are also waiting (${index} of ${total}).`;
}

/**
 * Remove's confirmation (m-15): what it does here, and on the person's other Macs when this screen signs it (`shared`:
 * the desktop app, with a person to share with). A Mac takes the devices it allowed along.
 */
export function removeConfirmCopy(device: { readonly name: string; readonly role?: string | undefined }, shared: boolean): { readonly title: string; readonly detail: string } {
  const along = device.role === "mac" ? " Devices it allowed are removed with it." : "";
  return {
    title: `Remove ${device.name}?`,
    detail: shared
      ? `It stops controlling this Mac now, and your other Macs that take this Mac's approvals remove it too.${along} To let it back in, unblock it on each Mac.`
      : `It stops controlling this Mac now.${along} To let it back in, unblock it here.`,
  };
}

/**
 * What Add a Mac says to a screen reader (m-14): the events only, a code shown and a code gone. The countdown is on the
 * screen, out of the live region, so nothing is read out each second.
 */
export function pairingAnnouncement(state: "live" | "gone" | "none"): string {
  if (state === "live") return "A code for your other Mac is shown. It works once, for 10 minutes.";
  return state === "gone" ? "That code was used or ran out." : "";
}

/** A waiting device's row in Settings, Devices: a Mac is named so there too, with what allowing it also lets it do. */
export function requestRowCopy(request: Pick<DeviceRequest, "code" | "role">, upgrade = false): string {
  if (request.role !== "mac") return `Waiting for you. It shows ${request.code}.`;
  if (upgrade) return `Joined with this Mac's code to count as a Mac: it could also allow other devices to control this Mac. Allow it only if ${ownCode(request.code)}.`;
  return `Joined with this Mac's code, as a Mac: it could also allow other devices to control this Mac. It shows ${request.code}.`;
}

/** Add a Mac: what to do with the code this Mac shows, and how long it has left (`leftMs`, counted down each second). */
export function pairingCopy(leftMs: number): string {
  const seconds = Math.max(0, Math.floor(leftMs / 1000));
  return `Type it in Caveman Code on your other Mac: Settings, Devices, Join your other Mac. It works once, for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} more.`;
}

/** Join your other Mac: the person's other Macs as Cloud lists their runtimes (never this one, never a Cloud computer), by name. */
export function joinTargets(
  runtimes: Iterable<{ readonly runtime_id: string; readonly name: string; readonly kind: "laptop" | "cloud"; readonly online: boolean }>,
  own: string | null | undefined,
): Array<{ readonly runtime_id: string; readonly name: string; readonly online: boolean }> {
  return [...runtimes]
    .filter((r) => r.kind === "laptop" && r.runtime_id !== own)
    .map((r) => ({ runtime_id: r.runtime_id, name: r.name || "A Mac", online: r.online }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** This Mac's own code, in its Settings, Devices: what another of your Macs asks you to check when this Mac connects to it. */
export function ownCodeCopy(code: string): string {
  return `This Mac's code is ${code}. When this Mac connects to another of your Macs, that Mac asks you to check it.`;
}

/** This screen's Allow of a waiting device, signed for the person's other Macs (allowStatementFor's rules). */
export const allowStatement = (own: DeviceKey, list: Pick<DeviceList, "family">, request: DeviceRequest): Promise<DeviceStatement | undefined> => allowStatementFor(own, list.family, request);

/** This screen's Remove of a device, signed so every Mac of the person's that takes this Mac's approvals removes it too. */
export const removeStatement = (own: DeviceKey, list: Pick<DeviceList, "family">, deviceId: string): Promise<DeviceStatement | undefined> => removeStatementFor(own, list.family, deviceId);
