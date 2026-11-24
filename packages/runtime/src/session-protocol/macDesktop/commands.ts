// The `desktop` tool's commands: agent-desktop's own (its batch entries, `{command, args}`), less what would take the
// person's computer from them or step around the person. Everything runs headless, through accessibility: no pointer
// movement and no focus change, so the gestures that need a real pointer (double-click, hover, drag, raw mouse input)
// and bringing a window forward are not here. Each command says which app it touches, so the runtime can ask the person
// for that app first, and how its result reads for the agent: a snapshot as a compact outline, not agent-desktop's JSON.
import type { AgentDesktopError, Envelope } from "./cli.ts";
import { CLIPBOARD, DOCK, MENU_BAR, NOTIFICATIONS, type AppIdentity } from "./apps.ts";

/** What a command touches, which is what the person allows. */
export type Target =
  /** The call's `app`, passed to agent-desktop as its `app` argument. */
  | "app"
  /** The call's `app` when it names one, else nothing of any app (a list of every window). */
  | "app-or-none"
  /** A ref (`ref_id`, `root`, `element`) from a snapshot of the call's app. */
  | "ref"
  /** Reads no app's content. */
  | "none";

export interface CommandSpec {
  readonly target: Target;
  /** Only looks: changes nothing on the computer. */
  readonly looks: boolean;
  /** Argument keys this tool refuses, and why. */
  readonly refuse?: Readonly<Record<string, string>>;
}

const NO_FOCUS = "it brings the app forward, and the agent works in the background";
const NO_PROGRAM = "starting a program with arguments is a command: use your shell tool";
const NO_FILES = "it reads or writes files on disk: use your file tools";

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  // Observe
  snapshot: { target: "app", looks: true },
  find: { target: "app", looks: true },
  get: { target: "ref", looks: true },
  is: { target: "ref", looks: true },
  screenshot: { target: "app", looks: true, refuse: { screen: "a whole display shows other apps: name the app" } },
  "list-surfaces": { target: "app", looks: true },
  "list-windows": { target: "app-or-none", looks: true },
  "list-apps": { target: "none", looks: true },
  "list-displays": { target: "none", looks: true },
  wait: { target: "app-or-none", looks: true, refuse: { notification: "notifications are read with list-notifications (app Notification Center)" } },
  // Act on a ref
  click: { target: "ref", looks: false },
  "right-click": { target: "ref", looks: false },
  type: { target: "ref", looks: false, refuse: { stdin: "pass the text as `text`" } },
  "set-value": { target: "ref", looks: false, refuse: { stdin: "pass the value as `value`" } },
  clear: { target: "ref", looks: false },
  focus: { target: "ref", looks: false },
  select: { target: "ref", looks: false },
  toggle: { target: "ref", looks: false },
  check: { target: "ref", looks: false },
  uncheck: { target: "ref", looks: false },
  expand: { target: "ref", looks: false },
  collapse: { target: "ref", looks: false },
  scroll: { target: "ref", looks: false },
  "scroll-to": { target: "ref", looks: false },
  // Keys go to the app's own process, without focusing it.
  press: { target: "app", looks: false, refuse: { force: "agent-desktop refuses quit and logout shortcuts on purpose: use close-app" } },
  // Apps and windows
  launch: {
    target: "app",
    looks: false,
    refuse: { args: NO_PROGRAM, env: NO_PROGRAM, cwd: NO_PROGRAM, no_attach: NO_PROGRAM, cdp: "a debugging port is the browser tools' job", activate: NO_FOCUS },
  },
  "close-app": { target: "app", looks: false, refuse: { force: "force-quitting loses the person's unsaved work: quit it, and answer its save sheet" } },
  minimize: { target: "app", looks: false },
  maximize: { target: "app", looks: false },
  restore: { target: "app", looks: false },
  "move-window": { target: "app", looks: false },
  "resize-window": { target: "app", looks: false },
  "open-system-surface": { target: "app", looks: false },
  // The clipboard and Notification Center are allowed like apps.
  "list-notifications": { target: "app", looks: true },
  "clipboard-get": { target: "app", looks: true, refuse: { out: NO_FILES, format: "text only" } },
  "clipboard-set": { target: "app", looks: false, refuse: { image: NO_FILES, file_url: NO_FILES, stdin: "pass the text as `text`" } },
  "clipboard-clear": { target: "app", looks: false },
  skills: { target: "none", looks: true },
};

/** The app a command touches no matter what the call names: the clipboard, notifications, the Dock, the menu bar. */
export const impliedApp = (command: string, args: Readonly<Record<string, unknown>>): AppIdentity | undefined => {
  if (command.startsWith("clipboard-")) return CLIPBOARD;
  if (command === "list-notifications") return NOTIFICATIONS;
  if (command === "open-system-surface") return args.surface === "dock" ? DOCK : args.surface === "menu-bar-extras" ? MENU_BAR : undefined;
  return undefined;
};

/** Commands whose app goes to agent-desktop under another key, or not at all. */
const APP_KEY: Readonly<Record<string, string | null>> = {
  "open-system-surface": null,
  "list-notifications": null,
  "clipboard-get": null,
  "clipboard-set": null,
  "clipboard-clear": null,
};

/** The batch entry's `app`, if it takes one. Shell surfaces (the Dock, the system's status items) take none. */
export const appArgument = (command: string, app: AppIdentity, args: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  if (APP_KEY[command] === null || app.pseudo) return {};
  if ((command === "snapshot" || command === "find") && (args.root !== undefined || app === DOCK)) return {};
  return { app: app.bundleId !== undefined && command === "launch" ? app.bundleId : app.name };
};

/** Every snapshot-qualified ref in a call's arguments: `@<snapshot>:e<N>`. */
export const refsIn = (args: Readonly<Record<string, unknown>>): Array<{ readonly ref: string; readonly snapshot: string }> =>
  Object.values(args).flatMap((value) => (typeof value === "string" ? [...value.matchAll(/@([A-Za-z0-9_-]+):e\d+/g)].map((m) => ({ ref: m[0], snapshot: m[1]! })) : []));

export const COMMAND_NAMES = Object.keys(COMMANDS);

// ---------------------------------------------------------------- results, as the agent reads them

interface Node {
  readonly role?: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly description?: string;
  readonly ref_id?: string;
  readonly states?: ReadonlyArray<string>;
  readonly children?: ReadonlyArray<Node>;
  readonly children_count?: number;
  readonly subtree_truncated?: boolean;
  readonly bounds?: Bounds;
}
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quoted = (text: string) => JSON.stringify(clip(text.replace(/\s+/g, " ").trim()));

/** One node as a line: `button "Save" @s1:e3 [disabled]`. */
const line = (node: Node, withBounds: boolean) => {
  const parts = [node.role ?? "element"];
  if (node.name) parts.push(quoted(node.name));
  const value = typeof node.value === "string" ? node.value : node.value === undefined || node.value === null ? undefined : JSON.stringify(node.value);
  if (value !== undefined && value !== "" && value !== node.name) parts.push(`= ${quoted(value)}`);
  if (node.description && node.description !== node.name) parts.push(`(${clip(node.description, 80)})`);
  if (node.ref_id) parts.push(node.ref_id);
  if (node.states && node.states.length > 0) parts.push(`[${node.states.join(", ")}]`);
  if (node.children_count !== undefined) parts.push(`+${node.children_count} inside`);
  if (node.subtree_truncated) parts.push("…cut");
  if (withBounds && node.bounds) parts.push(`@(${Math.round(node.bounds.x)},${Math.round(node.bounds.y)} ${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)})`);
  return parts.join(" ");
};

export const outline = (root: Node, withBounds: boolean): string => {
  const lines: Array<string> = [];
  const walk = (node: Node, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${line(node, withBounds)}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join("\n");
};

/** Every ref's bounds in a tree, and the root's: where the agent's pointer goes in the live view. */
export const boundsIn = (root: Node): { readonly root?: Bounds; readonly refs: ReadonlyMap<string, Bounds> } => {
  const refs = new Map<string, Bounds>();
  const walk = (node: Node) => {
    if (node.ref_id && node.bounds) refs.set(node.ref_id, node.bounds);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return { ...(root.bounds ? { root: root.bounds } : {}), refs };
};

export const errorText = (error: AgentDesktopError) => {
  const kind = typeof error.details?.kind === "string" ? ` (${error.details.kind})` : "";
  const retry = error.disposition?.retry ? ` retry: ${error.disposition.retry}.` : "";
  return `${error.code}${kind}: ${error.message}${error.suggestion ? ` ${error.suggestion}` : ""}${retry}`;
};

/** Keys of a result that only agent-desktop's own tooling reads. */
const NOISE = new Set(["version", "steps", "limits", "semantics", "process_instance"]);
const compactJson = (value: unknown): string =>
  JSON.stringify(value, (key, v) => (NOISE.has(key) ? undefined : v));

/** One command's result as the agent reads it. `bounds`: whether the agent asked for them (we always ask, for the pointer). */
export const resultText = (command: string, result: { readonly ok: boolean; readonly data?: unknown; readonly error?: AgentDesktopError }, bounds: boolean): string => {
  if (!result.ok) return result.error ? errorText(result.error) : "failed with no error";
  const data = (result.data ?? {}) as Record<string, unknown>;
  if ((command === "snapshot" || command === "find") && typeof data === "object") {
    const head: Array<string> = [];
    if (typeof data.snapshot_id === "string") head.push(`snapshot ${data.snapshot_id}`);
    if (typeof data.app === "string") head.push(data.app);
    const window = data.window as { id?: string; title?: string } | undefined;
    if (window?.id) head.push(`window ${window.id}${window.title ? ` ${quoted(window.title)}` : ""}`);
    if (typeof data.ref_count === "number") head.push(`${data.ref_count} refs`);
    const notes: Array<string> = [];
    if (data.complete === false) notes.push("incomplete: raise timeout_ms or drill in with root");
    if (data.identity_unproven === true) notes.push("identity unproven: snapshot again with a larger timeout_ms before acting");
    const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !["snapshot_id", "app", "window", "ref_count", "tree", "matches", "complete", "truncated", "nodes_observed", "identity_unproven"].includes(key)));
    const body =
      data.tree !== undefined
        ? outline(data.tree as Node, bounds)
        : Array.isArray(data.matches)
          ? (data.matches as ReadonlyArray<Node>).map((match) => line(match, true)).join("\n") || "no matches"
          : "";
    return [head.join(" · "), ...notes, ...(Object.keys(rest).length > 0 ? [compactJson(rest)] : []), body].filter(Boolean).join("\n");
  }
  if (command === "skills" && typeof data.content === "string") return data.content;
  return compactJson(data);
};

/** A batch envelope's entries (or one failure before any ran). */
export const batchResults = (envelope: Envelope): Array<{ readonly command: string; readonly ok: boolean; readonly data?: unknown; readonly error?: AgentDesktopError; readonly execution?: string }> => {
  if (!envelope.ok) {
    const index = typeof envelope.error?.details?.batch_index === "number" ? envelope.error.details.batch_index : 0;
    const command = typeof envelope.error?.details?.batch_command === "string" ? envelope.error.details.batch_command : envelope.command;
    const error = envelope.error ? { ...envelope.error, message: envelope.error.message.replace(/^Batch entry \d+ \('[^']*'\) failed validation: /, "") } : undefined;
    return [{ command: `${command}${index > 0 ? ` (step ${index + 1})` : ""}`, ok: false, ...(error ? { error } : {}) }];
  }
  const data = envelope.data as { results?: ReadonlyArray<{ command: string; ok: boolean; data?: unknown; error?: AgentDesktopError; execution?: string }> } | undefined;
  return [...(data?.results ?? [])];
};
