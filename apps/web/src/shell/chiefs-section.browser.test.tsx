// The sidebar's Chiefs, in Chromium against the scripted runtime: a section of their own above Projects, a row per Chief as a messenger lists a conversation: its name, when it last spoke, and "Working", its
// last reply or "No messages yet" under them. A click opens its page and fills the row; the amber dot says something
// of its waits on you; + makes a blank or ready-made Chief and opens it at its name; ⋯ hides the list, kept on this
// device.
import type { ChiefItem, Workspace } from "@caveman-app/session-protocol";
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { AT, chief, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";
import { windowTabs } from "../panes/store.ts";
import { CHIEF_TEMPLATES } from "./chief-templates.ts";

// ⌘-click opens a tab of its own in the desktop app; Chromium here is no desktop.
vi.mock("./tab-nav.ts", async (original) => ({
  ...(await original<typeof import("./tab-nav.ts")>()),
  wantsNewTab: (e: { button: number; metaKey: boolean; ctrlKey: boolean }) =>
    e.button === 1 || e.metaKey || e.ctrlKey,
}));

/** A Chief made 2026-11-15 to 17, with the one project it had; chief.get with nothing named answers it. */
const carl = chief("c-carl", "Carl", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});
/** A Chief that works in every project. */
const ada = chief("c-ada", "Ada");
/** Carl's own conversation (a Chief's workspace has its id), as workspace.get and workspace.changed carry it. */
const carlChat = (over: Partial<Workspace> = {}) =>
  workspace(carl.id, { kind: "chief", title: carl.name, ...over });
const item = (id: string, over: Partial<ChiefItem>): ChiefItem => ({
  id,
  chief_id: carl.id,
  text: id,
  state: "started",
  rank: 1,
  pinned: false,
  project_ids: [PROJECT.id],
  source: "composer",
  workspace_ids: [],
  created_at: AT,
  updated_at: AT,
  ...over,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });
const chiefs = () => sidebar().getByRole("region", { name: "Chiefs" });
/** A Chief's row, by its accessible name: its name, then ", working" or ", N need you". */
const chiefRow = (name: string) => chiefs().getByRole("link", { name, exact: true });
const rowNames = () =>
  chiefs()
    .getByRole("link")
    .elements()
    .map((el) => el.getAttribute("aria-label"));
/** When a Chief last spoke, at its row's right. */
const when = (name: string) => chiefRow(name).element().querySelector(".tabular-nums")?.textContent;
/** The amber dot at the end of a Chief's line. */
const dot = (name: string) => chiefRow(name).element().querySelector(".bg-warning");

test("lists each Chief above the projects: its name, when it last spoke, and its last reply, else No messages yet", async () => {
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      chiefs: [carl, ada],
      workspaces: [
        workspace("ws-1", { title: "Fix the login redirect" }),
        carlChat({
          activity: {
            last_reply: "Merged the login fix.",
            turn_started_at: minutesAgo(9),
            turn_ended_at: minutesAgo(5),
          },
        }),
      ],
    }),
  );
  await expect.element(chiefRow("Carl")).toBeVisible();
  await expect.element(chiefRow("Ada")).toBeVisible();
  // In the runtime's order, in a section of their own above Projects; neither is a row in a project.
  expect(rowNames()).toEqual(["Carl", "Ada"]);
  const top = (el: Element) => el.getBoundingClientRect().top;
  expect(top(chiefs().element())).toBeLessThan(
    top(sidebar().getByRole("heading", { name: "Projects", exact: true }).element()),
  );
  expect(
    sidebar().getByRole("button", { name: "app", exact: true }).element().closest("section"),
  ).not.toBe(chiefs().element());

  // Carl's last reply, dated by its last turn; Ada has said nothing yet. Each is read by its workspace's id.
  await expect
    .element(chiefRow("Carl"))
    .toHaveAttribute("aria-description", "Merged the login fix.");
  await expect.element(chiefRow("Carl")).toMatchTextContent(/Merged the login fix\.$/);
  expect(when("Carl")).toBe("5m");
  await expect.element(chiefRow("Ada")).toHaveAttribute("aria-description", "No messages yet");
  await expect.element(chiefRow("Ada")).toMatchTextContent(/No messages yet$/);
  const read = peer.callsOf("workspace.get").map((c) => c.params.workspace_id);
  expect(read).toContain(carl.id);
  expect(read).toContain(ada.id);
});

test("says Working while its conversation works, then its new reply", async () => {
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      chiefs: [carl, ada],
      workspaces: [workspace("ws-1", { title: "Fix the login redirect" }), carlChat()],
    }),
  );
  await expect.element(chiefRow("Carl")).toHaveAttribute("aria-description", "No messages yet");

  peer.change(carl.id, {
    status: "working",
    activity: { turn_started_at: new Date().toISOString() },
  });
  const working = chiefRow("Carl, working");
  await expect.element(working).toBeVisible();
  expect(working.element().querySelector(".lucy-shimmer")?.textContent).toBe("Working");
  expect(working.element().hasAttribute("aria-description")).toBe(false);
  // Another Chief's conversation is its own.
  await expect.element(chiefRow("Ada")).toHaveAttribute("aria-description", "No messages yet");

  peer.change(carl.id, {
    status: "idle",
    activity: {
      last_reply: "Opened a pull request for the login fix.",
      turn_ended_at: new Date().toISOString(),
    },
  });
  await expect
    .element(chiefRow("Carl"))
    .toHaveAttribute("aria-description", "Opened a pull request for the login fix.");
  expect(when("Carl")).toBe("now");
  expect(chiefRow("Carl").element().querySelector(".lucy-shimmer")).toBeNull();
});

test("a click opens its page and fills its row; ⌘-click opens it in a window tab of its own", async () => {
  await mountApp("/new", runtimeFixture({ chiefs: [carl, ada] }));
  await expect.element(chiefRow("Carl")).toBeVisible();
  await expect.element(chiefRow("Carl")).not.toHaveAttribute("aria-current");

  await userEvent.click(chiefRow("Carl"));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl");
  await expect.element(chiefRow("Carl")).toHaveAttribute("aria-current", "page");
  await expect.element(chiefRow("Ada")).not.toHaveAttribute("aria-current");

  await userEvent.click(chiefRow("Ada"));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-ada");
  await expect.element(chiefRow("Ada")).toHaveAttribute("aria-current", "page");
  await expect.element(chiefRow("Carl")).not.toHaveAttribute("aria-current");

  const before = windowTabs.get().active;
  // The window's tabs outlive the mount: the one opened here closes with the test, so later files start with one.
  const had = new Set(windowTabs.get().list.map((t) => t.id));
  onTestFinished(() => void windowTabs.close((t) => !had.has(t.id)));
  await userEvent.click(chiefRow("Carl"), { modifiers: ["Meta"] });
  await expect.poll(() => window.location.hash).toBe("#/chief/c-carl");
  expect(windowTabs.get().active).not.toBe(before);
  expect(windowTabs.get().list.find((t) => t.id === windowTabs.get().active)?.path).toBe(
    "/chief/c-carl",
  );
});

test("wears the amber dot while a chat it started or an item of its waits on you, and another Chief's lights no other", async () => {
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      chiefs: [carl, ada],
      workspaces: [
        workspace("ws-ask", { title: "Pick a palette", status: "needs_input" }),
        workspace("ws-deps", { title: "Upgrade dependencies" }),
      ],
      board: {
        items: [
          item("i-palette", { workspace_ids: ["ws-ask"] }),
          item("i-deps", { chief_id: ada.id, workspace_ids: ["ws-deps"] }),
        ],
        change_sets: [],
      },
    }),
  );
  // Carl's chat asks: one thing of Carl's waits on you, and Ada's row stays quiet.
  await expect.element(chiefRow("Carl, 1 need you")).toBeVisible();
  expect(dot("Carl, 1 need you")).not.toBeNull();
  await expect.element(chiefRow("Ada")).toBeVisible();
  expect(dot("Ada")).toBeNull();

  // Answered, the chat works again, and the dot goes.
  peer.change("ws-ask", { status: "working" });
  await expect.element(chiefRow("Carl")).toBeVisible();
  expect(dot("Carl")).toBeNull();

  // An item of Ada's needs you with no chat asking (its checks failed): her row says so.
  peer.notify("chief.board.updated", {
    items: [
      item("i-palette", { workspace_ids: ["ws-ask"] }),
      item("i-deps", {
        chief_id: ada.id,
        workspace_ids: ["ws-deps"],
        state: "needs_you",
        detail: "Checks failed",
      }),
    ],
    change_sets: [],
  });
  await expect.element(chiefRow("Ada, 1 need you")).toBeVisible();
  expect(dot("Ada, 1 need you")).not.toBeNull();
  expect(dot("Carl")).toBeNull();
});

test("+ → Blank Chief makes a Chief for every project and opens it at its name; shut, its row is there and filled", async () => {
  const { peer } = await mountApp("/new", runtimeFixture({ chiefs: [carl, ada] }));
  await expect.element(chiefRow("Ada")).toBeVisible();
  await userEvent.click(chiefs().getByRole("button", { name: "New Chief" }));
  // A blank one first, then the ready-made ones, each its name and what it covers.
  const offered = page
    .getByRole("menu")
    .getByRole("menuitem")
    .elements()
    .map((el) => el.textContent);
  expect(offered).toEqual(["Blank Chief", ...CHIEF_TEMPLATES.map((t) => `${t.name}${t.line}`)]);
  await userEvent.click(page.getByRole("menuitem", { name: "Blank Chief" }));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-3?settings=name");
  // Blank leaves everything to the runtime's defaults, as + did before it offered more.
  expect(peer.callsOf("chief.create").map(({ params: { request_id: _, ...p } }) => p)).toEqual([
    {},
  ]);
  // Navigation updates the hash before the lazy page and its dialog are ready for keyboard input.
  const settings = page.getByRole("dialog", { name: "Chief 3 settings" });
  await expect.element(settings).toBeVisible();
  await expect.element(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-3");
  await expect.element(chiefRow("Chief 3")).toHaveAttribute("aria-current", "page");
  expect(rowNames()).toEqual(["Carl", "Ada", "Chief 3"]);
});

test("+ → Maintainer makes the Chief with its name, character, role and soul, opens it at its name, and it greets with its own missions", async () => {
  const listed = [carl, ada];
  const { peer } = await mountApp("/new", runtimeFixture({ chiefs: listed }));
  // The runtime keeps what it is given (Chief.ts make), so its page and greeting read the Maintainer's profile.
  peer.on("chief.create", (p) => {
    const made = chief(`c-${listed.length + 1}`, p.name ?? `Chief ${listed.length + 1}`, {
      ...(p.avatar ? { avatar: p.avatar } : {}),
      ...(p.role ? { role: p.role } : {}),
      ...(p.soul !== undefined ? { soul: p.soul } : {}),
    });
    listed.push(made);
    peer.notify("chief.list.updated", { chiefs: [...listed] });
    return { chief: made };
  });
  const maintainer = CHIEF_TEMPLATES.find((t) => t.id === "maintainer")!;
  await expect.element(chiefRow("Ada")).toBeVisible();

  await userEvent.click(chiefs().getByRole("button", { name: "New Chief" }));
  await userEvent.click(page.getByRole("menuitem", { name: /^Maintainer/ }));
  await expect.poll(() => window.location.hash).toBe("#/chief/c-3?settings=name");
  const [made, ...more] = peer.callsOf("chief.create");
  expect(more).toEqual([]);
  const { request_id: _, ...sent } = made!.params;
  expect(sent).toEqual({
    name: "Maintainer",
    avatar: maintainer.avatar,
    role: maintainer.role,
    soul: maintainer.soul,
  });
  const settings = page.getByRole("dialog", { name: "Maintainer settings" });
  await expect.element(settings).toBeVisible();
  await expect.element(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.poll(() => window.location.hash).toBe("#/chief/c-3");
  await expect.element(chiefRow("Maintainer")).toHaveAttribute("aria-current", "page");
  // Its greeting says its role and offers its three missions, not the starters.
  const hello = page.getByRole("article", { name: "Maintainer says hello" });
  await expect.element(hello).toBeVisible();
  await expect.element(hello.getByText(maintainer.role)).toBeVisible();
  const card = hello.getByRole("button");
  await expect.element(card.first()).toBeVisible();
  expect(card.elements().map((el) => el.textContent)).toEqual(
    maintainer.missions.map((m) => `${m.title}${m.line}`),
  );

  // A second Maintainer takes a free name: the runtime refuses a taken one.
  await userEvent.click(chiefs().getByRole("button", { name: "New Chief" }));
  await userEvent.click(page.getByRole("menuitem", { name: /^Maintainer/ }));
  await expect.poll(() => peer.callsOf("chief.create").length).toBe(2);
  expect(peer.callsOf("chief.create")[1]!.params.name).toBe("Maintainer 2");
});

test("Hide Chiefs folds the list on this device: it stays folded when the app opens again, until Show Chiefs", async () => {
  const fixture = () => runtimeFixture({ chiefs: [carl, ada] });
  const { unmount } = await mountApp("/new", fixture());
  await expect.element(chiefRow("Carl")).toBeVisible();
  await userEvent.click(chiefs().getByRole("button", { name: "Chiefs options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Hide Chiefs" }));
  await expect.element(chiefRow("Carl")).not.toBeInTheDocument();
  expect(chiefRow("Ada").query()).toBeNull();
  // The heading and its keys stay, to make one or show them again.
  await expect.element(chiefs().getByRole("heading", { name: "Chiefs" })).toBeVisible();
  await expect.element(chiefs().getByRole("button", { name: "New Chief" })).toBeVisible();
  expect(localStorage.getItem("caveman.sidebarChiefsFolded")).toBe("1");

  await unmount();
  await mountApp("/new", fixture(), {}, { keepStorage: true });
  await expect.element(chiefs().getByRole("button", { name: "New Chief" })).toBeVisible();
  expect(chiefRow("Carl").query()).toBeNull();

  await userEvent.click(chiefs().getByRole("button", { name: "Chiefs options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show Chiefs" }));
  await expect.element(chiefRow("Carl")).toBeVisible();
  await expect.element(chiefRow("Ada")).toBeVisible();
  expect(localStorage.getItem("caveman.sidebarChiefsFolded")).toBe("0");
});
