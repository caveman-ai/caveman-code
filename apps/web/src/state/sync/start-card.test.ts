// A first visit in a browser window (web-window.ts): who can get the desktop app, the free way beside the plans, and
// the card a signed-in account with nothing yet is shown, with its one quiet line about sync.
import { expect, test } from "vitest";
import {
  canGetMacApp,
  DOWNLOAD_URL,
  freeWay,
  MAC_ONLY_LINE,
  startCard,
  SYNC_LINE,
  type MacHere,
  type WebWindow,
} from "./web-window.ts";

const APP = (nothingYet: boolean): WebWindow => ({ kind: "app", failed: false, nothingYet });

test("the desktop app is for a Mac: Windows, Linux, an iPhone and an iPad are told it is not", () => {
  expect(canGetMacApp({ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 0 })).toBe(
    true,
  );
  expect(canGetMacApp({ userAgentData: { platform: "macOS" }, platform: "MacIntel" })).toBe(true);
  expect(canGetMacApp({ platform: "Win32", userAgent: "Windows NT 10.0" })).toBe(false);
  expect(canGetMacApp({ userAgentData: { platform: "Windows" } })).toBe(false);
  expect(canGetMacApp({ platform: "Linux x86_64" })).toBe(false);
  // They type with Command, so the shortcuts count them as a Mac (lib/platform.ts); no Mac app runs on them.
  expect(canGetMacApp({ platform: "iPhone" })).toBe(false);
  expect(canGetMacApp({ platform: "iPad" })).toBe(false);
  // An iPad asking for the desktop site calls itself a Mac, with a touch screen.
  expect(canGetMacApp({ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 5 })).toBe(
    false,
  );
  expect(canGetMacApp(undefined)).toBe(false);
});

test("the free way: the download on a Mac, the plain line on any other computer", () => {
  expect(freeWay(true)).toEqual({
    title: "Run it free on your computer",
    line: "Caveman Code runs on your own subscriptions and keys. No plan needed.",
    action: { label: "Download for Mac", url: DOWNLOAD_URL },
  });
  expect(freeWay(false)).toEqual({
    title: "Run it free on your computer",
    line: MAC_ONLY_LINE,
    action: null,
  });
  expect(MAC_ONLY_LINE).toBe("The desktop app is Mac only today. The web app works now.");
});

test("nothing yet and no Mac: the card has the free way, then Cloud with a plan, and the sync line", () => {
  const none: MacHere = { kind: "none" };
  expect(startCard(APP(true), none, { free: true, canMac: true })).toEqual({
    title: "Ways to start",
    rows: [
      {
        id: "free",
        title: "Run it free on your computer",
        line: "Caveman Code runs on your own subscriptions and keys. No plan needed.",
        action: { kind: "download", label: "Download for Mac" },
      },
      {
        id: "cloud",
        title: "Run it in Cloud",
        line: "Chats in Cloud come with a plan. Connect a repository, then send.",
        action: { kind: "unlock", label: "See plans" },
      },
    ],
    sync: "Turn on sync on your Mac to see your chats here",
  });
  expect(SYNC_LINE).toBe("Turn on sync on your Mac to see your chats here");
});

test("on a computer that is not a Mac the free row says so and has nothing to press; a plan is offered only to a Free account", () => {
  const card = startCard(APP(true), { kind: "none" }, { free: false, canMac: false })!;
  expect(card.rows[0]).toMatchObject({ id: "free", line: MAC_ONLY_LINE, action: null });
  // Cloud has not said, or the account holds a plan: no plans button.
  expect(card.rows[1]!.action).toBeNull();
  expect(
    startCard(APP(true), { kind: "none" }, { free: null, canMac: false })!.rows[1]!.action,
  ).toBeNull();
});

test("a Mac that is not on line is named instead of the download, and the sync line still shows", () => {
  const card = startCard(
    APP(true),
    { kind: "asleep", name: "Studio" },
    { free: true, canMac: true },
  )!;
  expect(card.rows[0]).toEqual({
    id: "mac",
    title: "Open Caveman Code on Studio",
    line: "Studio isn't on line. Open Caveman Code there and keep sync on.",
    action: null,
  });
  expect(card.sync).toBe(SYNC_LINE);
});

test("no card once there is a chat, a Mac on line, or no app yet", () => {
  const way = { free: true, canMac: true };
  // Synced chats are here: nothing to say about sync, nothing to start.
  expect(startCard(APP(false), { kind: "none" }, way)).toBeNull();
  const place = { kind: "mac", name: "Studio", runtimeId: "r", computerId: "c" } as const;
  for (const mac of [
    { kind: "ask", name: "Studio", place },
    { kind: "waiting", name: "Studio" },
    { kind: "refused", name: "Studio" },
    { kind: "ready", name: "Studio" },
  ] as const)
    expect(startCard(APP(true), mac, way)).toBeNull();
  expect(startCard({ kind: "loading" }, { kind: "none" }, way)).toBeNull();
  expect(startCard({ kind: "signed_out" }, { kind: "none" }, way)).toBeNull();
});
