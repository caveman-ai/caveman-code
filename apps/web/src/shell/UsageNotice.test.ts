import { describe, expect, it } from "vitest";

import { noticeText } from "./UsageNotice.tsx";

describe("the one-time usage notice", () => {
  it("names what an older line left out, and says crash reports go to Sentry with secrets taken out", () => {
    expect(noticeText({ turnsDisclosed: true, reportsDisclosed: false })).toMatch(
      /^Crash reports now include where the app failed.*Sentry.*Never prompts or code\.$/,
    );
    expect(noticeText({ turnsDisclosed: false, reportsDisclosed: false })).toMatch(
      /^Usage stats now include how each turn went.*crash reports.*Never prompts or code\.$/,
    );
    expect(noticeText({ turnsDisclosed: false })).toMatch(
      /^Usage stats now include how each turn went/,
    );
  });
});
