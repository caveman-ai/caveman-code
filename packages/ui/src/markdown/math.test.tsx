import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Response } from "../ai/response.tsx";
import { Markdown } from "./Markdown.tsx";
import { MarkdownMath } from "./MarkdownMath.tsx";
import { typeset } from "./math-typeset.ts";

const chat = (md: string, streaming = false) => renderToStaticMarkup(<Response streaming={streaming}>{md}</Response>);

test("formulas in an answer are math, in each delimiter models write; prices and shell variables stay prose", () => {
  expect(chat("Area is $\\pi r^2$ here.")).toContain('data-math="inline" data-math-source="\\(\\pi r^2\\)"');
  expect(chat("Or \\(a+b\\) inline.")).toContain('data-math-source="\\(a+b\\)"');
  expect(chat("$$\nE = mc^2\n$$")).toContain('data-math="display" data-math-source="\\[\nE = mc^2\n\\]"');
  expect(chat("\\[\nx\n\\]")).toContain('data-math="display"');
  for (const prose of ["It costs $5 and $10.", "Set $HOME before running.", "Plans are $5/$10 monthly."]) {
    const out = chat(prose);
    expect(out, prose).not.toContain("data-slot=\"math\"");
    expect(out, prose).toContain(prose);
  }
  // Code keeps its dollars.
  expect(chat("Run `echo $x$` now.")).not.toContain('data-slot="math"');
});

test("a ```math fence draws once it closes; until then it shows as code", () => {
  const open = "```math\n\\frac{a}{b}";
  expect(chat(open, true)).not.toContain('data-slot="math"');
  expect(chat(`${open}\n\`\`\`\n\nThen more`, true)).toContain('data-math="display"');
  expect(chat(open)).toContain('data-math="display"');
});

test("a document reads LaTeX too; until KaTeX loads a formula shows its source", () => {
  const out = renderToStaticMarkup(<Markdown source={"# Energy\n\nWe have $E=mc^2$.\n\n```math\na^2+b^2=c^2\n```"} />);
  expect(out).toContain('data-math="inline"');
  expect(out).toContain('data-math="display"');
  expect(out).toContain("\\(E=mc^2\\)");
});

test("KaTeX typesets with MathML for screen readers, and returns nothing for TeX it can't parse", () => {
  const html = typeset("\\frac{1}{2}", false);
  expect(html).toContain('class="katex"');
  expect(html).toContain("<math");
  expect(typeset("\\frac{1}{", false)).toBe("");
  // No active HTML from TeX: \href and \htmlClass need trust, which is off.
  expect(typeset("\\href{javascript:alert(1)}{x}", false)).not.toMatch(/<a\b|href=/);
});

test("a formula that fits is no Tab stop and has no scroll label; it becomes one only once it overflows (T3's #23954)", () => {
  const html = renderToStaticMarkup(<MarkdownMath tex="x^2" display />);
  expect(html).not.toContain("tabindex");
  expect(html).not.toContain("Scroll display equation");
  expect(html).toContain('aria-label="Display equation"');
});
