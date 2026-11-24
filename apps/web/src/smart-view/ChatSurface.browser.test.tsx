// A chat shown beside the Chief is the chat itself: sends and interrupts address that session, and its draft
// follows it into its own tab. Opening a chat inside its own panel must not recursively mount more panels.
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { CavemanDesktop } from "../../../desktop/src/bridge.ts";
import { createCloseRouter } from "../../../desktop/src/closeRouter.ts";
import { mountApp } from "../../test/app.tsx";
import { RUNTIME_URL } from "../../test/fake-socket.ts";
import {
  chief,
  ENGINE,
  exchange,
  runtimeFixture,
  workspace,
  type RuntimeFixture,
} from "../../test/fixtures.ts";
import { getPanel, getTabs, openSurface } from "../panels/store.ts";
import { panes, windowTabs } from "../panes/store.ts";
import "./surfaces.tsx";

const panel = () => page.getByRole("tabpanel", { name: "Chat", exact: true });
const box = () => panel().getByRole("combobox", { name: "Message" });

async function besideChief(over: Partial<RuntimeFixture> = {}) {
  const profile = chief("c-app", "Chief");
  const app = await mountApp(
    "/chief/c-app",
    runtimeFixture({
      chiefs: [profile],
      workspaces: [
        workspace(profile.id, { kind: "chief", title: "Chief" }),
        workspace("ws-1", { root_path: "/Users/test/code/app" }),
      ],
      events: {
        [profile.id]: exchange("chief-t1", "Show the fix", "Here is the login fix."),
        "ws-1": exchange("t1", "Fix login", "The guard now runs once."),
      },
      ...over,
    }),
  );
  await expect.element(page.getByText("Here is the login fix.")).toBeVisible();
  openSurface(profile.id, "chat", { workspace_id: "ws-1", note: "Review this fix" });
  await expect.element(panel().getByText("The guard now runs once.")).toBeVisible();
  await userEvent.click(box());
  return app;
}

test("send, steer and stop act on the sidebar chat while the Chief stays open", async () => {
  const { peer } = await besideChief();
  await expect.element(panel().getByText("Review this fix")).toBeVisible();
  const submit = peer.hold("turn.submit");
  await userEvent.keyboard("Add a redirect test{Enter}");
  expect((await submit.call).params).toMatchObject({
    session_id: "s-ws-1",
    kind: "followup",
    input: { text: "Add a redirect test" },
  });
  await expect.element(panel().getByRole("log").getByText("Add a redirect test")).toBeVisible();
  await expect.element(box()).toHaveValue("");
  submit.answer({ turn_id: "t2", disposition: "started" });
  peer.emit("ws-1", { type: "turn.started", turn_id: "t2", payload: { engine: "caveman" } });
  await expect.element(panel().getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  const steer = peer.hold("turn.submit");
  await userEvent.keyboard("Only change the test{Enter}");
  expect((await steer.call).params).toMatchObject({
    session_id: "s-ws-1",
    kind: "steer",
    input: { text: "Only change the test" },
  });
  steer.answer({ turn_id: "t2", disposition: "steered" });
  await userEvent.click(panel().getByRole("button", { name: "Stop", exact: true }));
  expect((await peer.nextCall("turn.interrupt")).params.session_id).toBe("s-ws-1");
  peer.emit("ws-1", { type: "turn.done", turn_id: "t2", payload: { status: "interrupted" } });
  await expect
    .element(panel().getByRole("button", { name: "Stop", exact: true }))
    .not.toBeInTheDocument();
  expect(window.location.hash).toBe("#/chief/c-app");
  await expect.element(page.getByText("Here is the login fix.")).toBeVisible();
  expect(peer.callsOf("chief.capture")).toEqual([]);
});

test.each(["sidebar", "pane", "split"] as const)(
  "desktop close closes the chat surface, preserving its host (%s)",
  async (placement) => {
    const detached = placement !== "sidebar";
    const previous = window.cavemanDesktop;
    let closedWindows = 0;
    const close = createCloseRouter(() => closedWindows++);
    window.cavemanDesktop = {
      runtime: { url: RUNTIME_URL, token: "browser-test" },
      onCloseRequest: close.register,
    } as Partial<CavemanDesktop> as CavemanDesktop;
    onTestFinished(() => {
      if (previous) window.cavemanDesktop = previous;
      else delete window.cavemanDesktop;
    });
    await besideChief();
    const tabs = windowTabs.get().list.map((t) => t.id);
    let hostRoot = panes.get().root;
    if (detached) {
      // Exercise both possible hosts explicitly; no earlier test decides whether another chat survives the close.
      panes.set(
        placement === "split"
          ? {
              root: { kind: "pane", id: "existing-chat", workspaceId: "ws-1" },
              focused: "existing-chat",
            }
          : { root: null, focused: null },
      );
      hostRoot = panes.get().root;
      const route = panes.hostTab({ workspaceId: "c-app", id: getPanel("c-app").active! });
      if (route) window.location.hash = `#${route}`;
      await expect
        .element(page.getByRole("button", { name: "Back to the side panel" }))
        .toBeVisible();
      // Hosting can split beside another chat, so both panes can have a Message box. Focus the moved surface.
      const surface = page
        .getByRole("button", { name: "Back to the side panel" })
        .element()
        .closest('[data-tab-pane="chat"]')!;
      await userEvent.click(
        surface.querySelector<HTMLTextAreaElement>('[role="combobox"][aria-label="Message"]')!,
      );
      expect(document.activeElement?.closest("[data-tab-pane]")).toBe(surface);
    }
    close.request();
    await expect.poll(() => getTabs("c-app").some((t) => t.kind === "chat")).toBe(false);
    expect(closedWindows).toBe(0);
    expect(windowTabs.get().list.map((t) => t.id)).toEqual(tabs);
    if (detached) await expect.poll(() => panes.get().root).toEqual(hostRoot);
    else expect(window.location.hash).toBe("#/chief/c-app");
  },
);

test("model choice and draft survive Work and Chat tab switches", async () => {
  const { peer } = await besideChief({
    engines: [
      {
        ...ENGINE,
        models: [...ENGINE.models, { id: "alternate", label: "Alternate", efforts: ["medium"] }],
      },
    ],
  });
  await userEvent.click(panel().getByRole("button", { name: /^Model:/ }));
  await userEvent.keyboard("Alternate");
  await userEvent.click(page.getByRole("option", { name: /Alternate/ }));
  await userEvent.click(box());
  await userEvent.keyboard("Keep this model and draft");
  const draftBox = box().element();
  await userEvent.click(page.getByRole("tab", { name: "Work", exact: true }));
  await expect.element(box()).not.toBeInTheDocument();
  expect(draftBox.isConnected).toBe(true);
  await userEvent.click(page.getByRole("tab", { name: "Chat", exact: true }));
  await expect.element(box()).toHaveValue("Keep this model and draft");
  const submit = peer.hold("turn.submit");
  await userEvent.click(box());
  await userEvent.keyboard("{Enter}");
  expect((await submit.call).params).toMatchObject({
    session_id: "s-ws-1",
    input: { text: "Keep this model and draft" },
    options: { model: "alternate" },
  });
  submit.answer({ turn_id: "t2", disposition: "started" });
});

test("an attachment finishing its read while Work is open survives returning to Chat", async () => {
  const { peer } = await besideChief();
  const read = FileReader.prototype.readAsDataURL;
  let finish: (() => Promise<void>) | undefined;
  const delayed = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
    this: FileReader,
    file,
  ) {
    finish = () =>
      new Promise<void>((resolve) => {
        this.addEventListener("loadend", () => resolve(), { once: true });
        read.call(this, file);
      });
  });
  onTestFinished(() => delayed.mockRestore());
  const data = new DataTransfer();
  data.items.add(new File(["Review the redirect"], "review.txt", { type: "text/plain" }));
  box()
    .element()
    .closest("[data-composer]")!
    .dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  await expect.poll(() => Boolean(finish)).toBe(true);
  await userEvent.click(page.getByRole("tab", { name: "Work", exact: true }));
  await expect.element(box()).not.toBeInTheDocument();
  await finish!();
  await userEvent.click(page.getByRole("tab", { name: "Chat", exact: true }));
  await expect
    .element(panel().getByRole("list", { name: "Attachments" }).getByText("review.txt"))
    .toBeVisible();
  const submit = peer.hold("turn.submit");
  await userEvent.click(box());
  await userEvent.keyboard("Use the attachment{Enter}");
  expect((await submit.call).params.input.attachments).toMatchObject([
    { name: "review.txt", data: btoa("Review the redirect") },
  ]);
  submit.answer({ turn_id: "t2", disposition: "started" });
});

test("a hidden panel does not mark a new reply read until shown", async () => {
  const { peer } = await besideChief();
  const visits = () =>
    peer
      .callsOf("workspace.inbox")
      .filter((c) => c.params.workspace_id === "ws-1" && c.params.action.do === "seen").length;
  await expect.poll(visits).toBeGreaterThan(0);
  await userEvent.click(page.getByRole("button", { name: "Hide panel", exact: true }));
  await expect.element(box()).not.toBeInTheDocument();
  const before = visits();
  const updated = {
    ...peer.workspaces.get("ws-1")!,
    title: "Unread sidebar reply",
    updated_at: "2026-11-09T12:00:00.000Z",
  };
  peer.workspaces.set(updated.id, updated);
  peer.notify("workspace.changed", updated);
  peer.emit("ws-1", {
    type: "message.done",
    item_id: "new-answer",
    payload: { role: "assistant", text: "A reply that arrived while hidden." },
  });
  await expect.element(page.getByText("Unread sidebar reply", { exact: true })).toBeVisible();
  expect(visits()).toBe(before);
  await userEvent.click(page.getByRole("button", { name: "Show panel", exact: true }));
  await expect.element(panel().getByText("A reply that arrived while hidden.")).toBeVisible();
  await expect.poll(visits).toBeGreaterThan(before);
});

test("/diff reveals the target chat and its Changes panel", async () => {
  await besideChief();
  await userEvent.keyboard("/diff{Enter}");
  await expect.poll(() => window.location.hash).toBe("#/w/ws-1");
  await expect.element(page.getByRole("tabpanel", { name: "Changes", exact: true })).toBeVisible();
  expect(getPanel("ws-1").tabs.find((t) => t.id === getPanel("ws-1").active)?.kind).toBe("diff");
});

test("a transcript file link reveals the file in the target chat", async () => {
  const { peer } = await besideChief();
  peer.on("fs.read", (p) => ({
    path: p.path,
    encoding: "utf8",
    content: "export const guard = true;",
    size: 26,
    truncated: false,
  }));
  peer.emit("ws-1", {
    type: "message.done",
    item_id: "file-answer",
    payload: { role: "assistant", text: "See `src/login.ts`." },
  });
  await userEvent.click(panel().getByRole("button", { name: "login.ts", exact: true }));
  await expect.poll(() => window.location.hash).toBe("#/w/ws-1");
  await expect.element(page.getByRole("tabpanel", { name: "login.ts", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      peer
        .callsOf("fs.read")
        .some((c) => c.params.workspace_id === "ws-1" && c.params.path === "src/login.ts"),
    )
    .toBe(true);
});

test("a transcript artifact reveals its viewer in the target chat", async () => {
  const { peer } = await besideChief();
  peer.emit("ws-1", {
    type: "message.done",
    item_id: "code-answer",
    payload: { role: "assistant", text: '```json title="config.json"\n{"ready": true}\n```' },
  });
  await userEvent.click(panel().getByRole("button", { name: "Open in side panel", exact: true }));
  await expect.poll(() => window.location.hash).toBe("#/w/ws-1");
  await expect.element(page.getByRole("region", { name: "Side panel", exact: true })).toBeVisible();
  expect(getPanel("ws-1").tabs.find((t) => t.id === getPanel("ws-1").active)?.kind).toBe(
    "artifact",
  );
});

test("model and permissions shortcuts act on the focused sidebar composer", async () => {
  await besideChief({ engines: [{ ...ENGINE, access_modes: ["ask", "auto", "full"] }] });
  const mod = /Mac/i.test(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}{Shift>}m{/Shift}{/${mod}}`);
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(box());
  await userEvent.keyboard(`{${mod}>}{Shift>}a{/Shift}{/${mod}}`);
  await expect.element(page.getByRole("menu", { name: /^Permissions/ })).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: /^Full access/ })).toBeChecked();
});

test("a refused Stop reports the reason and leaves the sidebar chat usable", async () => {
  const { peer } = await besideChief();
  peer.emit("ws-1", { type: "turn.started", turn_id: "t2", payload: { engine: "caveman" } });
  const stop = panel().getByRole("button", { name: "Stop", exact: true });
  await expect.element(stop).toBeVisible();
  const interrupt = peer.hold("turn.interrupt");
  await userEvent.click(stop);
  expect((await interrupt.call).params.session_id).toBe("s-ws-1");
  interrupt.refuse("invalid_state", "The agent could not be stopped. Try again.");
  await expect
    .element(panel().getByRole("alert"))
    .toHaveTextContent("The agent could not be stopped. Try again.");
  await expect.element(stop).toBeEnabled();
  await expect.element(box()).toBeEnabled();
});

test("a draft typed in the sidebar follows Open chat", async () => {
  await besideChief();
  await userEvent.keyboard("Check the logout route too");
  await userEvent.click(panel().getByRole("button", { name: "Open chat", exact: true }));
  await expect.poll(() => window.location.hash).toBe("#/w/ws-1");
  await expect
    .element(page.getByRole("combobox", { name: "Message" }))
    .toHaveValue("Check the logout route too");
  await expect.element(page.getByText("The guard now runs once.")).toBeVisible();
});

test("a chat shown inside its own side panel does not mount nested panels", async () => {
  await mountApp(
    "/w/ws-1",
    runtimeFixture({ events: { "ws-1": exchange("t1", "Fix login", "The guard now runs once.") } }),
  );
  await expect.element(page.getByText("The guard now runs once.")).toBeVisible();
  openSurface("ws-1", "chat", { workspace_id: "ws-1" });
  await expect.element(box()).toBeVisible();
  expect(document.querySelectorAll("[data-side-panel]")).toHaveLength(1);
});
