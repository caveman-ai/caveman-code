// How the chat says what a tool call did: each action's verbs while it runs
// and once done, its icon, and how a settled run's summary says it. A shell
// command is read for what it did, as Codex parses its commands: "Read
// retry.go", "Searched for retryPolicy in src", "Ran tests", "Checked git
// status", never `cd "/Users/…" && sed -n 1,80p retry.go`. A command that did
// several things says each ("Read retry.go, searched for retryPolicy"); its
// line still opens to the command itself. A command this cannot read says
// "Ran" and the command, without its `cd` and shell wrapper.
import type { ToolItem } from "./transcript-model.ts";
import { basename } from "./workspace-paths.ts";

type Summary = (subjects: ReadonlyArray<string>) => string;

export interface ToolAction {
  /** Running and done, before a subject: "Reading" / "Read" retry.go. */
  readonly verbs?: readonly [string, string];
  /** Running and done when the call names no subject: "Listing files" / "Listed files". */
  readonly bare?: readonly [string, string];
  readonly icon: ToolItem["icon"];
  /** How a summary says this action's calls, from their subjects: "read 3 files", "ran tests". */
  readonly summary: Summary;
  /** The action a summary counts this one as, so a family reads once: every desktop step is "used Safari". */
  readonly summaryAs?: string;
}

/** "read retry.go", "read 3 files": each file once; `none` when they named none. */
const files =
  (verb: string, noun = "file", none = `${verb} ${noun}s`): Summary =>
  (subjects) => {
    const names = new Set(subjects.flatMap((s) => s.split(", ")).filter(Boolean));
    if (names.size === 1) return `${verb} ${basename([...names][0]!)}`;
    return names.size === 0 ? none : `${verb} ${names.size} ${noun}s`;
  };
/** "ran a command", "ran 3 commands". */
const times =
  (verb: string, noun: string): Summary =>
  (subjects) =>
    subjects.length === 1 ? `${verb} a ${noun}` : `${verb} ${subjects.length} ${noun}s`;
/** One call by its subject ("searched for retryPolicy"), else `plain`; several as `many` (`#` their count). */
const named =
  (verb: string, plain: string, many = plain): Summary =>
  (subjects) =>
    subjects.length === 1 && subjects[0] ? `${verb} ${subjects[0]}` : subjects.length === 1 ? plain : many.replace("#", String(subjects.length));
const once =
  (phrase: string): Summary =>
  () =>
    phrase;
/** The runtime's own tools, each by its done line: "sent to Fix login, read Fix checkout"; more than two by their count. */
const own: Summary = (subjects) => {
  const lines = [...new Set(subjects.filter(Boolean))].map((s) => s.charAt(0).toLowerCase() + s.slice(1));
  return lines.length > 2 ? `used ${subjects.length} Caveman Code tools` : lines.length === 0 ? "used a Caveman Code tool" : lines.join(", ");
};
/** "used Safari", "used 2 apps": each app once. */
const apps: Summary = (subjects) => {
  const names = new Set(subjects.filter(Boolean));
  return names.size === 1 ? `used ${[...names][0]}` : names.size === 0 ? "used an app" : `used ${names.size} apps`;
};

export const ACTIONS = {
  command: { verbs: ["Running", "Ran"], bare: ["Running a command", "Ran a command"], icon: "run", summary: times("ran", "command") },
  read: { verbs: ["Reading", "Read"], icon: "read", summary: files("read") },
  edit: { verbs: ["Editing", "Edited"], bare: ["Editing a file", "Edited a file"], icon: "edit", summary: files("edited") },
  create: { verbs: ["Creating", "Created"], icon: "create", summary: files("created") },
  write: { verbs: ["Writing", "Wrote"], icon: "edit", summary: files("wrote") },
  // A run that both wrote and edited files says it once, by file: never one file under two verbs.
  change: { verbs: ["Changing", "Changed"], icon: "edit", summary: files("changed") },
  delete: { verbs: ["Deleting", "Deleted"], icon: "edit", summary: files("deleted") },
  move: { verbs: ["Moving", "Moved"], icon: "edit", summary: named("moved", "moved a file", "moved # files") },
  copy: { verbs: ["Copying", "Copied"], icon: "edit", summary: named("copied", "copied a file", "copied # files") },
  folder: { verbs: ["Creating folder", "Created folder"], icon: "create", summary: files("created", "folder") },
  search: { verbs: ["Searching for", "Searched for"], bare: ["Searching", "Searched"], icon: "search", summary: named("searched for", "searched", "searched # times") },
  list: { verbs: ["Listing", "Listed"], bare: ["Listing files", "Listed files"], icon: "search", summary: files("listed", "folder", "listed files") },
  web: { verbs: ["Fetching", "Fetched"], icon: "web", summary: named("fetched", "fetched a page", "fetched # pages") },
  web_search: { verbs: ["Searching the web for", "Searched the web for"], bare: ["Searching the web", "Searched the web"], icon: "web", summary: named("searched the web for", "searched the web", "searched the web # times") },
  mcp: { verbs: ["Calling", "Called"], icon: "mcp", summary: times("called", "connector") },
  // The runtime's own tools (thread_send, delegate_task, …): the subject is the call's done line ("Sent to Fix login").
  caveman: { verbs: ["Using", "Used"], icon: "mcp", summary: own },
  browser: { verbs: ["Browsing", "Browsed"], icon: "browser", summary: times("browsed", "page") },
  other: { verbs: ["Using", "Used"], icon: "other", summary: times("used", "tool") },
  image_generation: { bare: ["Generating image", "Generated image"], icon: "other", summary: named("generated", "generated an image", "generated # images") },
  image_view: { verbs: ["Viewing", "Viewed"], icon: "read", summary: named("viewed", "viewed an image", "viewed # images") },
  test: { verbs: ["Testing", "Tested"], bare: ["Running tests", "Ran tests"], icon: "run", summary: named("tested", "ran tests") },
  typecheck: { verbs: ["Type-checking", "Type-checked"], icon: "run", summary: named("type-checked", "type-checked") },
  lint: { verbs: ["Linting", "Linted"], icon: "run", summary: named("linted", "linted") },
  format: { verbs: ["Formatting", "Formatted"], icon: "edit", summary: named("formatted", "formatted") },
  build: { verbs: ["Building", "Built"], icon: "run", summary: named("built", "built") },
  install: { verbs: ["Installing", "Installed"], bare: ["Installing dependencies", "Installed dependencies"], icon: "run", summary: named("installed", "installed dependencies") },
  python: { bare: ["Running a Python script", "Ran a Python script"], icon: "run", summary: times("ran", "Python script") },
  node: { bare: ["Running a Node script", "Ran a Node script"], icon: "run", summary: times("ran", "Node script") },
  wait: { verbs: ["Waiting", "Waited"], icon: "run", summary: named("waited", "waited") },
  query: { verbs: ["Querying", "Queried"], icon: "read", summary: named("queried", "queried a database") },
  git_status: { bare: ["Checking git status", "Checked git status"], icon: "read", summary: once("checked git status") },
  diff: { verbs: ["Diffing", "Diffed"], bare: ["Viewing changes", "Viewed changes"], icon: "read", summary: named("diffed", "viewed changes") },
  history: { verbs: ["Reading history of", "Read history of"], bare: ["Reading git history", "Read git history"], icon: "read", summary: named("read history of", "read git history") },
  show: { verbs: ["Viewing", "Viewed"], bare: ["Viewing the last commit", "Viewed the last commit"], icon: "read", summary: named("viewed", "viewed the last commit", "viewed # commits") },
  stage: { verbs: ["Staging", "Staged"], bare: ["Staging changes", "Staged changes"], icon: "run", summary: named("staged", "staged changes") },
  commit: { verbs: ["Committing", "Committed"], icon: "run", summary: named("committed", "committed") },
  push: { verbs: ["Pushing", "Pushed"], icon: "run", summary: named("pushed", "pushed") },
  pull: { verbs: ["Pulling", "Pulled"], icon: "run", summary: named("pulled", "pulled") },
  git_fetch: { verbs: ["Fetching", "Fetched"], bare: ["Fetching from git", "Fetched from git"], icon: "run", summary: named("fetched", "fetched from git") },
  switch: { verbs: ["Switching to", "Switched to"], icon: "run", summary: named("switched to", "switched branches") },
  restore: { verbs: ["Restoring", "Restored"], icon: "edit", summary: files("restored") },
  merge: { verbs: ["Merging", "Merged"], icon: "run", summary: named("merged", "merged") },
  rebase: { verbs: ["Rebasing onto", "Rebased onto"], bare: ["Rebasing", "Rebased"], icon: "run", summary: named("rebased onto", "rebased") },
  branches: { bare: ["Listing branches", "Listed branches"], icon: "read", summary: once("listed branches") },
  pr_open: { verbs: ["Opening pull request", "Opened pull request"], bare: ["Opening a pull request", "Opened a pull request"], icon: "web", summary: named("opened pull request", "opened a pull request") },
  pr: { verbs: ["Checking pull request", "Checked pull request"], bare: ["Checking pull requests", "Checked pull requests"], icon: "web", summary: named("checked pull request", "checked pull requests") },
  pr_merge: { verbs: ["Merging pull request", "Merged pull request"], bare: ["Merging a pull request", "Merged a pull request"], icon: "web", summary: named("merged pull request", "merged a pull request") },
  ci: { verbs: ["Checking CI run", "Checked CI run"], bare: ["Checking CI", "Checked CI"], icon: "web", summary: named("checked CI run", "checked CI") },
  issue: { verbs: ["Checking issue", "Checked issue"], bare: ["Checking issues", "Checked issues"], icon: "web", summary: named("checked issue", "checked issues") },
  issue_open: { verbs: ["Opening issue", "Opened issue"], bare: ["Opening an issue", "Opened an issue"], icon: "web", summary: named("opened issue", "opened an issue") },
  github: { verbs: ["Calling GitHub", "Called GitHub"], icon: "web", summary: named("called GitHub", "called GitHub") },
  // The Caveman engine's bash on a command it left running (its subject is that command).
  "bash:read": { verbs: ["Checking", "Checked"], icon: "run", summary: times("checked", "command") },
  "bash:write": { verbs: ["Sending input to", "Sent input to"], icon: "run", summary: named("sent input to", "sent input") },
  "bash:kill": { verbs: ["Stopping", "Stopped"], icon: "run", summary: times("stopped", "command") },
  "bash:list": { verbs: ["Listing", "Listed"], icon: "run", summary: named("listed", "listed commands") },
  // The runtime's own row while a new chat's worktree is made (workspace.create answers before it is): its branch.
  worktree: { verbs: ["Setting up worktree", "Set up worktree"], icon: "run", summary: named("set up worktree", "set up a worktree") },
  // The runtime's `desktop` tool on this Mac's apps, read like Codex reads computer use: the app is the subject.
  desktop: { verbs: ["Using", "Used"], bare: ["Using an app", "Used an app"], icon: "other", summary: apps },
  desktop_look: { verbs: ["Looking at", "Looked at"], bare: ["Looking at an app", "Looked at an app"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_click: { verbs: ["Clicking in", "Clicked in"], bare: ["Clicking", "Clicked"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_type: { verbs: ["Typing in", "Typed in"], bare: ["Typing", "Typed"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_press: { verbs: ["Pressing keys in", "Pressed keys in"], bare: ["Pressing keys", "Pressed keys"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_scroll: { verbs: ["Scrolling", "Scrolled"], bare: ["Scrolling", "Scrolled"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_open: { verbs: ["Opening", "Opened"], bare: ["Opening an app", "Opened an app"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_quit: { verbs: ["Quitting", "Quit"], bare: ["Quitting an app", "Quit an app"], icon: "other", summary: apps, summaryAs: "desktop" },
  desktop_arrange: { verbs: ["Arranging", "Arranged"], bare: ["Arranging a window", "Arranged a window"], icon: "other", summary: apps, summaryAs: "desktop" },
} as const satisfies Record<string, ToolAction>;

export type ActionKey = keyof typeof ACTIONS;

export const isAction = (key: string): key is ActionKey => Object.hasOwn(ACTIONS, key);

/** One thing a tool call did: an action and what it named ("" for none). */
export interface ToolPart {
  readonly action: ActionKey;
  readonly subject: string;
}

/** The verb a part's line opens with: running or done, bare when it names no subject. */
export function actionVerb(key: ActionKey, subject: string, done: boolean): string {
  const a: ToolAction = ACTIONS[key];
  const pair = (subject === "" ? a.bare : a.verbs) ?? a.verbs ?? a.bare!;
  return pair[done ? 1 : 0];
}

/**
 * "Read 3 files, searched for retryPolicy, ran tests": each action once, in order of first appearance. Writes and
 * edits together are one "changed" by file ("changed 2 files", not "wrote 2 files, edited tasks.test.js").
 */
export function summarizeParts(parts: ReadonlyArray<ToolPart>): string {
  const both = parts.some((p) => p.action === "write") && parts.some((p) => p.action === "edit");
  const groups = new Map<ActionKey, string[]>();
  for (const p of parts) {
    const as = (ACTIONS[p.action] as ToolAction).summaryAs;
    const action: ActionKey = both && (p.action === "write" || p.action === "edit") ? "change" : as !== undefined && isAction(as) ? as : p.action;
    groups.set(action, [...(groups.get(action) ?? []), p.subject]);
  }
  const s = [...groups].map(([action, subjects]) => ACTIONS[action].summary(subjects)).join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A call's line: one kind of part as its verb and subjects ("Read" a.ts, b.ts); several kinds in words, once done
 * ("Read a.ts, searched for retry") and while it runs, each kind by its first subject: the first as its verb and
 * subject, the rest after it ("Writing" tasks.test.js ", running tests"). A call held for approval says everything
 * Allow lets it do, never only its first step.
 */
export function lineOf(parts: ReadonlyArray<ToolPart>, done: boolean): { readonly verb: string; readonly subject: string; readonly then?: string } {
  const first = parts[0]!;
  if (done && parts.some((p) => p.action !== first.action)) return { verb: summarizeParts(parts), subject: "" };
  if (parts.some((p) => p.action !== first.action)) {
    const kinds = new Map<ActionKey, string>();
    for (const p of parts) if (!kinds.has(p.action)) kinds.set(p.action, p.subject);
    const entries = [...kinds];
    const [lead, subject] = entries[0]!;
    const rest = entries.slice(1);
    const then = rest
      .map(([action, s]) => {
        const verb = actionVerb(action, s, false);
        return `${verb.charAt(0).toLowerCase()}${verb.slice(1)}${s ? ` ${s}` : ""}`;
      })
      .join(", ");
    const verb = actionVerb(lead, subject, false);
    // With no subject of its own, the first kind's verb carries the rest: "Running tests, writing a.js".
    return subject ? { verb, subject, then } : { verb: `${verb}, ${then}`, subject: "" };
  }
  const subjects = done ? [...new Set(parts.map((p) => p.subject).filter(Boolean))] : [first.subject];
  return { verb: actionVerb(first.action, subjects.join(""), done), subject: subjects.join(", ") };
}

/** A call's mark: the run mark when any step runs something (as its approval card shows it), else its first step's. */
export function iconOf(parts: ReadonlyArray<ToolPart>): ToolItem["icon"] {
  return parts.some((p) => ACTIONS[p.action].icon === "run") ? "run" : ACTIONS[parts[0]!.action].icon;
}

// ------------------------------------------------------------- the desktop tool

/** The runtime's `desktop` tool in each engine's spelling: `mcp__caveman-code__desktop` (Claude Agent), `caveman-code.desktop` (Codex), `mcp__caveman_code__desktop` (Caveman). */
export const isDesktopTool = (name: string): boolean => /^(?:mcp__(?:caveman|t3)[-_]code__|(?:caveman|t3)[-_]code[.:/])desktop$/i.test(name);

/** What each agent-desktop command does, as a line says it; one this does not know reads "Used". */
const DESKTOP_VERBS: Readonly<Record<string, ActionKey>> = {
  ...Object.fromEntries(
    ["snapshot", "find", "get", "is", "screenshot", "wait", "list-surfaces", "list-windows", "list-apps", "list-displays", "list-notifications", "clipboard-get", "skills"].map((c) => [c, "desktop_look"]),
  ),
  ...Object.fromEntries(["click", "right-click", "check", "uncheck", "toggle", "expand", "collapse", "select", "focus"].map((c) => [c, "desktop_click"])),
  ...Object.fromEntries(["type", "set-value", "clear", "clipboard-set", "clipboard-clear"].map((c) => [c, "desktop_type"])),
  press: "desktop_press",
  scroll: "desktop_scroll",
  "scroll-to": "desktop_scroll",
  launch: "desktop_open",
  "open-system-surface": "desktop_open",
  "close-app": "desktop_quit",
  ...Object.fromEntries(["minimize", "maximize", "restore", "move-window", "resize-window"].map((c) => [c, "desktop_arrange"])),
};

/** Of a call's steps, the one its line says: any act beats a look, and opening or quitting an app beats typing, which beats a click. */
const DESKTOP_WEIGHT: Partial<Record<ActionKey, number>> = { desktop_look: 0, desktop: 1, desktop_scroll: 1, desktop_arrange: 1, desktop_click: 2, desktop_press: 3, desktop_type: 4, desktop_open: 5, desktop_quit: 5 };

/**
 * A `desktop` call ({ app?, command?, args?, steps? }) as one part: the app it used ("Clicked in Safari"), the
 * clipboard and Notification Center by name, and a call on a ref alone by its bare verb ("Clicked").
 */
export function readDesktop(input: unknown): ToolPart {
  const i = input !== null && typeof input === "object" ? (input as { app?: unknown; command?: unknown; steps?: unknown }) : {};
  const commands = Array.isArray(i.steps)
    ? i.steps.flatMap((s: unknown) => (s !== null && typeof s === "object" && typeof (s as { command?: unknown }).command === "string" ? [(s as { command: string }).command] : []))
    : typeof i.command === "string"
      ? [i.command]
      : [];
  let action: ActionKey = DESKTOP_VERBS[commands[0] ?? ""] ?? "desktop";
  for (const c of commands.slice(1)) {
    const next = DESKTOP_VERBS[c] ?? "desktop";
    if ((DESKTOP_WEIGHT[next] ?? 0) > (DESKTOP_WEIGHT[action] ?? 0)) action = next;
  }
  // Every step of a call works on its one app; the clipboard and Notification Center are named like apps.
  const app = typeof i.app === "string" ? i.app.trim() : "";
  const subject = app || (commands.some((c) => c.startsWith("clipboard-")) ? "Clipboard" : commands.includes("list-notifications") ? "Notification Center" : "");
  return { action, subject };
}

// ------------------------------------------------------------- shell commands

/** What a shell command did, step by step: `sed -n 1,80p retry.go; rg retry src` read retry.go and searched for retry in src. */
export function readCommand(command: string): ToolPart[] {
  const parts: ToolPart[] = [];
  for (const line of pipelines(steps(command))) {
    // `|| true`, `|| echo …`: what runs when the command before fails is not what it did.
    if (line.after === "||") continue;
    const read = readPipeline(line.steps);
    if (read !== NOISE) parts.push(read);
  }
  // A pause between steps says nothing; alone, it is a wait.
  const real = parts.some((p) => p.action !== "wait") ? parts.filter((p) => p.action !== "wait") : parts;
  return real.every((p) => p.action === "command") ? [{ action: "command", subject: plainCommand(command) }] : real;
}

/** The command as typed, without the shell wrapper Codex runs it in or the `cd` an agent opens with. */
export function plainCommand(command: string): string {
  const only = steps(command, false);
  let text = command.trim();
  const shell = only.length === 1 ? shellScript(only[0]!.words) : null;
  if (shell !== null) text = shell.trim();
  for (;;) {
    const next = text.replace(/^cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, "");
    if (next === text) return text;
    text = next;
  }
}

interface Step {
  readonly words: string[];
  /** Where its standard output goes (`> file`, `>> file`), when that is a file. */
  readonly writes: string | null;
  /** The operator before it: a step after `|` reads the one before's output. */
  readonly after: "" | ";" | "&&" | "||" | "|";
}

const NOISE = Symbol("noise");
/** A step's part; NOISE for one that did nothing to name (`cd`, `echo`); null for one this cannot read. */
type Read = ToolPart | typeof NOISE | null;

/** Splits a command line into its simple commands: quotes and escapes resolved, `$(…)` kept whole, heredoc bodies skipped. */
function steps(src: string, shells = true): Step[] {
  const out: Step[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let writes: string | null = null;
  let redirect: "out" | "drop" | null = null;
  let after: Step["after"] = "";
  const heredocs: string[] = [];
  const endWord = () => {
    if (!inWord) return;
    if (redirect === "out") writes = word;
    else if (redirect === null) words.push(word);
    redirect = null;
    word = "";
    inWord = false;
  };
  const endStep = (next: Step["after"]) => {
    endWord();
    if (words.length) {
      const script = shells ? shellScript(words) : null;
      if (script !== null) out.push(...steps(script).map((s, i) => (i === 0 ? { ...s, after } : s)));
      else out.push({ words, writes, after });
    }
    words = [];
    writes = null;
    redirect = null;
    after = next;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] !== "\n") (word += src[i + 1] ?? ""), (inWord = true);
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? src.length : end);
      inWord = true;
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`'.includes(src[j + 1]!)) j++;
        word += src[j++];
      }
      inWord = true;
      i = j + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      word += src.slice(i, j + 1);
      inWord = true;
      i = j + 1;
    } else if (c === "#" && !inWord) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "\n") {
      endStep(";");
      i++;
      // A heredoc's body runs to the line that closes it.
      for (const tag of heredocs.splice(0)) {
        while (i < src.length) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end + 1;
          if (line.trim() === tag) break;
        }
      }
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === ";" || c === "(" || c === ")") {
      endStep(";");
      i++;
    } else if (c === "&" && src[i + 1] === "&") {
      endStep("&&");
      i += 2;
    } else if (c === "|" && src[i + 1] === "|") {
      endStep("||");
      i += 2;
    } else if (c === "|") {
      endStep("|");
      i += src[i + 1] === "&" ? 2 : 1;
    } else if (c === "&" && src[i + 1] !== ">") {
      endStep(";");
      i++;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      endWord();
      i += src[i + 2] === "-" ? 3 : 2;
      while (src[i] === " ") i++;
      const tag = /^(['"]?)([\w.-]+)\1/.exec(src.slice(i));
      if (tag) heredocs.push(tag[2]!), (i += tag[0].length);
    } else if (c === "<" || c === ">" || c === "&") {
      // A redirect: standard output to a file is a write; anything else (input, stderr, `2>&1`) drops its target.
      const fd = inWord && /^\d$/.test(word) ? word : "";
      if (fd) (word = ""), (inWord = false);
      else endWord();
      const op = /^(?:&>>?|<<<|<|>>?)(&\d*-?)?\|?/.exec(src.slice(i))!;
      i += op[0].length;
      if (op[1]) continue;
      redirect = op[0].startsWith(">") && (fd === "" || fd === "1") && !op[0].startsWith("&") ? "out" : "drop";
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endStep(";");
  return out.map((s) => (s.writes === "/dev/null" ? { ...s, writes: null } : s));
}

/** `bash -lc "…"`, `/bin/zsh -c '…'`: the script it runs, else null. */
function shellScript(words: ReadonlyArray<string>): string | null {
  if (!/^(?:ba|z|da)?sh$/.test(basename(words[0] ?? ""))) return null;
  const at = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
  return at > 0 && words[at + 1] !== undefined ? words[at + 1]! : null;
}

/** Steps joined by pipes; `after` is the operator before the first. */
function pipelines(all: ReadonlyArray<Step>): Array<{ after: Step["after"]; steps: Step[] }> {
  const out: Array<{ after: Step["after"]; steps: Step[] }> = [];
  for (const step of all) {
    if (step.after === "|" && out.length) out[out.length - 1]!.steps.push(step);
    else out.push({ after: step.after, steps: [step] });
  }
  return out;
}

/** A pipeline is what its first real step did: `rg foo | head` searched; the steps after only shape the output. */
function readPipeline(line: ReadonlyArray<Step>): ToolPart | typeof NOISE {
  for (const step of line) {
    const words = unwrap(step.words);
    const read = readStep(words, step.writes);
    if (read === null) return { action: "command", subject: words.join(" ") };
    if (read !== NOISE) return read;
  }
  return NOISE;
}

/** Shell keywords before a command (`if git diff --quiet; then …`), and wrappers that run the one after them. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "exec", "caffeinate", "stdbuf", "unbuffer", "noglob", "builtin", "env"]);

/** The command under `FOO=1`, `env`, `timeout 90`, `sudo` and the like. */
function unwrap(words: ReadonlyArray<string>): string[] {
  let w = [...words];
  for (;;) {
    while (w.length > 1 && (/^[A-Za-z_]\w*=/.test(w[0]!) || KEYWORDS.has(w[0]!))) w = w.slice(1);
    const name = basename(w[0] ?? "");
    if (name === "timeout" || name === "gtimeout") w = flagsOff(w.slice(1), ["-k", "-s"]).slice(1);
    else if (WRAPPERS.has(name)) w = flagsOff(w.slice(1), ["-n", "-u", "-g"]);
    else return w;
  }
}

/** `args` without its leading flags (and the values of `valued` ones). */
function flagsOff(args: ReadonlyArray<string>, valued: ReadonlyArray<string>): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "-") i += valued.includes(args[i]!) ? 2 : 1;
  return args.slice(i);
}

/** The arguments that are not flags, skipping the value after each of `valued` and empty ones (`sed -i ''`); everything after `--` counts. */
function positionals(args: ReadonlyArray<string>, valued: ReadonlyArray<string> = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i + 1)];
    if (a.startsWith("-") && a !== "-") {
      if (valued.includes(a)) i++;
    } else if (a !== "") out.push(a);
  }
  return out;
}

/** The value of the first of `flags` (`-m msg`, `--title=x`), else null. */
function option(args: ReadonlyArray<string>, flags: ReadonlyArray<string>): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flags.includes(a)) return args[i + 1] ?? null;
    const eq = flags.find((f) => f.startsWith("--") && a.startsWith(`${f}=`));
    if (eq) return a.slice(eq.length + 1);
  }
  return null;
}

const join = (parts: ReadonlyArray<string>) => parts.join(", ");
/** Paths and targets worth naming: "." is where the command already is. */
const places = (parts: ReadonlyArray<string>) => parts.filter((p) => p !== "." && p !== "./");
const pathLike = (a: string) => /[/.]/.test(a) && !/^\d+(\.\d+)*$/.test(a);
const said = (action: ActionKey, subject = ""): ToolPart => ({ action, subject });

const QUIET = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "echo", "printf", "true", ":", "trap", "exit", "wait", "clear", "shopt", "local", "declare", "read", "test", "[", "[[", "fi", "done", "esac", "}", "break", "continue"]);
const GREP_VALUED = ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "-g", "-t", "-T", "-j", "-M", "--include", "--exclude", "--exclude-dir", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--context", "--after-context", "--before-context", "--regexp", "--file", "--threads", "--sort", "--sortr"];

function readStep(w: ReadonlyArray<string>, writes: string | null): Read {
  const name = basename(w[0] ?? "");
  const args = w.slice(1);
  // Nothing to run, or only `FOO=bar`.
  if (!name || (w.length === 1 && /^[A-Za-z_]\w*=/.test(name))) return NOISE;
  if ((name === "echo" || name === "printf" || name === "cat") && writes) return said("write", writes);
  if (QUIET.has(name)) return NOISE;
  switch (name) {
    case "cat":
    case "bat":
    case "less":
    case "more":
    case "nl": {
      const files = positionals(args).filter((a) => a !== "-");
      return files.length ? said("read", join(files)) : NOISE;
    }
    case "head":
    case "tail": {
      const files = positionals(args, ["-n", "-c", "--lines", "--bytes"]);
      return files.length ? said("read", join(files)) : NOISE;
    }
    case "sed":
    case "gsed":
    case "perl": {
      const inPlace = args.some((a) => /^-[a-z]*i/.test(a) || a === "--in-place");
      const script = option(args, ["-e", "--expression", "-f"]) !== null;
      const rest = positionals(args, ["-e", "--expression", "-f", "-l"]);
      const files = script ? rest : rest.slice(1);
      if (name === "perl" && !inPlace) return null;
      return files.length ? said(inPlace ? "edit" : "read", join(files)) : NOISE;
    }
    case "awk":
    case "gawk": {
      const files = positionals(args, ["-F", "-v", "-f"]).slice(option(args, ["-f"]) === null ? 1 : 0);
      return files.length ? said("read", join(files)) : NOISE;
    }
    case "grep":
    case "egrep":
    case "fgrep":
    case "ggrep":
    case "rg":
    case "ag":
    case "ack":
      return search(args);
    case "find": {
      const end = args.findIndex((a) => /^[-(!]/.test(a));
      const roots = places(end < 0 ? args : args.slice(0, end));
      const pattern = option(args, ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"]);
      return pattern ? said("search", roots.length ? `${pattern} in ${join(roots)}` : pattern) : said("list", join(roots));
    }
    case "fd":
    case "fdfind": {
      const [pattern, ...roots] = positionals(args, ["-e", "-t", "-d", "-E", "--extension", "--type", "--max-depth", "--exclude"]);
      if (!pattern) return said("list");
      return said("search", places(roots).length ? `${pattern} in ${join(places(roots))}` : pattern);
    }
    case "ls":
    case "tree":
    case "eza":
    case "exa":
    case "lsd":
      return said("list", join(places(positionals(args, ["-L", "-I", "-P"]))));
    case "git":
      return git(args);
    case "gh":
      return gh(args);
    case "curl":
    case "wget":
    case "http":
    case "https":
    case "xh": {
      const url = args.find((a) => /^(?:https?:\/\/|localhost[:/]|127\.0\.0\.1[:/])/.test(a)) ?? option(args, ["--url"]);
      return url ? said("web", url) : null;
    }
    case "sleep":
      return said("wait", /^\d+(\.\d+)?$/.test(args[0] ?? "") ? `${args[0]}s` : (args[0] ?? ""));
    case "mkdir":
      return said("folder", join(positionals(args, ["-m"])));
    case "rm":
    case "rmdir":
    case "trash":
      return said("delete", join(positionals(args)));
    case "touch":
      return said("create", join(positionals(args)));
    case "mv":
    case "cp": {
      const paths = positionals(args, ["-t", "-S"]);
      if (paths.length < 2) return null;
      return said(name === "mv" ? "move" : "copy", `${join(paths.slice(0, -1))} → ${paths.at(-1)}`);
    }
    case "sqlite3":
    case "duckdb":
    case "psql":
    case "mysql": {
      const db = option(args, ["-d", "--dbname"]) ?? positionals(args, ["-cmd", "-separator", "-U", "-h", "-p", "-c", "-u"])[0];
      return said("query", db ? basename(db.replace(/^file:/, "").replace(/\?.*$/, "")) : "");
    }
    case "python":
    case "python3":
    case "node":
    case "bun":
    case "deno":
    case "tsx":
      return runtime(name, args);
    case "uv":
    case "poetry":
    case "pipenv":
      if (args[0] === "run") return readStep(args.slice(1), writes);
      if (args[0] === "add" || args[0] === "sync" || (args[0] === "pip" && args[1] === "install")) return install(args.slice(args[0] === "pip" ? 2 : 1));
      return null;
    case "pip":
    case "pip3":
    case "brew":
    case "apt":
    case "apt-get":
    case "gem":
      return args[0] === "install" ? install(args.slice(1)) : null;
    case "npx":
    case "bunx":
    case "pnpx":
      return readStep(flagsOff(args, ["-p", "--package"]), writes);
    case "pnpm":
    case "npm":
    case "yarn":
    case "vp":
    case "turbo":
    case "nx":
      return packageScript(name, args, writes);
    case "make":
    case "just":
    case "task": {
      const dir = option(args, ["-C", "--directory", "-d"]);
      const target = positionals(args, ["-C", "--directory", "-d", "-f", "-j"]).find((a) => !a.includes("="));
      return target ? script(target, dir) : said("build", dir ?? "");
    }
    case "vitest":
    case "jest":
    case "mocha":
    case "ava":
    case "pytest":
    case "py.test":
    case "bats":
    case "rspec":
    case "phpunit":
      return said("test", join(places(positionals(args, ["-c", "--config", "-t", "--testNamePattern", "-k", "-m", "--project", "--reporter", "--root", "--dir"]).filter((a) => !["run", "watch", "related"].includes(a)))));
    case "playwright":
      return args[0] === "test" ? said("test", join(places(positionals(args.slice(1), ["-c", "--config", "-g", "--grep", "--project"])))) : null;
    case "tsc":
    case "tsgo":
    case "vue-tsc":
    case "mypy":
    case "pyright":
      return said("typecheck");
    case "eslint":
    case "oxlint":
    case "golangci-lint":
    case "stylelint":
    case "shellcheck":
    case "markdownlint":
      return said("lint", join(places(positionals(args, ["-c", "--config", "--format", "-f"]).filter(pathLike))));
    case "prettier":
    case "oxfmt":
    case "black":
    case "gofmt":
    case "goimports":
    case "rustfmt":
    case "dprint":
      return said("format", join(places(positionals(args, ["--config", "-c"]).filter((a) => pathLike(a) && a !== "fmt"))));
    case "biome":
    case "ruff":
      return args[0] === "format" ? said("format") : args[0] === "check" || args[0] === "lint" ? said("lint") : null;
    case "go":
      return tool(args, { test: "test", build: "build", vet: "lint", fmt: "format", get: "install" }, ["-run", "-count", "-timeout", "-tags", "-o", "-p"]);
    case "cargo":
      return tool(args, { test: "test", nextest: "test", build: "build", b: "build", check: "typecheck", c: "typecheck", clippy: "lint", fmt: "format", add: "install", install: "install" }, ["-p", "--package", "--features", "--target"]);
    default:
      return null;
  }
}

function search(args: ReadonlyArray<string>): ToolPart {
  if (args.includes("--files")) return said("list", join(places(positionals(args, GREP_VALUED))));
  const regexp = option(args, ["-e", "--regexp"]);
  const rest = positionals(args, GREP_VALUED);
  // `a\|b` (grep's alternation) reads as `a|b`.
  const pattern = (regexp ?? rest[0] ?? "").replaceAll("\\|", "|");
  const paths = places(regexp === null ? rest.slice(1) : rest);
  return said("search", paths.length ? `${pattern} in ${join(paths)}` : pattern);
}

const GIT_VALUED = ["-n", "--author", "--grep", "--since", "--until", "-s", "--source", "-b", "-B", "-c", "-C", "-m", "--message", "-F", "--date", "--onto", "-U"];

function git(all: ReadonlyArray<string>): ToolPart | null {
  // Global options: `-C dir`, `-c key=value`, `--no-pager`.
  const args = flagsOff(all, ["-C", "-c"]);
  const sub = args[0];
  const rest = args.slice(1);
  const pos = positionals(rest, GIT_VALUED);
  switch (sub) {
    case "status":
      return said("git_status");
    case "diff":
      return said("diff", pos.join(" "));
    case "log":
    case "shortlog":
    case "reflog":
      return said("history", pos.join(" "));
    case "show":
      return said("show", pos.join(" "));
    case "blame":
      return said("read", pos.at(-1) ?? "");
    case "grep":
      return search(rest);
    case "ls-files":
      return said("list", join(places(pos)));
    case "add":
      return said("stage", rest.includes("-A") || rest.includes("--all") ? "" : join(places(pos)));
    case "commit": {
      const message = option(rest, ["-m", "--message"]) ?? rest.find((a, i) => /^-[a-z]*m$/.test(rest[i - 1] ?? "") && !a.startsWith("-")) ?? "";
      // `-m "$(cat <<'EOF' … EOF)"`: the message's first line.
      const text = message.replace(/^\$\(cat <<-?\s*['"]?\w+['"]?\s*\n/, "");
      return said("commit", text.split("\n")[0]!.trim());
    }
    case "push":
      return said("push", pos.at(-1) ?? "");
    case "pull":
      return said("pull", pos.join(" "));
    case "fetch":
      return said("git_fetch", pos[0] ?? "");
    case "switch":
    case "checkout": {
      if (rest.includes("--")) return said("restore", join(rest.slice(rest.indexOf("--") + 1)));
      const created = option(rest, ["-b", "-B", "-c", "-C"]);
      return created || pos[0] ? said("switch", created ?? pos[0]!) : null;
    }
    case "restore":
      return said("restore", join(pos));
    case "merge":
      return said("merge", pos[0] ?? "");
    case "rebase":
      return said("rebase", option(rest, ["--onto"]) ?? pos[0] ?? "");
    case "branch":
      return pos.length || rest.includes("--show-current") ? null : said("branches");
    case "rm":
      return said("delete", join(pos));
    case "mv":
      return pos.length === 2 ? said("move", `${pos[0]} → ${pos[1]}`) : null;
    default:
      return null;
  }
}

/** A pull request or issue by number: "#123", from a number or its address. */
const ref = (arg: string | undefined) => {
  if (!arg) return "";
  const n = /^\d+$/.test(arg) ? arg : /\/(?:pull|issues)\/(\d+)/.exec(arg)?.[1];
  return n ? `#${n}` : arg;
};

function gh(all: ReadonlyArray<string>): ToolPart | null {
  const args = flagsOff(all, ["-R", "--repo"]);
  const [group, verb] = args;
  const pos = positionals(args.slice(2), ["-R", "--repo", "--json", "-q", "--jq", "-t", "--title", "-b", "--body", "-B", "--base", "-H", "--head", "-F", "--body-file", "-L", "--limit", "-s", "--state"]);
  if (group === "pr") {
    if (verb === "create") return said("pr_open", option(args, ["-t", "--title"]) ?? "");
    if (verb === "merge") return said("pr_merge", ref(pos[0]));
    if (verb === "checks") return said("ci", ref(pos[0]));
    if (["view", "diff", "status", "list"].includes(verb ?? "")) return said("pr", ref(pos[0]));
    return null;
  }
  if (group === "issue") {
    if (verb === "create") return said("issue_open", option(args, ["-t", "--title"]) ?? "");
    return verb === "view" || verb === "list" ? said("issue", ref(pos[0])) : null;
  }
  if (group === "run") return ["view", "list", "watch"].includes(verb ?? "") ? said("ci", pos[0] ?? "") : null;
  if (group === "api") return said("github", positionals(args.slice(1), ["-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "-q", "--jq", "--input", "-t", "--template"])[0] ?? "");
  return null;
}

function runtime(name: string, args: ReadonlyArray<string>): Read {
  const module = option(args, ["-m"]);
  if (module === "pytest") return said("test", join(places(positionals(args.slice(args.indexOf("-m") + 2)))));
  if (module === "pip") return args.includes("install") ? install(args.slice(args.indexOf("install") + 1)) : null;
  if (module !== null) return null;
  if (name === "bun" || name === "deno") {
    if (args[0] === "test") return said("test", join(places(positionals(args.slice(1)))));
    if (args[0] === "install" || args[0] === "add" || args[0] === "i") return install(args.slice(1));
    if (args[0] === "run" || args[0] === "x") return name === "bun" && args[0] === "run" ? packageScript("bun", args, null) : readStep(args.slice(1), null);
  }
  if (args.includes("--test")) return said("test", join(places(positionals(args))));
  // Code on the command line or from a heredoc, not a file.
  const files = positionals(args, ["-c", "-e", "--eval", "-p", "--print", "-W", "-X", "--input-type"]);
  if (files.length > 0 && files[0] !== "-") return null;
  return said(name.startsWith("python") ? "python" : "node");
}

function install(args: ReadonlyArray<string>): ToolPart {
  return said("install", join(places(positionals(args, ["-r", "--requirement", "--filter", "-C"]))));
}

/** `pnpm --filter web test`, `npm run build`, `yarn lint`, `vp run test`: the script by what it does, the package or folder as the subject. */
function packageScript(name: string, all: ReadonlyArray<string>, writes: string | null): Read {
  const valued = ["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"];
  let target: string | null = null;
  let i = 0;
  for (; i < all.length && all[i]!.startsWith("-"); i++) {
    const [flag, inline] = all[i]!.split("=", 2) as [string, string | undefined];
    if (!valued.includes(flag)) continue;
    target = inline ?? all[i + 1] ?? null;
    if (inline === undefined) i++;
  }
  let args = all.slice(i);
  if (name === "yarn" && args[0] === "workspace") (target = args[1] ?? target), (args = args.slice(2));
  const sub = args[0];
  if (!sub) return name === "yarn" || name === "pnpm" ? install([]) : null;
  if (["install", "i", "ci", "add", "update", "up"].includes(sub)) return install(args.slice(1));
  if (["exec", "dlx", "x"].includes(sub)) {
    const inner = readStep(flagsOff(args.slice(1), ["-p", "--package"]), writes);
    return inner !== NOISE && inner !== null && inner.subject === "" && target ? { ...inner, subject: target } : inner;
  }
  if (sub === "run" || sub === "run-script") return args[1] ? script(args[1], target) : null;
  if (name === "npm" && !["test", "t", "tst"].includes(sub)) return null;
  // `pnpm vitest run retry.test.ts`: a package's own binary, read as itself.
  const direct = RUNNERS.has(sub) ? readStep(args, writes) : null;
  if (direct !== null && direct !== NOISE) return target && direct.subject === "" ? { ...direct, subject: target } : direct;
  return script(sub, target);
}

const RUNNERS = new Set(["vitest", "jest", "mocha", "playwright", "tsc", "tsgo", "vue-tsc", "eslint", "oxlint", "prettier", "oxfmt", "biome"]);

/** A script or make target by its name: `test:unit` runs tests, `typecheck` type-checks. */
function script(name: string, target: string | null): ToolPart | null {
  const action: ActionKey | null = /^(?:test|tests|t|tst|spec|e2e|vitest|jest)(?:$|[:-])/.test(name)
    ? "test"
    : /^(?:typecheck|type-check|check-types|types|tsc)(?:$|[:-])/.test(name)
      ? "typecheck"
      : /^lint(?:$|[:-])/.test(name)
        ? "lint"
        : /^(?:fmt|format|prettier)(?:$|[:-])/.test(name)
          ? "format"
          : /^build(?:$|[:-])/.test(name)
            ? "build"
            : null;
  return action ? said(action, target ?? "") : null;
}

/** `go test ./...`, `cargo clippy`: a toolchain's subcommand by what it does. */
function tool(args: ReadonlyArray<string>, subs: Readonly<Record<string, ActionKey>>, valued: ReadonlyArray<string>): ToolPart | null {
  const action = subs[args[0] ?? ""];
  if (!action) return null;
  if (action === "install") return install(args.slice(1));
  return said(action, join(places(positionals(args.slice(1), valued).filter(pathLike))));
}
