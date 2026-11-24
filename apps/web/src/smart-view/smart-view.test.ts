import type { ChiefView, SmartViewEntry, SmartViewItem } from "@caveman-app/session-protocol";
import { SMART_VIEW_RULES, smartViewKey } from "@caveman-app/session-protocol/smart-view";
import { beforeEach, describe, expect, test } from "vitest";
import { defineSurface } from "../panels/registry.ts";
import { activateTab, closeTab, getPanel, getTabs, hostChanged, openSurface, resetPanels, setPanelOpen, setTabHost } from "../panels/store.ts";
import { applyView, resetShown, type ApplyContext } from "./apply.ts";
import { reconcile } from "./reconcile.ts";
import { touched } from "./sidebar.ts";
import { settingsLag } from "./settings-lag.ts";
import { targetOf } from "./targets.ts";
import "./surfaces.tsx";

// The Chief's Work tab, as routes/chief/work.tsx registers it: pinned, so it is nothing of the person's.
defineSurface({ kind: "chief-work", label: "Work", icon: () => null, identity: "one", title: () => "Work", component: () => null, pinned: true, launcher: false });

const CHIEF = "chief-1";
const at = "2026-11-11T10:00:00.000Z";
const entry = (item: SmartViewItem, extra: Partial<SmartViewEntry> = {}): SmartViewEntry => ({ id: smartViewKey(item), item, title: "t", asked: false, opened_at: at, seq: 1, state: "open", ...extra });
const view = (...entries: SmartViewEntry[]): ChiefView => ({ chief_id: CHIEF, on: true, entries });
const pr: SmartViewItem = { kind: "pr", project_id: "p1", number: 7 };
const chat: SmartViewItem = { kind: "chat", workspace_id: "ws-9" };
const shot: SmartViewItem = { kind: "image", url: "https://example.com/shot.png" };
const page: SmartViewItem = { kind: "web", url: "http://localhost:5173/" };

describe("targetOf: each kind to its surface", () => {
  test("pr, chat, image, video, web", () => {
    expect(targetOf(entry({ ...pr, view: "files" }))).toEqual({ kind: "pr", params: { project_id: "p1", number: 7, view: "files" } });
    expect(targetOf(entry(chat, { title: "Dark mode", note: "Needs you" }))).toEqual({ kind: "chat", params: { workspace_id: "ws-9", note: "Needs you" }, title: "Dark mode" });
    expect(targetOf(entry(shot))).toMatchObject({ kind: "media", params: { media: "image", url: "https://example.com/shot.png", gate: true } });
    expect(targetOf(entry({ kind: "video", workspace_id: "ws-9", path: "out/demo.mp4" }))).toMatchObject({ kind: "media", params: { media: "video", workspace_id: "ws-9", path: "out/demo.mp4" } });
    expect(targetOf(entry(page))).toEqual({ kind: "browser", params: { url: "http://localhost:5173/", backend: "local" } });
  });
  test("an unsafe address or an unknown kind shows nothing", () => {
    expect(targetOf(entry({ kind: "web", url: "javascript:alert(1)" }))).toBeNull();
    expect(targetOf(entry({ kind: "image", url: "file:///etc/passwd" }))).toBeNull();
    expect(targetOf(entry({ kind: "slides" } as never))).toBeNull();
  });
});

describe("reconcile", () => {
  const all = () => true;
  const none = () => false;
  test("new or brought forward: show; the same seq again: nothing", () => {
    expect(reconcile(view(entry(pr)), {}, all)).toEqual([{ kind: "show", entry: entry(pr) }]);
    expect(reconcile(view(entry(pr, { seq: 2 })), { [smartViewKey(pr)]: { tab: "pr:x", seq: 1 } }, all)).toEqual([{ kind: "show", entry: entry(pr, { seq: 2 }), tab: "pr:x" }]);
    expect(reconcile(view(entry(pr)), { [smartViewKey(pr)]: { tab: "pr:x", seq: 1 } }, all)).toEqual([]);
  });
  test("its tab gone: dismissed (kept until the runtime lists it closed); closed: its tab closes, then it is forgotten", () => {
    const shown = { [smartViewKey(pr)]: { tab: "pr:x", seq: 1 } };
    expect(reconcile(view(entry(pr)), shown, none)).toEqual([{ kind: "dismiss", id: smartViewKey(pr) }]);
    expect(reconcile(view(entry(pr, { state: "closed", closed_by: "chief" })), shown, all)).toEqual([{ kind: "close", id: smartViewKey(pr), tab: "pr:x", adopted: false }, { kind: "forget", id: smartViewKey(pr) }]);
    expect(reconcile(view(entry(pr, { state: "closed", closed_by: "person" })), shown, none)).toEqual([{ kind: "forget", id: smartViewKey(pr) }]);
    // Pruned by the runtime: forgotten, its tab left to the person.
    expect(reconcile(view(), shown, all)).toEqual([{ kind: "forget", id: smartViewKey(pr) }]);
  });
});

describe("in the Chief's panel: never move what the person is reading", () => {
  const P = "chief-ws";
  const dismissed: string[] = [];
  const ctx: ApplyContext = { panelId: P, narrow: false, visible: true, dismiss: (id) => dismissed.push(id) };
  const front = () => getPanel(P).tabs.find((t) => t.id === getPanel(P).active);
  beforeEach(() => {
    resetPanels();
    resetShown();
    touched(null);
    dismissed.length = 0;
    // The Chief's page: its panel shows its Work.
    openSurface(P, "chief-work", {});
  });

  test("an idle panel showing only the Chief's Work: the new thing comes to the front", () => {
    applyView(view(entry(pr)), ctx);
    expect(front()).toMatchObject({ kind: "pr", params: { project_id: "p1", number: 7 } });
    expect(front()!.attention ?? false).toBe(false);
  });

  test("reading their own tab: a new tab behind, pulsing, and what they read stays in front", () => {
    const theirs = openSurface(P, "browser", { url: "https://docs.example.com/", backend: "local" });
    applyView(view(entry(pr)), ctx);
    expect(getPanel(P).active).toBe(theirs);
    expect(getPanel(P).tabs.find((t) => t.kind === "pr")).toMatchObject({ attention: "pulse" });
    // It pulses until they look at it.
    activateTab(P, getPanel(P).tabs.find((t) => t.kind === "pr")!.id);
    expect(front()).toMatchObject({ kind: "pr", attention: false });
  });

  test("touched in the last idleMs (scrolling, clicking): behind, even on the Work tab", () => {
    touched(Date.now() - 1_000);
    applyView(view(entry(chat, { title: "Dark mode" })), ctx);
    expect(front()!.kind).toBe("chief-work");
    expect(getPanel(P).tabs.find((t) => t.kind === "chat")).toMatchObject({ title: "Dark mode", attention: "pulse" });
    touched(Date.now() - SMART_VIEW_RULES.idleMs - 1);
    applyView(view(entry(chat, { title: "Dark mode" }), entry(shot)), ctx);
    expect(front()!.kind).toBe("media");
  });

  test("a hidden panel is never popped open; its toggle's mark pulses", () => {
    setPanelOpen(P, false);
    applyView(view(entry(page)), ctx);
    expect(getPanel(P).open).toBe(false);
    expect(getPanel(P).tabs.some((t) => t.kind === "browser" && t.attention === "pulse")).toBe(true);
  });

  test("arrived while the page was away, or floating over the chat: behind", () => {
    applyView(view(entry(pr)), { ...ctx, visible: false });
    expect(front()!.kind).toBe("chief-work");
    applyView(view(entry(pr), entry(chat)), { ...ctx, narrow: true });
    expect(front()!.kind).toBe("chief-work");
  });

  test("what the person asked for comes to the front, the panel opening if hidden", () => {
    openSurface(P, "browser", { url: "https://docs.example.com/", backend: "local" });
    setPanelOpen(P, false);
    applyView(view(entry(pr, { asked: true })), ctx);
    expect(getPanel(P).open).toBe(true);
    expect(front()!.kind).toBe("pr");
  });

  test("the same list again opens nothing twice; brought forward (seq) on an open tab pulses it again", () => {
    const theirs = openSurface(P, "browser", { url: "https://docs.example.com/", backend: "local" });
    applyView(view(entry(page)), ctx);
    applyView(view(entry(page)), ctx);
    const pages = getPanel(P).tabs.filter((t) => t.kind === "browser" && t.id !== theirs);
    expect(pages).toHaveLength(1);
    activateTab(P, pages[0]!.id);
    activateTab(P, theirs);
    applyView(view(entry(page, { seq: 2 })), ctx);
    expect(getPanel(P).tabs.filter((t) => t.kind === "browser")).toHaveLength(2);
    expect(getPanel(P).tabs.find((t) => t.id === pages[0]!.id)).toMatchObject({ attention: "pulse" });
    expect(getPanel(P).active).toBe(theirs);
  });

  describe("a tab the person moved into a pane of its own (the movable panes)", () => {
    const panes = new Set<string>();
    const revealed: string[] = [];
    const host = (moved: string) => {
      panes.add(moved);
      hostChanged();
    };
    beforeEach(() => {
      panes.clear();
      revealed.length = 0;
      setTabHost({ hosts: (ws, id) => ws === P && panes.has(id), reveal: (_ws, id) => void revealed.push(id), retarget: () => {} });
    });

    test("it is still open: no dismiss, and the strip's own tab in front stays", () => {
      applyView(view(entry(pr)), ctx);
      const prTab = getTabs(P).find((t) => t.kind === "pr")!.id;
      host(prTab);
      applyView(view(entry(pr)), ctx);
      expect(dismissed).toEqual([]);
      expect(getPanel(P).tabs.some((t) => t.id === prTab)).toBe(false);
      expect(getTabs(P).some((t) => t.id === prTab)).toBe(true);
    });

    test("brought forward again: its pane is revealed only when the person asked, and it gets no pulse", () => {
      applyView(view(entry(pr)), ctx);
      const prTab = getTabs(P).find((t) => t.kind === "pr")!.id;
      host(prTab);
      applyView(view(entry(pr, { seq: 2 })), ctx);
      expect(revealed).toEqual([]);
      expect(getTabs(P).find((t) => t.id === prTab)!.attention ?? false).toBe(false);
      applyView(view(entry(pr, { seq: 3, asked: true })), ctx);
      expect(revealed).toEqual([prTab]);
    });

    test("the Chief closing it leaves the person's pane alone", () => {
      applyView(view(entry(chat)), ctx);
      const chatTab = getTabs(P).find((t) => t.kind === "chat")!.id;
      host(chatTab);
      applyView(view(entry(chat, { state: "closed", closed_by: "chief" })), ctx);
      expect(getTabs(P).some((t) => t.id === chatTab)).toBe(true);
      // Forgotten: a later list never touches it again.
      applyView(view(), ctx);
      expect(getTabs(P).some((t) => t.id === chatTab)).toBe(true);
    });

    test("a new item whose tab already sits in a pane (the person opened that PR there): no pane is revealed, nothing pulses", () => {
      const prTab = openSurface(P, "pr", { project_id: "p1", number: 7 });
      host(prTab);
      applyView(view(entry(pr)), ctx);
      expect(revealed).toEqual([]);
      expect(front()!.kind).toBe("chief-work");
      expect(getTabs(P).find((t) => t.id === prTab)!.attention ?? false).toBe(false);
    });
  });

  describe("review regressions (PR #76)", () => {
    test("H1: the Chief closing what the person looked at leaves the tab: in front, then scrolled", () => {
      applyView(view(entry(pr)), ctx);
      const prTab = front()!.id;
      expect(front()!.kind).toBe("pr");
      touched(Date.now());
      applyView(view(entry(pr, { state: "closed", closed_by: "chief" })), ctx);
      expect(front()!.id).toBe(prTab);
      // Forgotten: the tab is the person's now, and no later list touches it.
      applyView(view(), ctx);
      expect(getTabs(P).some((t) => t.id === prTab)).toBe(true);
    });

    test("H1: looked at once, then left behind another tab: still not closed by the Chief", () => {
      applyView(view(entry(pr)), ctx);
      const prTab = front()!.id;
      activateTab(P, getTabs(P).find((t) => t.kind === "chief-work")!.id);
      applyView(view(entry(pr, { state: "closed", closed_by: "chief" })), ctx);
      expect(getTabs(P).some((t) => t.id === prTab)).toBe(true);
    });

    test("H1: only a tab the person never looked at (still pulsing, behind) is tidied away", () => {
      openSurface(P, "browser", { url: "https://docs.example.com/", backend: "local" });
      applyView(view(entry(chat)), ctx);
      const chatTab = getTabs(P).find((t) => t.kind === "chat")!;
      expect(chatTab.attention).toBe("pulse");
      applyView(view(entry(chat, { state: "closed", closed_by: "chief" })), ctx);
      expect(getTabs(P).some((t) => t.id === chatTab.id)).toBe(false);
    });

    test("H2: the person's own PR tab is adopted: not brought forward, not renamed, never closed by the Chief", () => {
      const theirs = openSurface(P, "pr", { project_id: "p1", number: 7 });
      const before = getTabs(P).find((t) => t.id === theirs)!;
      applyView(view(entry(pr, { title: "The Chief's name for it" })), ctx);
      const after = getTabs(P).find((t) => t.id === theirs)!;
      expect(after.title).toBe(before.title);
      expect(after.reveal).toBe(before.reveal);
      expect(getTabs(P).filter((t) => t.kind === "pr")).toHaveLength(1);
      applyView(view(entry(pr, { state: "closed", closed_by: "chief" })), ctx);
      expect(getTabs(P).some((t) => t.id === theirs)).toBe(true);
    });

    test("H2: an adopted tab behind is only pulsed, and a chat tab of theirs keeps its name", () => {
      const theirChat = openSurface(P, "chat", { workspace_id: "ws-9" });
      activateTab(P, getTabs(P).find((t) => t.kind === "chief-work")!.id);
      applyView(view(entry(chat, { title: "The Chief's title" })), ctx);
      expect(front()!.kind).toBe("chief-work");
      expect(getTabs(P).find((t) => t.id === theirChat)).toMatchObject({ attention: "pulse" });
      expect(getTabs(P).find((t) => t.id === theirChat)!.title).toBeUndefined();
      // Brought forward again (seq): still only a pulse.
      activateTab(P, theirChat);
      activateTab(P, getTabs(P).find((t) => t.kind === "chief-work")!.id);
      applyView(view(entry(chat, { seq: 2 })), ctx);
      expect(front()!.kind).toBe("chief-work");
      applyView(view(entry(chat, { seq: 2, state: "closed", closed_by: "chief" })), ctx);
      expect(getTabs(P).some((t) => t.id === theirChat)).toBe(true);
    });

    test("M4: focus or a selection in the panel counts as in use, however long ago the last touch", () => {
      const doc = globalThis as { document?: unknown };
      const inPanel = { closest: () => ({}) };
      doc.document = { activeElement: inPanel, getSelection: () => null, querySelector: () => null };
      try {
        touched(Date.now() - SMART_VIEW_RULES.idleMs - 1_000);
        applyView(view(entry(pr)), ctx);
        expect(front()!.kind).toBe("chief-work");
        doc.document = { activeElement: null, getSelection: () => ({ isCollapsed: false, anchorNode: { parentElement: inPanel } }), querySelector: () => null };
        applyView(view(entry(pr), entry(chat)), ctx);
        expect(front()!.kind).toBe("chief-work");
        // The pointer resting over the panel: reading.
        doc.document = { activeElement: null, getSelection: () => null, querySelector: () => ({}) };
        applyView(view(entry(pr), entry(chat), entry(shot)), ctx);
        expect(front()!.kind).toBe("chief-work");
      } finally {
        delete doc.document;
      }
    });

    test("M5: Smart View off: nothing new shows, even what the list held from before", () => {
      applyView({ ...view(entry(pr), entry(chat)), on: false }, ctx);
      expect(getTabs(P).map((t) => t.kind)).toEqual(["chief-work"]);
    });

    test("M6: an address off this computer waits behind Load unless asked; this computer's loads", () => {
      expect(targetOf(entry({ kind: "web", url: "https://evil.example/x?d=secret" }))).toMatchObject({ kind: "media", params: { media: "web" } });
      expect(targetOf(entry({ kind: "web", url: "https://vercel.app/" }, { asked: true }))).toMatchObject({ kind: "browser" });
      expect(targetOf(entry({ kind: "image", url: "http://192.168.1.4/a.png" }))).toMatchObject({ params: { gate: true } });
      expect(targetOf(entry({ kind: "image", url: "http://localhost:5173/a.png" }))!.params).not.toHaveProperty("gate");
    });
  });

  test("the person closes it: the runtime is told; the Chief closes it: its tab closes; their own tabs are never touched", () => {
    const theirs = openSurface(P, "browser", { url: "https://docs.example.com/", backend: "local" });
    applyView(view(entry(pr), entry(chat)), ctx);
    const prTab = getPanel(P).tabs.find((t) => t.kind === "pr")!.id;
    closeTab(P, prTab);
    applyView(view(entry(pr), entry(chat)), ctx);
    expect(dismissed).toEqual([smartViewKey(pr)]);
    // The runtime lists it closed: forgotten, never shown again from this list.
    applyView(view(entry(pr, { state: "closed", closed_by: "person" }), entry(chat)), ctx);
    expect(getPanel(P).tabs.some((t) => t.kind === "pr")).toBe(false);
    applyView(view(entry(pr, { state: "closed", closed_by: "person" }), entry(chat, { state: "closed", closed_by: "chief" })), ctx);
    expect(getPanel(P).tabs.map((t) => t.kind)).toEqual(["chief-work", "browser"]);
    expect(getPanel(P).tabs.some((t) => t.id === theirs)).toBe(true);
  });
});

describe("M5: another window's settings follow the runtime's Smart View state at once", () => {
  test("it reads them again only when what it holds disagrees", () => {
    expect(settingsLag(JSON.stringify({}), false)).toBe(true);
    expect(settingsLag(JSON.stringify({ chief_smart_view: false }), true)).toBe(true);
    expect(settingsLag(JSON.stringify({ chief_smart_view: false }), false)).toBe(false);
    expect(settingsLag(JSON.stringify({ chief_smart_view: true }), true)).toBe(false);
    // Nothing read yet, or unreadable: the next poll does it.
    expect(settingsLag("", false)).toBe(false);
    expect(settingsLag("{", false)).toBe(false);
  });
});
