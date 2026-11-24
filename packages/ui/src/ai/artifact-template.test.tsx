import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Response } from "./response.tsx";

const DIRECTIVE = '::artifact-template{artifact_kind="image" display_name="Editorial portrait" gallery_kind="imagegen" skill_directory="/Users/test/.codex/skills/artifact-template-portrait" skill_name="artifact-template-portrait"}';
const render = (text: string, active = false, streaming = false) => renderToStaticMarkup(<Response onUseArtifactTemplate={active ? () => {} : undefined} streaming={streaming}>{text}</Response>);
const literal = (text: string) => {
  const html = render(text);
  expect(html).toContain("::artifact-template");
  expect(html).not.toContain('data-slot="artifact-template"');
  expect(html).not.toContain("Use template");
};

describe("artifact-template result cards (T3 Markdown behavior)", () => {
  it.each([false, true])("draws an accessible imagegen card, streaming=%s", (streaming) => {
    const html = render(DIRECTIVE, true, streaming);
    expect(html).toContain('role="group" aria-label="Editorial portrait template"');
    expect(html).toContain('data-artifact-kind="image" data-gallery-kind="imagegen"');
    expect(html).toContain("Image template");
    expect(html).toContain('type="button"');
    expect(html).toContain("Use template");
    expect(html).not.toContain("::artifact-template");
    expect(html).not.toMatch(/<p(?:\s|>)/); // no block card nested in a paragraph
    expect(html).not.toContain("skill_directory"); // local paths are metadata, not links or requests
  });

  it("is passive outside a composer-backed timeline", () => {
    const html = render(DIRECTIVE);
    expect(html).toContain('data-slot="artifact-template"');
    expect(html).not.toContain("Use template");
  });

  it.each([
    ["document", "Document template"], ["presentation", "Presentation template"],
    ["spreadsheet", "Spreadsheet template"], ["site", "Site template"],
    ["google-docs", "Google Doc template"], ["google-slides", "Google Slides template"],
    ["google-sheets", "Google Sheet template"], ["email", "Email template"], ["slack", "Slack template"],
  ])("uses the shared label and icon mapping for %s", (kind, label) => {
    expect(render(DIRECTIVE.replace('artifact_kind="image"', `artifact_kind="${kind}"`))).toContain(label);
  });

  it.each([
    DIRECTIVE.replace('skill_directory="/Users/test/.codex/skills/artifact-template-portrait" ', ""),
    DIRECTIVE.replace('skill_directory="/Users/test/.codex/skills/artifact-template-portrait"', 'skill_directory="relative/skill"'),
    DIRECTIVE.replace('artifact_kind="image"', 'artifact_kind="unknown"'),
    DIRECTIVE.replace('gallery_kind="imagegen"', 'gallery_kind="unknown"'),
    DIRECTIVE.replace('display_name="Editorial portrait"', 'display_name="  "'),
    DIRECTIVE.replace('skill_name="artifact-template-portrait"', 'skill_name="portrait"'),
    DIRECTIVE.slice(0, -1),
    `\\${DIRECTIVE}`,
    DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    `Example: ${DIRECTIVE}`,
    `\`${DIRECTIVE}\``,
    `\`\`\`text\n${DIRECTIVE}\n\`\`\``,
    `~~~markdown\n${DIRECTIVE}\n~~~`,
    `    ${DIRECTIVE}`,
  ])("preserves invalid and example directives as literal Markdown: %s", literal);

  it.each([
    ["four-space-indented fence", `\`\`\`md\n    \`\`\`\n\n${DIRECTIVE}\n\n\`\`\``],
    ["tab-indented fence", `\`\`\`md\n\t\`\`\`\n\n${DIRECTIVE}\n\n\`\`\``],
    ["HTML comment", `<!--\n\n${DIRECTIVE}\n\n-->`],
    ["preformatted HTML", `<pre>\n\n${DIRECTIVE}\n\n</pre>`],
    ["script HTML", `<script>\n\n${DIRECTIVE}\n\n</script>`],
    ["style HTML", `<style>\n\n${DIRECTIVE}\n\n</style>`],
  ])("preserves the whole-source context of %s", (_name, source) => {
    for (const streaming of [false, true]) {
      const html = render(source, true, streaming);
      expect(html).not.toContain('data-slot="artifact-template"');
      expect(html).not.toContain("Use template");
      const mixed = render(`${DIRECTIVE}\n\n${source}\n\n${DIRECTIVE}`, true, streaming);
      expect(mixed.match(/data-slot="artifact-template"/g)).toHaveLength(2);
    }
  });

  it("handles adjacent cards and nested Markdown without losing surrounding prose", () => {
    const html = render(`Before\n\n${DIRECTIVE}\n${DIRECTIVE.replace("Editorial portrait", "Product scene")}\n\nAfter\n\n> ${DIRECTIVE}`);
    expect(html.match(/data-slot="artifact-template"/g)).toHaveLength(3);
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("<blockquote");
    expect(html).toContain("Product scene");
  });

  it("escapes template names rather than rendering HTML", () => {
    const html = render(DIRECTIVE.replace("Editorial portrait", "<script>alert(1)</script>"));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("only promotes valid directives outside code, even in one unsplit block", () => {
    const html = render(`[doc]: https://example.com\n\n\`${DIRECTIVE}\`\n\n${DIRECTIVE}\n\n\`\`\`text\n${DIRECTIVE}\n\`\`\``);
    expect(html.match(/data-slot="artifact-template"/g)).toHaveLength(1);
    expect(html.match(/::artifact-template/g)).toHaveLength(2);
  });
});
