// A project's sidebar row, in Chromium against the scripted runtime. It is the project's own;
// Chiefs have a section of their own (chiefs-section.browser.test.tsx). A click on the row folds its chats and leaves
// the page where it is; its logo, else the pixel folder, sits bare in a 28px slot; hovered, the chevron tile takes the
// mark's place and + comes over the name's end; folded, the amber dot says a chat of it waits on you; a right-click or
// the menu key opens the project's menu, with nothing of a Chief's in it; a long name fades out instead of an
// ellipsis; and projects reorder by dragging their rows or with Alt+arrows.
import type { ChiefItem, Project } from "@caveman-app/session-protocol";
import { describe, expect, onTestFinished, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import {
  AT,
  chief,
  PROJECT,
  runtimeFixture,
  workspace,
  type RuntimeFixture,
} from "../../test/fixtures.ts";

const LIB: Project = { ...PROJECT, id: "p-lib", name: "lib", path: "/Users/test/code/lib" };
/** A Chief made 2026-11-15 to 17, with app as its one project: it still opens from Chiefs, never from app's row. */
const carl = chief("c-carl", "Carl", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });
/** A project's row: the button that folds its chats, named by the project. */
const row = (name: string) => sidebar().getByRole("button", { name, exact: true });
/** On the row's own surface, on its name: clear of the chevron tile in the mark's slot and the controls at its right. */
const ON_ROW = { x: 80, y: 16 } as const;
const clickRow = (name: string) => userEvent.click(row(name), { position: ON_ROW });
/** A chat's row: its title, then what it is doing, if anything; its options button ("… options") is not it. */
const chatRow = (title: string) =>
  sidebar().getByRole("button", {
    name: new RegExp(`^${RegExp.escape(title)}( (?!options$)\\S.*)?$`),
  });
const projectMenu = (name: string) => page.getByRole("menu", { name: `${name} options` });
/** The amber dot a project's row shows at rest while the project waits on you. */
const restDot = (project: string) =>
  row(project).element().closest("[data-peek]")!.querySelector("[data-waits]");
/** A Chief's row, in the sidebar's Chiefs. */
const chiefRow = (name: string | RegExp) =>
  sidebar()
    .getByRole("region", { name: "Chiefs" })
    .getByRole("link", { name, exact: typeof name === "string" });

/**
 * The app at /new once its sidebar has settled: the Chiefs load after the projects and push them down, so a test that
 * measures a project's row waits for Carl's.
 */
async function mountRows(fixture: RuntimeFixture, options?: Parameters<typeof mountApp>[3]) {
  const mounted = await mountApp("/new", fixture, {}, options);
  await expect.element(chiefRow(/^Carl\b/)).toBeVisible();
  return mounted;
}

describe("a project's row", () => {
  test("a click folds its chats and leaves the page where it is, though a Chief once had the project", async () => {
    await mountRows(
      runtimeFixture({
        chiefs: [carl],
        workspaces: [workspace("ws-1", { title: "Fix the login redirect" })],
      }),
    );
    await expect.element(chatRow("Fix the login redirect")).toBeVisible();
    const body = chatRow("Fix the login redirect").element().closest(".folder-body")!;
    /** Its chats' fold: shut is inert, clipped to nothing (styles.css .folder-body). */
    const shut = () => body.hasAttribute("inert") && !body.hasAttribute("data-open");
    await expect.element(row("app")).toHaveAttribute("aria-expanded", "true");

    await clickRow("app");
    await expect.poll(shut).toBe(true);
    await expect.element(row("app")).toHaveAttribute("aria-expanded", "false");
    expect(window.location.hash).toBe("#/new");
    expect(row("app").element().hasAttribute("aria-current")).toBe(false);

    await clickRow("app");
    await expect.poll(shut).toBe(false);
    await expect.element(row("app")).toHaveAttribute("aria-expanded", "true");
    expect(window.location.hash).toBe("#/new");
    // Its Chief is a row in Chiefs, not in the project's folder.
    await expect.element(chiefRow("Carl")).toBeVisible();
    expect(body.querySelector("a[href^='#/chief']")).toBeNull();
  });

  test("resting marks pass pointer hits to the row before the fold key appears", async () => {
    await mountRows(runtimeFixture({ chiefs: [carl], projects: [PROJECT, LIB] }));
    await expect.element(row("app")).toBeVisible();
    // Touch and a pointer arriving before hover styles update must hit the row, not an empty key wrapper.
    for (const name of ["app", "lib"]) {
      const button = row(name).element();
      const box = button.getBoundingClientRect();
      expect(document.elementFromPoint(box.left + 22, box.top + 16)).toBe(button);
    }
  });

  test("shows a bare logo, else the pixel folder, in the same 28px slot", async () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#3e63dd"/></svg>')}`;
    await mountRows(
      runtimeFixture({ chiefs: [carl], projects: [{ ...PROJECT, logo: { id: "logo-1" } }, LIB] }),
      { setup: (peer) => peer.on("project.logo.read", () => ({ id: "logo-1", url: svg })) },
    );
    const mark = (name: string) => row(name).element().closest("[data-peek]")!;
    await expect.poll(() => mark("app").querySelector("img")?.getAttribute("src")).toBe(svg);
    // 16px in its 28px slot, and nothing draws a box behind it.
    const img = mark("app").querySelector("img")!;
    expect(img.getBoundingClientRect().width).toBe(16);
    expect(img.parentElement!.getBoundingClientRect().width).toBe(28);
    expect(getComputedStyle(img.parentElement!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    // No logo: the pixel folder alone in the slot, no Chief in a grey square.
    expect(mark("lib").querySelector("img")).toBeNull();
    const slot = mark("lib").querySelector<HTMLElement>(".project-mark")!;
    expect(slot.getBoundingClientRect().width).toBe(28);
    expect(slot.children).toHaveLength(1);
    expect(slot.firstElementChild!.classList.contains("px-folder")).toBe(true);
    expect(getComputedStyle(slot.firstElementChild!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  test("hovered, a chevron tile takes its logo's place and hides and shows its chats without leaving the page; so does its menu", async () => {
    await mountRows(
      runtimeFixture({
        chiefs: [carl],
        workspaces: [workspace("ws-1", { title: "Fix the login redirect" })],
      }),
    );
    await expect.element(chatRow("Fix the login redirect")).toBeVisible();
    const body = chatRow("Fix the login redirect").element().closest(".folder-body")!;
    /** Its chats' fold: shut is inert, clipped to nothing (styles.css .folder-body). */
    const shut = () => body.hasAttribute("inert") && !body.hasAttribute("data-open");
    const plus = sidebar().getByRole("button", { name: "New chat in app" });
    const rowEl = () => row("app").element().closest<HTMLElement>("[data-peek]")!;
    const cut = () => getComputedStyle(rowEl()).getPropertyValue("--cut").trim();
    const hide = sidebar().getByRole("button", { name: "Hide app's chats" });
    const logo = () => rowEl().querySelector<HTMLElement>(".project-mark")!;
    // At rest the row is its mark and its name; hovered, the chevron tile covers the mark's slot, and + comes over the
    // name's end.
    expect(plus.query()).toBeNull();
    expect(hide.query()).toBeNull();
    expect(cut()).toBe("0px");
    await userEvent.hover(row("app"), { position: ON_ROW });
    await expect.element(plus).toBeVisible();
    await expect.element(hide).toBeVisible();
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => getComputedStyle(logo()).opacity).toBe("0");
    expect(logo().getBoundingClientRect().width).toBe(28);
    const tile = hide.element() as HTMLElement;
    expect([tile.offsetWidth, tile.offsetHeight]).toEqual([28, 28]);
    expect(cut()).toBe("26px");
    // The tile folds, and the page stays where it was.
    await userEvent.click(hide);
    await expect.poll(shut).toBe(true);
    expect(window.location.hash).toBe("#/new");
    // Unhovered, the logo is back.
    await userEvent.unhover(row("app"));
    await expect.poll(() => getComputedStyle(logo()).opacity).toBe("1");
    await userEvent.hover(row("app"), { position: ON_ROW });
    await userEvent.click(sidebar().getByRole("button", { name: "Show app's chats" }));
    await expect.poll(shut).toBe(false);
    expect(window.location.hash).toBe("#/new");

    await userEvent.click(row("app"), { button: "right", position: ON_ROW });
    await userEvent.click(page.getByRole("menuitem", { name: "Hide chats" }));
    await expect.poll(shut).toBe(true);
    await expect.element(projectMenu("app")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#/new");
    // + is still there on the hover, folded or not.
    await userEvent.hover(row("app"), { position: ON_ROW });
    await expect.element(plus).toBeVisible();

    await userEvent.click(row("app"), { button: "right", position: ON_ROW });
    await userEvent.click(page.getByRole("menuitem", { name: "Show chats" }));
    await expect.poll(shut).toBe(false);
    await expect.element(chatRow("Fix the login redirect")).toBeVisible();
    expect(window.location.hash).toBe("#/new");
  });

  test("its fold key and New chat key come with the hover and with keyboard focus, and + opens a chat in the project", async () => {
    await mountRows(runtimeFixture({ chiefs: [carl] }));
    // New chat takes focus on its first animation frame. Let that finish before moving focus to the row.
    await expect.element(page.getByRole("combobox", { name: "Message" })).toHaveFocus();
    const plus = sidebar().getByRole("button", { name: "New chat in app" });
    const fold = sidebar().getByRole("button", { name: "Hide app's chats" });
    await userEvent.hover(row("app"), { position: ON_ROW });
    await expect.element(plus).toBeVisible();
    await userEvent.unhover(row("app"));
    await expect.element(plus).not.toBeInTheDocument();
    // Tabbed onto from the keyboard, the row shows both keys.
    (row("app").element() as HTMLElement).focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Tab}");
    await expect.element(row("app")).toHaveFocus();
    await expect.element(plus).toBeVisible();
    await expect.element(fold).toBeVisible();
    await userEvent.click(plus);
    await expect.poll(() => window.location.hash).toBe(`#/new?project=${PROJECT.id}`);
  });

  test("a folded project's working status keeps its accessible label", async () => {
    await mountRows(
      runtimeFixture({
        chiefs: [carl],
        workspaces: [workspace("ws-working", { status: "working" })],
      }),
    );
    await userEvent.hover(row("app"), { position: ON_ROW });
    await userEvent.click(sidebar().getByRole("button", { name: "Hide app's chats" }));
    await expect
      .element(sidebar().getByRole("button", { name: "Show app's chats" }))
      .toHaveAttribute("aria-expanded", "false");
    await userEvent.unhover(row("app"));
    await expect
      .element(sidebar().getByRole("img", { name: "Working", exact: true }).first())
      .toBeVisible();
  });

  test("folded, it wears the amber dot while a chat of it waits on you, its pinned chats included", async () => {
    await mountRows(
      runtimeFixture({
        chiefs: [carl],
        workspaces: [
          workspace("ws-1", { title: "Fix the login redirect" }),
          workspace("ws-2", {
            title: "Pick a palette",
            status: "needs_input",
            inbox: { pinned_at: AT },
          }),
        ],
      }),
    );
    // The waiting chat sits in Pinned, not in the folder: the project still waits on you. A screen reader hears it
    // from the row itself, whatever shows. Open, the row shows no dot (its chats show their own).
    await expect.element(row("app")).toHaveAttribute("aria-description", "A chat here needs you");
    expect(restDot("app")).toBeNull();
    await clickRow("app");
    await userEvent.unhover(row("app"));
    await expect.poll(() => restDot("app")).not.toBeNull();
  });

  test("a Chief's item that needs you lights its Chief's row, not its project's", async () => {
    const item: ChiefItem = {
      id: "i-1",
      chief_id: carl.id,
      text: "Which palette?",
      state: "needs_you",
      detail: "Which palette?",
      rank: 1,
      pinned: false,
      project_ids: [PROJECT.id],
      source: "composer",
      workspace_ids: [],
      created_at: AT,
      updated_at: AT,
    };
    await mountRows(runtimeFixture({ chiefs: [carl], board: { items: [item], change_sets: [] } }));
    await expect.element(chiefRow("Carl, 1 need you")).toBeVisible();
    expect(row("app").element().hasAttribute("aria-description")).toBe(false);
    await clickRow("app");
    await userEvent.unhover(row("app"));
    await expect.element(row("app")).toHaveAttribute("aria-expanded", "false");
    expect(restDot("app")).toBeNull();
  });
});

describe("a folder that is no project", () => {
  test("a click folds it, and a right-click offers to archive its chats", async () => {
    await mountRows(
      runtimeFixture({
        chiefs: [carl],
        workspaces: [
          workspace("ws-loose", {
            title: "Loose chat",
            project_id: "p-unknown",
            repo: { path: "/Users/test/scratch" },
          }),
        ],
      }),
    );
    await expect.element(chatRow("Loose chat")).toBeVisible();
    const folder = (
      chatRow("Loose chat").element().closest(".folder-body")!.previousElementSibling as HTMLElement
    ).querySelector<HTMLElement>("[data-sidebar-row]")!;
    expect(folder.tagName).toBe("BUTTON");
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(folder, { position: ON_ROW });
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(folder, { button: "right", position: ON_ROW });
    await expect.element(page.getByRole("menuitem", { name: /Archive chat/ })).toBeVisible();
  });
});

describe("a project's menu", () => {
  test("has no ⋯: a right-click opens it at the pointer, with the project's actions and nothing of a Chief's", async () => {
    await mountRows(runtimeFixture({ chiefs: [carl], projects: [PROJECT, LIB] }));
    await expect.element(row("app")).toBeVisible();
    await userEvent.hover(row("app"), { position: ON_ROW });
    expect(sidebar().getByRole("button", { name: "app options" }).query()).toBeNull();

    // Open, the menu keeps the rest of the window from assistive tech: the row is measured first.
    const box = row("app").element().getBoundingClientRect();
    await userEvent.click(row("app"), { button: "right", position: ON_ROW });
    const menu = projectMenu("app");
    await expect.element(menu).toBeVisible();
    // At the pointer: its corner just under and right of where the row was clicked.
    const at = menu.element().getBoundingClientRect();
    expect(Math.abs(at.left - (box.left + ON_ROW.x))).toBeLessThan(4);
    expect(Math.abs(at.top - (box.top + ON_ROW.y))).toBeLessThan(6);
    for (const name of ["New chat", "Hide chats", "Rename", "Logo…"])
      await expect.element(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
    await expect.element(menu.getByRole("menuitem", { name: /^Remove project/ })).toBeVisible();
    // Its Chief's settings, board and calls are the Chief's own ⋯, in Chiefs.
    const items = menu
      .getByRole("menuitem")
      .elements()
      .map((el) => el.textContent ?? "");
    expect(items.filter((text) => /Chief|Board|Call /.test(text))).toEqual([]);
  });

  test("the menu key (Shift+F10) on the focused row opens it under the row, and Escape gives focus back to the row", async () => {
    await mountRows(runtimeFixture({ chiefs: [carl] }));
    // New chat takes focus on its first animation frame. Let that finish before moving focus to the row.
    await expect
      .element(page.getByRole("combobox", { name: "Message", exact: true }))
      .toHaveFocus();
    await expect.element(row("app")).toBeVisible();
    const button = row("app").element() as HTMLElement;
    const box = button.getBoundingClientRect();
    button.focus();
    await expect.element(row("app")).toHaveFocus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    const menu = projectMenu("app");
    await expect.element(menu).toBeVisible();
    expect(menu.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(box.bottom);
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(button);
  });
});

describe("a long project name", () => {
  test("runs to the row's end and fades out instead of an ellipsis; hovered, only the overlay changes", async () => {
    const long = "a-project-whose-name-is-far-too-long-for-the-sidebar";
    const project = { ...PROJECT, name: long };
    await mountRows(runtimeFixture({ chiefs: [carl], projects: [project] }));
    await expect.element(row(long)).toBeVisible();
    const rowEl = row(long).element().closest<HTMLElement>("[data-peek]")!;
    const name = rowEl.querySelector<HTMLElement>(".project-name")!;
    const style = getComputedStyle(name);
    expect(style.textOverflow).not.toBe("ellipsis");
    expect(style.maskImage).toContain("linear-gradient");
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    // At rest the name runs to the row's end: nothing at its right.
    expect(rowEl.getBoundingClientRect().right - name.getBoundingClientRect().right).toBeLessThan(
      8,
    );
    expect(getComputedStyle(rowEl).getPropertyValue("--cut").trim()).toBe("0px");

    const before = name.getBoundingClientRect();
    await userEvent.hover(row(long), { position: ON_ROW });
    // Hovered, + comes over the name's end and the fade moves with it; the name stays put.
    const plus = sidebar().getByRole("button", { name: `New chat in ${long}` });
    await expect.element(plus).toBeVisible();
    expect(getComputedStyle(rowEl).getPropertyValue("--cut").trim()).toBe("26px");
    expect(name.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
    expect(rowEl.getBoundingClientRect().height).toBe(32);
    // The chevron tile in the mark's slot, before the name; + at the row's far right.
    const chevron = sidebar()
      .getByRole("button", { name: `Hide ${long}'s chats` })
      .element();
    expect(chevron.getBoundingClientRect().right).toBeLessThanOrEqual(
      name.getBoundingClientRect().left,
    );
    expect(
      rowEl.getBoundingClientRect().right - plus.element().getBoundingClientRect().right,
    ).toBeLessThan(8);
  });
});

/** Real mouse presses exercise pointer capture, native click suppression and cancellation in Chromium. */
const orderIds = () =>
  [...sidebar().element().querySelectorAll<HTMLElement>("[data-order-id]")].map(
    (el) => el.dataset.orderId,
  );
async function holdRow(name: string, mark = false) {
  onTestFinished(() => commands.releasePointer());
  const box = row(name).element().getBoundingClientRect();
  const x = box.left + (mark ? 22 : 80);
  await commands.pointerTo(x, box.top + 16);
  await commands.holdPointer();
  await commands.pointerTo(x, box.top + 23);
}
async function overRow(name: string) {
  const box = row(name).element().getBoundingClientRect();
  await commands.pointerTo(box.left + 80, box.bottom - 2);
}

describe("sidebar arrangements", () => {
  const fixture = () =>
    runtimeFixture({
      chiefs: [carl],
      projects: [PROJECT, LIB],
      workspaces: [workspace("ws-1", { title: "Keep this open" })],
    });

  test("drags projects, morphs chevron into six dots, persists across remount and keeps folds", async () => {
    await mountRows(fixture());
    await expect.element(row("app")).toBeVisible();
    const initial = orderIds();
    expect(initial).toEqual([PROJECT.id, LIB.id]);
    await holdRow("app");
    const source = row("app").element().closest<HTMLElement>("[data-order-id]")!;
    await expect.poll(() => source.dataset.arranging).toBe("true");
    expect(source.querySelectorAll(".sidebar-drag-dots > span")).toHaveLength(6);
    await expect
      .poll(() => getComputedStyle(source.querySelector(".sidebar-drag-dots")!).opacity)
      .toBe("1");
    await expect
      .poll(() => getComputedStyle(source.querySelector(".project-fold-glyph")!).opacity)
      .toBe("0");
    await overRow("lib");
    await commands.releasePointer();
    await expect.poll(orderIds).toEqual([...initial].reverse());
    expect(JSON.parse(localStorage.getItem("caveman.projectOrder")!)).toEqual(
      [...initial].reverse(),
    );
    expect(source.hasAttribute("data-arranging")).toBe(false);
    await expect
      .poll(() => getComputedStyle(source.querySelector(".sidebar-drag-dots")!).opacity)
      .toBe("0");
    await expect.element(chatRow("Keep this open")).toBeVisible();
    expect(window.location.hash).toBe("#/new");
    await userEvent.keyboard("{Meta>}b{/Meta}");
    await userEvent.keyboard("{Meta>}b{/Meta}");
    await expect.element(row("app")).toBeVisible();
    expect(orderIds()).toEqual([...initial].reverse());
    await userEvent.hover(row("app"), { position: ON_ROW });
    await userEvent.click(sidebar().getByRole("button", { name: "Hide app's chats" }));
    await expect
      .poll(() =>
        chatRow("Keep this open").element().closest(".folder-body")!.hasAttribute("inert"),
      )
      .toBe(true);
  });

  test("Escape and pointer cancellation discard drag without navigation, folding or writes", async () => {
    await mountRows(fixture());
    await expect.element(row("app")).toBeVisible();
    const initial = orderIds();
    for (const cancel of ["escape", "pointer", "outside"] as const) {
      await holdRow("app", true);
      await overRow("lib");
      if (cancel === "escape") await userEvent.keyboard("{Escape}");
      else if (cancel === "pointer")
        row("app")
          .element()
          .dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
      if (cancel === "outside") await commands.pointerTo(900, 600);
      await commands.releasePointer();
      expect(orderIds()).toEqual(initial);
      expect(localStorage.getItem("caveman.projectOrder")).toBeNull();
      expect(sidebar().element().querySelector("[data-arranging]")).toBeNull();
      await expect.element(chatRow("Keep this open")).toBeVisible();
      expect(window.location.hash).toBe("#/new");
    }
  });

  test("a scrolling project list cancels a drop onto Add connections below its visible viewport", async () => {
    const projects = Array.from({ length: 24 }, (_, i) => ({
      ...PROJECT,
      id: `scroll-${i}`,
      name: i === 2 ? "Studio" : `Project ${i}`,
      path: `/tmp/scroll-project-${i}`,
    }));
    await mountRows(runtimeFixture({ projects, chiefs: [carl], workspaces: [] }));
    await expect.element(row("Studio")).toBeVisible();
    const checklist = sidebar().getByRole("button", { name: /^Getting started/ });
    await expect.element(checklist).toBeVisible();
    if (checklist.element().getAttribute("aria-expanded") !== "true")
      await userEvent.click(checklist);
    const add = sidebar().getByRole("button", { name: "Add connections in Plugins" });
    await expect.element(add).toBeVisible();
    let scroller = row("Studio").element().parentElement!;
    while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement!;
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    const viewport = scroller.getBoundingClientRect();
    const target = add.element().getBoundingClientRect();
    const x = target.left + target.width / 2,
      y = target.top + target.height / 2;
    expect(y).toBeGreaterThan(viewport.bottom);
    // Align an offscreen header with this actual checklist button, allowing for the old code's edge
    // auto-scroll on move/up. Studio stays visible above it; no fake rectangles or synthetic drops.
    const ghost = [...sidebar().element().querySelectorAll<HTMLElement>(".project-row")].find(
      (el) => el.getBoundingClientRect().top >= y + 8,
    )!;
    scroller.scrollTop += ghost.getBoundingClientRect().top - (y + 8);
    expect(ghost.getBoundingClientRect().top).toBeGreaterThan(viewport.bottom);
    const before = orderIds();
    const scrollTop = scroller.scrollTop;
    expect(localStorage.getItem("caveman.projectOrder")).toBeNull();
    await holdRow("Studio");
    await overRow("Project 3");
    await expect
      .poll(() =>
        sidebar().element().querySelector("[data-order-drop]")?.getAttribute("data-order-name"),
      )
      .toBe("Project 3");
    await commands.pointerTo(x, y, 1);
    await commands.releasePointer();
    expect(orderIds()).toEqual(before);
    expect(scroller.scrollTop).toBe(scrollTop);
    expect(localStorage.getItem("caveman.projectOrder")).toBeNull();
    expect(sidebar().element().querySelector("[data-order-drop]")).toBeNull();
    expect(window.location.hash).toBe("#/new");
  });

  test("Alt+arrows reorder projects and keep focus on the row", async () => {
    await mountRows(fixture());
    await expect.element(row("lib")).toBeVisible();
    const lib = row("lib").element() as HTMLElement;
    lib.focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(orderIds()).toEqual([LIB.id, PROJECT.id]);
    expect(document.activeElement).toBe(lib);
    expect(JSON.parse(localStorage.getItem("caveman.projectOrder")!)).toEqual([LIB.id, PROJECT.id]);
    // At the top already: it stays.
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(orderIds()).toEqual([LIB.id, PROJECT.id]);
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(orderIds()).toEqual([PROJECT.id, LIB.id]);
    expect(document.activeElement).toBe(lib);
    expect(window.location.hash).toBe("#/new");
  });
});
