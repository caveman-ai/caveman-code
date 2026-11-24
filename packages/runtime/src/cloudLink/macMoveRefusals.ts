// What a move of a chat between the person's own Macs says when one of them refuses it: on the screen that asked, and
// in the chat a Mac keeps when it refuses to let it go. Each names the Mac it is about, never Cloud as where the chat
// was going (Cloud only carries the move), and a refusal for want of an allowed device says which device, by its code,
// and where to allow it: on that Mac, or on any of the person's Macs it takes approvals from (THREAT-MODEL.md).
import { deviceCode } from "@caveman-app/session-protocol";

/** A Mac's name at the start of a sentence ("that Mac", when Cloud did not say, reads "That Mac"). */
const opening = (mac: string) => mac.charAt(0).toUpperCase() + mac.slice(1);
/** Where a device is allowed so that `mac` takes its word: there, or on a Mac whose approvals it takes. */
const allowOn = (mac: string) => `on ${mac} or on any of your Macs it takes approvals from (Settings, Devices)`;

/** A device's code as its own screen shows it, for an id that is one (Cloud passes the id on; garbage names none). */
export function codeOf(deviceId: string | undefined): string | undefined {
  if (deviceId === undefined) return undefined;
  try {
    return deviceCode(deviceId);
  } catch {
    return undefined;
  }
}

export const MAC_MOVE_REFUSALS = {
  /** This Mac's moves are off (they follow sync), for a chat going to another of the person's Macs. */
  movesOffHere: (to: string) => `Moving chats to ${to} is off on this Mac: its chats don't sync (Settings, Computers)`,
  /** Another Mac finds its own checkout of a chat's repository by its GitHub name. */
  notOnGitHub: (to: string) => `This chat's repository isn't on GitHub, so ${to} can't find its own checkout of it`,
  /** The receiving Mac's moves are off. */
  movesOffThere: (mac: string) => `Moving chats is off on ${mac}: its chats don't sync (Settings, Computers there).`,
  /** The receiving Mac's sign-in names no person, so no device's word counts there. */
  signInAgain: (mac: string) => `${opening(mac)}'s Caveman sign-in is from before Caveman named its person: sign in again there (Settings, Remote control) to move chats to it from your devices.`,
  /** The receiving Mac took this very move already. */
  spent: () => "That move was made once already: move the chat again.",
  /** The receiving Mac's check of the device's move found it too old (signed more than 23 hours before). */
  expired: () => "That move waited too long to be made: move the chat again.",
  /** The receiving Mac never allowed the device that asked (or none signed it): which one, and where to allow it. */
  notAllowed: (mac: string, deviceId: string | undefined) => {
    const code = codeOf(deviceId);
    return code
      ? `${opening(mac)} takes a chat only from a device you allowed there, and the one that asked (${code}) isn't. Allow it ${allowOn(mac)}, then move the chat again.`
      : `${opening(mac)} takes a chat only when you move it from ${mac} itself, or from a device you allowed ${allowOn(mac)}.`;
  },
  /** The receiving Mac has no checkout of the chat's repository: it never clones one on Cloud's word (T15). */
  repoMissing: (repo: string, mac: string) => `Open ${repo} on ${mac} first, then move the chat again.`,
  /**
   * In the chat a Mac kept, when the device that asked to move it is not one it allows (or none signed it). The mail is
   * Cloud's word, so this Mac's own chat names a device's code only for one removed here or on one of the person's
   * Macs (`removed`), and never as one to allow: any key can wait for the screen with a single hello, so a waiting
   * request or a key this Mac never saw gets the copy that has the device itself ask, showing its own code.
   */
  notAllowedNote: (deviceId: string | undefined, removed: boolean) => {
    const code = removed ? codeOf(deviceId) : undefined;
    if (code) return `The device that asked (${code}) was removed from this Mac, so the chat stays here. Move it from this Mac, or from a device you allowed ${allowOn("this Mac")}.`;
    if (deviceId !== undefined)
      return "A device this Mac doesn't know asked for it, so the chat stays here. Move it from this Mac, or open Caveman Code on the device you want to move it from: this Mac then asks you, and you allow it only if the code here matches the one that device shows.";
    return `No device you allowed on this Mac asked for it, so the chat stays here. Move it from this Mac, or from a device you allowed ${allowOn("this Mac")}.`;
  },
  /** In the chat a Mac kept, when a device it allows asked more than 23 hours before the move reached it. */
  expiredNote: () => "The request to move this chat waited too long to reach this Mac, so the chat stays here: move it again.",
  /** In the chat a Mac kept, when the move names a device it allows but that device's signature does not hold for it. */
  unverifiedNote: () => "The request to move this chat did not carry a valid signature from the device it names, so the chat stays here: move it again, from that device or from this Mac.",
} as const;
