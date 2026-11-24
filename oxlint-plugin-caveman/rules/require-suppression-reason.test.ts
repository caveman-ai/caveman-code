// ), oxlint-plugin-t3code/rules/require-suppression-reason.test.ts @ 67eebaca23.
import { describe, expect, it } from "vitest";

import { lintFixture } from "../test/lint.ts";

const RULE = "caveman/require-suppression-reason";

describe(RULE, () => {
  it.each([
    [
      "a directive with a -- reason",
      `
      // oxlint-disable-next-line no-control-regex -- ANSI sequences start with ESC.
      const ansi = /\\x1b\\[/;
      /* eslint-disable no-console -- this script reports to the terminal */
    `,
    ],
    [
      "a directive explained by the comment above",
      `
      // Positions are stable for a given string.
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
    ],
    [
      "stacked directives under one explanation",
      `
      // The fixture is invalid on purpose.
      // @ts-expect-error
      // oxlint-disable-next-line no-unused-vars
      const value: number = "text";
    `,
    ],
    [
      "a TypeScript directive followed by its reason",
      `
      // @ts-expect-error the fixture passes a string on purpose
      const count: number = "text";
    `,
    ],
    [
      "a directive in a JSX comment with a reason",
      `const el = <div>{/* oxlint-disable-next-line react/no-danger -- sanitized above */}</div>;`,
    ],
    ["enable directives", `/* oxlint-enable no-console */`],
    [
      "an empty comment line between the reason and the directive",
      `
      // Positions are stable for a given string.
      //
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
    ],
  ])("allows %s", (_name, source) => {
    const result = lintFixture(RULE, source);
    expect(result.failed, result.output).toBe(false);
  });

  it.each([
    [
      "a lint directive without a reason",
      `
      // oxlint-disable-next-line no-control-regex
      const ansi = /\\x1b\\[/;
    `,
      /end the directive with `-- reason`/,
    ],
    [
      "a file-level directive without a reason",
      `/* oxlint-disable eslint/no-useless-escape */`,
      /-- reason/,
    ],
    [
      "a TypeScript directive without a reason",
      `
      // @ts-expect-error
      const count: number = "text";
    `,
      /write the reason after the directive/,
    ],
    [
      "a directive whose only comment is a blank line away",
      `
      // Positions are stable for a given string.

      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
      /-- reason/,
    ],
    [
      "a directive under empty comments",
      `
      //
      /* */
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
      /-- reason/,
    ],
    [
      "a directive under a trailing comment on the code line above",
      `
      const first = 1; // the first value
      const second = 2; // oxlint-disable-line no-unused-vars
    `,
      /-- reason/,
    ],
  ])("reports %s", (_name, source, message) => {
    const result = lintFixture(RULE, source);
    expect(result.failed, result.output).toBe(true);
    expect(result.output).toMatch(/caveman\(require-suppression-reason\)/);
    expect(result.output).toMatch(message);
  });
});
