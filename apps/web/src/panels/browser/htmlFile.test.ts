import { beforeEach, expect, test } from "vitest";
import { chatLink } from "../../components/transcript/links.ts";
import { codeRef } from "../files/fileRefs.ts";
import { openFile } from "../openFile.ts";
import { getPanel, resetPanels, setTabIdentity } from "../store.ts";
import { HTML_FILE_SANDBOX, htmlFileDocument, htmlRead, isHtmlFile, type HtmlRead } from "./htmlFile.ts";

beforeEach(() => {
  resetPanels();
  setTabIdentity("file", (p) => p.path);
  setTabIdentity("browser", (p) => p.path ? `html:${p.path}` : "agent");
});

test("a chat link or code chip opens an HTML browser tab, not the workspace reader", () => {
  for (const text of ["/tmp/report.html", "docs/report.htm", "~/my-report.HTML"]) {
    const link = chatLink(text, "/repo");
    expect(link?.kind).toBe("file");
    if (link?.kind !== "file") throw new Error("missing HTML link");
    const first = openFile("w", link.path);
    const chip = codeRef(text, "/repo")!;
    expect(openFile("w", chip.path)).toBe(first);
    expect(getPanel("w").tabs.find((t) => t.id === first)).toMatchObject({ kind: "browser", params: { path: text, source: false }, reveal: 1 });
    expect(getPanel("w").active).toBe(first);
  }
  expect(getPanel("w").tabs).toHaveLength(3);
  openFile("w", "/tmp/report.html", 12);
  expect(getPanel("w").tabs[0]?.params).toMatchObject({ source: true, line: 12 });
  openFile("w", "/tmp/report.html");
  expect(getPanel("w").tabs[0]?.params).toEqual({ path: "/tmp/report.html", source: false });
  openFile("w", "README.md", 4);
  expect(getPanel("w").tabs.at(-1)).toMatchObject({ kind: "file", params: { path: "README.md", line: 4 } });
});

test("HTML classification agrees with T3's browser-file detector for HTML and source files", () => {
  // T3 browser/openFileInPreview.ts (13aa882c22), excluding its additional PDF support.
  const reference = (path: string) => /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");
  for (const path of ["report.html", "/tmp/REPORT.HTML", "a.htm", "foo.html.ts", "html", "a.h", "/tmp/image.png", "README.md", "report.html.bak"]) {
    expect(isHtmlFile(path), path).toBe(reference(path));
  }
});

test("HTML runs without the app's origin; CSP precedes all agent markup and denies API calls", () => {
  const html = '<html><body><script>parent.document.body.remove()</script></body></html>';
  const rendered = htmlFileDocument(html);
  expect(rendered.endsWith(html)).toBe(true);
  expect(rendered.indexOf("Content-Security-Policy")).toBeLessThan(rendered.indexOf("<script>"));
  expect(rendered).toContain("connect-src 'none'");
  expect(rendered).toContain("base-uri 'none'");
  expect(rendered).toContain("form-action 'none'");
  expect(rendered).toContain("t.scrollIntoView()");
  expect(rendered).toContain("e.preventDefault()");
  expect(HTML_FILE_SANDBOX.split(" ")).toEqual(["allow-scripts", "allow-downloads"]);
});

test("an agent edit elsewhere or a reconnect re-reads the HTML in place: the same bytes keep the page, Reload starts over", () => {
  const page = "<h1>Report</h1><input>";
  const shown = htmlRead(htmlRead({ status: "loading" }, { read: "fresh" }), { html: page });
  expect(shown).toEqual({ status: "ready", html: page });
  // A diff.changed for src/other.ts, then a reconnect: each bumps the files version and reads the file again.
  let state: HtmlRead = shown;
  for (const _ of ["edit", "reconnect"]) {
    state = htmlRead(state, { read: "again" });
    expect(state).toBe(shown);
    state = htmlRead(state, { html: page });
    expect(state).toBe(shown);
  }
  // The agent rewrites the page itself: the preview shows the new one.
  expect(htmlRead(htmlRead(shown, { read: "again" }), { html: "<h1>Report v2</h1>" })).toEqual({ status: "ready", html: "<h1>Report v2</h1>" });
  // Reload (and Retry) asks for a fresh page.
  expect(htmlRead(shown, { read: "fresh" })).toEqual({ status: "loading" });
});
