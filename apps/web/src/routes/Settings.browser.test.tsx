// Opening Settings from the app, in Chromium, against the scripted runtime: its sections, a change saved to the
// runtime, and the way back to the chat.
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { exchange, runtimeFixture, workspace } from "../../test/fixtures.ts";

const chat = () =>
  runtimeFixture({
    workspaces: [workspace("ws-1", { title: "Fix the login redirect" })],
    events: {
      "ws-1": exchange(
        "t1",
        "Why does login redirect twice?",
        "Because the guard runs on both routes.",
      ),
    },
  });

const sections = () => page.getByRole("complementary", { name: "Settings sections" });

async function openSettings() {
  const app = await mountApp("/w/ws-1", chat());
  await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
  await userEvent.click(
    page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Settings" }),
  );
  await expect.element(page.getByRole("heading", { level: 1, name: "General" })).toBeVisible();
  return app;
}

test("the sidebar's Settings opens General with every section listed, a section opens, and Back returns to the chat", async () => {
  await openSettings();
  // Settings takes the window: the app's sidebar and chat step out of the way, and of the accessibility tree.
  await expect
    .element(page.getByRole("complementary", { name: "Sidebar" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("log")).not.toBeInTheDocument();
  await expect
    .element(sections().getByRole("link", { name: "General" }))
    .toHaveAttribute("aria-current", "page");
  for (const name of [
    "Account",
    "Appearance",
    "Keyboard",
    "Models & keys",
    "Projects",
    "Archived chats",
  ]) {
    await expect.element(sections().getByRole("link", { name })).toBeVisible();
  }

  await userEvent.click(sections().getByRole("link", { name: "Appearance" }));
  await expect.element(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  await expect
    .element(sections().getByRole("link", { name: "Appearance" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(sections().getByRole("link", { name: "General" }))
    .not.toHaveAttribute("aria-current");

  await userEvent.click(sections().getByRole("link", { name: "Back to app" }));
  await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
  await expect.element(sections()).not.toBeInTheDocument();
  await expect.element(page.getByRole("combobox", { name: "Message" })).toBeVisible();
});

test("a setting changed in General is saved to the runtime and shown at once", async () => {
  const { peer } = await openSettings();
  const permissions = page.getByRole("combobox", { name: "Permissions for new chats" });
  await expect.element(permissions).toHaveTextContent("Full access");
  const save = peer.hold("settings.set");
  await userEvent.click(permissions);
  await expect
    .element(page.getByRole("option", { name: "Full access" }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.click(page.getByRole("option", { name: "Supervised" }));

  const { params } = await save.call;
  expect(params.settings).toEqual({ default_access: "ask" });
  // Shown before the runtime answers, and kept once it does.
  await expect.element(permissions).toHaveTextContent("Supervised");
  save.answer({ ...peer.fixture.settings, default_access: "ask" });
  await expect.element(permissions).toHaveTextContent("Supervised");
  await expect.element(permissions).toHaveFocus();
});
