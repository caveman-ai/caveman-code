// The sidebar by topic, in Chromium, against the scripted runtime: a group shows its live chats and folds what is
// over; a group with nothing live sits in Closed groups at the column's foot; × closes one, Reopen brings it back.
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { runtimeFixture, workspace } from "../../test/fixtures.ts";
import { PeerError } from "../../test/session-peer.ts";

const sidebar = () => page.getByRole("complementary", { name: "Sidebar" });

async function byTopic() {
  await userEvent.click(sidebar().getByRole("button", { name: /^Chat list options/ }));
  await userEvent.hover(page.getByRole("menuitem", { name: /Group by/ }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Topic" }));
  await userEvent.keyboard("{Escape}");
}

test("a group folds what is over, closes when nothing in it is live, and comes back with Reopen", async () => {
  const done = new Date(Date.now() - 3_600_000).toISOString();
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-a1", {
          title: "Fix the login redirect",
          status: "working",
          topic: "Auth Flow",
          topic_icon: "🔐",
        }),
        workspace("ws-a2", {
          title: "Session cookie audit",
          topic: "Auth Flow",
          topic_icon: "🔐",
          inbox: { done_at: done },
        }),
        workspace("ws-b1", {
          title: "Pricing page copy",
          topic: "Billing Redesign",
          topic_icon: "💳",
          inbox: { done_at: done },
        }),
        workspace("ws-b2", {
          title: "Seat math",
          topic: "Billing Redesign",
          topic_icon: "💳",
          inbox: { done_at: done },
        }),
        workspace("ws-loose", { title: "Quick question", inbox: { done_at: done } }),
      ],
    }),
  );
  await byTopic();
  const list = sidebar().getByRole("region", { name: "Chats" });
  // Auth Flow is open with its working chat; its done one is folded behind one line.
  await expect.element(list.getByRole("button", { name: "Auth Flow" })).toBeVisible();
  await expect.element(list.getByRole("button", { name: /🔐/ })).toBeVisible();
  await expect.element(list.getByText("Fix the login redirect")).toBeVisible();
  await expect.element(list.getByRole("button", { name: /^1 done/ })).toBeVisible();
  expect(list.getByText("Session cookie audit").query()).toBeNull();
  // Billing Redesign has nothing live: it waits in Closed groups, and the loose done chat on the Done shelf.
  expect(list.getByRole("button", { name: "Billing Redesign" }).query()).toBeNull();
  const closedGroups = sidebar().getByRole("region", { name: "Closed groups" });
  await expect.element(closedGroups).toBeVisible();
  await expect.element(sidebar().getByRole("region", { name: "Done" })).toBeVisible();

  // Reopen brings Billing Redesign back into the list, and its chats are not done any more: live again in it.
  await userEvent.click(sidebar().getByRole("button", { name: "Closed groups" }));
  await userEvent.click(closedGroups.getByRole("button", { name: "Reopen Billing Redesign" }));
  await expect.element(list.getByRole("button", { name: "Billing Redesign" })).toBeVisible();
  await expect.poll(() => peer.workspace("ws-b1").inbox?.done_at).toBeUndefined();
  await expect.element(list.getByText("Seat math")).toBeVisible();

  // × on Auth Flow asks first: its chat still works. Closing marks its chats done, and it goes to Closed groups.
  await userEvent.hover(list.getByRole("button", { name: "Auth Flow" }));
  await userEvent.click(list.getByRole("button", { name: "Close Auth Flow" }));
  await expect.element(page.getByText("Close Auth Flow?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Close group" }));
  await expect.poll(() => peer.workspace("ws-a1").inbox?.done_at).toBeTruthy();
  await expect.poll(() => list.getByRole("button", { name: "Auth Flow" }).query()).toBeNull();
  await expect.element(closedGroups.getByRole("button", { name: /^Auth Flow/ })).toBeVisible();
});

test("a group's emoji is picked for the whole group", async () => {
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-1", { title: "Relay drops", status: "working", topic: "Relay" }),
        workspace("ws-2", { title: "Relay retries", status: "working", topic: "Relay" }),
      ],
    }),
  );
  await byTopic();
  await userEvent.click(sidebar().getByRole("button", { name: "Pick an emoji for Relay" }));
  await userEvent.click(page.getByRole("button", { name: "🚀" }));
  await expect
    .poll(() => [peer.workspace("ws-1").topic_icon, peer.workspace("ws-2").topic_icon])
    .toEqual(["🚀", "🚀"]);
  await expect.element(sidebar().getByRole("button", { name: /Relay's emoji, 🚀/ })).toBeVisible();
});

test("× closes a group whose chat has a finished agent under it, marking the agent done too", async () => {
  const done = new Date(Date.now() - 3_600_000).toISOString();
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-login", { title: "Login", topic: "Auth", topic_icon: "🔐" }),
        workspace("ws-audit", { title: "Audit", parent_workspace_id: "ws-login" }),
        workspace("ws-cookies", {
          title: "Cookies",
          topic: "Auth",
          topic_icon: "🔐",
          inbox: { done_at: done },
        }),
        // Pinned, it sits in Pinned, not in the group: closing the group leaves it.
        workspace("ws-pinned", {
          title: "Token rotation",
          topic: "Auth",
          topic_icon: "🔐",
          inbox: { pinned_at: done },
        }),
      ],
    }),
  );
  await byTopic();
  const list = sidebar().getByRole("region", { name: "Chats" });
  await userEvent.hover(list.getByRole("button", { name: "Auth" }));
  await userEvent.click(list.getByRole("button", { name: "Close Auth" }));
  await expect
    .poll(() =>
      [peer.workspace("ws-login").inbox?.done_at, peer.workspace("ws-audit").inbox?.done_at].every(
        Boolean,
      ),
    )
    .toBe(true);
  await expect.poll(() => list.getByRole("button", { name: "Auth" }).query()).toBeNull();
  await expect.element(sidebar().getByRole("region", { name: "Closed groups" })).toBeVisible();
  expect(peer.workspace("ws-pinned").inbox).toEqual({ pinned_at: done });
});

test("a chat dragged out of a closed group leaves its group", async () => {
  const done = new Date(Date.now() - 3_600_000).toISOString();
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-live", { title: "Fix the login redirect", status: "working" }),
        workspace("ws-b1", {
          title: "Pricing page copy",
          topic: "Billing Redesign",
          inbox: { done_at: done },
        }),
        workspace("ws-b2", { title: "Seat math", topic: "Billing Redesign", inbox: { done_at: done } }),
      ],
    }),
  );
  await byTopic();
  const closedGroups = sidebar().getByRole("region", { name: "Closed groups" });
  await userEvent.click(sidebar().getByRole("button", { name: "Closed groups" }));
  await userEvent.click(closedGroups.getByRole("button", { name: /^Billing Redesign/ }));
  const row = closedGroups.getByRole("button", { name: "Seat math", exact: true });
  await expect.element(row).toBeVisible();
  // The sidebar's drag is the pointer's own (panes/drag.ts): down on the row, a move that starts the drag (Pinned's
  // drop row opens above the list and moves it down), then over the loose chat's lower edge where it now is, and up.
  const pointer = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
      }),
    );
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const from = row.element().getBoundingClientRect();
  pointer(row.element(), "pointerdown", from.x + 20, from.y + from.height / 2);
  pointer(window, "pointermove", from.x + 20, from.y - 20);
  await frame();
  await frame();
  const to = sidebar()
    .getByRole("button", { name: "Fix the login redirect Working" })
    .element()
    .getBoundingClientRect();
  pointer(window, "pointermove", to.x + 20, to.y + to.height * 0.9);
  await frame();
  pointer(window, "pointerup", to.x + 20, to.y + to.height * 0.9);
  await expect.poll(() => peer.workspace("ws-b2").topic).toBeUndefined();
  expect(peer.workspace("ws-b1").topic).toBe("Billing Redesign");
});

test("a pinned group renamed stays pinned and open under its new name", async () => {
  const done = new Date(Date.now() - 3_600_000).toISOString();
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-1", {
          title: "Pricing page copy",
          topic: "Billing Redesign",
          inbox: { done_at: done },
        }),
        workspace("ws-2", { title: "Seat math", topic: "Billing Redesign", inbox: { done_at: done } }),
      ],
    }),
  );
  await byTopic();
  const list = sidebar().getByRole("region", { name: "Chats" });
  // Nothing in it is live: closed, until pinned.
  await userEvent.click(sidebar().getByRole("button", { name: "Closed groups" }));
  await userEvent.click(
    sidebar()
      .getByRole("region", { name: "Closed groups" })
      .getByRole("button", { name: "Reopen Billing Redesign" }),
  );
  await userEvent.click(list.getByRole("button", { name: "Billing Redesign options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Pin to the top" }));
  await userEvent.click(list.getByRole("button", { name: "Billing Redesign options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Rename" }));
  await userEvent.fill(list.getByRole("textbox", { name: "Group name" }), "Pricing");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => [peer.workspace("ws-1").topic, peer.workspace("ws-2").topic])
    .toEqual(["Pricing", "Pricing"]);
  // Still on top and pinned under its new name (its heading names it so).
  await expect.element(list.getByRole("button", { name: "Pricing Pinned" })).toBeVisible();
  // Pinned under both names while its chats moved; once they all have, under the new one alone.
  await expect
    .poll(() => JSON.parse(localStorage.getItem("caveman.topicMarks") ?? "{}"))
    .toMatchObject({ pinned: ["Pricing"] });
});

test("a rename that moves only some of a pinned group's chats keeps the pin on both halves", async () => {
  const { peer } = await mountApp(
    "/new",
    runtimeFixture({
      workspaces: [
        workspace("ws-1", { title: "Pricing page copy", status: "working", topic: "Billing Redesign" }),
        workspace("ws-2", { title: "Seat math", status: "working", topic: "Billing Redesign" }),
        workspace("ws-3", { title: "Annual discount", status: "working", topic: "Billing Redesign" }),
      ],
    }),
  );
  // The runtime takes the new name for two of the chats and refuses the third.
  peer.on("workspace.topic", (p) => {
    if (p.workspace_id === "ws-3")
      throw new PeerError("invalid_state", "Its engine thread is busy.");
    return peer.change(p.workspace_id, p.topic === null ? {} : { topic: p.topic });
  });
  await byTopic();
  const list = sidebar().getByRole("region", { name: "Chats" });
  await userEvent.click(list.getByRole("button", { name: "Billing Redesign options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Pin to the top" }));
  await userEvent.click(list.getByRole("button", { name: "Billing Redesign options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Rename" }));
  await userEvent.fill(list.getByRole("textbox", { name: "Group name" }), "Pricing");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => [
      peer.workspace("ws-1").topic,
      peer.workspace("ws-2").topic,
      peer.workspace("ws-3").topic,
    ])
    .toEqual(["Pricing", "Pricing", "Billing Redesign"]);
  // The refusal is said once the rename has settled what it moved: everything after reads the settled state.
  await expect
    .poll(() =>
      [...document.querySelectorAll("[role=status]")].some((n) =>
        n.textContent?.includes("Its engine thread is busy."),
      ),
    )
    .toBe(true);
  // The two that moved are a pinned group under the new name; the old name, with the one that stayed, keeps its pin.
  await expect.element(list.getByRole("button", { name: "Pricing Pinned" })).toBeVisible();
  await expect
    .poll(() => JSON.parse(localStorage.getItem("caveman.topicMarks") ?? "{}").pinned)
    .toEqual(expect.arrayContaining(["Billing Redesign", "Pricing"]));
});
