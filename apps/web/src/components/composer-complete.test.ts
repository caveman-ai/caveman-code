import { expect, test } from "vitest";
import { COMMANDS, engineCommandsFor, leadingCommand, leadingSlash, noteUse, rank, score, skillMentions, skillsFor, skillToken, slashTrigger, tildePath } from "./composer-complete.ts";
import { changeDraft, EMPTY_DRAFT, refEdit, serializeDraft } from "./thread-refs.ts";

const names = (q: string) => rank(COMMANDS, q, (c) => c.names, (c) => `cmd:${c.id}`, (c) => c.description).map((r) => r.name);

test("the scorer: whole name, then its start, a word's start, anywhere, then letters in order", () => {
  const order = ["review", "reviewer-guide", "code-review", "prereview", "rxexvxiew"].map((t) => score("review", t)?.score ?? -1);
  expect([...order].sort((a, b) => b - a)).toEqual(order);
  expect(score("comm", "caveman-commit")?.hits).toEqual([8, 9, 10, 11]);
  // Letters in order take the word starts: "cc" lights the two c's that begin words.
  expect(score("cc", "caveman-commit")?.hits).toEqual([0, 8]);
  expect(score("xyz", "review")).toBeNull();
  expect(score("re", "frontend-design")).toBeNull(); // two scattered letters mid-word: noise
  expect(score("rnt", "frontend-design")).not.toBeNull();
  expect(score("", "anything")).toEqual({ score: 0, hits: [] });
});

test("commands rank as you type, an alias answers under its own name, a description word answers last", () => {
  expect(names("rev")[0]).toBe("review");
  expect(names("mod")[0]).toBe("model");
  expect(names("clear")[0]).toBe("clear"); // /new's alias, shown as typed
  expect(names("approvals")[0]).toBe("approvals");
  expect(names("comp")[0]).toBe("compact");
  expect(names("summarize")).toContain("compact"); // its description
  expect(names("")).toEqual(COMMANDS.map((c) => c.names[0]));
});

test("what was picked lately wins a tie", () => {
  const before = names("")[0];
  noteUse("cmd:settings");
  expect(names("")[0]).toBe("settings");
  expect(names("s")[0]).toBe("settings"); // ties with status, skills, shell…; picked last
  expect(names("st")[0]).toBe("status"); // a better match still wins over a recent one
  noteUse(`cmd:${COMMANDS.find((c) => c.names[0] === before)!.id}`);
});

test("the / trigger: commands only when it opens the message, skills anywhere after a space, never in a word or a pill", () => {
  expect(slashTrigger("/", 1)).toEqual({ start: 0, query: "", commands: true });
  expect(slashTrigger("  /rev", 6)).toEqual({ start: 2, query: "rev", commands: true });
  expect(slashTrigger("fix it /cav", 11)).toEqual({ start: 7, query: "cav", commands: false });
  expect(slashTrigger("and/or", 6)).toBeNull();
  expect(slashTrigger("/review now", 11)).toBeNull(); // a space ends it
 // A path is no command, wherever the caret sits in it (upstream #19671).
  expect(slashTrigger("Run /tmp/build.sh", 17)).toBeNull();
  expect(slashTrigger("/etc/hosts", 10)).toBeNull();
  expect(slashTrigger("Use /etc/hosts now", "Use /et".length)).toBeNull();
  expect(slashTrigger("/rev now", 4)).toEqual({ start: 0, query: "rev", commands: true });
  const pill = { id: 1, workspace_id: "", skill: "caveman-commit", title: "caveman-commit", start: 0, end: 15 };
  expect(slashTrigger("/caveman-commit", 15, [pill])).toBeNull();
  expect(slashTrigger("/caveman-commit /x", 18, [pill])).toEqual({ start: 16, query: "x", commands: false });
});

test("a message that opens with a command runs it; one no command owns goes as typed", () => {
  expect(leadingCommand("/rename Auth fix")).toMatchObject({ command: { id: "rename" }, args: "Auth fix", start: 0, end: 7 });
  expect(leadingCommand("/clear")).toMatchObject({ command: { id: "new" }, args: "" });
  expect(leadingCommand(" /MODEL opus")).toMatchObject({ command: { id: "model" }, args: "opus", start: 1 });
  expect(leadingCommand("/security-review")).toBeNull(); // Claude Agent's own: sent
  expect(leadingCommand("please /review")).toBeNull();
  expect(leadingCommand("/reviewing")).toBeNull();
  const pill = { id: 1, workspace_id: "", skill: "review", title: "review", start: 0, end: 7 };
  expect(leadingCommand("/review the auth", [pill])).toBeNull(); // a skill pill, not the command
});

const skill = (over: Partial<Parameters<typeof skillsFor>[0][number]>): Parameters<typeof skillsFor>[0][number] => ({
  name: "caveman-commit",
  description: "Write a Conventional Commit",
  scope: "me",
  path: "/Users/ada/.claude/skills/caveman-commit/SKILL.md",
  engines: ["claude-agent"],
  enabled: true,
  idle_tokens_estimate: 12,
  ...over,
});

test("a skill goes by the name its engine runs it under, in characters a mention holds", () => {
  // Claude Agent runs home and repository skills by folder; Codex by declared name.
  const declared = skill({ name: "Commit Helper", path: "/r/.claude/skills/commit/SKILL.md", scope: "project" });
  expect(skillToken(declared, "claude-agent")).toBe("commit");
  expect(skillToken(declared, "codex")).toBe("Commit-Helper");
  expect(skillToken(skill({ name: "--odd name!" }), "codex")).toBe("odd-name-");
  expect(tildePath("/Users/ada/.claude/skills/x/SKILL.md")).toBe("~/.claude/skills/x/SKILL.md");
});

test("a chat offers the skills its engine loads: on, its own repository's, one per name", () => {
  const all = [
    skill({}),
    skill({ name: "codex-only", path: "/h/.agents/skills/codex-only/SKILL.md", engines: ["codex"] }),
    skill({ name: "off", path: "/h/.claude/skills/off/SKILL.md", enabled: false }),
    skill({ name: "here", path: "/a/.claude/skills/here/SKILL.md", scope: "project", project_id: "p1" }),
    skill({ name: "there", path: "/b/.claude/skills/there/SKILL.md", scope: "project", project_id: "p2" }),
    skill({ path: "/x/.claude/skills/caveman-commit/SKILL.md", scope: "project", project_id: "p1" }),
  ];
  expect(skillsFor(all, "claude-agent", "p1").map((s) => s.token)).toEqual(["caveman-commit", "here"]);
  expect(skillsFor(all, "codex", "p1").map((s) => s.token)).toEqual(["codex-only"]);
  expect(skillsFor(all, undefined, "p1")).toEqual([]);
});

test("sent `$name` reads back as a skill only when it names one", () => {
  const text = "$caveman-commit then echo $HOME and $caveman-commit.";
  expect(skillMentions(text, new Set(["caveman-commit"]))).toEqual([{ start: 0, end: 15, token: "caveman-commit" }]);
  expect(skillMentions("pay $20", new Set(["20"]))).toEqual([]); // starts with a digit: "20" never names a skill here
});

test("a picked skill is a pill reading /name that sends $name", () => {
  let d = changeDraft(EMPTY_DRAFT, "fix it /cav", 11);
  const e = refEdit(d.text, 7, 11, { workspace_id: "", title: "caveman-commit", skill: "caveman-commit" });
  d = changeDraft(d, d.text.slice(0, 7) + e.insert, 7 + e.insert.length, e.ref);
  expect(d.text).toBe("fix it /caveman-commit ");
  expect(d.refs[0]).toMatchObject({ start: 7, end: 22, skill: "caveman-commit" });
  expect(serializeDraft(d)).toBe("fix it $caveman-commit ");
});

test("an engine's own commands: not ones ours answer to, not its skills, one per name, no leading slash", () => {
  const listed = engineCommandsFor(
    [{ name: "compact" }, { name: "/security-review", description: "Review the branch" }, { name: "caveman-commit" }, { name: "security-review" }, { name: "Init" }, { name: "pr-comments", hint: "[pr]" }],
    new Set(["caveman-commit"]),
  );
  expect(listed).toEqual([{ name: "security-review", description: "Review the branch" }, { name: "pr-comments", hint: "[pr]" }]);
});

test("the /word a message opens with: ours, an engine's, a plugin's", () => {
  expect(leadingSlash("/plugin:deploy now")).toEqual({ name: "plugin:deploy", start: 0, end: 14, args: "now" });
  expect(leadingSlash("  /security-review")).toEqual({ name: "security-review", start: 2, end: 18, args: "" });
  expect(leadingSlash("see /x")).toBeNull();
  expect(leadingCommand("/undo")).toMatchObject({ command: { id: "undo" } });
  expect(leadingCommand("/signout")).toMatchObject({ command: { id: "logout" } });
  expect(leadingCommand("/export")).toMatchObject({ command: { id: "export" } });
});
