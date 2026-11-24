// ), apps/web/src/textDirection.test.ts @ 3690c86253 (#22777).
import { describe, expect, it } from "vitest";
import { rehypeTextDirection, textDirection } from "./text-direction.ts";

describe("textDirection", () => {
  it.each([
    ["Arabic", "اكتب دالة تجمع الأرقام", "rtl"],
    ["Hebrew", "תקן את הבאג", "rtl"],
    ["English", "fix the failing test", "ltr"],
    ["Arabic that opens with an English term", "StrictMode: يعيد الـ render مرتين في التطوير", "rtl"],
    ["English quoting one Arabic word", "translate the label مرحبا for the login screen", "ltr"],
    [
      "tied sentences use the whole-text word majority",
      "Done. تم إصلاح المشكلة في الملف الرئيسي",
      "rtl",
    ],
    ["a tie, by its first word", "React مكتبة", "ltr"],
    ["a tie that opens in Arabic", "مكتبة React", "rtl"],
    ["Arabic around numbers and punctuation", "عدّل السطر 42، ثم شغّل الاختبارات (3)", "rtl"],
    [
      "mostly Arabic sentences beside one long English one",
      "هذا مثال على paragraph يحتوي على نص عربي و English words معًا. Arabic text should flow right-to-left while English words like JavaScript, React, and API should remain left-to-right within the same line. الأرقام 1234567890 ورموز مثل @username و #hashtag و 100$ تظهر في الاتجاه الصحيح. هذه جملة لاختبار RTL rendering في المتصفح أو المحرر.",
      "rtl",
    ],
    [
      "mostly English sentences beside one Arabic one",
      "Run the migration first. ثم شغّل الاختبارات كلها. Then deploy to staging.",
      "ltr",
    ],
    [
      "Arabic with inline abbreviations",
      "هذه جملة عربية تتحدث عن e.g. React i.e. TypeScript JavaScript",
      "rtl",
    ],
    [
      "an abbreviation at a sentence boundary",
      "This long English sentence describes the technology sector in the U.S. هذه جملة عربية. وهذه جملة عربية أخرى.",
      "rtl",
    ],
  ])("reads %s", (_, text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });

  it("leaves text without letters to its surroundings", () => {
    expect(textDirection("42 — 7 ✓")).toBeUndefined();
  });
});

describe("rehypeTextDirection", () => {
  const el = (tagName: string, ...children: object[]) => ({ type: "element", tagName, properties: {}, children });
  const text = (value: string) => ({ type: "text", value });

  it("sets each top-level block's direction, leaves code blocks alone and isolates inline code", () => {
    const code = el("code", text("const x = 1; const y = 2; const z = 3"));
    const tree = { type: "root", children: [el("p", text("شغّل "), code, text(" ثم تحقق")), el("p", text("fix the test")), el("pre", el("code", text("مرحبا بالعالم")))] };
    rehypeTextDirection()(tree);
    const [rtl, ltr, pre] = tree.children as Array<{ properties: Record<string, unknown>; children: Array<{ properties?: Record<string, unknown> }> }>;
    expect(rtl!.properties.dir).toBe("rtl");
    expect(ltr!.properties.dir).toBe("ltr");
    expect(pre!.properties.dir).toBeUndefined();
    expect(code.properties).toEqual({ dir: "ltr" });
    expect(pre!.children[0]!.properties).toEqual({});
  });
});
