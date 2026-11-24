// New chat in an empty pane of the split view: the chat it makes lands in that pane, in the tab the message was sent
// from, though the person may be in another tab by the time workspace.create answers; when the pane is gone by then,
// it opens as any new chat does.
import { document } from "../shell/dom.test-support.ts";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, test } from "vitest";
import { panes, windowTabs } from "../panes/store.ts";
import { EMPTY, insert, leaves, newPane, show } from "../panes/tree.ts";
import { RuntimeFixture } from "../state/runtime.tsx";
import { keydown, mount, settle, type } from "../shell/dom.test-support.ts";
import { NewChat } from "./NewChat.tsx";

function Where() {
  const { pathname } = useLocation();
  return createElement("output", { "data-where": "" }, pathname);
}

/** A new tab in front: `chat` in p1 and ⌘D's empty pane, p2, beside it. Answers the tab's id. */
function tabWithEmptyPane(chat: string): string {
  const one = show(EMPTY, chat);
  windowTabs.open(`/w/${chat}`, insert(one, "p1", "right", newPane(one, null)));
  return windowTabs.get().active;
}

const chatsIn = (tab: string) =>
  leaves(windowTabs.get().list.find((t) => t.id === tab)!.layout.root).map((p) => [
    p.id,
    p.workspaceId,
  ]);

/** The empty pane's New chat, its message sent: `made` answers workspace.create with the chat's id. */
async function send() {
  let made: (id: string) => void = () => undefined;
  const client = {
    call: (method: string) =>
      method === "workspace.create"
        ? new Promise((resolve) => (made = (id) => resolve({ id })))
        : Promise.reject(new Error(`${method} is not part of this test`)),
    on: () => () => undefined,
  };
  const engine = {
    id: "caveman",
    label: "Caveman",
    capabilities: {},
    models: [{ id: "opus", label: "Opus 5.5", efforts: [] }],
    auth: { state: "api_key", accounts: [] },
  };
  const value = {
    status: "connected",
    error: null,
    client,
    connection: 1,
    identity: { userName: "Ada", computerName: "Ada's Mac" },
    workspaces: [],
    raw: new Map(),
    projects: [{ id: "p1", name: "acme", path: "/code/acme" }],
    engines: [engine],
    settings: { default_engine: "caveman", engines: {}, favorite_models: [] },
    refresh: async () => undefined,
    adopt: () => undefined,
  } as never;
  const view = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        TooltipProvider,
        null,
        createElement(RuntimeFixture, {
          value,
          children: [
            createElement(NewChat, { key: "chat", pane: "p2", autoFocus: false }),
            createElement(Where, { key: "where" }),
          ],
        }),
      ),
    ),
  );
  await settle();
  const box = document.querySelector("textarea")!;
  await type(box, "Add a health check endpoint");
  await keydown(box, { key: "Enter", keyCode: 13, isComposing: false });
  await settle();
  return {
    made: async (id: string) => {
      made(id);
      await settle();
    },
    where: () => document.querySelector("[data-where]")!,
    ...view,
  };
}

test("the chat lands in the empty pane it was sent from, though the person went to another tab while it was made", async () => {
  const sentFrom = tabWithEmptyPane("a");
  const other = show(EMPTY, "x");
  windowTabs.open("/w/x", insert(other, "p1", "right", newPane(other, "y")));
  const behind = windowTabs.get().active;
  windowTabs.activate(sentFrom);

  const chat = await send();
  // ⌘2 while workspace.create runs: the other split, whose second pane is p2 too, comes to the front.
  windowTabs.activate(behind);
  await chat.made("fresh");
  expect(chatsIn(behind)).toEqual([
    ["p1", "x"],
    ["p2", "y"],
  ]);
  expect(windowTabs.get().active).toBe(behind);
  expect(chatsIn(sentFrom)).toEqual([
    ["p1", "a"],
    ["p2", "fresh"],
  ]);
  // It landed in its pane: no page opened over the tab in front.
  expect(chat.where().textContent).toBe("/");
  await chat.unmount();
});

test("a chat whose empty pane was closed while it was made opens as a new chat does", async () => {
  const tab = tabWithEmptyPane("b");
  const chat = await send();
  panes.close("p2");
  await chat.made("made-after-close");
  expect(chat.where().textContent).toBe("/w/made-after-close");
  // In its pane before the route shows the panes (tree.place: the one pane on screen takes it), so the pane never
  // holds the chat it showed before while this one loads.
  expect(chatsIn(tab)).toEqual([["p1", "made-after-close"]]);
  await chat.unmount();
});
