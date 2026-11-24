// What a person reads of a message the runtime wrote for the agent: one quiet line, or a lead's builders' one result
// row, never the instructions and never the bracket lines older history carries.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { generatedOf, legacyGenerated, resultLine } from "./generated.ts";
import { SessionModel } from "./transcript.ts";

const result = (
  over: Partial<Parameters<typeof generatedOf>[0]["builders_result"] & object> = {},
) => ({
  total: 30,
  merged: 28,
  left_out: [
    { workspace_id: "w-7", title: "Port the theme", why: "conflicts in a.ts" },
    { title: "Port the inbox", why: "its tests fail" },
  ],
  pull_requests: [{ number: 128, url: "https://github.com/acme/web/pull/128" }],
  ...over,
});

test("the builders' one result reads as one row: merged of total, how many are left out, the pull requests", () => {
  const one = generatedOf({
    text: "Your builders have finished: (instructions)",
    generated: { shown: "Builders finished" },
    builders_result: result(),
  })!;
  expect(one.line).toBe("28 of 30 merged · 2 left out · PR #128");
  expect(one.result!.leftOut).toEqual([
    { workspaceId: "w-7", title: "Port the theme", why: "conflicts in a.ts" },
    { title: "Port the inbox", why: "its tests fail" },
  ]);
  // One pull request per repository; none, with why.
  const two = generatedOf({
    text: "",
    generated: { shown: "" },
    builders_result: result({
      pull_requests: [
        { number: 128, url: "https://github.com/acme/web/pull/128", repo: "acme/web" },
        { number: 57, url: "https://github.com/acme/api/pull/57", repo: "acme/api" },
      ],
    }),
  })!;
  expect(two.line).toBe("28 of 30 merged · 2 left out · PR #128, #57");
  const none = generatedOf({
    text: "",
    generated: { shown: "" },
    builders_result: result({
      pull_requests: [],
      problem: "GitHub refused the pull request: the branch is protected.",
    }),
  })!;
  expect(none.line).toBe("28 of 30 merged · 2 left out · no pull request");
  expect(none.result!.problem).toBe("GitHub refused the pull request: the branch is protected.");
  // All merged: nothing left out to say.
  expect(
    resultLine(
      generatedOf({
        text: "",
        generated: { shown: "" },
        builders_result: result({ merged: 30, left_out: [] }),
      })!.result!,
    ),
  ).toBe("30 of 30 merged · PR #128");
});

test("a builder's own result is its one line, naming its sender only when the line does not", () => {
  const from = { workspace_id: "w-3", title: "Port the settings page" };
  expect(
    generatedOf({
      text: "[Builder …] long instructions",
      from,
      generated: { shown: "Port the settings page finished" },
    }),
  ).toEqual({ line: "Port the settings page finished", fromChat: true });
  expect(
    generatedOf({ text: "Carry on.", from, generated: { shown: "Plan reset, carrying on" } }),
  ).toEqual({
    line: "Plan reset, carrying on",
    fromChat: true,
    sender: { title: "Port the settings page", workspaceId: "w-3" },
  });
  // The person's own words, and another chat's agent's message, are not the runtime's.
  expect(generatedOf({ text: "Ship it" })).toBeNull();
  expect(generatedOf({ text: "Can you look at the API?", from })).toBeNull();
});

test("history before the field: the bracket lines read as the same quiet rows, never shown as they are", () => {
  expect(
    legacyGenerated(
      '[Builder "Port the settings page" finished its turn (on this computer, workspace ws_1)]\nIt is done.',
    )?.line,
  ).toBe("Port the settings page finished");
  expect(legacyGenerated('[Builder "Port the inbox" was stopped (by its lead)]')?.line).toBe(
    "Port the inbox stopped",
  );
  expect(legacyGenerated('[Builder "Port the theme" failed (its agent exited)]')?.line).toBe(
    "Port the theme failed",
  );
  const summary = legacyGenerated(
    "[Caveman Code] Your builders have finished. 28 of 30 branches are merged into caveman/port-settings: … Not in: X (it still conflicts). One pull request carries it all, with a note from each builder: https://github.com/acme/web/pull/128",
  )!;
  expect(summary.line).toBe("28 of 30 merged · 2 left out · PR #128");
  expect(summary.result!.pullRequests).toEqual([
    { number: 128, url: "https://github.com/acme/web/pull/128" },
  ]);
  expect(legacyGenerated("[Caveman Code] Your builders have finished.")?.line).toBe(
    "Agents finished",
  );
  expect(legacyGenerated("Ship it")).toBeNull();
  expect(legacyGenerated("Why does [Builder x] fail?")).toBeNull();
});

test("the transcript marks such a message generated, so it is drawn as a row and never as the person's bubble", () => {
  let cursor = 0;
  const ev = (payload: unknown): SessionEvent =>
    ({
      session_id: "s1",
      cursor: ++cursor,
      at: "2026-11-10T12:00:00.000Z",
      type: "message.done",
      item_id: `m${cursor}`,
      payload,
    }) as SessionEvent;
  const m = new SessionModel();
  m.apply(ev({ role: "user", text: "Ship it" }));
  m.apply(
    ev({
      role: "user",
      text: "(instructions for the lead)",
      generated: { shown: "Builders finished" },
      builders_result: result(),
    }),
  );
  m.apply(
    ev({
      role: "user",
      text: '[Builder "Port the inbox" finished its turn (on this computer, workspace ws_2)]',
      from: { workspace_id: "w-2", title: "Port the inbox" },
    }),
  );
  const users = m.snapshot().items.filter((i) => i.kind === "user");
  expect(users.map((u) => (u.kind === "user" ? (u.generated?.line ?? null) : null))).toEqual([
    null,
    "28 of 30 merged · 2 left out · PR #128",
    "Port the inbox finished",
  ]);
});
