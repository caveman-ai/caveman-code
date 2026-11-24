import { win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { touchedFile, codeRef, folderCandidate } from "./fileRefs.ts";

const root = "/Users/me/repo";

describe("codeRef", () => {
  test("explicit folder paths keep their kind, with spaces and absolute workspace paths", () => {
    expect(codeRef("src/", root)).toEqual({ path: "src", directory: true });
    expect(codeRef("docs/design notes/", root)).toEqual({ path: "docs/design notes", directory: true });
    expect(codeRef(`${root}/apps/web/`, root)).toEqual({ path: "apps/web", directory: true });
    expect(codeRef("./docs/../src/", root)).toEqual({ path: "src", directory: true });
    for (const invalid of ["../../outside/", "/etc/", "https://example.com/", "github.com/org/", "/v1/code/*/"]) expect(codeRef(invalid, root)).toBeNull();
  });

  test("ambiguous spans are candidates, not chips until a real folder is found", () => {
    for (const path of ["src", "apps/web/src", "origin/main", "docs/design notes"]) expect(folderCandidate(path, root)).toEqual({ path });
    for (const invalid of ["pnpm test", "Effect.fail", "run()", "https://example.com", "../outside", "/etc/passwd", "a`b/c", "foo\nbar/"]) expect(folderCandidate(invalid, root), invalid).toBeNull();
    expect(codeRef("apps/web/src", root)).toBeNull();
  });
  test("paths with a slash and an extension, or a line", () => {
    expect(codeRef("docs/research/SEAMLESS_COMPUTERS_2026-10-17.md", root)).toEqual({ path: "docs/research/SEAMLESS_COMPUTERS_2026-10-17.md" });
    expect(codeRef("packages/ui/src/ai/response.tsx:120", root)).toEqual({ path: "packages/ui/src/ai/response.tsx", line: 120 });
    expect(codeRef("lifecycle.ts:12", root)).toEqual({ path: "lifecycle.ts", line: 12 });
    expect(codeRef("/Users/me/repo/CLAUDE.md", root)).toEqual({ path: "CLAUDE.md" });
    expect(codeRef(".github/workflows/ci.yml", root)).toEqual({ path: ".github/workflows/ci.yml" });
    expect(codeRef("services/api/Dockerfile", root)).toEqual({ path: "services/api/Dockerfile" });
    expect(codeRef("./docs/../README.md", root)).toEqual({ path: "README.md" });
  });

  test("HTML documents are clickable even when the agent left them in a temporary folder", () => {
    for (const text of ["/tmp/report.html", "~/reports/report.htm", "/tmp/my report.HTML", "report.html"]) {
      expect(codeRef(text, null), text).toEqual({ path: text });
    }
    expect(codeRef("/Users/me/repo/report.html", root)).toEqual({ path: "report.html" });
    for (const text of ["../report.html", "//host/report.html", "open /tmp/report.html"]) expect(codeRef(text, root), text).toBeNull();
  });

  test("paths that leave the chat's folder stay code", () => {
    for (const text of ["/Users/someone-else/notes.md", "../../etc/passwd.txt", "/Users/me/repo/x.md:3"]) {
      expect(codeRef(text, text.endsWith(":3") ? null : root), text).toBeNull();
    }
  });

  test("~/ is the home folder, never a folder named ~ in the chat's (T3 #20950)", () => {
    expect(codeRef("~/repo/src/a.ts:4", root)).toEqual({ path: "src/a.ts", line: 4 });
    for (const [text, at] of [["~/.claude/CLAUDE.md", root], ["~/notes.md", "/work/project"], ["~/src/a.ts", null]] as const) {
      expect(codeRef(text, at), text).toBeNull();
    }
  });

  test("a code span never opens, or looks for a folder at, a network share or another drive, however it is written", () => {
    // Windows reads each of these, decoded, as \\attacker.example\share\… or as a path on another drive. A chip reaches it when
    // clicked; a folder candidate as soon as the answer renders, when the chip asks whether it is a folder.
    const spans = [
      "%5C%5Cattacker.example%5Cshare%5Cx.ts:12",
      "%2F%2Fattacker.example%2Fshare%2Fx.ts:3",
      "./%5C%5Cattacker.example%5Cshare%5Cx.ts",
      "docs/../%5C/attacker.example/share/x.ts",
      "%5C%5Cattacker.example/share",
      "%2F%2Fattacker.example/share",
      String.raw`\\attacker.example\share\x.ts:12`,
      "//attacker.example/share/x.ts:3",
      "./D:x.ts",
      "a/../C:/x.ts:3",
    ];
    const winRoot = String.raw`C:\Users\me\repo`;
    const paths = spans.flatMap((text) => [codeRef(text, root), folderCandidate(text, root)]).flatMap((ref) => (ref ? [ref.path] : []));
    expect(paths.filter((path) => !win32.resolve(winRoot, path).startsWith(`${winRoot}\\`))).toEqual([]);
  });

  test("a code span opens the name it spells: nothing in it is percent-decoded", () => {
    expect(codeRef("docs/report%20final.md", root)).toEqual({ path: "docs/report%20final.md" });
    expect(codeRef("%5C%5Cattacker.example%5Cshare%5Cx.ts:12", root)).toEqual({ path: "%5C%5Cattacker.example%5Cshare%5Cx.ts", line: 12 });
    expect(codeRef("docs/../%5C/attacker.example/share/x.ts", root)).toEqual({ path: "%5C/attacker.example/share/x.ts" });
    expect(folderCandidate("%2F%2Fattacker.example/share", root)).toEqual({ path: "%2F%2Fattacker.example/share" });
  });

  test("a Windows path names its folders with backslashes (T3's inline code paths)", () => {
    const win = "C:\\Users\\me\\proj";
    expect(codeRef("C:\\Users\\me\\proj\\src\\app.ts", win)).toEqual({ path: "src/app.ts" });
    expect(codeRef("c:\\users\\me\\proj\\services\\api\\Dockerfile", win)).toEqual({ path: "services/api/Dockerfile" });
    expect(codeRef("C:\\Users\\me\\proj\\src\\app.ts:12", win)).toEqual({ path: "src/app.ts", line: 12 });
    expect(codeRef("src\\components\\Button.tsx", win)).toEqual({ path: "src/components/Button.tsx" });
    expect(codeRef("C:\\tmp\\report.html", win)).toEqual({ path: "C:\\tmp\\report.html" });
    // Outside the chat's folder, on a share, a Windows path on a Mac's chat, or a regex: code.
    for (const [text, at] of [["C:\\Windows\\System32\\drivers\\etc\\hosts.txt", win], ["\\\\host\\share\\a.ts", win], ["\\\\host\\share\\r.html", win], ["C:\\Users\\me\\proj\\src\\app.ts", root], ["\\d+\\.ts$", root], ["C:\\Users\\me\\proj\\src\\", win]] as const) {
      expect(codeRef(text, at), text).toBeNull();
    }
  });

  test("a regex's escapes are not Windows folders: the span stays code", () => {
    for (const text of ["foo\\.ts", "re\\.compile", "a\\.b\\.c", ".*\\.test\\.ts", "[a-z]+\\.json", "*\\.md", "src\\*.ts", "\"src\\app.ts\""]) {
      expect(codeRef(text, root), text).toBeNull();
    }
    // A Windows path into a dot folder, or through a route folder, is still one.
    expect(codeRef(".\\.github\\workflows\\ci.yml", root)).toEqual({ path: ".github/workflows/ci.yml" });
    expect(codeRef("app\\[slug]\\page.tsx", root)).toEqual({ path: "app/[slug]/page.tsx" });
  });

  test("identifiers, refs, commands, versions and hosts stay code", () => {
    for (const text of ["Effect.fail", "LifecycleError", "lifecycle.ts", "origin/main", "save/automations-design-2026-10-16", "pnpm test", "glm-5.3", "models/qwen2.5", "github.com/acme/api", "/v1/code/*", ".env.local.example", "a`b/c.ts"]) {
      expect(codeRef(text, root), text).toBeNull();
    }
  });
});

test("a bare file name is a file only when it names exactly one file the chat touched", () => {
  const known = ["notes/pilot.md", "recap-email.md", "a/README.md", "b/README.md"];
  expect(touchedFile("pilot.md", known)).toBe("notes/pilot.md");
  expect(touchedFile(" recap-email.md ", known)).toBe("recap-email.md");
  // Two touched files share the name: no guess.
  expect(touchedFile("README.md", known)).toBeNull();
  // Not touched, not a plain name, or no extension: code, not a file.
  expect(touchedFile("questions.md", known)).toBeNull();
  expect(touchedFile("pilot", ["pilot"])).toBeNull();
  expect(touchedFile("JSON.parse", ["JSON.parse"])).toBe("JSON.parse");
  expect(touchedFile("a b.md", ["a b.md"])).toBeNull();
});
