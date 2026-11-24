import { deviceCode } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";

import { testDevice } from "../session-protocol/devices.testkit.ts";
import { codeOf, MAC_MOVE_REFUSALS } from "./macMoveRefusals.ts";

describe("Mac-to-Mac move refusals", () => {
  test("none names Cloud as where the chat was going; each names the Mac it is about", async () => {
    const phone = await testDevice("iPhone, Safari");
    const all: Record<string, string> = {
      movesOffHere: MAC_MOVE_REFUSALS.movesOffHere("Mac B"),
      notOnGitHub: MAC_MOVE_REFUSALS.notOnGitHub("Mac B"),
      movesOffThere: MAC_MOVE_REFUSALS.movesOffThere("Mac B"),
      signInAgain: MAC_MOVE_REFUSALS.signInAgain("Mac B"),
      spent: MAC_MOVE_REFUSALS.spent(),
      expired: MAC_MOVE_REFUSALS.expired(),
      notAllowed: MAC_MOVE_REFUSALS.notAllowed("Mac B", phone.device_id),
      notAllowedUnsigned: MAC_MOVE_REFUSALS.notAllowed("Mac B", undefined),
      repoMissing: MAC_MOVE_REFUSALS.repoMissing("octocat/hello", "Mac B"),
      notAllowedNote: MAC_MOVE_REFUSALS.notAllowedNote(phone.device_id, true),
      notAllowedNoteStranger: MAC_MOVE_REFUSALS.notAllowedNote(phone.device_id, false),
      notAllowedNoteUnsigned: MAC_MOVE_REFUSALS.notAllowedNote(undefined, false),
      expiredNote: MAC_MOVE_REFUSALS.expiredNote(),
      unverifiedNote: MAC_MOVE_REFUSALS.unverifiedNote(),
    };
    expect(Object.keys(all).sort()).toEqual([...Object.keys(MAC_MOVE_REFUSALS), "notAllowedUnsigned", "notAllowedNoteStranger", "notAllowedNoteUnsigned"].sort());
    for (const [name, text] of Object.entries(all)) {
      expect([name, /\bto (Caveman )?Cloud\b|Cloud computer/i.test(text)]).toEqual([name, false]);
      if (!["spent", "expired", "expiredNote", "unverifiedNote"].includes(name) && !name.startsWith("notAllowedNote")) expect([name, text.includes("Mac B")]).toEqual([name, true]);
    }
  });

  test("a refusal for want of an allowed device names the Mac, the device's code and where to allow it", async () => {
    const phone = await testDevice("iPhone, Safari");
    const code = deviceCode(phone.device_id);
    expect(MAC_MOVE_REFUSALS.notAllowed("Mac B", phone.device_id)).toBe(
      `Mac B takes a chat only from a device you allowed there, and the one that asked (${code}) isn't. Allow it on Mac B or on any of your Macs it takes approvals from (Settings, Devices), then move the chat again.`,
    );
    // A device removed here or on one of the person's Macs: named by its code, and never as one to allow.
    const removed = MAC_MOVE_REFUSALS.notAllowedNote(phone.device_id, true);
    expect(removed).toBe(
      `The device that asked (${code}) was removed from this Mac, so the chat stays here. Move it from this Mac, or from a device you allowed on this Mac or on any of your Macs it takes approvals from (Settings, Devices).`,
    );
    expect(removed).not.toMatch(/Allow it/);
    // A device waiting for the screen, or one this Mac never saw: the id is only Cloud's word (any key waits for the
    // screen with one hello), so this Mac's own chat never vouches for its code; the device itself is to ask, showing it.
    const stranger = MAC_MOVE_REFUSALS.notAllowedNote(phone.device_id, false);
    expect(stranger).not.toContain(code);
    expect(stranger).toContain("open Caveman Code on the device you want to move it from");
    // A device this Mac allows whose move waited too long, or whose signature does not hold: said as such, never "not allowed".
    for (const note of [MAC_MOVE_REFUSALS.expiredNote(), MAC_MOVE_REFUSALS.unverifiedNote()]) {
      expect(note).toContain("move it again");
      expect(note).not.toMatch(/allowed|doesn't know/);
    }
    // Unsigned, or an id Cloud made up: no code to name, still where to allow.
    for (const id of [undefined, "not-a-key"]) {
      expect(codeOf(id)).toBeUndefined();
      expect(MAC_MOVE_REFUSALS.notAllowed("Mac B", id)).toContain("on Mac B or on any of your Macs it takes approvals from");
    }
  });
});
