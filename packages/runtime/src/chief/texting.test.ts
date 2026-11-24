import { describe, expect, test } from "vitest";

import { textingProblems, type TextingRule } from "./texting.ts";

const cases: ReadonlyArray<{ rule: TextingRule; bad: string; good: string }> = [
  {
    rule: "heading",
    bad: "## Auth leak\nI found the leak in the auth middleware.",
    good: "I found the leak in the auth middleware. Want me to open a fix?",
  },
  {
    rule: "bold",
    bad: "I found **the leak** in the auth middleware.",
    good: "I found the leak in the auth middleware.",
  },
  {
    rule: "list",
    bad: "- [[12]] fixed the auth leak.\n- [[13]] waits on your review.",
    good: "[[12]] fixed the auth leak.\n\n[[13]] waits on your review.",
  },
  {
    rule: "steps",
    bad: "Step 1: I'll trace the expired token.",
    good: "I'll trace the expired token.",
  },
  {
    rule: "opener",
    bad: "Sure! I'll trace the expired token.",
    good: "I'll trace the expired token.",
  },
  { rule: "filler", bad: "Done.", good: "[[12]] fixed the auth leak." },
  {
    rule: "hedge",
    bad: "I would check the token refresh first.",
    good: "I'll check the token refresh first.",
  },
  {
    rule: "machinery",
    bad: "I added the auth fix to the board.",
    good: "The auth fix waits on your review.",
  },
  {
    rule: "long_paragraph",
    bad: "I found the leak in auth. The fix closes expired sessions. Want me to open it?",
    good: "I found the leak in auth. The fix closes expired sessions.\n\nWant me to open it?",
  },
  {
    rule: "long_sentence",
    bad: "I found that the login button wraps on narrow screens because its fixed width leaves no room for the longer label when the browser increases text size.",
    good: "The login button wraps on narrow screens because its width is fixed. I'll let the label set its width.",
  },
];

describe("textingProblems", () => {
  test.each(cases)("flags $rule and accepts its close variant", ({ rule, bad, good }) => {
    expect(textingProblems(bad)).toContainEqual(expect.objectContaining({ rule }));
    expect(textingProblems(good)).toEqual([]);
  });

  test.each(["**Auth** is fixed.", "__Auth__ is fixed.", "**A** is fixed."])(
    "flags bold: %s",
    (reply) => {
      expect(textingProblems(reply).map((p) => p.rule)).toContain("bold");
    },
  );

  test.each(["Auth leak\n===", "Auth leak\n---", "### Auth leak"])(
    "flags markdown headings: %s",
    (reply) => {
      expect(textingProblems(reply).map((p) => p.rule)).toContain("heading");
    },
  );

  test.each(["-", "*", "+", "•", "1.", "2)"])(
    "allows an explicitly requested list: %s",
    (marker) => {
      const reply = `${marker} [[12]] fixed the leak.\n${marker} [[13]] needs your review.`;
      expect(textingProblems(reply).map((p) => p.rule)).toContain("list");
      expect(textingProblems(reply, { listAsked: true })).toEqual([]);
    },
  );

  test("asking for a list does not exempt other rules", () => {
    expect(textingProblems("- **Auth** is fixed.", { listAsked: true })).toEqual([
      { rule: "bold", at: "**Auth**" },
    ]);
  });

  test.each(["Sure", "Great question", "Absolutely", "Got it", "Of course"])(
    "flags only leading opener: %s",
    (opener) => {
      expect(textingProblems(`${opener}. I'll check auth.`).map((p) => p.rule)).toContain("opener");
      expect(textingProblems(`The error says “${opener}”. I'll check auth.`)).toEqual([]);
    },
  );

  test.each(["Done.", "Queued.", "Started.", "On it.", "Noted.", "  noted!  ", "Done. Queued."])(
    "flags filler-only reply: %s",
    (reply) => {
      expect(textingProblems(reply).map((p) => p.rule)).toContain("filler");
    },
  );

  test("substance after an acknowledgement is not filler-only", () => {
    expect(textingProblems("Done. The fix closes expired sessions.")).toEqual([]);
  });

  test.each(["I would", "I could", "we could", "I'd suggest", "I’d suggest"])(
    "flags hedges about its own work: %s",
    (hedge) => {
      expect(textingProblems(`${hedge} check auth first.`).map((p) => p.rule)).toContain("hedge");
      expect(textingProblems("That change could break auth. I'll check it first.")).toEqual([]);
    },
  );

  test.each(["Step 1", "Step one", "step two"])("flags numbered instructions: %s", (step) => {
    expect(textingProblems(`${step}: I'll check auth.`).map((p) => p.rule)).toContain("steps");
    expect(textingProblems("The next step fixes auth.")).toEqual([]);
  });

  test.each([
    "chat_start",
    "chat_send",
    "chat_digest",
    "queue_add",
    "queue_update",
    "view_open",
    "memory_sql",
    "playbook",
    "brief",
    "the board",
    "my board",
    '<note item="12">',
    '<chat_update state="done">',
  ])("flags exposed machinery: %s", (machinery) => {
    expect(textingProblems(`I used ${machinery} for the auth fix.`).map((p) => p.rule)).toContain(
      "machinery",
    );
    expect(textingProblems(`The error is in \`${machinery}\`.`)).toEqual([]);
  });

  test("ignores machinery substrings in ordinary words, and remember and schedule as plain words", () => {
    expect(
      textingProblems(
        "The skateboard page and scheduled checks pass. The briefing starts tomorrow.",
      ),
    ).toEqual([]);
    expect(textingProblems("I'll remember that. The release is on schedule.")).toEqual([]);
  });

  test("keeps sentence boundaries out of abbreviations, versions, URLs, files and issue references", () => {
    expect(
      textingProblems(
        "[[12]] fixes v2.1 in README.md, e.g. #123. See https://example.com/fix/v2.1?q=README.md#123.",
      ),
    ).toEqual([]);
    expect(
      textingProblems("The fix covers auth, i.e. expired sessions. See src/auth.test.ts for #123."),
    ).toEqual([]);
    expect(
      textingProblems("README.md names v2.1. #123 tracks the fix. I'll open it.").map(
        (p) => p.rule,
      ),
    ).toContain("long_paragraph");
  });

  test("keeps sentence limits at 25 words", () => {
    const reply =
      "I found the auth leak in the token refresh handler and fixed it so expired sessions close before another request can reuse the old token";
    expect(reply.split(" ")).toHaveLength(25);
    expect(textingProblems(reply)).toEqual([]);
    expect(textingProblems(`1. ${reply}`, { listAsked: true })).toEqual([]);
    expect(textingProblems(`${reply} again`).map((p) => p.rule)).toContain("long_sentence");
  });

  test("ignores links, references and inline code", () => {
    expect(
      textingProblems(
        '[**Sure, the board**](https://example.com/brief(v2.1)) fixed [[chat:chat_start]]. See `queue_update("Step 1")`.',
      ),
    ).toEqual([]);
    expect(
      textingProblems("[Great question][fix]\n\n[fix]: https://example.com/the-board"),
    ).toEqual([]);
    expect(textingProblems("``Sure! I could schedule the board.``")).toEqual([]);
    expect(textingProblems("[[12]]. [[13]]. [[chat:auth]].")).toEqual([]);
  });

  test("requested lists keep sentence limits within each item", () => {
    expect(
      textingProblems(
        "1. [[12]] fixed auth.\n2. [[13]] fixed the phone layout.\n3. [[14]] waits on you.",
        { listAsked: true },
      ),
    ).toEqual([]);
    expect(
      textingProblems("- Auth is fixed. It closes expired sessions. Want me to open it?", {
        listAsked: true,
      }).map((p) => p.rule),
    ).toContain("long_paragraph");
  });

  test("ignores code fences, including long fences, tildes and unfinished blocks", () => {
    for (const [open, close] of [
      ["```ts", "```"],
      ["````markdown", "````"],
      ["~~~mermaid", "~~~"],
      ["```", ""],
    ]) {
      expect(
        textingProblems(
          `${open}\n# Heading\n**Bold**\n- Step 1: I could schedule the board. Done. Queued. Started.\n${close}`,
        ),
      ).toEqual([]);
    }
  });

  test("does not let a shorter fence expose code", () => {
    expect(textingProblems("````markdown\n```\n# Heading\nSure!\n````")).toEqual([]);
    expect(
      textingProblems("```ts\nconst fixed = true;\n```\n\nSure! I'll check auth.").map(
        (p) => p.rule,
      ),
    ).toContain("opener");
  });

  test("ignores markdown tables but checks prose around them", () => {
    const table =
      "| Option | Status |\n| :--- | ---: |\n| **Step 1** | I could schedule the board. Done. Queued. Started. |";
    expect(textingProblems(table)).toEqual([]);
    expect(textingProblems(`Auth is fixed.\n\n${table}\n\nI could check mobile.`)).toEqual([
      { rule: "hedge", at: "I could" },
    ]);
    expect(textingProblems("Option | Status\n--- | ---\n**Auth** | Done.")).toEqual([]);
  });

  test("accepts a clean multi-paragraph reply with mermaid and an item reference", () => {
    const reply = [
      "[[12]] found the leak in the auth middleware. Expired tokens kept sessions alive.",
      "The fix closes each session when its token expires. Want me to open it?",
      "```mermaid\nflowchart LR\n  A[Token expires] --> B[Session closes]\n  B --> C[Next request signs in]\n```",
      "[[chat:auth-fix]] covers the phone layout too.",
    ].join("\n\n");
    expect(textingProblems(reply)).toEqual([]);
  });

  test("returns readable excerpts of the original text, clipped to 80 characters", () => {
    const reply = `## ${"Auth fix ".repeat(15)}`;
    const problem = textingProblems(reply).find((p) => p.rule === "heading")!;
    expect(problem.at).toHaveLength(80);
    expect(problem.at).toBe(`${reply.slice(0, 79)}…`);
  });

  test.each(["", " \n\n ", "#123 fixes auth.", "I'm sure the fix holds. It passed on mobile."])(
    "accepts clean or empty text: %s",
    (reply) => {
      expect(textingProblems(reply)).toEqual([]);
    },
  );
});
