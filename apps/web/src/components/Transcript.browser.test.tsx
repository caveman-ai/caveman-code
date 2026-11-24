// A chat's transcript, in Chromium, against the scripted runtime playing the engine: a streaming answer, tool rows,
// an approval and a question answered, and a long thread that keeps the reader's place.
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { exchange, longThread, runtimeFixture, workspace } from "../../test/fixtures.ts";
import type { EventDraft } from "../../test/session-peer.ts";
import { ASK_ARM_MS } from "./Transcript.tsx";

const TITLE = "Fix the login redirect";

async function openChat(
  events: EventDraft[] = exchange(
    "t1",
    "Why does login redirect twice?",
    "Because the guard runs on both routes.",
  ),
) {
  const app = await mountApp(
    "/w/ws-1",
    runtimeFixture({
      workspaces: [workspace("ws-1", { title: TITLE })],
      events: { "ws-1": events },
    }),
  );
  await expect.element(page.getByRole("log")).toBeVisible();
  return app;
}

/** A turn the person started, as the engine opens it. */
const started = (turn: string, ask: string): EventDraft[] => [
  { type: "turn.started", turn_id: turn, payload: { engine: "caveman" } },
  {
    type: "message.done",
    turn_id: turn,
    item_id: `${turn}-ask`,
    payload: { role: "user", text: ask },
  },
];

const thread = () => page.getByRole("log");
const announced = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const waitForArm = () => new Promise((resolve) => setTimeout(resolve, ASK_ARM_MS + 50));

/** The view's scroll offset once it has stopped moving (a wheel scrolls smoothly; growth lays out a frame later). */
async function settledScrollTop(el: HTMLElement): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(
      () => {
        const still = el.scrollTop === last;
        last = el.scrollTop;
        return still;
      },
      { interval: 100 },
    )
    .toBe(true);
  return last;
}

/**
 * The round "Scroll to the newest message" button stays mounted and fades: shown, it is opaque and a button; gone, it
 * is transparent and inert, out of the Tab order and unseen by screen readers. (`toBeVisible` reads layout, not
 * opacity.)
 */
const scrollButton = () => page.getByRole("button", { name: "Scroll to the newest message" });
async function expectScrollButton(shown: boolean) {
  // By its tooltip, which finds it faded out too.
  await expect
    .element(page.getByTitle("Scroll to the newest message"))
    .toHaveStyle({ opacity: shown ? "1" : "0" });
  if (shown) await expect.element(scrollButton()).toBeInTheDocument();
  else await expect.element(scrollButton()).not.toBeInTheDocument();
}

describe("a streaming answer", () => {
  test("grows as the engine streams it, then settles with its actions and says it finished", async () => {
    const { peer } = await openChat();
    // The person is in this chat: its box has focus.
    await userEvent.click(page.getByRole("combobox", { name: "Message" }));
    peer.emit("ws-1", ...started("t2", "Fix it then"));
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();

    peer.emit("ws-1", {
      type: "message.delta",
      turn_id: "t2",
      item_id: "t2-answer",
      payload: { text: "The guard runs " },
    });
    await expect.element(thread().getByText("The guard runs", { exact: false })).toBeVisible();
    peer.emit("ws-1", {
      type: "message.delta",
      turn_id: "t2",
      item_id: "t2-answer",
      payload: { text: "on /login and /home." },
    });
    await expect.element(thread().getByText("The guard runs on /login and /home.")).toBeVisible();
    // While it streams, the answer has no actions yet: the first exchange's are the only ones.
    await expect.element(thread().getByRole("button", { name: "Copy answer" })).toHaveLength(1);

    peer.emit(
      "ws-1",
      {
        type: "message.done",
        turn_id: "t2",
        item_id: "t2-answer",
        payload: {
          role: "assistant",
          text: "The guard runs on /login and /home. I removed the second one.",
        },
      },
      { type: "turn.done", turn_id: "t2", payload: { status: "completed" } },
    );
    await expect
      .element(thread().getByText("The guard runs on /login and /home. I removed the second one."))
      .toBeVisible();
    await expect.element(thread().getByRole("button", { name: "Copy answer" })).toHaveLength(2);
    await expect.element(announced("Caveman finished.")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});

describe("tool rows", () => {
  test("a turn's tool calls sit folded under its trace, and open to show what ran", async () => {
    await openChat([
      ...exchange("t1", "Why does login redirect twice?", "Because the guard runs on both routes."),
      ...started("t2", "Run the login tests"),
      {
        type: "tool.started",
        turn_id: "t2",
        item_id: "tool-1",
        payload: {
          name: "Bash",
          title: "pnpm test src/login.test.ts",
          kind: "command",
          input: { command: "pnpm test src/login.test.ts" },
        },
      },
      {
        type: "tool.output",
        turn_id: "t2",
        item_id: "tool-1",
        payload: { text: "1 failed, 3 passed\n" },
      },
      { type: "tool.done", turn_id: "t2", item_id: "tool-1", payload: { status: "completed" } },
      {
        type: "tool.started",
        turn_id: "t2",
        item_id: "tool-2",
        payload: {
          name: "Read",
          title: "src/login.ts",
          kind: "read",
          input: { file_path: "src/login.ts" },
        },
      },
      { type: "tool.done", turn_id: "t2", item_id: "tool-2", payload: { status: "completed" } },
      {
        type: "message.done",
        turn_id: "t2",
        item_id: "t2-answer",
        payload: { role: "assistant", text: "One test fails: the redirect test." },
      },
      { type: "turn.done", turn_id: "t2", payload: { status: "completed" } },
    ]);
    await expect.element(thread().getByText("One test fails: the redirect test.")).toBeVisible();
    // Finished, the turn folds under its trace ("Caveman worked for 1s").
    const trace = thread().getByRole("button", { name: /worked for/ });
    await expect.element(trace).toHaveAttribute("aria-expanded", "false");
    const steps = thread().getByRole("button", { name: "Ran tests, read login.ts" });
    await expect.element(steps).not.toBeInTheDocument();
    const run = thread().getByRole("button", { name: /^Ran tests \d/ });
    await expect.element(run).not.toBeInTheDocument();

    // Opened, it shows the turn as it ran: its tools under one line saying what they did, each a row.
    await userEvent.click(trace);
    await expect.element(trace).toHaveAttribute("aria-expanded", "true");
    await expect.element(steps).toHaveAttribute("aria-expanded", "true");
    await expect.element(run).toBeVisible();
    await expect.element(run).toHaveAttribute("aria-expanded", "false");
    await expect.element(thread().getByText(/^Read src\/login\.ts/)).toBeVisible();

    // A command's row opens on the command as it ran and what it printed.
    await userEvent.click(run);
    await expect.element(run).toHaveAttribute("aria-expanded", "true");
    await expect.element(thread().getByText("pnpm test src/login.test.ts")).toBeVisible();
    await expect.element(thread().getByText("1 failed, 3 passed")).toBeVisible();
  });
});

describe("asks", () => {
  test("an approval: announced, answered with Allow, then closed by the runtime", async () => {
    const { peer } = await openChat();
    peer.change("ws-1", { status: "needs_input" });
    peer.emit(
      "ws-1",
      ...started("t2", "Fix it then"),
      {
        type: "tool.started",
        turn_id: "t2",
        item_id: "tool-1",
        payload: {
          name: "Edit",
          title: "src/login.ts",
          kind: "edit",
          input: { file_path: "src/login.ts" },
        },
      },
      {
        type: "ask.user",
        turn_id: "t2",
        item_id: "ask-1",
        payload: {
          kind: "approval",
          title: "Edit src/login.ts",
          tool_item_id: "tool-1",
          options: [
            { id: "allow", label: "Allow", decision: "allow" },
            { id: "deny", label: "Deny", decision: "deny" },
          ],
        },
      },
    );
    const allow = thread().getByRole("button", { name: "1 Allow" });
    await expect.element(allow).toBeVisible();
    await expect.element(thread().getByRole("button", { name: "2 Deny" })).toBeVisible();
    await expect
      .element(announced("Caveman wants approval: Edit src/login.ts"))
      .toBeInTheDocument();

    // The card ignores clicks for its first moments (a double-click meant for what was there), as a person waits.
    await waitForArm();
    await userEvent.click(allow);
    const { params } = await peer.nextCall("ask.respond");
    expect(params).toMatchObject({
      session_id: "s-ws-1",
      ask_id: "ask-1",
      response: { kind: "approval", option_id: "allow" },
    });
    // Answered: focus goes on to the chat's box, not to the page behind.
    await expect.element(page.getByRole("combobox", { name: "Message" })).toHaveFocus();

    peer.emit("ws-1", {
      type: "ask.resolved",
      turn_id: "t2",
      item_id: "ask-1",
      payload: { outcome: "answered", response: { kind: "approval", option_id: "allow" } },
    });
    await expect.element(thread().getByText("Answered: Allow")).toBeVisible();
    await expect.element(allow).not.toBeInTheDocument();
  });

  test("an approval's keycap answers it from the keyboard", async () => {
    const { peer } = await openChat();
    peer.emit("ws-1", ...started("t2", "Fix it then"), {
      type: "ask.user",
      turn_id: "t2",
      item_id: "ask-1",
      payload: {
        kind: "approval",
        title: "Run rm -rf dist",
        options: [
          { id: "allow", label: "Allow", decision: "allow" },
          { id: "deny", label: "Deny", decision: "deny" },
        ],
      },
    });
    const allow = thread().getByRole("button", { name: "1 Allow" });
    await expect.element(allow).toBeVisible();
    await waitForArm();
    (allow.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("2");
    const { params } = await peer.nextCall("ask.respond");
    expect(params.response).toEqual({ kind: "approval", option_id: "deny" });
  });

  test("a question: answered in the person's own words", async () => {
    const { peer } = await openChat();
    peer.emit("ws-1", ...started("t2", "Fix it then"), {
      type: "ask.user",
      turn_id: "t2",
      item_id: "ask-q",
      payload: {
        kind: "question",
        questions: [
          {
            id: "q1",
            prompt: "Which route should keep the guard?",
            options: [
              { id: "login", label: "/login" },
              { id: "home", label: "/home" },
            ],
            multi_select: false,
            allow_text: true,
          },
        ],
      },
    });
    await expect.element(thread().getByText("Which route should keep the guard?")).toBeVisible();
    await expect.element(thread().getByRole("button", { name: "1 /login" })).toBeVisible();
    const own = thread().getByRole("textbox", { name: "Answer in your own words" });
    const send = thread().getByRole("button", { name: "Send", exact: true });
    await expect.element(send).toBeDisabled();

    await waitForArm();
    await userEvent.fill(own, "Neither: move it to the router");
    await expect.element(send).toBeEnabled();
    await userEvent.click(send);
    const { params } = await peer.nextCall("ask.respond");
    expect(params).toMatchObject({
      ask_id: "ask-q",
      response: {
        kind: "question",
        answers: [{ question_id: "q1", option_ids: [], text: "Neither: move it to the router" }],
      },
    });

    peer.emit("ws-1", {
      type: "ask.resolved",
      turn_id: "t2",
      item_id: "ask-q",
      payload: { outcome: "answered", response: params.response },
    });
    await expect.element(thread().getByText("Neither: move it to the router")).toBeVisible();
    await expect.element(own).not.toBeInTheDocument();
  });
});

describe("a long thread", () => {
  test("opens at its end, and keeps the reader's place while new work streams in below", async () => {
    const { peer } = await openChat(longThread(30));
    const log = thread().element() as HTMLElement;
    const lastAnswer = thread().getByText("Answer 30.");
    await expect.element(lastAnswer).toBeInViewport();
    await expect.poll(() => log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2);
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight * 2);
    await expectScrollButton(false);

    // The reader scrolls up to read earlier answers.
    await userEvent.wheel(thread(), { direction: "up", times: 20 });
    await expect.element(lastAnswer).not.toBeInViewport();
    await expectScrollButton(true);
    const reading = await settledScrollTop(log);
    expect(log.scrollHeight - reading - log.clientHeight).toBeGreaterThan(log.clientHeight);

    // A new turn streams in below; the view stays where they are reading.
    peer.emit("ws-1", ...started("t31", "Question 31"));
    for (const word of ["Streaming ", "a ", "new ", "answer."]) {
      peer.emit("ws-1", {
        type: "message.delta",
        turn_id: "t31",
        item_id: "t31-answer",
        payload: { text: word },
      });
    }
    await expect.element(thread().getByText("Streaming a new answer.")).toBeInTheDocument();
    expect(await settledScrollTop(log)).toBe(reading);
    await expect.element(thread().getByText("Streaming a new answer.")).not.toBeInViewport();

    // The round button brings them back to the newest message, which then follows the stream again.
    await userEvent.click(scrollButton());
    await expect.element(thread().getByText("Streaming a new answer.")).toBeInViewport();
    await expectScrollButton(false);
    peer.emit("ws-1", {
      type: "message.delta",
      turn_id: "t31",
      item_id: "t31-answer",
      payload: { text: "\n\nAnd one more paragraph at the end." },
    });
    await expect.element(thread().getByText("And one more paragraph at the end.")).toBeInViewport();
  });
});

// A screen reader lists no "Scroll to the newest message" button nobody can see.
test("at the end of a thread, the scroll-to-newest button is gone for screen readers too", async () => {
  await openChat();
  await expect.element(scrollButton(), { timeout: 1_000 }).not.toBeInTheDocument();
  await expect.element(page.getByTitle("Scroll to the newest message")).toHaveAttribute("inert");
});
