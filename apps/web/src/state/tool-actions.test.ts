import { expect, test } from "vitest";
import { actionVerb, iconOf, isDesktopTool, lineOf, plainCommand, readCommand, readDesktop, summarizeParts, type ToolPart } from "./tool-actions.ts";

const read = (command: string) => readCommand(command).map((p) => [p.action, p.subject]);
const said = (command: string) => {
  const line = lineOf(readCommand(command), true);
  return [line.verb, line.subject].filter(Boolean).join(" ");
};

test("a command says what it did, past the cd an agent opens with and the shell Codex wraps it in", () => {
  expect(read(`cd "/Users/me/repo" && sed -n 1,80p src/retry.go`)).toEqual([["read", "src/retry.go"]]);
  expect(read(`/bin/zsh -lc "rg -n 'retryPolicy' src --glob '*.go'"`)).toEqual([["search", "retryPolicy in src"]]);
  expect(read(`cd ~/repo && grep -rn "a\\|b" packages/runtime/src | grep -v test | head -20 || true`)).toEqual([["search", "a|b in packages/runtime/src"]]);
  expect(read("ls -la apps/web/src")).toEqual([["list", "apps/web/src"]]);
  expect(said("ls")).toBe("Listed files");
  expect(said("ls apps/web/src/state; ls /repo/apps/web/src/components; cat package.json")).toBe("Listed 2 folders, read package.json");
  expect(read(`find . -name "*.test.ts" -not -path "*/node_modules/*"`)).toEqual([["search", "*.test.ts"]]);
  expect(read("cat package.json tsconfig.json")).toEqual([["read", "package.json, tsconfig.json"]]);
});

test("a command that did several things says each, in order, done and while it runs", () => {
  const command = `cd /repo && sed -n 1,40p src/a.ts; grep -n "retry" src/b.ts; sed -n 1,9p src/c.ts`;
  expect(said(command)).toBe("Read 2 files, searched for retry in src/b.ts");
  expect(lineOf(readCommand(command), false)).toEqual({ verb: "Reading", subject: "src/a.ts", then: "searching for retry in src/b.ts" });
  expect(said("git status --short && git log --oneline -3 && git diff --stat")).toBe("Checked git status, read git history, viewed changes");
  // A step it cannot read is still counted, never dropped.
  expect(said(`cat > /tmp/probe.mjs <<'EOF'\nconsole.log(1)\nEOF\nnode /tmp/probe.mjs --flag`)).toBe("Wrote probe.mjs, ran a command");
  // Separators and pauses say nothing.
  expect(said(`echo "== a"; sleep 2; curl -s http://localhost:5173/health`)).toBe("Fetched http://localhost:5173/health");
  expect(said("sleep 20 && echo finished")).toBe("Waited 20s");
});

test("tests, checks, builds and installs by what they do, naming the package or file", () => {
  expect(read("pnpm --filter @caveman-app/web exec vitest run --config ../../vitest.config.ts src/state/transcript.test.ts")).toEqual([["test", "src/state/transcript.test.ts"]]);
  expect(read("pnpm -C apps/web test")).toEqual([["test", "apps/web"]]);
  expect(said("timeout 300 go test -count=1 ./cloud/...")).toBe("Tested ./cloud/...");
  expect(said("npm test")).toBe("Ran tests");
  expect(said("make test-postgres-integration")).toBe("Ran tests");
  expect(said("pnpm typecheck 2>&1 | tail -20")).toBe("Type-checked");
  expect(said("npx tsc --noEmit -p tsconfig.json")).toBe("Type-checked");
  expect(said("cargo clippy")).toBe("Linted");
  expect(said("pnpm install --frozen-lockfile")).toBe("Installed dependencies");
  expect(said("pnpm add -D vitest")).toBe("Installed vitest");
  expect(said("python3 -m pytest tests/test_retry.py")).toBe("Tested tests/test_retry.py");
});

test("git and GitHub by what they did", () => {
  expect(said(`git commit --only -m "$(cat <<'EOF'\nfix(web): commands say what they did\n\nBody.\nEOF\n)" -- apps/web`)).toBe("Committed fix(web): commands say what they did");
  expect(said("git add apps/web/src/a.ts && git commit -am wip")).toBe("Staged apps/web/src/a.ts, committed wip");
  expect(said("git push -u origin caveman/fix")).toBe("Pushed caveman/fix");
  expect(said("git fetch -q origin && git merge --ff-only origin/main")).toBe("Fetched origin, merged origin/main");
  expect(said("git show 9773f66 --stat")).toBe("Viewed 9773f66");
  expect(said("git -C ../app log --oneline -5")).toBe("Read git history");
  expect(said("gh pr view 123 --json title,body -q .title")).toBe("Checked pull request #123");
  expect(said(`gh pr create --title "Commands say what they did" --body x`)).toBe("Opened pull request Commands say what they did");
  expect(said("gh run view 991 --log-failed")).toBe("Checked CI run 991");
  expect(said(`gh api repos/acme/app/pulls/7/comments --jq '.[].body'`)).toBe("Called GitHub repos/acme/app/pulls/7/comments");
});

test("files changed by hand, scripts and databases", () => {
  expect(said("mkdir -p /tmp/probe && rm -rf /tmp/old")).toBe("Created probe, deleted old");
  expect(said(`sed -i '' 's/a/b/' src/a.ts`)).toBe("Edited src/a.ts");
  expect(said("mv src/a.ts src/b.ts")).toBe("Moved src/a.ts → src/b.ts");
  expect(said(`python3 -I - <<'EOF'\nprint(1)\nEOF`)).toBe("Ran a Python script");
  expect(said(`node -e "console.log(1)"`)).toBe("Ran a Node script");
  expect(said(`sqlite3 -readonly "file:/data/state.sqlite?mode=ro" "select 1;"`)).toBe("Queried state.sqlite");
});

test("what it cannot read says Ran and the command, without the cd", () => {
  expect(read(`cd "/Users/me/repo" && ./scripts/g.sh https://x.dev 6`)).toEqual([["command", "./scripts/g.sh https://x.dev 6"]]);
  expect(read("command -v node")).toEqual([["command", "command -v node"]]);
  expect(read("for f in a b; do wc -l $f; done")).toEqual([["command", "for f in a b; do wc -l $f; done"]]);
  expect(plainCommand(`/bin/bash -lc "cd /repo && node -e \\"x\\""`)).toBe(`node -e "x"`);
});

test("a part with no subject takes its bare verbs", () => {
  const parts: ToolPart[] = [{ action: "test", subject: "" }];
  expect([actionVerb("test", "", false), lineOf(parts, true).verb]).toEqual(["Running tests", "Ran tests"]);
  expect(actionVerb("test", "apps/web", true)).toBe("Tested");
});

test("a call held for approval says all it would do, and wears the run mark when it runs anything", () => {
  const parts = readCommand(`cat >> tasks.test.js <<'EOF'\ntest('x', () => {});\nEOF\nnode --test`);
  expect(lineOf(parts, false)).toEqual({ verb: "Writing", subject: "tasks.test.js", then: "running tests" });
  // A first step that names nothing carries the rest in its verb.
  expect(lineOf([{ action: "test", subject: "" }, { action: "write", subject: "a.js" }], false)).toEqual({ verb: "Running tests, writing a.js", subject: "" });
  expect(iconOf(parts)).toBe("run");
  expect(iconOf(readCommand("cat > a.txt <<'EOF'\nhi\nEOF"))).toBe("edit");
});

test("a run that wrote and edited files says it once, by file", () => {
  const parts: ToolPart[] = [
    { action: "write", subject: "tasks.js" },
    { action: "write", subject: "tasks.test.js" },
    { action: "edit", subject: "tasks.test.js" },
    { action: "test", subject: "" },
  ];
  expect(summarizeParts(parts)).toBe("Changed 2 files, ran tests");
  expect(summarizeParts([{ action: "edit", subject: "tasks.js" }])).toBe("Edited tasks.js");
});

test("the desktop tool is known in every engine's spelling, and nothing else is", () => {
  expect(["mcp__caveman-code__desktop", "caveman-code.desktop", "mcp__caveman_code__desktop"].every(isDesktopTool)).toBe(true);
  expect(["desktop", "mcp__caveman-code__browser", "mcp__other__desktop", "caveman-code.desktop_x"].some(isDesktopTool)).toBe(false);
});

test("a desktop call says what it did in which app, like Codex says computer use", () => {
  const line = (input: unknown, done: boolean) => {
    const l = lineOf([readDesktop(input)], done);
    return [l.verb, l.subject].filter(Boolean).join(" ");
  };
  expect(line({ app: "Safari", command: "snapshot" }, false)).toBe("Looking at Safari");
  expect(line({ app: "Safari", command: "snapshot" }, true)).toBe("Looked at Safari");
  expect(line({ app: "Safari", command: "click", args: { ref_id: "@a:e5" } }, true)).toBe("Clicked in Safari");
  expect(line({ app: "Notes", command: "type", args: { text: "hi" } }, false)).toBe("Typing in Notes");
  expect(line({ app: "Notes", command: "set-value" }, true)).toBe("Typed in Notes");
  expect(line({ app: "Finder", command: "press", args: { combo: "cmd+n" } }, true)).toBe("Pressed keys in Finder");
  expect(line({ app: "Safari", command: "scroll" }, true)).toBe("Scrolled Safari");
  expect(line({ app: "Calendar", command: "launch" }, true)).toBe("Opened Calendar");
  expect(line({ app: "Calendar", command: "close-app" }, false)).toBe("Quitting Calendar");
  expect(line({ app: "Calendar", command: "move-window" }, true)).toBe("Arranged Calendar");
  // The clipboard and Notification Center by name; a call on a ref alone by its bare verb.
  expect(line({ command: "clipboard-get" }, true)).toBe("Looked at Clipboard");
  expect(line({ command: "list-notifications" }, true)).toBe("Looked at Notification Center");
  expect(line({ command: "click", args: { ref_id: "@a:e5" } }, true)).toBe("Clicked");
  expect(line({ app: "Safari" }, true)).toBe("Used Safari");
  expect(line(null, true)).toBe("Used an app");
});

test("a desktop call of several steps says its most significant one: any act beats a look", () => {
  const steps = (...commands: string[]) => readDesktop({ app: "Safari", steps: commands.map((command) => ({ command })) });
  expect(steps("snapshot", "click", "snapshot")).toEqual({ action: "desktop_click", subject: "Safari" });
  expect(steps("click", "type", "press")).toEqual({ action: "desktop_type", subject: "Safari" });
  expect(steps("snapshot", "find")).toEqual({ action: "desktop_look", subject: "Safari" });
  expect(steps("launch", "snapshot", "click")).toEqual({ action: "desktop_open", subject: "Safari" });
  expect(iconOf([steps("click")])).toBe("other");
});

test("a run of desktop calls sums up as the apps it used", () => {
  const part = (app: string, command: string) => readDesktop({ app, command });
  expect(summarizeParts([part("Safari", "snapshot"), part("Safari", "click"), part("Safari", "type")])).toBe("Used Safari");
  expect(summarizeParts([part("Safari", "click"), part("Notes", "type")])).toBe("Used 2 apps");
  expect(summarizeParts([...readCommand("cat a.ts"), part("Safari", "click")])).toBe("Read a.ts, used Safari");
});
