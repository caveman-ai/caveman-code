// A folded running turn says the kind of work, with what it is on beside it.
import { expect, test } from "vitest";
import type { ToolPart } from "../../state/tool-actions.ts";
import type { ToolItem } from "../../state/transcript-model.ts";
import { stepLine, THINKING } from "./step-line.ts";

const ROOT = "/private/tmp/water";
const tool = (name: string, verb: string, subject: string, parts: ReadonlyArray<ToolPart>, command: string | null = null): ToolItem => ({
  kind: "tool",
  id: `${name}-${subject}`,
  verb,
  subject,
  parts,
  command,
  status: "running",
  startedAt: "2026-11-09T22:56:30.000Z",
  finishedAt: null,
  added: null,
  removed: null,
  output: "",
  name,
  input: {},
  result: null,
  icon: "read",
});
const read = (path: string) => tool("Read", "Reading", path, [{ action: "read", subject: path }]);
const reading = tool("Read", "Reading", "Read", [{ action: "read", subject: "" }]);

test("reads, lists and searches are one kind of work, Exploring, with the file or search beside it", () => {
  expect(stepLine(read(`${ROOT}/notes/note1.md`), null, ROOT)).toEqual({ id: "explore", words: "Exploring", icon: "search", detail: "note1.md" });
  expect(stepLine(tool("command", "Searching for", "water", [{ action: "search", subject: "water" }], 'grep -rn "water" .'), null, ROOT)).toMatchObject({ words: "Exploring", detail: "water" });
  expect(stepLine(tool("command", "Reading git history", "", [{ action: "history", subject: "" }], "git log --oneline"), null, ROOT)).toEqual({ id: "explore", words: "Exploring", icon: "search" });
});

test("a command says no shell; edits and web searches say their kind", () => {
  const sleep = tool("command", "Running", "sleep 4 && wc -w notes/*.md", [{ action: "command", subject: "sleep 4 && wc -w notes/*.md" }], "sleep 4 && wc -w notes/*.md");
  expect(stepLine(sleep, null, ROOT)).toEqual({ id: "run", words: "Running a command", icon: "run" });
  expect(stepLine(tool("Edit", "Editing", "src/a.ts", [{ action: "edit", subject: "src/a.ts" }]), null, ROOT)).toEqual({ id: "edit", words: "Editing files", icon: "edit", detail: "a.ts" });
  expect(stepLine(tool("WebSearch", "Fetching", "docs", [{ action: "web", subject: "docs" }]), null, ROOT)).toMatchObject({ words: "Searching the web" });
});

test("a step whose name has not arrived keeps the name the line shows, never a blank, but only from its own kind", () => {
  const shown = stepLine(read(`${ROOT}/notes/note1.md`), null, ROOT);
  // The next read, its file still on its way: the line stays "Exploring note1.md" until note2.md arrives.
  expect(stepLine(reading, shown, ROOT)).toEqual(shown);
  expect(stepLine(read(`${ROOT}/notes/note2.md`), shown, ROOT).detail).toBe("note2.md");
  // After "Thinking" (a real pause), or from a command, the new read says its kind alone until its file arrives.
  expect(stepLine(reading, THINKING, ROOT)).toEqual({ id: "explore", words: "Exploring", icon: "search" });
  const pendingCommand = tool("command", "Running a command", "", [{ action: "command", subject: "" }]);
  expect(stepLine(pendingCommand, shown, ROOT)).toEqual({ id: "run", words: "Running a command", icon: "run" });
});

test("web searches, apps and pictures say their own kind, never a command", () => {
  const search = tool("WebSearch", "Searching the web for", "release notes", [{ action: "web_search", subject: "release notes" }]);
  expect(stepLine(search, null, ROOT)).toEqual({ id: "web", words: "Searching the web", icon: "web", detail: "release notes" });
  expect(stepLine(tool("WebFetch", "Fetching", "https://example.com", [{ action: "web", subject: "https://example.com" }]), null, ROOT)).toMatchObject({ words: "Searching the web" });
  expect(stepLine(tool("desktop", "Using", "Safari", [{ action: "desktop_click", subject: "Safari" }]), null, ROOT)).toEqual({ id: "app", words: "Using an app", icon: "browser", detail: "Safari" });
  expect(stepLine(tool("image_generation", "Generating image", "", [{ action: "image_generation", subject: "" }]), null, ROOT)).toMatchObject({ words: "Generating an image" });
  expect(stepLine(tool("mcp__linear__list", "Calling", "linear", [{ action: "mcp", subject: "linear" }]), null, ROOT)).toMatchObject({ words: "Using a tool" });
  expect(stepLine(tool("command", "Checking pull request", "#60", [{ action: "pr", subject: "#60" }], "gh pr view 60"), null, ROOT)).toMatchObject({ words: "Exploring" });
  expect(stepLine(tool("command", "Committing", "", [{ action: "commit", subject: "" }], "git commit -m x"), null, ROOT)).toMatchObject({ words: "Running a command" });
});

test("the runtime's own tools say their kind: one on other threads names the first, a preview uses an app", () => {
  const own = (icon: ToolItem["icon"], threads?: ToolItem["threads"]): ToolItem => ({ ...tool("mcp__caveman-code__x", "Sending to", "", [{ action: "caveman", subject: "Sent to Fix checkout" }]), icon, ...(threads ? { threads } : {}) });
  expect(stepLine(own("agent", [{ thread: { title: "Fix checkout" }, text: "Go" }]), null, ROOT)).toEqual({ id: "threads", words: "Working with other threads", icon: "agent", detail: "Fix checkout" });
  expect(stepLine(own("browser"), null, ROOT)).toMatchObject({ id: "app", words: "Using an app" });
  expect(stepLine(own("mcp"), null, ROOT)).toMatchObject({ id: "other", words: "Using a tool" });
});
