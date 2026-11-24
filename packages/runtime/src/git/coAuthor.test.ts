import { describe, expect, it } from "vitest";
import { CAVEMAN_CO_AUTHOR, CAVEMAN_PR_FOOTER, coAuthorOn, withCoAuthor, withPrFooter } from "./coAuthor.ts";

describe("withCoAuthor", () => {
  it("adds the trailer after a blank line, once", () => {
    const once = withCoAuthor("fix: retry storms\n");
    expect(once).toBe(`fix: retry storms\n\n${CAVEMAN_CO_AUTHOR}`);
    expect(withCoAuthor(once)).toBe(once);
  });

  it("joins an existing trailer block and keeps the user's own trailers", () => {
    const message = "feat: x\n\nWhy it matters.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
    expect(withCoAuthor(message)).toBe(`${message}\n${CAVEMAN_CO_AUTHOR}`);
  });

  it("never mistakes a subject or a prose paragraph for trailers", () => {
    expect(withCoAuthor("docs: note: this")).toBe(`docs: note: this\n\n${CAVEMAN_CO_AUTHOR}`);
    expect(withCoAuthor("feat: x\n\nSee the issue.")).toBe(`feat: x\n\nSee the issue.\n\n${CAVEMAN_CO_AUTHOR}`);
  });
});

describe("withPrFooter", () => {
  it("appends the footer once, or stands alone in an empty body", () => {
    expect(withPrFooter(undefined)).toBe(CAVEMAN_PR_FOOTER);
    const body = withPrFooter("Summary\n");
    expect(body).toBe(`Summary\n\n${CAVEMAN_PR_FOOTER}`);
    expect(withPrFooter(body)).toBe(body);
  });
});

describe("coAuthorOn", () => {
  it("is on unless the setting says false", () => {
    expect(coAuthorOn(undefined)).toBe(true);
    expect(coAuthorOn("{}")).toBe(true);
    expect(coAuthorOn('{"git_co_author":true}')).toBe(true);
    expect(coAuthorOn('{"git_co_author":false}')).toBe(false);
  });
});
