// The composer in a chat, in Chromium, against the scripted runtime: typing, the `/` and `@` menus, sending, and
// steering a turn that is running.
import { describe, expect, test } from "vitest";
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

const messageBox = () => page.getByRole("combobox", { name: "Message" });

/** Opens the chat and waits for its transcript, so the box belongs to a chat that has loaded. */
async function openChat() {
  const app = await mountApp("/w/ws-1", chat());
  await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();
  await userEvent.click(messageBox());
  return app;
}

describe("sending", () => {
  test("Enter sends what was typed as the chat's next turn, shows it at once and empties the box", async () => {
    const { peer } = await openChat();
    const submit = peer.hold("turn.submit");
    await userEvent.keyboard("Add a test for the redirect");
    await expect.element(messageBox()).toHaveValue("Add a test for the redirect");
    await expect.element(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await userEvent.keyboard("{Enter}");
    const { params } = await submit.call;
    expect(params).toMatchObject({
      session_id: "s-ws-1",
      kind: "followup",
      input: { text: "Add a test for the redirect" },
    });
    // Before the runtime answers: the message is in the thread and the box is empty, ready for the next one.
    await expect
      .element(page.getByRole("log").getByText("Add a test for the redirect"))
      .toBeVisible();
    await expect.element(messageBox()).toHaveValue("");
    submit.answer({ turn_id: "t2", disposition: "started" });
    await expect.element(messageBox()).toHaveFocus();
  });

  test("Shift+Enter starts a new line instead of sending", async () => {
    const { peer } = await openChat();
    await userEvent.keyboard("First line{Shift>}{Enter}{/Shift}Second line");
    await expect.element(messageBox()).toHaveValue("First line\nSecond line");
    expect(peer.callsOf("turn.submit")).toEqual([]);
  });

  test("a message the runtime refuses comes back into the box, with the reason", async () => {
    const { peer } = await openChat();
    const submit = peer.hold("turn.submit");
    await userEvent.keyboard("Ship it{Enter}");
    await submit.call;
    submit.refuse("engine_unavailable", "Caveman is not signed in.");
    await expect.element(messageBox()).toHaveValue("Ship it");
    await expect.element(page.getByText("Caveman is not signed in.")).toBeVisible();
  });
});

describe("the / menu", () => {
  test("lists commands as you type, follows the arrow keys, and Escape closes it keeping the text", async () => {
    await openChat();
    await userEvent.keyboard("/");
    const menu = page.getByRole("listbox", { name: "Commands and skills" });
    await expect.element(menu).toBeVisible();
    await expect.element(messageBox()).toHaveAttribute("aria-expanded", "true");
    // The first command is the selected one, and the box says so to assistive tech.
    const first = menu.getByRole("option").first();
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    await expect.element(messageBox()).toHaveAttribute("aria-activedescendant", first.element().id);

    // Typing narrows the list; the best match leads, selected.
    await userEvent.keyboard("ren");
    await expect.element(menu.getByRole("option").first()).toHaveAccessibleName(/^\/rename/);
    await expect.element(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect.element(menu.getByRole("option", { name: /^\/model/ })).not.toBeInTheDocument();

    await userEvent.keyboard("{Backspace}{Backspace}{Backspace}");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(menu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect.element(first).toHaveAttribute("aria-selected", "false");

    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
    await expect.element(messageBox()).toHaveAttribute("aria-expanded", "false");
    await expect.element(messageBox()).toHaveValue("/");
    await expect.element(messageBox()).toHaveFocus();
  });

  test("Enter on a command that takes words puts it in the box to finish", async () => {
    const { peer } = await openChat();
    await userEvent.keyboard("/rena{Enter}");
    await expect.element(messageBox()).toHaveValue("/rename ");
    await expect
      .element(page.getByRole("listbox", { name: "Commands and skills" }))
      .not.toBeInTheDocument();
    expect(peer.callsOf("turn.submit")).toEqual([]);
  });
});

describe("the @ menu", () => {
  test("finds the checkout's files by name and adds the picked one to the message", async () => {
    const { peer } = await openChat();
    await userEvent.keyboard("Look at @login");
    const menu = page.getByRole("listbox", { name: "Add to this message" });
    await expect.element(menu.getByRole("option", { name: /^login\.ts src/ })).toBeVisible();
    await expect.element(menu.getByRole("option", { name: /^login\.test\.ts src/ })).toBeVisible();
    // What was typed after @ is what the runtime was asked for.
    await expect
      .poll(() =>
        peer
          .callsOf("fs.search")
          .some((c) => c.params.workspace_id === "ws-1" && c.params.query === "login"),
      )
      .toBe(true);

    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect.element(menu).not.toBeInTheDocument();
    await expect.element(messageBox()).toHaveValue("Look at @src/login.test.ts ");

    const submit = peer.hold("turn.submit");
    await userEvent.keyboard("please{Enter}");
    const { params } = await submit.call;
    expect(params.input.text).toContain("src/login.test.ts");
    submit.answer({ turn_id: "t2", disposition: "started" });
  });
});

describe("while a turn runs", () => {
  test("the box steers the running turn, and Stop interrupts it", async () => {
    const { peer } = await openChat();
    peer.emit(
      "ws-1",
      { type: "turn.started", turn_id: "t2", payload: { engine: "caveman" } },
      {
        type: "message.done",
        turn_id: "t2",
        item_id: "t2-ask",
        payload: { role: "user", text: "Fix it then" },
      },
      {
        type: "message.delta",
        turn_id: "t2",
        item_id: "t2-answer",
        payload: { text: "Looking at the guard" },
      },
    );
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect
      .element(messageBox())
      .toHaveAttribute("placeholder", expect.stringMatching(/^Steer/));

    await userEvent.keyboard("Only touch the login route");
    const steer = page.getByRole("button", { name: "Steer", exact: true });
    await expect.element(steer).toBeEnabled();
    const submit = peer.hold("turn.submit");
    await userEvent.keyboard("{Enter}");
    const { params } = await submit.call;
    expect(params).toMatchObject({
      session_id: "s-ws-1",
      kind: "steer",
      input: { text: "Only touch the login route" },
    });
    submit.answer({ turn_id: "t2", disposition: "steered" });
    await expect.element(messageBox()).toHaveValue("");

    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    const stop = await peer.nextCall("turn.interrupt");
    expect(stop.params.session_id).toBe("s-ws-1");
    peer.emit("ws-1", { type: "turn.done", turn_id: "t2", payload: { status: "interrupted" } });
    await expect.element(page.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Send", exact: true }))
      .toBeInTheDocument();
  });
});
