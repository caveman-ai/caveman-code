// Move to, opened from the computer under a chat's box (WhereItRuns), in Chromium: the real app against the scripted
// runtime for the places and the check, and the real foot with two clients for a move that waits on a turn. Focus is
// asserted here, not in linkedom (which has none): the chip is where it comes back to.
import type { Workspace } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createRoot } from "react-dom/client";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { mountApp } from "../../../test/app.tsx";
import { exchange, PROJECT, runtimeFixture, workspace } from "../../../test/fixtures.ts";
import { WhereItRuns } from "./Moves.tsx";

const chip = () => page.getByRole("button", { name: "Runs on This Mac. Move this chat" });
const places = () => page.getByRole("group", { name: "Move this chat to" });
const cloud = () => places().getByRole("button", { name: "Cloud" });

/** What the runtime answers when a chat can go: its login there, and nothing left behind. */
const CAN_GO = {
  login: null,
  preflight: { work: { left: [] }, context: { mode: "native" } },
} as const;

describe("Move to, from the computer under the box", () => {
  test("it opens the places; Cloud asks the runtime, Back returns to the places, and closing hands focus back to the chip", async () => {
    const { peer } = await mountApp(
      "/w/ws-1",
      runtimeFixture({
        workspaces: [workspace("ws-1", { title: "Fix the login redirect" })],
        events: {
          "ws-1": exchange(
            "t1",
            "Why does login redirect twice?",
            "Because the guard runs on both routes.",
          ),
        },
      }),
    );
    peer.on("session.move.check", () => CAN_GO);
    await expect.element(page.getByText("Because the guard runs on both routes.")).toBeVisible();

    // The foot says where the chat is, and its computer is the way to move it.
    await expect.element(page.getByRole("group", { name: "Where the chat is" })).toBeVisible();
    await userEvent.click(chip());
    await expect.element(places()).toBeVisible();
    await expect.element(cloud()).toBeVisible();
    await expect.element(chip()).toHaveAttribute("aria-expanded", "true");

    // Cloud: the runtime is asked whether the chat can go there, and the card says what it answered.
    await userEvent.click(cloud());
    await expect.element(page.getByText("Move to Cloud")).toBeVisible();
    await expect.element(page.getByText(/It continues there as the same chat/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Move", exact: true })).toBeEnabled();
    expect(peer.callsOf("session.move.check").map((c) => c.params)).toEqual([
      { session_id: "s-ws-1", to: "cloud" },
    ]);
    // Asking is not moving.
    expect(peer.callsOf("session.move")).toEqual([]);

    // Back is the places again, the card gone.
    await userEvent.click(page.getByRole("button", { name: "Back", exact: true }));
    await expect.element(places()).toBeVisible();
    await expect.element(page.getByText("Move to Cloud")).not.toBeInTheDocument();

    // Escape closes it, and focus goes back to where it was opened from.
    await userEvent.keyboard("{Escape}");
    await expect.element(places()).not.toBeInTheDocument();
    await expect.element(chip()).toHaveFocus();
    await expect.element(chip()).toHaveAttribute("aria-expanded", "false");

    // Opened again it starts from the places, not from the card it was closed on.
    await userEvent.click(chip());
    await expect.element(places()).toBeVisible();
    await expect.element(page.getByText("Move to Cloud")).not.toBeInTheDocument();
    expect(peer.callsOf("session.move")).toEqual([]);
  });

  test("a move that waits for the turn to end is asked once, Close leaves it waiting with focus on the chip, and it is still waiting when opened again", async () => {
    // The chat is read through another client than the window's (as a chat on another computer is): the move goes
    // through Cloud as mail that computer acts on once its turn ends, so the card waits instead of closing.
    const working = workspace("ws-wait", { title: "Rename the billing route", status: "working" });
    const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chatClient = {
      call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        asked.push({ method, params });
        if (method === "session.move.check") return CAN_GO;
        if (method === "session.move")
          return { session: { id: working.session_id, state: "live" }, pending: true };
        return {};
      }),
    };
    const windowClient = { call: vi.fn(async () => ({})) };
    const runtime = {
      status: "connected",
      error: null,
      client: windowClient,
      connection: 1,
      identity: {},
      engines: [],
      settings: null,
      workspaces: [],
      raw: new Map(),
      projects: [PROJECT],
      refresh: async () => undefined,
      markSeen: () => undefined,
    } as unknown as RuntimeContextValue;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    onTestFinished(() => {
      root.unmount();
      host.remove();
    });
    root.render(
      <TooltipProvider>
        <RuntimeFixture value={runtime}>
          <div className="p-8">
            <WhereItRuns
              client={chatClient as never}
              workspace={working as Workspace}
              movedFrom={null}
            />
          </div>
        </RuntimeFixture>
      </TooltipProvider>,
    );

    await userEvent.click(chip());
    await userEvent.click(cloud());
    // Its turn is running there, so the one action says when it moves.
    await expect
      .element(page.getByText("Its turn there runs to its end first, then it moves."))
      .toBeVisible();
    await userEvent.click(
      page.getByRole("button", { name: "Move when this turn ends", exact: true }),
    );
    await expect
      .element(page.getByText("Waiting for its turn on This Mac to end. It moves then."))
      .toBeVisible();
    expect(asked.filter((a) => a.method === "session.move").map((a) => a.params)).toEqual([
      expect.objectContaining({ session_id: working.session_id, to: "cloud" }),
    ]);

    // Close is not Back: the move is asked already, so the card only closes, and focus returns to the chip.
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await expect.element(places()).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Waiting for its turn on This Mac to end. It moves then."))
      .not.toBeInTheDocument();
    await expect.element(chip()).toHaveFocus();

    // Opened again it still says it waits, and pressing the waiting button asks for nothing more. It is aria-disabled
    // rather than disabled (focus stays on it), so a browser's click action refuses it: the DOM's own click is the press.
    await userEvent.click(chip());
    await expect
      .element(page.getByText("Waiting for its turn on This Mac to end. It moves then."))
      .toBeVisible();
    const waiting = page.getByRole("button", { name: "Waiting for this turn…" });
    await expect.element(waiting).toHaveAttribute("aria-disabled", "true");
    (waiting.element() as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked.filter((a) => a.method === "session.move")).toHaveLength(1);
  });
});
