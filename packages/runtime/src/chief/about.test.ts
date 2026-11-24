// What a chat is about, with no model call: its key terms for the board, and chat_search's score.
import { describe, expect, test } from "vitest";

import { keyTerms, ownWords, queryTerms, score } from "./about.ts";
import { crewContract } from "./prompt.ts";

// The note that started the chat the Chief could not find: filler first, the topic after.
const WINDOWS_GOAL =
  "i need you to realyl dig deep into all of the things that could potentially break when installing caveman code from scratch on windows and macos. " +
  "my friend's windows laptop took forever to onboard, the setup was really slow.";
const RAW_TITLE = WINDOWS_GOAL.slice(0, 80);

describe("key terms", () => {
  test("a chat titled with its note's filler is about what the note goes on to say: the platforms lead, the filler and the project's name do not", () => {
    const terms = keyTerms({ title: RAW_TITLE, goal: WINDOWS_GOAL, project: "caveman-code" });
    expect(terms.slice(0, 2)).toEqual(["windows", "macos"]);
    expect(terms).toContain("installing");
    for (const filler of [
      "need",
      "dig",
      "deep",
      "things",
      "potentially",
      "brea",
      "caveman",
      "code",
    ])
      expect(terms).not.toContain(filler);
    expect(terms.length).toBeLessThanOrEqual(6);
  });

  test("a title the Chief wrote counts most; where the person's latest ask turned counts too", () => {
    const terms = keyTerms({
      title: "Stripe webhooks",
      goal: "Wire the stripe webhooks into billing.",
      ask: "now also the refund flow on the dashboard",
    });
    expect(terms.slice(0, 2)).toEqual(["stripe", "webhooks"]);
    expect(terms).toContain("refund");
  });

  test("a task the Chief started reads as its brief: not its crew rules, change set footer or report contract", () => {
    const task = `Goal: fix the gemini wrap bug.\n\n<crew_rules>\nUse pnpm\n</crew_rules>\n\n${crewContract("Chief")}`;
    expect(ownWords(task)).toBe("Goal: fix the gemini wrap bug.");
    expect(keyTerms({ goal: ownWords(task) })).toEqual(["fix", "gemini", "wrap", "bug"]);
    expect(
      ownWords("see https://github.com/o/r/pull/42 and [that chat](t3-context://thread/abc)"),
    ).toBe("see #42 and that chat");
  });
});

describe("search score", () => {
  test('"the windows session" finds the chat by its goal, not by the words that only point at a chat', () => {
    const terms = queryTerms("help the windows session out w that");
    expect(terms).toEqual(["window"]);
    const windows = score(terms, { title: RAW_TITLE, goal: WINDOWS_GOAL });
    const other = score(terms, {
      title: "Fix the gemini wrap",
      goal: "Fix the gemini wrap bug in the session list.",
    });
    expect(windows.score).toBeGreaterThan(0);
    expect(windows.matched).toEqual(["window (goal)"]);
    expect(other.score).toBe(0);
  });

  test("aliases, stems and word starts match; a title or key term outweighs a latest answer", () => {
    expect(
      score(queryTerms("the mac onboarding one"), { title: "x", goal: "slow onboard on macOS" })
        .matched,
    ).toEqual(["macos (goal)", "onboard (goal)"]);
    expect(
      score(queryTerms("installs"), { title: "x", goal: "installing from scratch" }).score,
    ).toBe(2);
    expect(
      score(queryTerms("#42"), {
        title: "x",
        answer: ownWords("PR: https://github.com/o/r/pull/42"),
      }).score,
    ).toBe(1);
    expect(score(queryTerms("billing"), { title: "Billing page" }).score).toBeGreaterThan(
      score(queryTerms("billing"), { title: "x", answer: "billing" }).score,
    );
    expect(
      score(queryTerms("auth"), { title: "x", branch: "caveman/fix-auth-redirect-1a2b3c" }).matched,
    ).toEqual(["auth (branch)"]);
    // The repository a chat works in finds it when nothing it says names that repository.
    expect(
      score(queryTerms("cloud"), { title: "Fix the relay reconnect", repos: ["cloud"] }).matched,
    ).toEqual(["cloud (repos)"]);
  });
});
