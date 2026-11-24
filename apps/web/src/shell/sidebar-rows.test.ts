// A chat row's end says its status (model.ts chatStatus): what it asks, work in progress, a failed last turn, sleep; else where it runs.
import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("../panes/drag.ts", () => ({}));
vi.mock("../panes/store.ts", () => ({ panes: {}, announce: () => undefined }));
import type { WorkspaceView } from "../state/model.ts";
import { keepRenameFocus, trailingFor } from "./Sidebar.tsx";

const chat = (over: Partial<WorkspaceView>): WorkspaceView =>
  ({ id: "w1", title: "say hi", state: "completed", asleep: false, parentId: null, computer: { kind: "this_mac", label: "This Mac" }, ...over }) as WorkspaceView;
const mark = (w: WorkspaceView) => renderToStaticMarkup(createElement(Fragment, null, trailingFor(w)));

test("a chat whose last turn failed says Failed on its row, not where it runs", () => {
  expect(mark(chat({ state: "failed" }))).toContain("Failed");
  expect(mark(chat({ state: "failed" }))).not.toContain("This Mac");
  // A delegated agent that failed says it too (its logo says the rest otherwise).
  expect(mark(chat({ state: "failed", parentId: "w0" }))).toContain("Failed");
});

test("a working chat's todos sit before its ring on the row's line, so the ring ends every row on one edge", () => {
  const todos = { activity: { ask: null, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: { done: 2, total: 5 }, readyToBuild: false } } as Partial<WorkspaceView>;
  for (const w of [chat({ state: "working", ...todos }), chat({ state: "working", parentId: "w0", ...todos })]) {
    const html = mark(w);
    expect(html).not.toContain("flex-col");
    // The count first, the ring (the step strip) last.
    expect(html.indexOf("2/5")).toBeGreaterThan(-1);
    expect(html.indexOf("2/5")).toBeLessThan(html.indexOf("px-strip"));
  }
});

test("a question beats everything; a finished chat here ends quietly; a working one says so", () => {
  expect(mark(chat({ state: "needs_input" }))).toContain("Needs you");
  expect(mark(chat({ state: "needs_input", activity: { ask: { kind: "approval", prompt: "Run rm -rf build?" }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false } }))).toContain("Approve");
  // No computer glyph on every row: a chat on this computer shows nothing once it is done.
  expect(mark(chat({ state: "completed" }))).toBe("");
  expect(mark(chat({ state: "working" }))).toContain("Working");
  expect(mark(chat({ state: "working" }))).not.toContain("This Mac");
  // Parked here, it sleeps; parked because it moved to a Cloud computer, it runs on there.
  expect(mark(chat({ asleep: true }))).toContain("Asleep");
  expect(mark(chat({ asleep: true, computer: { kind: "caveman_cloud", label: "Cloud computer" } }))).toContain("In Cloud");
});

test("a chat on another computer says where it runs the same way, whether or not it has a status", () => {
  const away = { synced: { remote: true } } as Partial<WorkspaceView>;
  // Cloud is one place: a chat there never names the machine it is on.
  const cloud = { kind: "caveman_cloud", label: "acme-web" } as WorkspaceView["computer"];
  expect(mark(chat({ ...away, state: "working", computer: cloud }))).toContain('aria-label="In Cloud"');
  expect(mark(chat({ ...away, state: "completed", computer: cloud }))).toContain('aria-label="In Cloud"');
  expect(mark(chat({ ...away, state: "working", computer: cloud }))).not.toContain("acme-web");
  // A Mac goes by its own name.
  expect(mark(chat({ ...away, state: "completed", computer: { kind: "laptop", label: "Studio" } as WorkspaceView["computer"] }))).toContain('aria-label="On Studio"');
  // Not away (the window's own computer): nothing to say.
  expect(mark(chat({ state: "completed", computer: cloud }))).toBe("");
});

test("a chat whose place in Cloud sleeps says Asleep beside the cloud; once a message was sent, Waking, never both", () => {
  const away = { synced: { remote: true } } as Partial<WorkspaceView>;
  const cloud = { kind: "caveman_cloud", label: "acme-web" } as WorkspaceView["computer"];
  const asleep = mark(chat({ ...away, asleep: true, computer: cloud }));
  expect(asleep).toContain('aria-label="In Cloud"');
  expect(asleep).toContain('aria-label="Asleep"');
  const waking = mark(chat({ ...away, waking: true, computer: cloud }));
  expect(waking).toContain('aria-label="Waking…"');
  expect(waking).not.toContain("Asleep");
});

test("in a browser window every chat says its place, the one on the runtime the window quietly uses too", () => {
  const web = (w: WorkspaceView) => renderToStaticMarkup(createElement(Fragment, null, trailingFor(w, undefined, true)));
  const placed = (kind: "cloud" | "this_mac" | "laptop", name: string) => ({ synced: { remote: false, where: { kind, name } } }) as unknown as Partial<WorkspaceView>;
  // The window's own runtime is a Cloud computer its person never picked: a chat on it is in Cloud like the rest.
  const onIts = web(chat({ ...placed("cloud", "acme-web"), state: "completed", computer: { kind: "this_mac", label: "Cloud" } as WorkspaceView["computer"] }));
  expect(onIts).toContain('aria-label="In Cloud"');
  expect(onIts).not.toContain("acme-web");
  // A Mac's chat goes by the Mac's name, the Mac the window rides too.
  expect(web(chat({ ...placed("this_mac", "Studio"), state: "working" }))).toContain('aria-label="On Studio"');
  // Before Cloud's list has placed a chat, its row says nothing of where.
  expect(web(chat({ state: "completed" }))).toBe("");
  // The desktop app keeps a chat on its own computer quiet.
  expect(mark(chat({ ...placed("this_mac", "Studio"), state: "completed" }))).toBe("");
});

test("a row menu hands focus back to its button when it closes, except when Rename put a field in the row", () => {
  const close = (renaming: { current: boolean }) => {
    let prevented = false;
    keepRenameFocus({ preventDefault: () => void (prevented = true) }, renaming);
    return prevented;
  };
  // Escape, Pin, Fork: Radix's default puts focus back on the trigger (it used to land on <body>).
  expect(close({ current: false })).toBe(false);
  // Rename: the field keeps focus, once; the next close is back to normal.
  const renaming = { current: true };
  expect(close(renaming)).toBe(true);
  expect(renaming.current).toBe(false);
  expect(close(renaming)).toBe(false);
  // Neither menu blanket-prevents the focus return any more.
  expect(readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8")).not.toContain("onCloseAutoFocus={(e) => e.preventDefault()}");
});

test("a rename finished from the keyboard puts focus back on its row or folder", () => {
  // Enter and Escape in the chat and project name fields mark the row for refocus; it used to land on <body>.
  const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
  expect(sidebar.match(/refocusRow\.current = true;/g)).toHaveLength(2);
  expect(sidebar.match(/refocusFolder\.current = true;/g)).toHaveLength(2);
  expect(sidebar).toContain("ref={rowButton}");
  // A project's row: the link to its Chief, or with no Chief here the fold button, takes focus back.
  expect(sidebar).toContain('row?.querySelector<HTMLElement>("[data-sidebar-row]")');
  expect(sidebar).toContain("rowControl(row.current)?.focus();");
});

test("the sidebar's toggle, then Back and Forward, sit in its title band beside the traffic lights, and ahead of the tabs once tucked away", () => {
  const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
  expect(source).toMatch(/<TitleBar>\s*<SidebarToggle hidden=\{flyout\} \/>\s*<HistoryNav className="ml-0\.5" \/>\s*\{appName\}\s*<\/TitleBar>/);
  // Tucked away the sidebar is gone, no rail left behind; its way back keeps that place at the head of the tab strip
  // (after a Mac's traffic lights, 12px in on Windows and in full screen), or in a browser the band above the panel.
  // Resting on the window's left edge slides it out over the page for a look, its toggle there keeping it.
  expect(source).toContain("layout.hidden ? <SidebarFlyout width={layout.width} /> : <SidebarPanel");
  expect(source).toContain("<SidebarPanel width={width} flyout />");
  expect(source).toContain('className="fixed bottom-0 left-0 top-10 z-40 w-2"');
  // Back and Forward keep their place too: 2px after the toggle in either band (the strip's gap, the band's margin).
  expect(readFileSync(new URL("./TabStrip.tsx", import.meta.url), "utf8")).toMatch(/<SidebarToggle hidden className="ml-1" \/>\s*<HistoryNav className="mr-0\.5" \/>/);
  expect(readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8")).toContain("<SidebarToggle hidden />");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  expect(css).toContain(".tab-strip[data-sidebar-hidden] { padding-left: calc(76px / var(--zoom, 1)); }");
  expect(css).toContain("html:is([data-wco], [data-fullscreen]) .tab-strip[data-sidebar-hidden] { padding-left: 8px; }");
  const toggle = readFileSync(new URL("./SidebarToggle.tsx", import.meta.url), "utf8");
  expect(toggle).toContain('data-sidebar-toggle');
  expect(toggle).toContain("aria-keyshortcuts={ariaChord(toggle)}");
  // The width is the stored one, not a fixed 272px panel.
  expect(source).not.toContain('"flex w-[272px] shrink-0');
  expect(source).toContain('role="separator"');
});
