import { expect, test } from "vitest";
import { CHIP_PAIR_CLASS, rehypeChipPunctuation } from "./chip-punctuation.ts";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: object[]) => ({
  type: "element",
  tagName,
  properties: {} as Record<string, unknown>,
  children,
});

function paired(block: ReturnType<typeof element>) {
  rehypeChipPunctuation()({ type: "root", children: [block] });
  return block.children;
}

test("a link or inline code and the punctuation after it share one span (T3's #26871)", () => {
  const link = element("a", [text("a.ts")]);
  expect(paired(element("p", [text("See "), link, text("... next")]))).toEqual([
    text("See "),
    expect.objectContaining({
      tagName: "span",
      properties: { className: [CHIP_PAIR_CLASS] },
      children: [link, text("...")],
    }),
    text(" next"),
  ]);
  const code = element("code", [text("retry.go")]);
  expect(paired(element("p", [code, text(").")]))).toEqual([
    expect.objectContaining({ tagName: "span", children: [code, text(").")] }),
  ]);
});

test("words after a chip, and code blocks, are left alone", () => {
  const code = element("code", [text("a.ts")]);
  expect(paired(element("p", [code, text(" and more")]))).toEqual([code, text(" and more")]);
  const children = [element("code", [text("a.ts")]), text(".")];
  expect(paired(element("pre", [...children]))).toEqual(children);
});
