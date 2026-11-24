// The Chief's conversation stays quiet and reads as a messenger, in Chromium against the scripted runtime: a wake it
// answered with nothing leaves no row at all (no "Worked" line, no wake line), a turn's steps stay out of the
// conversation, a reply is plain words as a chat's under its name with its character at the run's last row, and a note
// the person sent while a turn ran is a message of its own, in order. Its chats' moments are cards that always stay,
// grouped under "While you were away" when they came since the person last looked.
import type { ChiefItem, ChiefMoment } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { AT, chief, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";
import type { EventDraft } from "../../test/session-peer.ts";
import { CHIEF_TEMPLATES } from "../shell/chief-templates.ts";

const APP = chief("c-app", "app", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});

const tool = (turn: string, id: string, name: string): EventDraft[] => [
  {
    type: "tool.started",
    turn_id: turn,
    item_id: id,
    payload: { name, title: name, kind: "mcp", input: {} },
  },
  { type: "tool.done", turn_id: turn, item_id: id, payload: { status: "completed" } },
];
const said = (
  turn: string,
  id: string,
  text: string,
  role: "user" | "assistant" = "assistant",
  extra: object = {},
): EventDraft => ({
  type: "message.done",
  turn_id: turn,
  item_id: id,
  payload: { role, text, ...extra },
});
const turn = (id: string, ...body: EventDraft[][]): EventDraft[] => [
  { type: "turn.started", turn_id: id, payload: { engine: "caveman" } },
  ...body.flat(),
  { type: "turn.done", turn_id: id, payload: { status: "completed" } },
];
/** A wake: the runtime's own message to the Chief, drawn as its one line. */
const wake = (id: string, line: string): EventDraft =>
  said(id, `${id}-wake`, `<chat_update state="done"/>`, "user", { generated: { shown: line } });

async function openChief(events: EventDraft[]) {
  await mountApp(
    "/chief/c-app",
    runtimeFixture({
      chiefs: [APP],
      workspaces: [
        workspace("ws-1", { title: "Fix the login redirect" }),
        workspace("c-app", { kind: "chief", title: "app" }),
      ],
      events: { "c-app": events },
    }),
  );
  await expect.element(page.getByRole("log")).toBeVisible();
}

const log = () => page.getByRole("log");

describe("the Chief's conversation", () => {
  test("a wake it answered with nothing draws nothing; one it answered shows its words, its steps out of sight", async () => {
    await openChief([
      ...turn(
        "t1",
        [said("t1", "t1-u", "Fix the login redirect", "user")],
        tool("t1", "t1-a", "chat_start"),
        [said("t1", "t1-r", "Started a chat on the login redirect.")],
      ),
      // Two wakes it had nothing to say about.
      ...turn(
        "t2",
        [wake("t2", "1 chat changed: Fix the login redirect working")],
        tool("t2", "t2-a", "chat_digest"),
        tool("t2", "t2-b", "queue_update"),
      ),
      ...turn(
        "t3",
        [wake("t3", "1 chat changed: Fix the login redirect needs a rebase")],
        tool("t3", "t3-a", "chat_send"),
      ),
      // One it answered.
      ...turn(
        "t4",
        [wake("t4", "1 chat changed: Fix the login redirect done")],
        tool("t4", "t4-a", "chat_digest"),
        [said("t4", "t4-r", "The login redirect is fixed and ready for review.")],
      ),
    ]);
    await expect
      .element(log().getByText("The login redirect is fixed and ready for review."))
      .toBeVisible();
    await expect.element(log().getByText("Started a chat on the login redirect.")).toBeVisible();
    // The silent wakes left nothing: not their line, not a "Worked" row.
    await expect.element(log().getByText(/working$|needs a rebase/)).not.toBeInTheDocument();
    await expect
      .element(log().getByText("1 chat changed: Fix the login redirect done"))
      .toBeVisible();
    // A messenger keeps every turn's steps out of the conversation: no "Worked" line, even over its words.
    expect(
      log()
        .getByRole("button", { name: /^Worked/ })
        .elements(),
    ).toHaveLength(0);
  });

  test("a turn that stopped or failed says so, though no footer follows a reply", async () => {
    await openChief([
      { type: "turn.started", turn_id: "t1", payload: { engine: "caveman" } },
      said("t1", "t1-u", "Look into the flaky test", "user"),
      said("t1", "t1-r", "Looking now."),
      { type: "turn.done", turn_id: "t1", payload: { status: "interrupted" } },
      { type: "turn.started", turn_id: "t2", payload: { engine: "caveman" } },
      said("t2", "t2-u", "Try again", "user"),
      { type: "turn.done", turn_id: "t2", payload: { status: "failed" } },
    ]);
    await expect.element(log().getByText("Looking now.")).toBeVisible();
    await expect.element(log().getByText("Stopped", { exact: true })).toBeVisible();
    await expect.element(log().getByText("The turn failed")).toBeVisible();
  });

  test("Find in chat reaches a step behind a reply, though the messenger keeps steps out of view", async () => {
    const read: EventDraft[] = [
      {
        type: "tool.started",
        turn_id: "t1",
        item_id: "t1-a",
        payload: {
          name: "Read",
          title: "Read",
          kind: "read",
          input: { file_path: "src/auth/login-redirect.ts" },
        },
      },
      { type: "tool.done", turn_id: "t1", item_id: "t1-a", payload: { status: "completed" } },
    ];
    await openChief([
      ...turn("t1", [said("t1", "t1-u", "Is the login okay?", "user")], read, [
        said("t1", "t1-r", "The login is fine."),
      ]),
    ]);
    await expect.element(log().getByText("The login is fine.")).toBeVisible();
    await expect.element(log().getByText(/login-redirect/)).not.toBeInTheDocument();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    await userEvent.keyboard(mac ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}");
    const field = page.getByRole("textbox", { name: "Find in chat" });
    await expect.element(field).toBeVisible();
    await userEvent.fill(field, "login-redirect");
    await expect
      .element(
        log()
          .getByText(/login-redirect/)
          .first(),
      )
      .toBeVisible();
  });

  test("a starter mission that didn't send says so under its card, which stays to try again", async () => {
    const { peer } = await mountApp(
      "/chief/c-app",
      runtimeFixture({
        chiefs: [APP],
        workspaces: [workspace("c-app", { kind: "chief", title: "app" })],
      }),
    );
    const card = page.getByRole("article", { name: "app says hello" });
    await expect.element(card).toBeVisible();
    const capture = peer.hold("chief.capture");
    await userEvent.click(card.getByRole("button", { name: /^Keep CI green/ }));
    expect((await capture.call).params.text).toContain("Keep CI green");
    capture.refuse("internal", "The runtime is restarting");
    await expect
      .element(card.getByRole("alert"))
      .toHaveTextContent("Not sent: The runtime is restarting");
    await expect.element(card.getByRole("button", { name: /^Keep CI green/ })).toBeEnabled();
  });

  test("a ready-made Chief's card offers its own missions while its role is the template's; a pick sends its note", async () => {
    const reviewer = CHIEF_TEMPLATES.find((t) => t.id === "reviewer")!;
    const { peer } = await mountApp(
      "/chief/c-app",
      runtimeFixture({
        chiefs: [{ ...APP, name: "Reviewer", role: reviewer.role, avatar: reviewer.avatar }],
        workspaces: [workspace("c-app", { kind: "chief", title: "Reviewer" })],
      }),
    );
    const hello = page.getByRole("article", { name: "Reviewer says hello" });
    await expect.element(hello.getByText(reviewer.role)).toBeVisible();
    await expect.element(hello.getByText("Put Reviewer to work")).toBeVisible();
    const missions = hello.getByRole("button");
    expect(missions.elements().map((el) => el.textContent)).toEqual(
      reviewer.missions.map((m) => `${m.title}${m.line}`),
    );
    const [first] = reviewer.missions;
    const capture = peer.hold("chief.capture");
    await userEvent.click(hello.getByRole("button", { name: new RegExp(`^${first!.title}`) }));
    const { params } = await capture.call;
    expect(params.text).toBe(first!.note);
    capture.answer({
      item: {
        id: "i-1",
        chief_id: APP.id,
        text: params.text,
        state: "unsorted",
        rank: 1,
        pinned: false,
        project_ids: [],
        source: "composer",
        workspace_ids: [],
        created_at: AT,
        updated_at: AT,
      },
    });
  });

  test("a Chief whose role is its own, not a template's, offers the starters", async () => {
    await mountApp(
      "/chief/c-app",
      runtimeFixture({
        chiefs: [{ ...APP, role: `${CHIEF_TEMPLATES[0]!.role} And I watch the deploys.` }],
        workspaces: [workspace("c-app", { kind: "chief", title: "app" })],
      }),
    );
    const hello = page.getByRole("article", { name: "app says hello" });
    await expect.element(hello.getByText(/And I watch the deploys\.$/)).toBeVisible();
    await expect
      .element(hello.getByRole("button", { name: /^Keep CI green in app/ }))
      .toBeVisible();
    expect(hello.getByRole("button").elements()).toHaveLength(3);
  });

  test("as a messenger: its reply as a chat's, no bubble, its name over the run, its character at the run's last words", async () => {
    await openChief([
      ...turn(
        "t1",
        [said("t1", "t1-u", "What's going on?", "user")],
        tool("t1", "t1-a", "chat_digest"),
        [said("t1", "t1-r", "Two chats are working.\n\nThe login fix is ready for review.")],
      ),
      ...turn("t2", [
        said("t2", "t2-u", "Forwarded from the auth chat.", "user", { from: { title: "Auth" } }),
      ]),
    ]);
    const first = log().getByText("Two chats are working.");
    await expect.element(first).toBeVisible();
    const second = log().getByText("The login fix is ready for review.").element();
    // Its words are one plain reply, as a chat's: no bubble, and no tail on its side.
    const reply = first.element().closest("[data-slot='response']");
    expect(reply).not.toBeNull();
    expect(second.closest("[data-slot='response']")).toBe(reply);
    for (const tail of log().element().querySelectorAll(".bubble-tail")) {
      expect(tail.closest("[data-row-kind]")!.getAttribute("data-row-kind")).toBe("user");
    }
    // Its name heads the run once: over its greeting, and over its reply after your message.
    expect(log().element().querySelectorAll("[data-messenger-name]")).toHaveLength(2);
    // Its character stands at the reply's last words, not at its first, nor at the turn's footer.
    const avatar = [...log().element().querySelectorAll("[data-messenger-avatar]")]
      .at(-1)!
      .getBoundingClientRect();
    const words = reply!.getBoundingClientRect();
    expect(Math.abs(avatar.bottom - words.bottom)).toBeLessThan(6);
    expect(avatar.right).toBeLessThanOrEqual(words.left);
    // Its steps stay out of the conversation.
    await expect.element(log().getByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
    // Your words are in the page's colour on their ink bubble; words from elsewhere, in an outlined bubble with no
    // fill, keep the page's ink, so they never vanish into the page.
    const ink = (text: string) => getComputedStyle(log().getByText(text).element()).color;
    expect(ink("What's going on?")).not.toBe(ink("Two chats are working."));
    expect(ink("Forwarded from the auth chat.")).not.toBe(ink("What's going on?"));
  });

  test("a note sent while a turn ran is its own message, in order, and the silent work before it is gone", async () => {
    await openChief([
      ...turn(
        "t1",
        [wake("t1", "1 chat changed: Fix the login redirect done")],
        tool("t1", "t1-a", "chat_digest"),
        [said("t1", "t1-s", "and add dark mode to settings", "user", { delivery: "steer" })],
        tool("t1", "t1-b", "chat_start"),
        [said("t1", "t1-r", "Started dark mode beside the login fix.")],
      ),
    ]);
    const note = log().getByText("and add dark mode to settings");
    await expect.element(note).toBeVisible();
    await expect.element(log().getByText("You added · this turn")).not.toBeInTheDocument();
    // Drawn as the person's own message, before the reply.
    const row = note.element().closest("[data-row]")!;
    expect(row.getAttribute("data-row-kind")).toBe("user");
    expect(row.hasAttribute("data-steering")).toBe(false);
    const reply = log().getByText("Started dark mode beside the login fix.").element();
    expect(row.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The wake's silent work before the note left no line, and the work after it stays out of sight.
    await expect
      .element(log().getByText("1 chat changed: Fix the login redirect done"))
      .not.toBeInTheDocument();
    expect(
      log()
        .getByRole("button", { name: /^Worked/ })
        .elements(),
    ).toHaveLength(0);
  });
});

const minutes = (n: number) => new Date(Date.parse(AT) + n * 60_000).toISOString();
const stamped = (at: string, events: EventDraft[]): EventDraft[] =>
  events.map((e) => ({ ...e, at }));
const moment = (id: string, at: string, m: ChiefMoment, title: string): EventDraft => ({
  type: "notification",
  item_id: id,
  at,
  payload: { level: "info", title, moment: m },
});
const boardItem = (
  id: string,
  title: string,
  workspaceId: string,
  over: Partial<ChiefItem> = {},
): ChiefItem => ({
  id,
  chief_id: APP.id,
  text: title,
  title,
  state: "started",
  rank: 1,
  pinned: false,
  project_ids: [PROJECT.id],
  source: "chief",
  workspace_ids: [workspaceId],
  created_at: minutes(-90),
  updated_at: minutes(-30),
  ...over,
});

/** Three chats under way and one done, each with its moment; the person last looked before any of them. */
async function openMoments(later: ReadonlyArray<EventDraft> = []) {
  const mounted = await mountApp(
    "/chief/c-app",
    runtimeFixture({
      chiefs: [APP],
      workspaces: [
        workspace("ws-1", { title: "Fix the login redirect", status: "working" }),
        workspace("ws-2", { title: "Dark mode in settings", status: "needs_input" }),
        workspace("ws-3", {
          title: "Search the board",
          status: "idle",
          pull_request: {
            number: 41,
            url: "https://github.com/acme/app/pull/41",
            state: "open",
            checks: "passing",
          },
          preview: {
            command: "pnpm dev --port {port}",
            path: "/board",
            registered_at: minutes(-12),
          },
        }),
        workspace("ws-4", { title: "Rate limit the API", status: "working" }),
        workspace("ws-5", { title: "Export to CSV", status: "idle" }),
        // A second build of the search item, whose pull request the item synced last.
        workspace("ws-6", {
          title: "Search the board, the other way",
          status: "idle",
          pull_request: {
            number: 42,
            url: "https://github.com/acme/app/pull/42",
            state: "open",
            checks: "failing",
          },
        }),
        workspace("c-app", { kind: "chief", title: "app" }),
      ],
      board: {
        items: [
          boardItem("ci-1", "Fix the login redirect", "ws-1"),
          boardItem("ci-2", "Dark mode in settings", "ws-2", { state: "needs_you" }),
          boardItem("ci-3", "Search the board", "ws-3", {
            state: "review",
            workspace_ids: ["ws-3", "ws-6"],
            pull_request: {
              number: 42,
              url: "https://github.com/acme/app/pull/42",
              state: "open",
              checks: "failing",
            },
          }),
          boardItem("ci-4", "Rate limit the API", "ws-4"),
          boardItem("ci-5", "Export to CSV", "ws-5", { state: "needs_you" }),
        ],
        change_sets: [],
      },
      events: {
        "c-app": [
          ...stamped(
            minutes(-60),
            turn(
              "t1",
              [
                said(
                  "t1",
                  "t1-u",
                  "Fix the login redirect, add dark mode, search the board",
                  "user",
                ),
              ],
              tool("t1", "t1-a", "chat_start"),
              [said("t1", "t1-r", "Started them.")],
            ),
          ),
          moment(
            "mo-started",
            minutes(-30),
            { kind: "started", workspace_id: "ws-1", item_id: "ci-1" },
            "Started Fix the login redirect",
          ),
          // A wake it had nothing to say about, with a moment written while it ran.
          ...stamped(minutes(-25), [
            { type: "turn.started", turn_id: "t2", payload: { engine: "caveman" } },
            wake("t2", "1 chat changed: Rate limit the API working"),
            ...tool("t2", "t2-a", "chat_digest"),
            moment(
              "mo-plan",
              minutes(-25),
              {
                kind: "plan",
                workspace_id: "ws-4",
                item_id: "ci-4",
                text: "I'll put a token bucket in front of /api, keyed by account, with the limits in config.",
              },
              "Rate limit the API has a plan",
            ),
            ...tool("t2", "t2-b", "queue_update"),
            { type: "turn.done", turn_id: "t2", payload: { status: "completed" } },
          ]),
          moment(
            "mo-needs",
            minutes(-20),
            {
              kind: "needs_you",
              workspace_id: "ws-2",
              item_id: "ci-2",
              text: "Should dark mode follow the system setting, or start dark?",
              ask: {
                id: "ask-7",
                kind: "question",
                question_id: "q1",
                recommended: { option_id: "system", label: "Follow the system setting" },
              },
            },
            "Dark mode in settings needs you",
          ),
          // A question the chat asked in its report: no card id, its chat idle while the item waits on the person.
          moment(
            "mo-worded",
            minutes(-15),
            {
              kind: "needs_you",
              workspace_id: "ws-5",
              item_id: "ci-5",
              text: "Comma or semicolon as the separator?",
            },
            "Export to CSV needs you",
          ),
          moment(
            "mo-result",
            minutes(-10),
            { kind: "result", workspace_id: "ws-3", item_id: "ci-3" },
            "Search the board is ready",
          ),
          // The result's narration: the wake the runtime started for its lines and diagram.
          ...stamped(
            minutes(-9),
            turn(
              "t3",
              [wake("t3", "1 chat changed: Search the board done")],
              tool("t3", "t3-a", "chat_digest"),
              [said("t3", "t3-r", "Search is on the board: type to filter work by title.")],
            ),
          ),
          moment(
            "mo-news",
            minutes(-5),
            {
              kind: "news",
              text: "Two new bug reports since this morning: the export button and a slow board.",
            },
            "Bug check",
          ),
          ...later,
        ],
      },
    }),
    { "caveman.chief.read.c-app": minutes(-45) },
  );
  await expect.element(page.getByRole("log")).toBeVisible();
  return mounted;
}

const card = (kind: ChiefMoment["kind"]) =>
  log().element().querySelector(`[data-moment="${kind}"]`) as HTMLElement | null;

describe("the Chief's moments", () => {
  test("each moment is its card, a silent wake keeps its moment and draws no line, and what came since you looked is one away group", async () => {
    await openMoments();
    await expect.element(log().getByText("Follow the system setting")).toBeVisible();
    // Started: one line, the chat's live mark and title.
    expect(card("started")?.textContent).toContain("Fix the login redirect");
    // Plan: the chat, then its own words.
    expect(card("plan")?.textContent).toContain("Rate limit the API");
    expect(card("plan")?.textContent).toContain("token bucket in front of /api");
    // Needs you: the question and the answer the chat recommends.
    expect(card("needs_you")?.textContent).toContain(
      "Should dark mode follow the system setting, or start dark?",
    );
    await expect.element(log().getByRole("button", { name: "Use this" })).toBeVisible();
    // Result: the chat, its pull request, and Open preview.
    expect(card("result")?.textContent).toContain("#41 · CI passing");
    await expect.element(log().getByRole("button", { name: "Open preview" })).toBeVisible();
    // Its narration follows the card with no wake line or "Worked" line between.
    const narration = log()
      .getByText("Search is on the board: type to filter work by title.")
      .element();
    expect(
      card("result")!.compareDocumentPosition(narration) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect
      .element(log().getByText("1 chat changed: Search the board done"))
      .not.toBeInTheDocument();
    // News: the routine's report.
    expect(card("news")?.textContent).toContain("Two new bug reports since this morning");
    // The silent wake drew nothing of its own: no wake line, and no turn draws a Worked row.
    await expect
      .element(log().getByText("1 chat changed: Rate limit the API working"))
      .not.toBeInTheDocument();
    expect(
      log()
        .getByRole("button", { name: /^Worked/ })
        .elements(),
    ).toHaveLength(0);
    // The moments since you last looked come under "While you were away", not "New".
    await expect.element(log().getByText("While you were away")).toBeVisible();
    await expect.element(log().getByText("New", { exact: true })).not.toBeInTheDocument();
    const heading = log().getByText("While you were away").element();
    expect(
      heading.compareDocumentPosition(card("started")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(log().getByText("Started them.").element()) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  test("Use this answers the chat's own card on its session, and the card reads settled", async () => {
    const { peer } = await openMoments();
    await userEvent.click(log().getByRole("button", { name: "Use this" }));
    const { params } = await peer.nextCall("ask.respond");
    expect(params).toMatchObject({
      session_id: "s-ws-2",
      ask_id: "ask-7",
      response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["system"] }] },
    });
    await expect.element(log().getByRole("button", { name: "Use this" })).not.toBeInTheDocument();
    expect(card("needs_you")?.textContent).toContain("answered");
  });

  test("a question asked in a report waits while its item does, though its chat is idle, with no Use this", async () => {
    await openMoments();
    const worded = log().getByRole("region", { name: "Export to CSV needs you" });
    await expect.element(worded).toBeVisible();
    expect(worded.element().textContent).toContain("Comma or semicolon as the separator?");
    expect(worded.element().textContent).toContain("asks");
    expect(worded.element().textContent).not.toContain("answered");
    expect(worded.getByRole("button", { name: "Use this" }).elements()).toHaveLength(0);
  });

  test("a chat's later question settles its earlier card, which keeps no Use this, though the chat waits again", async () => {
    await openMoments([
      moment(
        "mo-needs-2",
        minutes(-3),
        {
          kind: "needs_you",
          workspace_id: "ws-2",
          item_id: "ci-2",
          text: "Which accent color in dark mode?",
          ask: {
            id: "ask-8",
            kind: "question",
            question_id: "q1",
            recommended: { option_id: "blue", label: "Keep the blue" },
          },
        },
        "Dark mode in settings needs you",
      ),
    ]);
    await expect.element(log().getByText("Keep the blue")).toBeVisible();
    const [first, second] = log()
      .element()
      .querySelectorAll<HTMLElement>(
        '[data-moment="needs_you"][aria-label="Dark mode in settings needs you"]',
      );
    expect(first?.textContent).toContain("answered");
    expect(first?.textContent).not.toContain("Use this");
    expect(second?.textContent).toContain("Use this");
    expect(log().getByRole("button", { name: "Use this" }).elements()).toHaveLength(1);
  });

  test("a question answered elsewhere reads settled as the chat moves on", async () => {
    const { peer } = await openMoments();
    await expect.element(log().getByRole("button", { name: "Use this" })).toBeVisible();
    peer.change("ws-2", { status: "working" });
    await expect.element(log().getByRole("button", { name: "Use this" })).not.toBeInTheDocument();
    expect(card("needs_you")?.textContent).toContain("answered");
  });
});

const reaction = (id: string, message: string, emoji: "👍" | "👀" | "✅" | "❤️"): EventDraft => ({
  type: "notification",
  item_id: id,
  payload: {
    level: "info",
    title: `Reacted ${emoji}`,
    moment: { kind: "reaction", message_id: message, emoji },
  },
});
/** Your bubble holding `text`. */
const bubbleOf = (text: string) =>
  log().getByText(text, { exact: true }).element().closest<HTMLElement>('[data-slot="bubble"]')!;

describe("the Chief's reactions", () => {
  test("a reaction is a badge over the corner of the bubble it answers, the latest one, with no row of its own", async () => {
    const { peer } = await mountApp(
      "/chief/c-app",
      runtimeFixture({
        chiefs: [APP],
        workspaces: [workspace("c-app", { kind: "chief", title: "app" })],
        events: {
          "c-app": [
            ...turn(
              "t1",
              [said("t1", "t1-u", "Queue the docs pass", "user")],
              [said("t1", "t1-r", "It's on the board for tomorrow.")],
            ),
            ...turn("t2", [said("t2", "t2-u", "And the flaky login test", "user")]),
            reaction("re-1", "t2-u", "👀"),
          ],
        },
      }),
    );
    const badge = log().getByRole("img", { name: "app reacted 👀" });
    await expect.element(badge).toBeVisible();
    // On the bubble of the message it answers, and on no other.
    expect(bubbleOf("And the flaky login test").contains(badge.element())).toBe(true);
    expect(bubbleOf("Queue the docs pass").querySelector("[data-reaction]")).toBeNull();
    // No row of its own: no card, no notice line.
    await expect.element(log().getByText("Reacted 👀")).not.toBeInTheDocument();
    expect(log().element().querySelector('[data-moment="reaction"]')).toBeNull();
    // A small round chip over the bubble's top-left corner, in the deck's grey.
    const chip = badge.element().getBoundingClientRect();
    const corner = bubbleOf("And the flaky login test").getBoundingClientRect();
    expect(Math.round(chip.width)).toBe(20);
    expect(chip.left).toBeLessThan(corner.left);
    expect(chip.right).toBeGreaterThan(corner.left);
    expect(chip.top).toBeLessThan(corner.top);
    expect(chip.bottom).toBeGreaterThan(corner.top);
    expect(getComputedStyle(badge.element()).backgroundColor).not.toBe(
      getComputedStyle(bubbleOf("And the flaky login test")).backgroundColor,
    );

    // One arriving live overlaps its bubble's corner: nothing in the conversation moves.
    const reply = log().getByText("It's on the board for tomorrow.").element();
    const before = [
      bubbleOf("Queue the docs pass").getBoundingClientRect(),
      reply.getBoundingClientRect(),
    ].map((r) => [r.top, r.height]);
    peer.emit("c-app", reaction("re-2", "t1-u", "👍"));
    await expect.element(log().getByRole("img", { name: "app reacted 👍" })).toBeVisible();
    expect(bubbleOf("Queue the docs pass").querySelector('[data-reaction="👍"]')).not.toBeNull();
    expect(
      [bubbleOf("Queue the docs pass").getBoundingClientRect(), reply.getBoundingClientRect()].map(
        (r) => [r.top, r.height],
      ),
    ).toEqual(before);

    // A later reaction on the same message takes the earlier one's place.
    peer.emit("c-app", reaction("re-3", "t2-u", "✅"));
    await expect.element(log().getByRole("img", { name: "app reacted ✅" })).toBeVisible();
    await expect
      .element(log().getByRole("img", { name: "app reacted 👀" }))
      .not.toBeInTheDocument();
    expect(bubbleOf("And the flaky login test").querySelectorAll("[data-reaction]")).toHaveLength(
      1,
    );
  });
});
