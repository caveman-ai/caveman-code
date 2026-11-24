import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { skillMarkdown } from "./Create.tsx";

// Engines read a SKILL.md's front matter as YAML (the runtime's parseFrontmatter, Claude Agent), so what the person
// typed in "When to use it" has to come back from a YAML read exactly as typed.
const frontMatter = (markdown: string): unknown =>
  parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(markdown)![1]!);

test.each([
  "Write the weekly release notes",
  "Use when: writing release notes",
  '"Release" notes for the week',
  "'Release' notes for the week",
  "[draft] release notes",
  "{draft} release notes",
  "- release notes",
  "@team release notes",
  "*bold* release notes",
  "> quoted release notes",
  "| piped release notes",
  "%TAG release notes",
  "Release notes # weekly",
  "true",
  "42",
  "null",
  "Notes \\ for the week, in naïve “quotes”",
])("a new skill's front matter keeps the description %j as typed", (description) => {
  expect(frontMatter(skillMarkdown("release-notes", description, "Write the notes."))).toEqual({
    name: "release-notes",
    description,
  });
});

test("a new skill's description is one line, its spacing folded", () => {
  const markdown = skillMarkdown(
    "release-notes",
    "  Use when:\n  writing\trelease notes  ",
    "\nWrite the notes.\n\n",
  );
  expect(frontMatter(markdown)).toEqual({
    name: "release-notes",
    description: "Use when: writing release notes",
  });
  expect(markdown.endsWith("---\n\nWrite the notes.\n")).toBe(true);
});
