// An answer leaves every list of asks the moment it is given, its Undo in the toast, and Undo puts the ask back where
// it was. The engine hears it only
// once Undo has gone; a question's answer continues the chat that way, an approval's runs or doesn't run the command.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

// What the toast says: the verb, then what it was about (its two lines in the bar row), read back as one sentence.
const notices: { text: string; detail?: string; action?: { label: string; onPress: () => void } }[] = [];
const said = (n: { text: string; detail?: string } | undefined) => (n ? (n.detail ? `${n.text} ${n.detail}` : n.text) : undefined);
vi.mock("../shell/ui", () => ({ notice: (n: { text: string; detail?: string; action?: { label: string; onPress: () => void } } | null) => n && notices.push(n) }));
vi.mock("../components/ui/Choices", () => ({ ARM_MS: 450 }));

import { resetStore, store } from "../store/store";
import { asksOf, needOf } from "../store/select";
import { act, gist, saidOf, undo, UNDO_MS } from "./decide";

const chat = (id: string) => store.get().board.chats.find((c) => c.id === id)!;
const asking = () => asksOf(store.get()).map((a) => a.asker.id);

beforeEach(() => {
  vi.useFakeTimers();
  notices.length = 0;
  resetStore();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("the scripted world's asks", () => {
  it("are three approvals and three that need direction, the longest-waiting first, each with what it did so far", () => {
    const asks = asksOf(store.get());
    expect(asks.map((a) => a.need.kind).sort()).toEqual(["approval", "approval", "approval", "question", "question", "question"]);
    const at = asks.map((a) => a.need.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const a of asks) expect(a.need.summary.length).toBeGreaterThan(20);
    const flag = asks.find((a) => a.asker.id === "relay-limits")!.need;
    expect(flag.kind === "question" && flag.options.filter((o) => o.recommended).length).toBe(1);
  });

  it("a subagent's ask lights its parent's row and is answered on the subagent", () => {
    const composer = asksOf(store.get()).find((a) => a.asker.id === "audit-composer")!;
    expect(composer.row.chat.id).toBe("audit");
  });
});

describe("answering", () => {
  it("takes a question out of every list at once and says so in the toast, with Undo", () => {
    const before = asking();
    const option = (needOf(chat("relay-limits")) as Extract<ReturnType<typeof needOf>, { kind: "question" }>).options[0]!;
    expect(act("relay-limits", { kind: "option", option })).toBe(true);
    expect(asking()).toEqual(before.filter((id) => id !== "relay-limits"));
    expect(chat("relay-limits").phase).toBe("working");
    // Your answer lands as your own message; the question gives way to it.
    const last = chat("relay-limits").items.at(-2);
    expect(last).toMatchObject({ kind: "you", text: "Remove it" });
    expect(chat("relay-limits").items.some((i) => i.kind === "ask" && !i.answer)).toBe(false);
    expect(notices.at(-1)).toMatchObject({ text: "Told it:", detail: "Remove it", action: { label: "Undo" } });
  });

  it("puts it back where it was on Undo, and the engine never hears it", () => {
    const before = asking();
    const items = chat("migration").items;
    act("migration", { kind: "allow" });
    expect(said(notices.at(-1))).toBe("Allowed pnpm db:migrate");
    vi.advanceTimersByTime(UNDO_MS - 500);
    undo("migration");
    expect(asking()).toEqual(before);
    expect(chat("migration").items).toEqual(items);
    expect(chat("migration").phase).toBe("needs");
    vi.advanceTimersByTime(30_000);
    expect(chat("migration").phase).toBe("needs");
    expect(store.get().board.said.some((l) => l.text.includes("migration is running"))).toBe(false);
  });

  it("hears a second tap on the same ask as nothing", () => {
    expect(act("launch-post", { kind: "deny" })).toBe(true);
    expect(act("launch-post", { kind: "allow" })).toBe(false);
    expect(chat("launch-post").items.find((i) => i.kind === "ask")).toMatchObject({ answer: "denied" });
  });

  it("goes on once Undo has gone: the approval runs and the chat finishes", () => {
    act("migration", { kind: "allow" });
    vi.advanceTimersByTime(UNDO_MS + 100);
    undo("migration");
    expect(chat("migration").phase).toBe("working");
    vi.advanceTimersByTime(10_000);
    expect(chat("migration").phase).toBe("done");
    expect(chat("migration").items.find((i) => i.kind === "ask")).toMatchObject({ answer: "allowed" });
  });

  it("continues a question the way it was told, and comes back with something to look at", () => {
    act("launch-email", { kind: "told", text: "Something shorter, under 30 characters" });
    expect(said(notices.at(-1))).toBe("Told it: Something shorter, under 30…");
    vi.advanceTimersByTime(UNDO_MS + 12_000);
    expect(chat("launch-email").phase).toBe("ready");
  });
});

describe("what the toast says", () => {
  it("names the command without its flags, and your words cut at a word", () => {
    expect(gist("pnpm --filter @caveman-app/mobile add react-native-keyboard-controller")).toBe("pnpm add react-native-keyboard-controller");
    expect(saidOf(chat("launch-post"), { kind: "deny" }).text).toBe("Denied vercel deploy");
    expect(saidOf(chat("launch-post"), { kind: "deny", instead: "Publish it tomorrow at 9" }).text).toBe("Told it: Publish it tomorrow at 9");
    expect(saidOf(chat("fold-jump"), { kind: "allow" }).text).toBe("Told it: Measure before the fold");
  });
});
