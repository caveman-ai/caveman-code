import { expect, test } from "vitest";
import type { Artifact } from "./transcript-model.ts";
import { isAbsolutePath, outsideWorkspace, sameArtifacts, withWorkspacePaths, workspacePath, workspaceText } from "./workspace-paths.ts";

const root = "/Users/me/state/worktrees/repo/fix-retry--e658b536";

test("a path inside the chat's folder reads relative to it; anything else stays as it was", () => {
  expect(workspacePath(`${root}/retry.ts`, root)).toBe("retry.ts");
  expect(workspacePath(`${root}/src/a/b.ts`, `${root}/`)).toBe("src/a/b.ts");
  expect(workspacePath(root, root)).toBe(".");
  // A sibling folder that only shares the prefix is outside.
  expect(workspacePath(`${root}-other/retry.ts`, root)).toBe(`${root}-other/retry.ts`);
  expect(workspacePath("/etc/hosts", root)).toBe("/etc/hosts");
  expect(workspacePath("src/a.ts", root)).toBe("src/a.ts");
  expect(workspacePath(`${root}/retry.ts`, null)).toBe(`${root}/retry.ts`);
  // macOS: /tmp is /private/tmp, and an engine may report either.
  expect(workspacePath("/private/tmp/w/docs/a.md", "/tmp/w")).toBe("docs/a.md");
  expect(workspacePath("/tmp/w/docs/a.md", "/private/tmp/w/")).toBe("docs/a.md");
  expect(workspacePath("/private/var/w", "/var/w")).toBe(".");
  expect(isAbsolutePath("/x")).toBe(true);
  expect(isAbsolutePath("C:\\x")).toBe(true);
  expect(isAbsolutePath("src/x")).toBe(false);
});

test("a path inside a Windows folder reads relative to it, written with either separator in any case", () => {
  const win = String.raw`C:\Users\me\proj`;
  expect(workspacePath(String.raw`C:\Users\me\proj\src\app.ts`, win)).toBe("src/app.ts");
  expect(workspacePath("C:/Users/me/proj/src/app.ts", `${win}\\`)).toBe("src/app.ts");
  expect(workspacePath(String.raw`c:\users\me\proj`, win)).toBe(".");
  expect(workspacePath(String.raw`C:\Users\me\proj-other\a.ts`, win)).toBe(String.raw`C:\Users\me\proj-other\a.ts`);
  expect(workspacePath(String.raw`C:\Users\me\proj\..\other\a.ts`, win)).toBe(String.raw`C:\Users\me\proj\..\other\a.ts`);
  expect(workspacePath("src/a.ts", win)).toBe("src/a.ts");
});

test("file artifacts take the relative path fs.read accepts; the list is kept when nothing changes", () => {
  const file = (path: string): Artifact => ({ kind: "file", id: `${path}:file`, itemId: path, title: "retry.ts", meta: "Edited", path, change: "edited", added: null, removed: null, diff: null, status: "done" });
  const code: Artifact = { kind: "code", id: "c", itemId: "a", title: "TypeScript", meta: "3 lines", code: "x", language: "ts", line: 1 };
  const out = withWorkspacePaths([file(`${root}/retry.ts`), code], root);
  expect(out.map((a) => (a.kind === "file" ? a.path : a.kind))).toEqual(["retry.ts", "code"]);
  const relative = [file("retry.ts"), code];
  expect(withWorkspacePaths(relative, root)).toBe(relative);
  expect(withWorkspacePaths(out, null)).toBe(out);
 // The same artifacts again (a streamed token): the same copy, so no transcript row sees a new prop (upstream #27420).
  const list = [file(`${root}/retry.ts`), code];
  expect(withWorkspacePaths(list, root)).toBe(withWorkspacePaths(list, root));
  const grown = [...list, file(`${root}/b.ts`)];
  expect(withWorkspacePaths(grown, root)[0]).toBe(withWorkspacePaths(list, root)[0]);
  expect(sameArtifacts(withWorkspacePaths([...list], root), withWorkspacePaths(list, root))).toBe(true);
  // Another folder reads them afresh.
  expect(withWorkspacePaths(list, "/Users/me").map((a) => (a.kind === "file" ? a.path : a.kind))).toEqual([`state/worktrees/repo/fix-retry--e658b536/retry.ts`, "code"]);
});

test("a line's text names a file in the chat's folder relatively, whichever spelling of macOS's /tmp the engine used", () => {
  expect(workspaceText(`Edited ${root}/retry.ts`, root)).toBe("Edited retry.ts");
  expect(workspaceText("/private/tmp/wt/index.html", "/tmp/wt")).toBe("index.html");
  expect(workspaceText("/tmp/wt/index.html and /private/tmp/wt/a.ts", "/private/tmp/wt")).toBe("index.html and a.ts");
  expect(workspaceText("/tmp/wt", "/tmp/wt")).toBe(".");
});

test("a line's text names a file in a Windows chat's folder relatively, whichever separator and case the engine used", () => {
  const win = String.raw`C:\Users\me\proj`;
  expect(workspaceText(String.raw`Edited C:\Users\me\proj\src\a.ts`, win)).toBe(String.raw`Edited src\a.ts`);
  expect(workspaceText("Read C:/Users/me/proj/src/a.ts", `${win}\\`)).toBe("Read src/a.ts");
  expect(workspaceText(String.raw`c:\users\me\proj\a.ts, C:\Users\me\proj\b.ts`, win)).toBe("a.ts, b.ts");
  expect(workspaceText("C:/Users/me/proj", win)).toBe(".");
  // A sibling folder that only shares the prefix is outside.
  expect(workspaceText(String.raw`C:\Users\me\proj-other\a.ts`, win)).toBe(String.raw`C:\Users\me\proj-other\a.ts`);
  expect(workspaceText(String.raw`Read \\server\share\proj\a.ts`, String.raw`\\server\share\proj`)).toBe("Read a.ts");
});

test("a path is outside the chat's folder only when it stays absolute against it", () => {
  expect(outsideWorkspace("src/a.ts", "/repo")).toBe(false);
  expect(outsideWorkspace("/repo/src/a.ts", "/repo")).toBe(false);
  expect(outsideWorkspace("/private/tmp/w/a.ts", "/tmp/w")).toBe(false);
  expect(outsideWorkspace("/tmp/result.txt", "/repo")).toBe(true);
  expect(outsideWorkspace("C:\\Users\\me\\repo\\a.ts", "C:\\Users\\me\\repo")).toBe(false);
  expect(outsideWorkspace("D:\\out.txt", "C:\\Users\\me\\repo")).toBe(true);
});
