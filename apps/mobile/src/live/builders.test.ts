// A lead's builders in the desktop's words: what became of each, and the one result once their work came together.
import type { BuildersResult } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import { builderWords, generatedLine, resultLine } from "./builders";

/** Tuesday Nov 10 2026, 3:00 PM in New York. */
const NOW = Date.parse("2026-11-10T20:00:00.000Z");
const ZONE = "America/New_York";

describe("what became of a builder", () => {
  const said = (builder: Parameters<typeof builderWords>[0]) => {
    const { words, tone } = builderWords(builder, NOW, ZONE);
    return [words, tone];
  };

  it("is one state in words, each with its one colour", () => {
    expect(said({ state: "working" })).toEqual(["Working", "quiet"]);
    expect(said({ state: "done" })).toEqual(["Done", "quiet"]);
    expect(said({ state: "merged" })).toEqual(["Merged", "quiet"]);
    expect(said({ state: "left_out", why: "conflicts in a.ts" })).toEqual([
      "Left out: conflicts in a.ts",
      "warn",
    ]);
    expect(said({ state: "failed", why: "its agent stopped" })).toEqual([
      "Failed: its agent stopped",
      "bad",
    ]);
    // With no reason given, the state alone: never a colon and nothing after it.
    expect(said({ state: "left_out" })).toEqual(["Left out", "warn"]);
    expect(said({ state: "failed", why: "  " })).toEqual(["Failed", "bad"]);
  });

  it("says until when a paused builder waits, in the person's own clock, and only Paused when its plan named no time", () => {
    expect(
      said({ state: "paused", until: "2026-11-11T04:08:00.000Z", plan: "Claude plan" }),
    ).toEqual(["Paused until 11:08 PM", "warn"]);
    expect(said({ state: "paused", until: "2026-11-14T12:44:00.000Z" })).toEqual([
      "Paused until Sat 7:44 AM",
      "warn",
    ]);
    expect(said({ state: "paused" })).toEqual(["Paused", "warn"]);
    // A reset already past says no time: it carries on by itself.
    expect(said({ state: "paused", until: "2026-11-10T19:00:00.000Z" })).toEqual([
      "Paused",
      "warn",
    ]);
    expect(
      builderWords({ state: "paused", until: "2026-11-11T04:08:00.000Z" }, NOW, "UTC").words,
    ).toBe("Paused until Wed 4:08 AM");
  });

  it("only a builder at work lets its row say what it is doing now instead", () => {
    expect(builderWords({ state: "working" }, NOW).working).toBe(true);
    for (const state of ["done", "merged", "left_out", "paused", "failed"] as const)
      expect(builderWords({ state }, NOW).working).toBe(false);
  });
});

describe("a lead's builders' one result", () => {
  const result = (patch: Partial<BuildersResult> = {}): BuildersResult => ({
    total: 30,
    merged: 28,
    left_out: [
      { title: "Port the settings page", why: "conflicts in a.ts" },
      { title: "Port the sidebar", why: "its agent stopped" },
    ],
    pull_requests: [{ number: 128, url: "https://github.com/acme/app/pull/128" }],
    ...patch,
  });

  it("is one line: how many merged, how many were left out, and the pull request", () => {
    expect(resultLine(result())).toBe("28 of 30 merged · 2 left out · PR #128");
    expect(resultLine(result({ merged: 30, left_out: [] }))).toBe("30 of 30 merged · PR #128");
    // One pull request per repository the lead works in.
    expect(
      resultLine(
        result({
          pull_requests: [
            { number: 128, url: "u", repo: "acme/app" },
            { number: 57, url: "u", repo: "acme/api" },
          ],
        }),
      ),
    ).toBe("28 of 30 merged · 2 left out · PR #128, #57");
    expect(resultLine(result({ pull_requests: [] }))).toBe(
      "28 of 30 merged · 2 left out · no pull request",
    );
  });

  it("is what the chat shows for the message the runtime wrote, never the instructions the agent was given", () => {
    const text =
      "[Caveman Code] Your builders have finished. Review the merged branch and open a pull request.";
    expect(
      generatedLine({ text, generated: { shown: "Builders finished" }, builders_result: result() }),
    ).toBe("28 of 30 merged · 2 left out · PR #128");
    // No pull request was opened: why, in the runtime's own sentence for a person.
    expect(
      generatedLine({
        text,
        generated: { shown: "" },
        builders_result: result({
          pull_requests: [],
          problem: "GitHub isn't connected on this Mac.",
        }),
      }),
    ).toBe("28 of 30 merged · 2 left out · no pull request\n\nGitHub isn't connected on this Mac.");
  });
});

describe("a message the runtime wrote for the agent", () => {
  it("reads as its one line for a person", () => {
    expect(
      generatedLine({
        text: "Carry on from where you stopped. Do not repeat finished work.",
        generated: { shown: "Carried on after the plan reset" },
      }),
    ).toBe("Carried on after the plan reset");
    expect(
      generatedLine({
        text: "…",
        generated: { shown: "Port the settings page finished" },
        from: { title: "Port the settings page" },
      }),
    ).toBe("Port the settings page finished");
    // The line does not name who wrote it: the builder's title leads.
    expect(
      generatedLine({
        text: "…",
        generated: { shown: "Finished" },
        from: { title: "Port the sidebar" },
      }),
    ).toBe("Port the sidebar: Finished");
    expect(generatedLine({ text: "…", generated: { shown: "  " } })).toBe("Agent finished");
  });

  it("reads history from before the runtime said so, by its bracket lines", () => {
    expect(
      generatedLine({
        text: '[Builder "Port the sidebar" finished its turn (completed)]\nIt changed 4 files.',
      }),
    ).toBe("Port the sidebar finished");
    expect(generatedLine({ text: '[Builder "Port the sidebar" was stopped]' })).toBe(
      "Port the sidebar stopped",
    );
    expect(generatedLine({ text: '[Builder "Port the sidebar" failed: exit 1]' })).toBe(
      "Port the sidebar failed",
    );
    expect(
      generatedLine({
        text: "[Caveman Code] Your builders have finished. 28 of 30 builders merged. Pull request: https://github.com/acme/app/pull/128",
      }),
    ).toBe("28 of 30 merged · 2 left out · PR #128");
    expect(generatedLine({ text: "[Caveman Code] Your builders have finished." })).toBe(
      "Agents finished",
    );
  });

  it("leaves the person's own words, and another chat's, alone", () => {
    expect(generatedLine({ text: "Make the relay test stop flaking" })).toBeNull();
    expect(generatedLine({ text: "Use the new endpoint", from: { title: "Lead" } })).toBeNull();
    expect(generatedLine({ text: "[Builder] is a word I typed" })).toBeNull();
  });
});
