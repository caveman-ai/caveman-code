import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { languageFromPath, resolveLanguage } from "../ai/highlight";
import { FileTypeIcon } from "../icons/file-type";
import { Response, runnable, splitBlocks, tableToCsv, tableToMarkdown } from "../ai/response";
import { Markdown, markdownLead, markdownOutline, setTaskChecked } from "./Markdown";

test("languageFromPath: extensions and well-known filenames", () => {
  expect(languageFromPath("apps/web/src/main.tsx")).toBe("tsx");
  expect(languageFromPath("cmd/server/main.go")).toBe("go");
  expect(languageFromPath(".github/workflows/ci.yml")).toBe("yaml");
  expect(languageFromPath("scripts/release.sh")).toBe("bash");
  expect(languageFromPath("services/api/Dockerfile")).toBe("docker");
  expect(languageFromPath("Dockerfile.dev")).toBe("docker");
  expect(languageFromPath("Makefile")).toBe("make");
  expect(languageFromPath("go.mod")).toBe("go");
  expect(languageFromPath(".gitignore")).toBe("ini");
  expect(languageFromPath("C:\\repo\\tsconfig.json")).toBe("jsonc");
  expect(languageFromPath(".env.local")).toBe("dotenv");
  expect(languageFromPath("src/Main.KT")).toBe("kotlin");
  expect(languageFromPath("LICENSE")).toBeNull();
  expect(languageFromPath("notes.unknownext")).toBeNull();
  // The chat's fence names resolve as before.
  expect(resolveLanguage("ts")).toBe("typescript");
  expect(resolveLanguage("zsh")).toBe("bash");
  expect(resolveLanguage("klingon")).toBeNull();
 // Dialects with no grammar of their own read as their base language; assembly by its usual names (upstream #25865, #27899).
  expect(["luau", "xsd", "xsl", "xslt"].map(resolveLanguage)).toEqual(["lua", "xml", "xml", "xml"]);
  expect(["asm", "s", "nasm", "assembly"].map(resolveLanguage)).toEqual(["asm", "asm", "asm", "asm"]);
  expect(languageFromPath("game/Player.luau")).toBe("lua");
  expect(languageFromPath("boot/start.S")).toBe("asm");
});

test("a dialect's file wears its base language's mark (T3's #22455)", () => {
  const mark = (path: string) => /href="#([^"]+)"/.exec(renderToStaticMarkup(createElement(FileTypeIcon, { path })))?.[1];
  expect(mark("game/player.lua")).toMatch(/lua/);
  expect(mark("game/Player.luau")).toBe(mark("game/player.lua"));
  expect([mark("schema.xsd"), mark("page.xsl"), mark("page.xslt")]).toEqual([mark("feed.xml"), mark("feed.xml"), mark("feed.xml")]);
});

test("markdownOutline: GitHub-style ids, deduplicated, inline markup stripped", () => {
  const outline = markdownOutline(
    ["# Caveman `Code`", "", "## Install", "", "```md", "# not a heading", "```", "", "## Install", "", "Setext title", "---", "", "### Café & *friends*"].join("\n"),
  );
  expect(outline).toEqual([
    { depth: 1, text: "Caveman Code", id: "md-caveman-code" },
    { depth: 2, text: "Install", id: "md-install" },
    { depth: 2, text: "Install", id: "md-install-1" },
    { depth: 2, text: "Setext title", id: "md-setext-title" },
    { depth: 3, text: "Café & friends", id: "md-café--friends" },
  ]);
  const html = renderToStaticMarkup(createElement(Markdown, { source: "## Install\n\n## Install" }));
  expect(html).toContain('id="md-install"');
  expect(html).toContain('id="md-install-1"');
});

// Markdown streams through Response's splitter; these pin the behaviour it relies on.
test("splitBlocks: an unclosed fence stays one block while it streams", () => {
  const unclosed = "```ts\nconst a = 1;\n\nconst b = 2;\n";
  expect(splitBlocks(`Intro\n\n${unclosed}`).map((b) => b.text)).toEqual(["Intro\n", unclosed]);
  expect(splitBlocks("~~~\na\n\nb\n~~~\n\nAfter").map((b) => b.text)).toEqual(["~~~\na\n\nb\n~~~\n", "After"]);
});

test("splitBlocks: a text with a footnote or a reference link stays one block, so its uses resolve", () => {
  const footnote = "Full jitter is best[^1].\n\nMore text.\n\n[^1]: https://aws.amazon.com/blogs/architecture/";
  expect(splitBlocks(footnote)).toEqual([{ text: footnote, offset: 0 }]);
  const reference = "See [the docs][d].\n\nThen ship.\n\n[d]: https://example.com/docs";
  expect(splitBlocks(reference)).toHaveLength(1);
  expect(splitBlocks("One.\n\nTwo [x](https://x.dev).").map((b) => b.text)).toEqual(["One.\n", "Two [x](https://x.dev)."]);
  const html = renderToStaticMarkup(createElement(Response, { children: footnote }));
  expect(html).not.toContain("[^1]");
  expect(html).toContain('href="https://aws.amazon.com/blogs/architecture/"');
});

test("links: only http(s) and mailto open a tab; unsafe schemes lose their href", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      source: "[web](https://example.com) [mail](mailto:a@b.co) [file](./README.md) [irc](irc://irc.libera.chat/x) [xmpp](xmpp:a@b) [js](javascript:alert(1)) [top](#install)",
    }),
  );
  const anchors = [...html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => [label, /href="([^"]*)"/.exec(attrs!)?.[1] ?? null, /target="_blank"/.test(attrs!)]);
  expect(anchors).toEqual([
    ["web", "https://example.com", true],
    ["mail", "mailto:a@b.co", true],
    ["file", "./README.md", false],
    ["irc", "irc://irc.libera.chat/x", false],
    ["xmpp", "xmpp:a@b", false],
    ["js", "", false],
    ["top", "#install", false],
  ]);
});

test("setTaskChecked: ticks the nth task as the reader numbers them, never one in a code block", () => {
  const doc = ["# Rollout", "", "- [ ] ship", "  1. [x] nested", "", "```md", "- [ ] not a task", "```", "", "* [X] last"].join("\n");
  expect(setTaskChecked(doc, 0, true)).toBe(doc.replace("- [ ] ship", "- [x] ship"));
  expect(setTaskChecked(doc, 1, false)).toBe(doc.replace("1. [x] nested", "1. [ ] nested"));
  expect(setTaskChecked(doc, 2, false)).toBe(doc.replace("* [X] last", "* [ ] last"));
  expect(setTaskChecked(doc, 3, true)).toBeNull();
  // The renderer gives each box the same index.
  const html = renderToStaticMarkup(createElement(Markdown, { source: doc, onToggleTask: () => undefined }));
  expect([...html.matchAll(/data-task="(\d)"/g)].map((m) => m[1])).toEqual(["0", "1", "2"]);
});

test("setTaskChecked: a box the reader draws live in a quote, an alert or a list item's first line ticks its source", () => {
  const doc = ["> [!NOTE]", "> - [ ] confirm with founder", "", "> > 1) [X] quoted twice", "", "- - [ ] same line as its parent"].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { source: doc, onToggleTask: () => undefined }));
  expect([...html.matchAll(/data-task="(\d)"/g)].map((m) => m[1])).toEqual(["0", "1", "2"]);
  expect(html.match(/md-check-live/g)?.length).toBe(3);
  expect(setTaskChecked(doc, 0, true)).toBe(doc.replace("> - [ ] confirm", "> - [x] confirm"));
  expect(setTaskChecked(doc, 1, false)).toBe(doc.replace("1) [X] quoted", "1) [ ] quoted"));
  expect(setTaskChecked(doc, 2, true)).toBe(doc.replace("- - [ ] same", "- - [x] same"));
  expect(setTaskChecked("> - [x] done", 0, false)).toBe("> - [ ] done");
});

test("table copy and shell runs: Markdown and CSV escape their cells; a console transcript runs its prompts", () => {
  const rows = [["Method", "Notes"], ["fs.read", 'reads "one" file, whole'], ["a|b", "x"]];
  expect(tableToMarkdown(rows)).toBe("| Method | Notes |\n| --- | --- |\n| fs.read | reads \"one\" file, whole |\n| a\\|b | x |");
  expect(tableToCsv(rows)).toBe('Method,Notes\nfs.read,"reads ""one"" file, whole"\na|b,x');
  expect(runnable("pnpm test", "bash")).toBe("pnpm test");
  expect(runnable("$ pnpm i\nDone in 2s\n$ pnpm test", "console")).toBe("pnpm i\npnpm test");
  expect(runnable("const a = 1", "ts")).toBeNull();
  expect(runnable("   ", "sh")).toBeNull();
});

test("a shell block offers Run only where the host can run it; every block can wrap", () => {
  const md = "```bash\npnpm test\n```\n\n```ts\nconst a = 1\n```";
  const withRun = renderToStaticMarkup(createElement(Response, { onRun: () => undefined, children: md }));
  expect(withRun.match(/Run in a terminal/g)?.length).toBe(2); // aria-label and title, one button
  expect(withRun.match(/aria-label="Wrap lines"/g)?.length).toBe(2);
  expect(renderToStaticMarkup(createElement(Response, { children: md }))).not.toContain("Run in a terminal");
  expect(renderToStaticMarkup(createElement(Markdown, { source: md, onRun: () => undefined }))).toContain("Run in a terminal");
});

// Hosted text: pull request descriptions and comments as their host draws them.
const hosted = (source: string, breaks = true) => renderToStaticMarkup(createElement(Markdown, { source, hosted: { breaks } }));

test("hosted: a bot's HTML draws as folds and badges, template comments vanish, document text keeps HTML as text", () => {
  const dependabot = [
    "Bumps [fast-uri](https://github.com/fastify/fast-uri) from 3.1.8 to 3.1.9.",
    "<details>",
    "<summary>Release notes</summary>",
    "<p><em>Sourced from <a href=\"https://github.com/fastify/fast-uri/releases\">fast-uri's releases</a>.</em></p>",
    "<pre lang=\"sh\"><code>npm install fast-uri@3.1.9\n</code></pre>",
    "</details>",
    "",
    "<!-- Please describe your change -->",
    "<sub>sub</sub> <kbd>Ctrl</kbd>",
  ].join("\n");
  const html = hosted(dependabot);
  expect(html).toContain("<details");
  expect(html).toMatch(/<summary[^>]*>.*Release notes/);
  expect(html).toContain('href="https://github.com/fastify/fast-uri/releases"');
  expect(html).toContain("npm install fast-uri@3.1.9");
  expect(html).not.toContain("&lt;details");
  expect(html).not.toContain("Please describe");
  expect(html).toContain("<sub>sub</sub>");
  expect(html).toMatch(/<kbd[^>]*>Ctrl<\/kbd>/);
  // The side-panel reader never renders HTML.
  expect(renderToStaticMarkup(createElement(Markdown, { source: dependabot }))).toContain("&lt;details&gt;");
});

test("hosted: nothing that runs, styles or frames survives the allow-list", () => {
  const html = hosted(
    [
      "Hi <script>alert(1)</script> there.",
      '<img src="https://x.dev/a.png" onerror="alert(2)">',
      '<a href="javascript:alert(3)">js</a> <a href="https://ok.dev" onclick="alert(4)">ok</a>',
      '<iframe src="https://evil.dev"></iframe><form action="https://evil.dev"><input name="q"></form>',
      "<style>body{display:none}</style>",
      '<div style="position:fixed;inset:0">overlay</div>',
      '<video src="javascript:alert(5)"></video>',
    ].join("\n\n"),
  );
  for (const bad of ["<script", "alert(1)", "onerror", "onclick", "javascript:", "<iframe", "<form", "display:none", "position:fixed", "<style"]) expect(html).not.toContain(bad);
  expect(html).toContain('href="https://ok.dev"');
  expect(html).toContain("overlay");
});

test("hosted: GitHub's newlines break lines; other hosts' join", () => {
  expect(hosted("Passing null threw:\nTypeError")).toMatch(/threw:<br\/>\s*TypeError/);
  expect(hosted("Passing null threw:\nTypeError", false)).not.toContain("<br/>");
});

test("hosted: an attachment link alone on its line is its media; one in a sentence stays a link", () => {
  const url = "https://github.com/user-attachments/assets/aafd7cea-9d18-4f28-a865-de7a11e104a4";
  const alone = hosted(`Before:\n${url}\nAfter:`);
  expect(alone).toMatch(new RegExp(`<img src="${url}"[^>]*data-attachment|<img[^>]*src="${url}"`));
  expect(alone).not.toContain(`href="${url}"`);
  expect(hosted(`The clip ${url} shows it.`)).toContain(`href="${url}"`);
  expect(hosted(`Plain:\n\n${url}`, false)).toMatch(/<img[^>]*src=/);
});

test("hosted: an uploaded screenshot holds its box before it loads; :shortcodes: draw outside code", () => {
  const html = hosted('<img width="2210" height="1530" alt="image" src="https://github.com/user-attachments/assets/e3df4516-7ca9-4c24-bb3f-c1d411591e64" />');
  expect(html).toContain("aspect-ratio:2210 / 1530");
  expect(html).toContain("min(100%, 2210px, 924px)");
  expect(hosted(":robot: I have created a release `:robot:` :not_a_code:")).toMatch(/🤖 I have created a release <code[^>]*>:robot:<\/code> :not_a_code:/);
});

test("markdownLead: the first paragraph, past headings, template comments and code", () => {
  expect(markdownLead("<!-- Describe it -->\n\n## Summary\n\n```sh\nmake\n```\n\nFixes the **flaky** [test](https://x.dev).\n\nMore.")).toBe("Fixes the flaky test.");
  expect(markdownLead("## Only a heading")).toBe("");
});
