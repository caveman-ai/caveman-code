// The Chief's /clear, in Chromium against the scripted runtime: the "/" menu in its box offers it, running it clears
// the page to a fresh section headed with today and the time (no note goes to the Chief), what comes next shows under
// it, the page opens cleared again, and Show earlier brings the earlier conversation back. Without /clear, a note
// goes as before.
import type { ChiefProfile } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { chief, exchange, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";

const appChief: ChiefProfile = chief("c-app", "app", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});
const fixture = () =>
  runtimeFixture({
    chiefs: [appChief],
    projects: [PROJECT],
    workspaces: [workspace("c-app", { kind: "chief" })],
    events: {
      "c-app": exchange(
        "t1",
        "Plan the login fix",
        "Two chats: one for the guard, one for the test.",
      ),
    },
  });

const box = () => page.getByRole("combobox", { name: "Message" });
const log = () => page.getByRole("log");
const OLD = "Two chats: one for the guard, one for the test.";

async function openChief() {
  const app = await mountApp("/chief/c-app", fixture());
  await expect.element(page.getByText(OLD)).toBeVisible();
  await userEvent.click(box());
  return app;
}

describe("the Chief's /clear", () => {
  test("the / menu in its box offers only /clear", async () => {
    await openChief();
    await userEvent.keyboard("/");
    const menu = page.getByRole("listbox", { name: "Commands and skills" });
    await expect.element(menu).toBeVisible();
    expect(
      menu
        .getByRole("option")
        .all()
        .map((o) => o.element().textContent),
    ).toEqual([expect.stringMatching(/^\/clear/)]);
    // A "/" no command answers is just the start of a note.
    await userEvent.keyboard("tmp");
    await expect.element(menu).not.toBeInTheDocument();
  });

  test("clears the page to a fresh section headed Today and the time; it stays cleared when reopened, and Show earlier brings the rest back", async () => {
    const { peer } = await openChief();
    await userEvent.keyboard("/clear{Enter}");
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();
    const heading = page.getByRole("note").filter({ hasText: /^Today .+, \d{1,2}:\d{2}/ });
    await expect.element(heading).toBeVisible();
    await expect.element(box()).toHaveValue("");
    expect(peer.callsOf("chief.capture")).toEqual([]);

    peer.emit("c-app", ...exchange("t2", "Next task", "Fresh reply"));
    await expect.element(log().getByText("Fresh reply")).toBeVisible();
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();

    // Away and back: the page opens on the fresh section.
    window.location.hash = "#/new";
    await expect.element(page.getByPlaceholder(/^Describe a task/)).toBeVisible();
    window.location.hash = "#/chief/c-app";
    await expect.element(heading).toBeVisible();
    await expect.element(page.getByText(OLD)).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Show earlier" }));
    await expect.element(log().getByText(OLD)).toBeVisible();
    await expect.element(log().getByText("Fresh reply")).toBeVisible();

    await userEvent.click(box());
    await userEvent.keyboard("/clear{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Run /clear" }));
    await expect.element(log().getByText("Fresh reply")).not.toBeInTheDocument();
    await expect.element(heading).toBeVisible();
  });

  test("an empty Chief can start a fresh section too", async () => {
    await mountApp("/chief/c-app", { ...fixture(), events: {} });
    await userEvent.click(box());
    await userEvent.keyboard("/clear");
    await expect
      .element(page.getByRole("option").filter({ hasText: "/clear" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("note").filter({ hasText: /^Today .+, \d{1,2}:\d{2}/ }))
      .toBeVisible();
    expect(
      Object.keys(localStorage).some((key) => key.startsWith("caveman.chief.cleared.v2.")),
    ).toBe(true);
  });

  test("a note is sent as before, /clear in the middle of it too", async () => {
    const { peer } = await openChief();
    const capture = peer.hold("chief.capture");
    await userEvent.keyboard("Tell me where /clear went{Enter}");
    const { params } = await capture.call;
    expect(params).toMatchObject({ text: "Tell me where /clear went" });
    await expect.element(page.getByText(OLD)).toBeVisible();
  });
});
