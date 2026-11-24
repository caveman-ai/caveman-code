// What a running turn's folded line says while a step runs (, "Calmer", chosen over today's
// per-call words and Codex's on recorded turns): the kind of work, steady through a run of the same kind
// ("Exploring", "Running a command", "Editing files", "Searching the web", "Using an app"), with what it is on
// quietly beside it ("note2.md", "webhooks.md"). A command says no shell. A step whose name has not arrived yet
// (Claude streams a tool's input after its name) keeps the name the line shows, so a new read never blanks the line
// before its file is known.
import type { ToolItem } from "../../state/transcript-model.ts";
import { basename, workspaceText } from "../../state/workspace-paths.ts";

export interface StepLine {
  /** The line it is: a new id rolls in, the same id fills in place. */
  readonly id: string;
  readonly words: string;
  /** What the step is on, quieter beside the words ("note2.md"). */
  readonly detail?: string;
  /** The kind's mark, in the engine mark's column; none: the thinking mark. */
  readonly icon?: ToolItem["icon"];
}

export const THINKING: StepLine = { id: "Thinking", words: "Thinking" };

// Every action (state/tool-actions.ts ACTIONS) has its kind; one not named here runs something.
const EXPLORE = new Set(["read", "list", "search", "history", "git_status", "diff", "show", "branches", "query", "image_view", "pr", "ci", "issue"]);
const EDIT = new Set(["edit", "create", "write", "change", "delete", "move", "copy", "folder", "format", "restore"]);
const WEB = new Set(["web", "web_search"]);
const APP = new Set(["browser", "desktop", "desktop_look", "desktop_click", "desktop_type", "desktop_press", "desktop_scroll", "desktop_open", "desktop_quit", "desktop_arrange"]);
const OTHER = new Set(["mcp", "other", "github"]);
type Kind = "explore" | "run" | "edit" | "web" | "app" | "image" | "threads" | "other";
const KINDS: Record<Kind, { words: string; icon: ToolItem["icon"] }> = {
  explore: { words: "Exploring", icon: "search" },
  run: { words: "Running a command", icon: "run" },
  edit: { words: "Editing files", icon: "edit" },
  web: { words: "Searching the web", icon: "web" },
  app: { words: "Using an app", icon: "browser" },
  image: { words: "Generating an image", icon: "create" },
  threads: { words: "Working with other threads", icon: "agent" },
  other: { words: "Using a tool", icon: "other" },
};

const actions = (t: ToolItem): string[] => t.parts.map((p) => p.action);
function kindOf(t: ToolItem): Kind {
  const a = actions(t);
  const all = (set: ReadonlySet<string>) => a.length > 0 && a.every((x) => set.has(x));
  if (all(EXPLORE)) return "explore";
  if (a.some((x) => EDIT.has(x))) return "edit";
  if (all(WEB)) return "web";
  if (all(APP)) return "app";
  if (a.includes("image_generation")) return "image";
  if (all(OTHER)) return "other";
  // The runtime's own tools: one on other threads (it wears the agent mark), a preview browser's, any other.
  if (all(new Set(["caveman"]))) return t.icon === "agent" ? "threads" : t.icon === "browser" ? "app" : "other";
  return "run";
}

/** The call is known but not what it names yet. */
const pending = (t: ToolItem) => (!t.subject && !t.command && actions(t).every((a) => a === "command")) || t.subject.trim().toLowerCase() === t.name.trim().toLowerCase();

/** What a step is on, short: a file's own name (read or changed), the search, the folder, the wait, the app. */
function shortName(t: ToolItem, root: string | null | undefined): string {
  const first = t.parts[0];
  if (!first || pending(t)) return "";
  if (first.action === "read" || EDIT.has(first.action)) return basename(first.subject || t.subject);
  if (first.action === "search" || first.action === "list" || first.action === "wait" || first.action === "web_search") return workspaceText(first.subject || t.subject, root);
  if (APP.has(first.action)) return first.subject;
  // A tool on other threads: the first it names.
  if (first.action === "caveman") return t.threads?.find((n) => n.thread !== null)?.thread?.title ?? "";
  return "";
}

/** The line for the step running now, given the line shown (whose name a nameless step of the same kind keeps). */
export function stepLine(step: ToolItem, shown: StepLine | null, root: string | null | undefined): StepLine {
  const kind = kindOf(step);
  const name = shortName(step, root) || (shown?.id === kind ? (shown.detail ?? "") : "");
  return { id: kind, words: KINDS[kind].words, icon: KINDS[kind].icon, ...(name ? { detail: name } : {}) };
}

export const lineKey = (x: StepLine | null): string => (x ? `${x.id}\u0000${x.words}\u0000${x.detail ?? ""}` : "");
