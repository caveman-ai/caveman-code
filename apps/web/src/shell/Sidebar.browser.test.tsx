// The sidebar, in Chromium, against the scripted runtime: starting a new chat, switching between chats, and finding
// one with search.
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { exchange, runtimeFixture, workspace } from "../../test/fixtures.ts";
import { ariaChord } from "../panels/chrome.tsx";
import { chord } from "../state/keybindings.ts";

const twoChats = () =>
  runtimeFixture({
    workspaces: [
      workspace("ws-1", { title: "Fix the login redirect" }),
      workspace("ws-2", { title: "Add dark mode" }),
    ],
    events: {
      "ws-1": exchange(
        "t1",
        "Why does login redirect twice?",
        "Because the guard runs on both routes.",
      ),
      "ws-2": exchange("t1", "Add a dark mode", "Done: the toggle is in the header."),
    },
  });

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });
/** A chat's row: its title, then what it is doing, if anything ("Working"); its options button ("… options") follows. */
const chatRow = (title: string) =>
  sidebar().getByRole("button", {
    name: new RegExp(`^${RegExp.escape(title)}( (?!options$)\\S.*)?$`),
  });
const messageBox = () => page.getByRole("combobox", { name: "Message" });
const chatsMenu = () => sidebar().getByRole("button", { name: /^Chat list options/ });
/** Search, as the chat list's ⋯ menu offers it. */
async function searchFromMenu() {
  await userEvent.click(chatsMenu());
  await userEvent.click(page.getByRole("menuitem", { name: /^Search chats/ }));
}

describe("New chat", () => {
  test("opens the new-chat page with its box focused, and sending there starts the chat and opens it", async () => {
    const { peer } = await mountApp("/w/ws-1", twoChats());
    await expect.element(chatRow("Fix the login redirect")).toHaveAttribute("aria-current", "page");

    await userEvent.click(sidebar().getByRole("link", { name: "New chat" }));
    await expect
      .element(page.getByRole("heading", { name: /^What should we build/ }))
      .toBeVisible();
    await expect.element(messageBox()).toHaveFocus();
    await expect.element(chatRow("Fix the login redirect")).not.toHaveAttribute("aria-current");

    await userEvent.keyboard("Make the header sticky{Enter}");
    const { params } = await peer.nextCall("workspace.create");
    expect(params).toMatchObject({
      repo: { path: "/Users/test/code/app" },
      engine: "caveman",
      task: { text: "Make the header sticky" },
    });
    // The new chat opens on its first message and takes its place in the sidebar, as the one open.
    await expect.element(page.getByRole("log").getByText("Make the header sticky")).toBeVisible();
    await expect.element(chatRow("Make the header sticky")).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/w/ws-new-1");
  });
});

describe("switching chats", () => {
  test("a chat's row opens it, and coming back finds the first chat as it was left, draft included", async () => {
    await mountApp("/w/ws-1", twoChats());
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
    await userEvent.click(messageBox());
    await userEvent.keyboard("Half-written thought");

    await userEvent.click(chatRow("Add dark mode"));
    await expect.element(page.getByText("Done: the toggle is in the header.")).toBeVisible();
    await expect
      .element(page.getByText("Because the guard runs on both routes."))
      .not.toBeVisible();
    await expect.element(chatRow("Add dark mode")).toHaveAttribute("aria-current", "page");
    await expect.element(chatRow("Fix the login redirect")).not.toHaveAttribute("aria-current");
    await expect
      .element(
        page
          .getByRole("region", { name: "Workspace" })
          .getByRole("button", { name: "Add dark mode" }),
      )
      .toBeVisible();
    await expect.element(messageBox()).toHaveValue("");

    await userEvent.click(chatRow("Fix the login redirect"));
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
    await expect.element(chatRow("Fix the login redirect")).toHaveAttribute("aria-current", "page");
    await expect.element(messageBox()).toHaveValue("Half-written thought");
  });
});

describe("the hairline over the chats", () => {
  const hairline = () => sidebar().getByRole("separator", { name: "Height above the chats" });
  const moon = () => sidebar().getByRole("button", { name: /^Focus mode/ });
  // On the hairline left of the moon, which sits over its middle.
  const onLine = { x: 16, y: 12 } as const;
  /**
   * How tall all of the top is, once the sidebar is up: its three places, then the Chiefs, which come a moment later
   * (chief.list), so it waits for their row and for the top to have grown round it.
   */
  const shownAll = async () => {
    await expect.element(hairline()).toBeInTheDocument();
    const chief = sidebar().getByRole("region", { name: "Chiefs" }).getByRole("link").first();
    await expect.element(chief).toBeVisible();
    const max = () => Number(hairline().element().getAttribute("aria-valuemax"));
    const top = () => document.getElementById(moon().element().getAttribute("aria-controls")!)!;
    await expect
      .poll(
        () =>
          max() >=
          chief.element().getBoundingClientRect().bottom - top().getBoundingClientRect().top,
      )
      .toBe(true);
    return max();
  };

  test("dragged up it folds the top away into focus mode; dragged down it shows all of it again", async () => {
    await mountApp("/w/ws-1", twoChats());
    const full = await shownAll();
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", String(full));

    // Up onto New chat: shorter than a row, so the top folds away as the moon would fold it. New chat, above the top,
    // stays.
    const newChat = sidebar().getByRole("link", { name: "New chat" });
    await userEvent.dragAndDrop(hairline(), newChat, { sourcePosition: onLine });
    await expect.element(moon()).toHaveAccessibleName("Focus mode on: show everything");
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", "0");
    expect(localStorage.getItem("caveman.sidebarFocus")).toBe("1");
    const top = document.getElementById(moon().element().getAttribute("aria-controls")!)!;
    expect(top.getBoundingClientRect().height).toBe(0);
    expect(top.contains(newChat.element())).toBe(false);
    expect(newChat.element().getBoundingClientRect().height).toBeGreaterThan(0);
    await userEvent.click(newChat);
    await expect
      .element(page.getByRole("heading", { name: /^What should we build/ }))
      .toBeVisible();

    // Down past its foot: all of it, nothing kept as a height.
    await userEvent.dragAndDrop(hairline(), sidebar().getByRole("link", { name: "Settings" }), {
      sourcePosition: onLine,
    });
    await expect.element(moon()).toHaveAccessibleName("Focus mode: show only chats");
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", String(full));
    expect(localStorage.getItem("caveman.sidebarFocus")).toBe("0");
    expect(localStorage.getItem("caveman.sidebarTop")).toBeNull();

    // A drag never swallows the next click: the moon still folds and unfolds.
    await userEvent.click(moon());
    await expect.element(moon()).toHaveAccessibleName("Focus mode on: show everything");
    await userEvent.click(moon());
    await expect.element(moon()).toHaveAccessibleName("Focus mode: show only chats");
  });

  test("dragged from the moon, the top keeps the row it is left at and scrolls within it; the moon brings it back", async () => {
    await mountApp("/w/ws-1", twoChats());
    const full = await shownAll();
    const line = hairline().element().getBoundingClientRect();
    // From the moon itself, 60px up: it rests under the nearest row, short of all of it.
    await userEvent.dragAndDrop(moon(), hairline(), {
      targetPosition: { x: line.width / 2, y: 12 - 60 },
      force: true,
      steps: 6,
    });
    await expect.element(hairline()).not.toHaveAttribute("aria-valuenow", String(full));
    const kept = Number(hairline().element().getAttribute("aria-valuenow"));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(full);
    expect(localStorage.getItem("caveman.sidebarTop")).toBe(String(kept));
    // The drag did not click the moon.
    await expect.element(moon()).toHaveAccessibleName("Focus mode: show only chats");
    const top = document.getElementById(moon().element().getAttribute("aria-controls")!)!;
    expect(top.getBoundingClientRect().height).toBe(kept);

    await userEvent.click(moon());
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", "0");
    await userEvent.click(moon());
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", String(kept));
  });

  test("it stops under a row: let go inside the third place, two show whole; the keys move it a row", async () => {
    await mountApp("/w/ws-1", twoChats());
    // The top's rows are the places (Review, Plugins, Automations), then the Chiefs; the projects are under the line.
    const place = (name: string) => sidebar().getByRole("link", { name, exact: true });
    await expect.element(place("Automations")).toBeVisible();
    await shownAll();
    const bottom = (name: string) =>
      Math.round(place(name).element().getBoundingClientRect().bottom);
    const topBottom = () =>
      Math.round(
        document
          .getElementById(moon().element().getAttribute("aria-controls")!)!
          .getBoundingClientRect().bottom,
      );

    // Up until the hairline is 6px into Automations: nearer Plugins' foot than its own, so it rests there.
    const line = hairline().element().getBoundingClientRect();
    const into = place("Automations").element().getBoundingClientRect().top + 6;
    await userEvent.dragAndDrop(hairline(), hairline(), {
      sourcePosition: onLine,
      targetPosition: { x: onLine.x, y: onLine.y + into - line.top },
      force: true,
      steps: 8,
    });
    await expect.poll(topBottom).toBe(bottom("Plugins"));
    expect(localStorage.getItem("caveman.sidebarTop")).toBe(
      hairline().element().getAttribute("aria-valuenow"),
    );

    hairline().element().focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(topBottom).toBe(bottom("Review"));
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(topBottom).toBe(bottom("Plugins"));
  });

  test("from the keyboard: the arrow keys move it a row, Home folds the top away and End shows all of it", async () => {
    await mountApp("/w/ws-1", twoChats());
    const full = await shownAll();
    const now = () => Number(hairline().element().getAttribute("aria-valuenow"));
    hairline().element().focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(now).toBeLessThan(full);
    const oneUp = now();
    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(now).toBeLessThan(oneUp);
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(now).toBe(oneUp);
    await userEvent.keyboard("{Home}");
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", "0");
    await expect.element(moon()).toHaveAccessibleName("Focus mode on: show everything");
    await userEvent.keyboard("{End}");
    await expect.element(hairline()).toHaveAttribute("aria-valuenow", String(full));
    await expect.element(moon()).toHaveAccessibleName("Focus mode: show only chats");
  });
});

describe("search", () => {
  test("Search chats finds a chat by its title and Enter opens it", async () => {
    const { peer } = await mountApp("/w/ws-1", twoChats());
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();

    await searchFromMenu();
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect.element(dialog).toBeVisible();
    const query = dialog.getByRole("combobox");
    await expect.element(query).toHaveFocus();

    // The start of its title: the chat leads, its name typed ahead in the field.
    await userEvent.keyboard("add dark");
    const results = dialog.getByRole("listbox", { name: "Results" });
    const hit = results.getByRole("option", { name: /^Add dark mode/ });
    await expect.element(hit).toBeVisible();
    await expect.element(hit).toHaveAttribute("aria-selected", "true");
    await expect.element(query).toHaveValue("add dark mode");
    await expect
      .poll(() => peer.callsOf("chat.search").some((c) => c.params.query === "add dark"))
      .toBe(true);

    await userEvent.keyboard("{Enter}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(page.getByText("Done: the toggle is in the header.")).toBeVisible();
    await expect.element(chatRow("Add dark mode")).toHaveAttribute("aria-current", "page");
  });

  // Closing search gives focus back where it was, so a keyboard or screen reader user carries on from there.
  test("Escape closes search, and focus goes back to the menu it came from", async () => {
    await mountApp("/w/ws-1", twoChats());
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
    await searchFromMenu();
    await expect.element(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    await expect.element(chatsMenu(), { timeout: 1_000 }).toHaveFocus();
  });

  test("its shortcut from the message box, then Escape, puts focus back in the box", async () => {
    await mountApp("/w/ws-1", twoChats());
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
    await userEvent.click(messageBox());
    // The shortcut as the menu announces it (Meta+K on a Mac, Control+K elsewhere).
    const [mod, key] = ariaChord(chord("app.search")).split("+");
    await userEvent.keyboard(`{${mod}>}${key!.toLowerCase()}{/${mod}}`);
    await expect.element(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    await expect.element(messageBox(), { timeout: 1_000 }).toHaveFocus();
  });
});

describe("a project with many chats", () => {
  // 40 chats in one project, chat 0 the most recently started.
  const manyChats = () =>
    runtimeFixture({
      workspaces: Array.from({ length: 40 }, (_, i) =>
        workspace(`c${i}`, {
          title: `Long project chat ${i}`,
          created_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        }),
      ),
    });
  const showMore = () => sidebar().getByRole("button", { name: "Show more", exact: true });
  const showLess = () => sidebar().getByRole("button", { name: "Show less", exact: true });

  test("opens fifteen chats at a time; when the pressed button goes, focus moves to the one left", async () => {
    await mountApp("/new", manyChats());
    await expect.element(chatRow("Long project chat 7")).toBeInTheDocument();
    await expect.element(chatRow("Long project chat 8")).not.toBeInTheDocument();
    await expect.element(showLess()).not.toBeInTheDocument();

    // New chat puts focus in its box once it opens; only then does focus go to Show more, so the box takes none back.
    await expect.element(messageBox()).toHaveFocus();
    (showMore().element() as HTMLElement).focus();
    await expect.element(showMore()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(chatRow("Long project chat 22")).toBeInTheDocument();
    await expect.element(chatRow("Long project chat 23")).not.toBeInTheDocument();
    await expect.element(showLess()).toBeInTheDocument();
    await expect.element(showMore()).toHaveFocus();

    // The last Show more opens every chat and goes: focus moves to Show less.
    await userEvent.keyboard("{Enter}");
    await expect.element(chatRow("Long project chat 37")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect.element(chatRow("Long project chat 39")).toBeInTheDocument();
    await expect.element(showMore()).not.toBeInTheDocument();
    await expect.element(showLess()).toHaveFocus();

    // Show less folds back to the first eight and goes: focus moves to Show more.
    await userEvent.keyboard("{Enter}");
    await expect.element(chatRow("Long project chat 8")).not.toBeInTheDocument();
    await expect.element(showLess()).not.toBeInTheDocument();
    await expect.element(showMore()).toHaveFocus();
  });
});
