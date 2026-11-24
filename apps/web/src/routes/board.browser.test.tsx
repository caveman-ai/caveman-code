// A Chief's board in a page of its own (/chief/:id/board), opened from the Chief's ⋯ in the sidebar's Chiefs or by its
// address: its own items alone, without its conversation or Work panel, its name in the bar and Chat back to it.
import type { ChiefItem } from "@caveman-app/session-protocol";
import { expect, onTestFinished, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { AT, chief, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";
import { windowTabs } from "../panes/store.ts";

// Ids no other file uses: a Chief's side panel stays in the page's memory between files, and one leaves c-app's on Chat.
const appChief = chief("c-carl", "Carl", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});
const lib = { ...PROJECT, id: "p-lib", name: "lib", path: "/Users/test/code/lib" };
const libChief = chief("c-ugg", "Ugg", {
  project_id: lib.id,
  project_ids: [lib.id],
  project_default: true,
});
const item = (id: string, patch: Partial<ChiefItem> = {}): ChiefItem => ({
  id,
  chief_id: appChief.id,
  text: id,
  title: id,
  state: "queued",
  rank: 1,
  pinned: false,
  project_ids: [PROJECT.id],
  source: "composer",
  workspace_ids: [],
  created_at: AT,
  updated_at: AT,
  ...patch,
});
const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });
const chiefRow = (name: string) =>
  sidebar().getByRole("region", { name: "Chiefs" }).getByRole("link", { name, exact: true });
/** A Chief's board, from its ⋯ in the sidebar (it shows on the row's hover). */
async function openBoard(name: string) {
  await userEvent.hover(chiefRow(name));
  await userEvent.click(sidebar().getByRole("button", { name: `${name} options` }));
  await userEvent.click(page.getByRole("menuitem", { name: "Board", exact: true }));
}
const board = () => page.getByRole("region", { name: "Board", exact: true });

test("a Chief's ⋯ opens its board alone; a card opens its chat, and Chat or its row its conversation", async () => {
  await mountApp(
    "/new",
    runtimeFixture({
      chiefs: [appChief, libChief],
      projects: [PROJECT, lib],
      workspaces: [
        workspace("ws-1", { title: "Sticky header" }),
        // A chat of its own, so the other Chief's item is one its board shows: only the Chief's own items show here.
        workspace("ws-2", { title: "Other project", repo: { path: lib.path }, project_id: lib.id }),
      ],
      board: {
        items: [
          item("Sticky header", { workspace_ids: ["ws-1"] }),
          item("Other project", {
            chief_id: libChief.id,
            project_ids: [lib.id],
            workspace_ids: ["ws-2"],
          }),
        ],
        change_sets: [],
      },
    }),
  );
  // A card opens its chat in a window tab of its own, and the window's tabs outlive the mount: those opened here close
  // with the test, so later files start with one.
  const had = new Set(windowTabs.get().list.map((t) => t.id));
  onTestFinished(() => void windowTabs.close((t) => !had.has(t.id)));
  await openBoard("Carl");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl/board");
  await expect.element(board().getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  // Its bar names the Chief whose board it is.
  await expect.element(board().getByText("Carl", { exact: true })).toBeVisible();
  await expect.element(board().getByText("Sticky header", { exact: true })).toBeVisible();
  await expect.element(board().getByText("Other project")).not.toBeInTheDocument();
  await expect.element(page.getByRole("combobox", { name: "Message" })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("radiogroup", { name: "Show the work as" }))
    .not.toBeInTheDocument();
  // Its conversation is not in front: the Chief's row is not filled.
  await expect.element(chiefRow("Carl")).not.toHaveAttribute("aria-current");

  await userEvent.click(board().getByRole("button", { name: "Sticky header", exact: true }));
  await expect.poll(() => window.location.hash).toBe("#/w/ws-1");
  await openBoard("Carl");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl/board");
  await userEvent.click(board().getByRole("link", { name: "Chat", exact: true }));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl");
  await expect.element(chiefRow("Carl")).toHaveAttribute("aria-current", "page");
  // Visiting the page never chooses Board in the Chief's own Work panel (closed until its toggle opens it).
  const toggle = page.getByRole("button", { name: /^(Show|Hide) panel$/ }).first();
  await expect.element(toggle).toBeVisible();
  if (toggle.element().getAttribute("aria-label") === "Show panel") await toggle.click();
  await expect
    .element(page.getByRole("radio", { name: "List", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  // Its row leaves the board for its conversation too.
  await openBoard("Carl");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl/board");
  await userEvent.click(chiefRow("Carl"));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl");

  // The other Chief's board shows its own item, and not this one's.
  await openBoard("Ugg");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-ugg/board");
  await expect.element(board().getByText("Ugg", { exact: true })).toBeVisible();
  await expect.element(board().getByText("Other project", { exact: true })).toBeVisible();
  await expect.element(board().getByText("Sticky header")).not.toBeInTheDocument();
});

test("a card says what proves it done; its ⋯ sets that and how often the Chief looks in", async () => {
  const proof = "CI green on main for a week";
  const sticky = item("Sticky header", { number: 12, workspace_ids: ["ws-1"], done_when: proof });
  const { peer } = await mountApp(
    "/chief/c-carl/board",
    runtimeFixture({
      chiefs: [appChief],
      workspaces: [workspace("ws-1", { title: "Sticky header" })],
      board: { items: [sticky, item("Docs pass", { number: 13 })], change_sets: [] },
    }),
  );
  // The card shows the person's edit at once; the runtime's answer (the item) changes nothing on screen.
  peer.on("chief.items.update", () => sticky);
  // One muted line under its title, the whole of it in its tooltip; a card without one has none.
  const line = board().getByText(`Done when ${proof}`, { exact: true });
  await expect.element(line).toBeVisible();
  await expect.element(line).toHaveAttribute("title", `Done when ${proof}`);
  expect(
    board()
      .getByText(/^Done when/)
      .elements(),
  ).toHaveLength(1);
  const card = () =>
    board().element().querySelector<HTMLElement>('[data-work-card="Sticky header"]')!;
  const options = board().getByRole("button", { name: "CAR-12 options", exact: true });
  const openMenu = async () => {
    // The last one has finished closing (it fades out), as a person's next click would find it.
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await userEvent.hover(card());
    await userEvent.click(options);
  };

  // Set done when…: the line becomes a field in place; Enter sends the new words.
  await openMenu();
  await userEvent.click(page.getByRole("menuitem", { name: "Set done when…" }));
  const field = board().getByRole("textbox", { name: "Done when" });
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveValue(proof);
  await userEvent.fill(field, "CI green on main for two weeks");
  await userEvent.keyboard("{Enter}");
  expect((await peer.nextCall("chief.items.update")).params).toMatchObject({
    item_id: "Sticky header",
    done_when: "CI green on main for two weeks",
  });
  await expect
    .element(board().getByText("Done when CI green on main for two weeks", { exact: true }))
    .toBeVisible();
  await expect.element(field).not.toBeInTheDocument();

  // Escape keeps what it was, and sends nothing.
  await openMenu();
  await userEvent.click(page.getByRole("menuitem", { name: "Set done when…" }));
  await userEvent.fill(board().getByRole("textbox", { name: "Done when" }), "never mind");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(board().getByText("Done when CI green on main for two weeks", { exact: true }))
    .toBeVisible();
  expect(peer.callsOf("chief.items.update")).toHaveLength(1);

  // Check in: Never until set; Weekly sends its pace, and the menu shows it checked.
  await openMenu();
  const checkIn = page.getByRole("menuitem", { name: /^Check in/ });
  // Its pace reads beside it without opening it.
  await expect.element(checkIn).toBeVisible();
  expect(checkIn.element().textContent?.trim()).toBe("Check inNever");
  await userEvent.click(checkIn);
  await expect
    .element(page.getByRole("menuitemradio", { name: "Never" }))
    .toHaveAttribute("aria-checked", "true");
  await userEvent.click(page.getByRole("menuitemradio", { name: "Weekly" }));
  await expect
    .poll(() => peer.callsOf("chief.items.update").at(-1)?.params)
    .toMatchObject({ item_id: "Sticky header", check_in: "week" });
  await openMenu();
  await expect.element(checkIn).toBeVisible();
  expect(checkIn.element().textContent?.trim()).toBe("Check inWeekly");
  await userEvent.keyboard("{Escape}");

  // Emptied, it clears: the line goes.
  await openMenu();
  await userEvent.click(page.getByRole("menuitem", { name: "Set done when…" }));
  await userEvent.clear(board().getByRole("textbox", { name: "Done when" }));
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => peer.callsOf("chief.items.update").at(-1)?.params)
    .toMatchObject({ item_id: "Sticky header", done_when: "" });
  await expect.element(board().getByText(/^Done when/)).not.toBeInTheDocument();
});

test("what is typed into Done when still saves when a board update moves the card to another column mid-edit", async () => {
  const docs = item("Docs pass", { number: 13 });
  const { peer } = await mountApp(
    "/chief/c-carl/board",
    runtimeFixture({ chiefs: [appChief], board: { items: [docs], change_sets: [] } }),
  );
  peer.on("chief.items.update", () => docs);
  await expect.element(board().getByText("Docs pass", { exact: true })).toBeVisible();
  await userEvent.hover(
    board().element().querySelector<HTMLElement>('[data-work-card="Docs pass"]')!,
  );
  await userEvent.click(board().getByRole("button", { name: "CAR-13 options", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Set done when…" }));
  await userEvent.fill(
    board().getByRole("textbox", { name: "Done when" }),
    "The 2.0 docs are live",
  );
  // A chat fails meanwhile: the item waits on the person now, in another column, and its card is drawn anew.
  peer.notify("chief.board.updated", {
    items: [{ ...docs, state: "needs_you", detail: "The docs build failed." }],
    change_sets: [],
  });
  expect((await peer.nextCall("chief.items.update")).params).toMatchObject({
    item_id: "Docs pass",
    done_when: "The 2.0 docs are live",
  });
});

test("the Work panel's List row says it too; its right-click menu opens at the pointer and sets it", async () => {
  const docs = item("Docs pass", { number: 13 });
  const { peer } = await mountApp(
    "/chief/c-carl",
    runtimeFixture({
      chiefs: [appChief],
      workspaces: [workspace("c-carl", { kind: "chief", title: "Carl" })],
      board: {
        items: [
          item("Keep CI green", { number: 12, done_when: "CI green on main for a week" }),
          docs,
        ],
        change_sets: [],
      },
    }),
  );
  peer.on("chief.items.update", () => docs);
  // The Work panel is there but closed, as a messenger opens (Chief.tsx).
  const toggle = page.getByRole("button", { name: /^(Show|Hide) panel$/ }).first();
  await expect.element(toggle).toBeVisible();
  if (toggle.element().getAttribute("aria-label") === "Show panel") await toggle.click();
  await expect
    .element(page.getByText("Done when CI green on main for a week", { exact: true }))
    .toBeVisible();
  const row = page.getByRole("group", { name: /^CAR-13 Docs pass/ });
  await userEvent.click(row, { button: "right", position: { x: 120, y: 12 } });
  const set = page.getByRole("menuitem", { name: "Set done when…" });
  await expect.element(set).toBeVisible();
  // Where the pointer was, inside the window, though the row sits in the side panel's scroller.
  const at = row.element().getBoundingClientRect();
  const menu = page.getByRole("menu").element().getBoundingClientRect();
  expect(Math.abs(menu.left - (at.left + 120))).toBeLessThan(4);
  expect(menu.right).toBeLessThanOrEqual(window.innerWidth);
  await userEvent.click(set);
  const field = page.getByRole("textbox", { name: "Done when" });
  await expect.element(field).toHaveFocus();
  await userEvent.fill(field, "The 2.0 docs are live");
  await userEvent.keyboard("{Enter}");
  expect((await peer.nextCall("chief.items.update")).params).toMatchObject({
    item_id: "Docs pass",
    done_when: "The 2.0 docs are live",
  });
  await expect
    .element(page.getByText("Done when The 2.0 docs are live", { exact: true }))
    .toBeVisible();
  // Back on its row, for the list's keys.
  await expect.element(row).toHaveFocus();
});

test("home board route loads without Chief transcript", async () => {
  await mountApp(
    "/chief/board",
    runtimeFixture({ chiefs: [chief("home", "Chief", { home: true })] }),
  );
  await expect.element(board().getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect.element(board().getByText("Nothing on the board")).toBeVisible();
  await expect
    .element(board().getByRole("link", { name: "Chat", exact: true }))
    .toHaveAttribute("href", "#/chief");
});

test("on a phone, the board's bar opens the sidebar drawer, so another Chief's board is a menu away", async () => {
  await page.viewport(390, 844);
  try {
    await mountApp(
      "/chief/c-carl/board",
      runtimeFixture({ chiefs: [appChief, libChief], projects: [PROJECT, lib] }),
    );
    await expect
      .element(board().getByRole("heading", { name: "Board", exact: true }))
      .toBeVisible();
    await userEvent.click(board().getByRole("button", { name: "Open the sidebar" }));
    await openBoard("Ugg");
    await expect.poll(() => window.location.hash).toBe("#/chief/c-ugg/board");
    await expect.element(board().getByRole("button", { name: "Open the sidebar" })).toBeVisible();
  } finally {
    await page.viewport(1400, 900);
  }
});

test("a Chief removed while its board is open leaves the board for home, as its chat does", async () => {
  const { peer } = await mountApp(
    "/chief/c-carl/board",
    runtimeFixture({ chiefs: [chief("home", "Chief", { home: true }), appChief] }),
  );
  await expect.element(board().getByText("Nothing on the board")).toBeVisible();
  peer.notify("chief.list.updated", { chiefs: [chief("home", "Chief", { home: true })] });
  await expect.poll(() => window.location.hash).toBe("#/chief");
  await expect.element(board()).not.toBeInTheDocument();
});
