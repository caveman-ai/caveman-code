// The one quiet sync offer (state/sync-offer.ts): what it reads back, when a line may show, and what counts as a chat.
import { describe, expect, test } from "vitest";
import {
  chatCount,
  dayKey,
  readSyncOffer,
  SETTLED_CHATS,
  showsSyncOffer,
  type SyncOfferInput,
} from "./sync-offer.ts";

const ASK = { available: true, on: false, ask: true } as const;
/** A settled person on a second day with sync on offer and nothing in the way. */
const settled: SyncOfferInput = {
  saved: { firstDay: "2026-11-20", chats: 1, answer: null },
  firstSession: false,
  today: "2026-11-21",
  sync: ASK,
  syncChats: undefined,
  dialogOpen: false,
  running: false,
  hosted: false,
};
const but = (over: Partial<SyncOfferInput>): SyncOfferInput => ({ ...settled, ...over });

describe("what is read back", () => {
  test("nothing, damaged or foreign storage reads as a device never seen", () => {
    for (const raw of [
      null,
      "",
      "{",
      "null",
      "7",
      '{"firstDay":"yesterday","chats":"3","answer":"maybe"}',
      '{"chats":-2}',
    ]) {
      expect(readSyncOffer(raw)).toEqual({ firstDay: null, chats: 0, answer: null });
    }
  });

  test("the first day, the chats seen and the answer are kept", () => {
    expect(readSyncOffer('{"firstDay":"2026-11-20","chats":4.9,"answer":"off"}')).toEqual({
      firstDay: "2026-11-20",
      chats: 4,
      answer: "off",
    });
    expect(readSyncOffer('{"firstDay":"2026-11-20","chats":0,"answer":"on"}').answer).toBe("on");
  });
});

describe("what counts as a day and a chat", () => {
  test("a day is the local calendar day, not 24 hours", () => {
    expect(dayKey(new Date(2026, 10, 21, 23, 59))).toBe("2026-11-21");
    expect(dayKey(new Date(2026, 10, 22, 0, 1))).toBe("2026-11-22");
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  test("sub-chats, automation steps and chats put away are not chats the person started", () => {
    const w = (over: Partial<Parameters<typeof chatCount>[0][number]> = {}) => ({
      parentId: null,
      state: "completed" as const,
      ...over,
    });
    expect(
      chatCount([
        w(),
        w(),
        w({ parentId: "ws-1" }),
        w({ automationStep: true }),
        w({ state: "archived" }),
        w({ state: "working" }),
      ]),
    ).toBe(3);
    expect(chatCount([])).toBe(0);
  });
});

describe("when the line shows", () => {
  test("on the second day, with sync on offer and nothing in the way", () => {
    expect(showsSyncOffer(settled)).toBe(true);
  });

  test("after the third chat, still on the first day", () => {
    const sameDay = { firstDay: "2026-11-21", chats: SETTLED_CHATS - 1, answer: null } as const;
    expect(showsSyncOffer(but({ saved: sameDay }))).toBe(false);
    expect(showsSyncOffer(but({ saved: { ...sameDay, chats: SETTLED_CHATS } }))).toBe(true);
  });

  test("never in the first session, however many chats there are", () => {
    expect(showsSyncOffer(but({ firstSession: true }))).toBe(false);
    expect(
      showsSyncOffer(
        but({ firstSession: true, saved: { firstDay: "2026-11-21", chats: 9, answer: null } }),
      ),
    ).toBe(false);
  });

  test("never while a chat is running or the sync dialog is open", () => {
    expect(showsSyncOffer(but({ running: true }))).toBe(false);
    expect(showsSyncOffer(but({ dialogOpen: true }))).toBe(false);
  });

  test("never once answered, here or anywhere (the setting, Settings, the dialog, the line itself)", () => {
    expect(showsSyncOffer(but({ saved: { ...settled.saved, answer: "on" } }))).toBe(false);
    expect(showsSyncOffer(but({ saved: { ...settled.saved, answer: "off" } }))).toBe(false);
    expect(showsSyncOffer(but({ syncChats: true }))).toBe(false);
    expect(showsSyncOffer(but({ syncChats: false }))).toBe(false);
    expect(showsSyncOffer(but({ sync: { available: true, on: true } }))).toBe(false);
    expect(showsSyncOffer(but({ sync: { available: true, on: false, ask: false } }))).toBe(false);
  });

  test("never where this Caveman offers no sync, or in a browser window", () => {
    expect(showsSyncOffer(but({ sync: { available: false, on: false, ask: true } }))).toBe(false);
    expect(showsSyncOffer(but({ sync: null }))).toBe(false);
    expect(showsSyncOffer(but({ sync: undefined }))).toBe(false);
    expect(showsSyncOffer(but({ hosted: true }))).toBe(false);
  });

  test("a device that has not been seen yet is not settled", () => {
    expect(showsSyncOffer(but({ saved: { firstDay: null, chats: 0, answer: null } }))).toBe(false);
  });
});
