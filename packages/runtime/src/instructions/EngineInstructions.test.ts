import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  cavemanSections,
  cutUtf8,
  importsOf,
  InstructionSources,
  REPOSITORY_INSTRUCTIONS_MAX_BYTES,
  repositorySections,
} from "./EngineInstructions.ts";

const tree = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-instructions-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};

describe("repositorySections", () => {
  it("reads AGENTS.md, else CLAUDE.md, per directory from the checkout root down to cwd", () => {
    const root = tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "AGENTS.md": "Root agents.\n",
      "CLAUDE.md": "Root claude, shadowed.\n",
      "packages/web/CLAUDE.md": "Web claude.\n",
      "packages/web/src/x.ts": "",
      "elsewhere/AGENTS.md": "Not on the path.\n",
    });
    expect(repositorySections(path.join(root, "packages/web/src"))).toEqual([
      { title: "AGENTS.md", text: "Root agents." },
      { title: path.join("packages", "web", "CLAUDE.md"), text: "Web claude." },
    ]);
  });

  it("treats cwd as the root outside a checkout, and a worktree's .git file as a checkout", () => {
    const loose = tree({ "AGENTS.md": "Loose.\n" });
    expect(repositorySections(loose)).toEqual([{ title: "AGENTS.md", text: "Loose." }]);
    const worktree = tree({ ".git": "gitdir: /elsewhere\n", "AGENTS.md": "Worktree.\n", "sub/AGENTS.md": "Sub.\n" });
    expect(repositorySections(path.join(worktree, "sub")).map((section) => section.text)).toEqual(["Worktree.", "Sub."]);
  });

  it("keeps the files together under Codex's 32 KiB", () => {
    const root = tree({ ".git/HEAD": "", "AGENTS.md": "a".repeat(REPOSITORY_INSTRUCTIONS_MAX_BYTES + 10), "sub/AGENTS.md": "Dropped.\n" });
    const sections = repositorySections(path.join(root, "sub"));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.text.endsWith("[truncated]")).toBe(true);
  });
});

describe("CLAUDE.md imports", () => {
  it("parses @path as Claude Code does: not in code spans or fences, an escaped space kept, a quoted path or an email never", () => {
    expect(
      importsOf(
        [
          "@AGENTS.md",
          "See @docs/style.md and @docs/Design\\ Docs/ui.md, or mail ops@acme.dev.",
          "Literal: `@README` and ``@x.md``.",
          '@"docs/quoted.md"',
          "```",
          "@inside/fence.md",
          "```",
          "~~~md",
          "@inside/tilde.md",
          "~~~",
          "- @rules/last.md",
        ].join("\n"),
      ),
    ).toEqual(["AGENTS.md", "docs/style.md", "docs/Design Docs/ui.md,", "rules/last.md"]);
  });

  it("loads a CLAUDE.md's imports after it, relative to the importing file, four hops deep, each file once", () => {
    const root = tree({
      ".git/HEAD": "",
      "CLAUDE.md": "Root rules. Follow @docs/style.md.\n@docs/style.md\n",
      "docs/style.md": "Style: tabs. @more/one.md",
      "docs/more/one.md": "One. @two.md",
      "docs/more/two.md": "Two. @three.md",
      "docs/more/three.md": "Three. @four.md",
      "docs/more/four.md": "Four, a fifth hop away: not loaded.",
    });
    expect(repositorySections(root)).toEqual([
      { title: "CLAUDE.md", text: "Root rules. Follow @docs/style.md.\n@docs/style.md" },
      { title: path.join("docs", "style.md"), text: "Style: tabs. @more/one.md" },
      { title: path.join("docs", "more", "one.md"), text: "One. @two.md" },
      { title: path.join("docs", "more", "two.md"), text: "Two. @three.md" },
      { title: path.join("docs", "more", "three.md"), text: "Three. @four.md" },
    ]);
  });

  it("never follows an import out of the checkout, into .git or an .env file, and AGENTS.md's imports stay text (Codex reads them so)", () => {
    const outside = tree({ "secret.md": "OUTSIDE" });
    const root = tree({
      ".git/HEAD": "",
      ".git/config.md": "GIT",
      ".env": "TOKEN=1",
      "CLAUDE.md": `@${path.join(outside, "secret.md")} @~/.ssh/id_rsa @../x.md @.git/config.md @.env @AGENTS-notes.md @missing.md`,
      "AGENTS-notes.md": "Notes.",
      "sub/AGENTS.md": "Sub. @../AGENTS-notes.md",
    });
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "linked.md"), "file");
    fs.appendFileSync(path.join(root, "CLAUDE.md"), " @linked.md");
    const sections = repositorySections(path.join(root, "sub"));
    expect(sections.map((s) => s.title)).toEqual(["CLAUDE.md", "AGENTS-notes.md", path.join("sub", "AGENTS.md")]);
    expect(JSON.stringify(sections)).not.toMatch(/OUTSIDE|GIT"|TOKEN=1/);
  });

  it("cuts at 32 KiB on a character boundary, never ending in a replacement character", () => {
    expect(cutUtf8("aé", 2)).toBe("a");
    expect(cutUtf8("a🙂b", 4)).toBe("a");
    expect(cutUtf8("abc", 10)).toBe("abc");
    const root = tree({ ".git/HEAD": "", "AGENTS.md": `${"a".repeat(REPOSITORY_INSTRUCTIONS_MAX_BYTES - 1)}é and more` });
    const [section] = repositorySections(root);
    expect(section!.text).toBe(`${"a".repeat(REPOSITORY_INSTRUCTIONS_MAX_BYTES - 1)}\n[truncated]`);
    expect(section!.text).not.toContain("\uFFFD");
  });
});

describe("cavemanSections", () => {
  it("orders repository files, team rules, the runtime's text, then extra sources, dropping empty ones", async () => {
    const root = tree({ ".git/HEAD": "", "AGENTS.md": "Use pnpm.\n" });
    const threadId = ThreadId.make("thread-instructions");
    const seen: Array<string> = [];
    const sections = await Effect.runPromise(
      cavemanSections({
        threadId,
        cwd: root,
        rules: [{ plugin: "backend", name: "sql", text: "Never write raw SQL.\n" }],
        runtime: "<project_instructions>Mine.</project_instructions>",
      }).pipe(
        Effect.provideService(InstructionSources, [
          { title: "Memory", read: (id, engine) => Effect.sync(() => (seen.push(`${id}:${engine}`), "You prefer tabs.")) },
          { title: "Empty", read: () => Effect.succeed("  ") },
        ]),
      ),
    );
    expect(sections).toEqual([
      { title: "AGENTS.md", text: "Use pnpm." },
      { title: "Plugin rules", text: "## sql (plugin rules from backend)\n\nNever write raw SQL." },
      { title: "Caveman Code", text: "<project_instructions>Mine.</project_instructions>" },
      { title: "Memory", text: "You prefer tabs." },
    ]);
    expect(seen).toEqual([`${threadId}:caveman`]);
  });
});
