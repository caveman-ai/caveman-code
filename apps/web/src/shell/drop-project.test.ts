import { describe, expect, test } from "vitest";
import { carriesProject, droppedName, droppedProjects, importedLine } from "./drop-project.ts";

const data =
  (by: Record<string, string>) =>
  (type: string): string =>
    by[type] ?? "";

describe("carriesProject", () => {
  test("files and editors' file lists only where their paths reach the runtime; links anywhere", () => {
    expect(carriesProject(["Files"], true)).toBe(true);
    expect(carriesProject(["Files"], false)).toBe(false);
    expect(carriesProject(["codefiles", "resourceurls"], true)).toBe(true);
    expect(carriesProject(["application/vnd.code.uri-list"], false)).toBe(false);
    expect(carriesProject(["text/uri-list", "text/plain"], false)).toBe(true);
    expect(carriesProject(["text/plain"], true)).toBe(false);
  });
});

describe("droppedProjects", () => {
  test("Finder: each file or folder once, as dropped", () => {
    expect(
      droppedProjects(
        ["/Users/me/code/app", "/Users/me/code/app/", "/Users/me/notes.txt", ""],
        data({}),
        true,
      ),
    ).toEqual([{ path: "/Users/me/code/app" }, { path: "/Users/me/notes.txt" }]);
  });

  test("VS Code and its forks: file links and their own lists, decoded, once", () => {
    const drop = data({
      "text/uri-list": "file:///Users/me/My%20App/README.md",
      "application/vnd.code.uri-list":
        "file:///Users/me/My%20App/README.md\nfile:///c%3A/work/x.ts",
      codefiles: JSON.stringify(["/Users/me/My App/README.md"]),
      resourceurls: JSON.stringify(["file:///Users/me/other", "vscode-remote://ssh/x"]),
    });
    expect(droppedProjects([], drop, true)).toEqual([
      { path: "/Users/me/My App/README.md" },
      { path: "c:/work/x.ts" },
      { path: "/Users/me/other" },
    ]);
  });

  test("without paths, GitHub links name their repository; other links and comments are skipped", () => {
    const list = [
      "# a comment",
      "https://github.com/acme/widget/blob/main/src/index.ts",
      "https://github.com/Acme/Widget",
      "https://example.com/page",
      "https://github.com/acme/other.git",
    ].join("\r\n");
    expect(droppedProjects([], data({ "text/uri-list": list }), true)).toEqual([
      { url: "https://github.com/acme/widget" },
      { url: "https://github.com/acme/other" },
    ]);
  });

  test("in a browser, paths and file links add nothing", () => {
    expect(
      droppedProjects(["/Users/me/app"], data({ "text/uri-list": "file:///Users/me/app" }), false),
    ).toEqual([]);
  });

  test("names what it adds", () => {
    expect(droppedName({ path: "/Users/me/code/app" })).toBe("app");
    expect(droppedName({ path: "/Users/me/code/app/README.md" })).toBe("app");
    expect(droppedName({ path: "/Users/me/code/.config" })).toBe(".config");
    expect(droppedName({ url: "https://github.com/acme/widget" })).toBe("widget");
  });
});

describe("importedLine", () => {
  test("says what came in; nothing when there was nothing new", () => {
    expect(importedLine("app", { imported: 1, already: 0, skipped: 0 })).toBe(
      "1 chat from Claude Code and Codex came into app.",
    );
    expect(importedLine("app", { imported: 3, already: 2, skipped: 1 })).toBe(
      "3 chats from Claude Code and Codex came into app.",
    );
    expect(importedLine("app", { imported: 0, already: 2, skipped: 0 })).toBeNull();
    expect(importedLine("app", { imported: 0, already: 0, skipped: 0 })).toBeNull();
    expect(importedLine("app", { imported: 0, already: 0, skipped: 2 })).toBe(
      "app's Claude Code and Codex chats could not be brought in.",
    );
  });
});
