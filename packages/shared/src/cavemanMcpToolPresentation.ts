// ), packages/shared/src/t3McpToolPresentation.ts @ ab3a3cd1.
export type CavemanMcpToolLogo = "caveman-code";

export interface CavemanMcpToolPresentation {
  readonly displayName: string;
  readonly logo: CavemanMcpToolLogo;
}

export type CavemanMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "automation-check"
  | "automation-explain"
  | "automation-run"
  | "automation-list"
  | "automation-templates"
  | "preview-register"
  | "setup-propose"
  | "memory-query";

export interface CavemanMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "caveman-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: CavemanMcpToolSummaryAction;
  /**
   * A tool on other threads: its action, running and completed verbs before the threads it names, by title, once the
   * runtime knows them ("Sent to" Fix login). Without them it reads as `labels` ("Sent to a thread").
   */
  readonly named?: readonly [action: string, running: string, completed: string];
}

function tool(
  labels: CavemanMcpToolDefinition["labels"],
  summaryAction: CavemanMcpToolSummaryAction,
  icon: CavemanMcpToolDefinition["icon"] = "caveman-code",
  displayName = `${labels[0]} ${labels[3]}`,
): CavemanMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

/** A tool on other threads, with the verbs it says their titles with. */
function onThreads(
  definition: CavemanMcpToolDefinition,
  named: NonNullable<CavemanMcpToolDefinition["named"]>,
): CavemanMcpToolDefinition {
  return { ...definition, named };
}

// Read-only compatibility: stored transcripts retain the old server spellings. Codex registers
// "caveman-code-direct" for tools kept out of Code Mode.
const CAVEMAN_CODE_MCP_SERVER_ALIASES = new Set([
  "caveman-code",
  "caveman_code",
  "cavemancode",
  "caveman code",
  "caveman-code-direct",
  "caveman_code_direct",
  "t3-code",
  "t3_code",
  "t3code",
  "t3 code",
  "t3-code-direct",
  "t3_code_direct",
]);

export function isCavemanMcpServer(name: string): boolean {
  return (
    CAVEMAN_CODE_MCP_SERVER_ALIASES.has(name.toLowerCase()) ||
    /^(?:caveman-code|t3-code)-.+$/i.test(name)
  );
}

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const CAVEMAN_CODE_MCP_TOOLS: Readonly<Record<string, CavemanMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  // Named by its input's title: its child's card says the rest, and takes its row's place.
  delegate_task: onThreads(
    tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
    ["Delegate", "Delegating", "Delegated"],
  ),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(["Schedule", "Scheduling", "Scheduled", "a task"], "schedule-create"),
  // schedule_task with where: "cloud" (resolveT3McpToolDefinition): it runs on a Cloud computer of its own.
  schedule_task_cloud: tool(
    ["Schedule", "Scheduling", "Scheduled", "a task on Cloud"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  automation_check: tool(["Check", "Checking", "Checked", "automations"], "automation-check"),
  automation_explain: tool(
    ["Explain", "Explaining", "Explained", "an automation"],
    "automation-explain",
  ),
  automation_run: tool(["Run", "Running", "Started", "an automation"], "automation-run"),
  automation_list: tool(["List", "Listing", "Listed", "automations"], "automation-list"),
  automation_templates: tool(
    ["Get", "Getting", "Got", "automation templates"],
    "automation-templates",
  ),
  create_threads: onThreads(tool(["Create", "Creating", "Created", "threads"], "thread-create"), [
    "Start",
    "Starting",
    "Started",
  ]),
  thread_start: tool(["Start", "Starting", "Started", "a thread"], "thread-create"),
  thread_list: tool(["List", "Listing", "Listed", "threads"], "thread-list"),
  thread_read: onThreads(tool(["Read", "Reading", "Read", "a thread"], "thread-read"), [
    "Read",
    "Reading",
    "Read",
  ]),
  thread_send: onThreads(tool(["Send", "Sending", "Sent", "to a thread"], "thread-send"), [
    "Send to",
    "Sending to",
    "Sent to",
  ]),
  // thread_send with expectReply, or inReplyTo (resolveCavemanMcpToolDefinition): a question, or an answer to one.
  thread_ask: onThreads(tool(["Ask", "Asking", "Asked", "a thread"], "thread-send"), [
    "Ask",
    "Asking",
    "Asked",
  ]),
  thread_reply: onThreads(
    tool(["Reply to", "Replying to", "Replied to", "a thread"], "thread-send"),
    ["Reply to", "Replying to", "Replied to"],
  ),
  thread_wait: onThreads(tool(["Wait", "Waiting", "Waited", "for a thread"], "thread-wait"), [
    "Wait for",
    "Waiting for",
    "Waited for",
  ]),
  workflow_stop: tool(["Stop", "Stopping", "Requested a stop for", "a workflow"], "workflow-stop"),
  background_wait: tool(["Update", "Updating", "Updated", "background waits"], "background-wait"),
  thread_interrupt: onThreads(
    tool(
      ["Interrupt", "Interrupting", "Requested an interrupt of", "a thread"],
      "thread-interrupt",
    ),
    // It asks: the thread may still be stopping, or have had no run to stop.
    ["Interrupt", "Interrupting", "Requested an interrupt of"],
  ),
  worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_act: tool(["Use", "Using", "Used", "the preview browser"], "browser", "browser"),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  queue: tool(["Manage", "Managing", "Managed", "queued messages"], "queue-edit"),
  pending_request: tool(["Handle", "Handling", "Handled", "pending questions"], "question-respond"),
  queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  pending_request_list: tool(["List", "Listing", "Listed", "pending questions"], "question-list"),
  pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  thread_configuration: onThreads(
    tool(["Read", "Reading", "Read", "thread configuration"], "thread-configuration"),
    ["Read the settings of", "Reading the settings of", "Read the settings of"],
  ),
  thread_configure: onThreads(
    tool(["Use", "Using", "Used", "thread model settings"], "thread-configure"),
    ["Configure", "Configuring", "Configured"],
  ),
  thread_transfer: tool(["Use", "Using", "Used", "thread transfers"], "thread-fork"),
  thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  thread_organize: onThreads(
    tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
    ["Organize", "Organizing", "Organized"],
  ),
  thread_update: onThreads(
    tool(["Update", "Updating", "Updated", "thread metadata"], "thread-update"),
    ["Update", "Updating", "Updated"],
  ),
  worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  thread_launch: onThreads(
    tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
    ["Start", "Starting", "Started"],
  ),
  project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  register_preview: tool(
    ["Register", "Registering", "Registered", "a preview"],
    "preview-register",
    "browser",
  ),
  propose_setup_change: tool(
    ["Propose", "Proposing", "Proposed", "a setup change"],
    "setup-propose",
  ),
  memory_sql: tool(["Query", "Querying", "Queried", "memory"], "memory-query"),
};

/**
 * The Caveman Code orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const CAVEMAN_CODE_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(CAVEMAN_CODE_MCP_TOOLS),
);

function normalizeCavemanMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// Timelines resolve every work row's tool name on each update; names repeat across updates.
// ACP titles can carry whole commands, so long labels are parsed but not kept.
const toolNameCache = new Map<string, string | null>();
const TOOL_NAME_CACHE_LIMIT = 10_000;
const TOOL_NAME_CACHE_MAX_KEY_LENGTH = 256;

function resolveCavemanMcpToolName(value: string): string | null {
  if (value.length > TOOL_NAME_CACHE_MAX_KEY_LENGTH) return parseCavemanMcpToolName(value);
  const cached = toolNameCache.get(value);
  if (cached !== undefined) return cached;
  const name = parseCavemanMcpToolName(value);
  if (toolNameCache.size >= TOOL_NAME_CACHE_LIMIT) toolNameCache.clear();
  toolNameCache.set(value, name);
  return name;
}

/**
 * ACP agents disagree on how the injected Caveman Code server prefixes its tools:
 * `mcp__caveman-code__x` (Claude/Cursor), `caveman-code.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
/** Canonical IDs only; old t3_ tool names remain readable in stored transcripts. */
function canonicalToolName(name: string): string | null {
  const candidate = name.startsWith("t3_") ? name.slice(3) : name;
  return Object.hasOwn(CAVEMAN_CODE_MCP_TOOLS, candidate) ? candidate : null;
}

function parseCavemanMcpToolName(value: string): string | null {
  const label = normalizeCavemanMcpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined && tool !== undefined && isCavemanMcpServer(server)
      ? canonicalToolName(tool)
      : null;
  }

  const namespaceMatch =
    /^(?:caveman|t3)[-_ ]?code(?:[-_]direct)?(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) return canonicalToolName(namespaceMatch.groups.tool ?? "");

  const prefixed =
    /^(?:mcp[-_]{1,2})?(?:caveman|t3)[-_ ]?code(?:[-_]direct)?(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
      label,
    );
  const candidate = canonicalToolName(prefixed?.groups?.tool ?? label);
  if (candidate !== null) return candidate;
  // OpenCode 2 joins a per-thread server to its tool with `_`. Thread ids can
  // contain `_` too; take the longest known tool suffix, including legacy IDs.
  if (!/^(?:caveman-code|t3-code)-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of CAVEMAN_CODE_MCP_TOOL_NAMES) {
    if (
      (label.endsWith(`_${tool}`) || label.endsWith(`_t3_${tool}`)) &&
      tool.length > (longest?.length ?? 0)
    )
      longest = tool;
  }
  return longest;
}

/** The bare Caveman Code tool name (`html_render`) for any provider's spelling of it. */
export function resolveCavemanMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveCavemanMcpToolName(toolName);
  return name !== null && Object.hasOwn(CAVEMAN_CODE_MCP_TOOLS, name) ? name : null;
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  preview_act: (action) => `preview_${action}`,
  queue: (action) => `queue_${action}`,
  pending_request: (action) => `pending_request_${action}`,
  thread_transfer: (action) =>
    ({ fork: "thread_fork", merge_back: "thread_merge_back", status: "thread_transfers" })[action],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveCavemanMcpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): CavemanMcpToolDefinition | null {
  const name = toolName == null ? null : resolveCavemanMcpToolName(toolName);
  if (name === null || !Object.hasOwn(CAVEMAN_CODE_MCP_TOOLS, name)) return null;
  const fields = asSummaryInput(input);
  if (name === "schedule_task" && fields?.where === "cloud" && fields.scheduledTaskId === undefined)
    return CAVEMAN_CODE_MCP_TOOLS.schedule_task_cloud!;
  // thread_configure without `modelSelection` only reads a thread's settings.
  if (name === "thread_configure" && fields !== undefined && fields.modelSelection === undefined)
    return CAVEMAN_CODE_MCP_TOOLS.thread_configuration!;
  if (name === "thread_send" && typeof fields?.inReplyTo === "string")
    return CAVEMAN_CODE_MCP_TOOLS.thread_reply!;
  if (name === "thread_send" && fields?.expectReply === true)
    return CAVEMAN_CODE_MCP_TOOLS.thread_ask!;
  const action = fields?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(CAVEMAN_CODE_MCP_TOOLS, actionTool)
    ? CAVEMAN_CODE_MCP_TOOLS[actionTool]!
    : CAVEMAN_CODE_MCP_TOOLS[name]!;
}

/** Tools whose summary depends on which fields a call sets. */
const ACTION_SUMMARIES: Readonly<
  Record<string, (input: SummaryInput) => CavemanMcpToolSummaryAction | undefined>
> = {
  thread_configure: ({ modelSelection }) =>
    modelSelection === undefined ? "thread-configuration" : "thread-configure",
  schedule_task: ({ scheduledTaskId }) =>
    scheduledTaskId === undefined ? "schedule-create" : "schedule-update",
};

export function resolveCavemanMcpSummaryAction(
  toolName: string | null | undefined,
  input: unknown,
): CavemanMcpToolSummaryAction | null {
  const definition = resolveCavemanMcpToolDefinition(toolName, input);
  if (definition === null) return null;
  const summarize = ACTION_SUMMARIES[resolveCavemanMcpToolName(toolName!) ?? ""];
  const fields = asSummaryInput(input);
  return (fields && summarize?.(fields)) ?? definition.summaryAction;
}

export function resolveCavemanMcpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): CavemanMcpToolPresentation | null {
  const definition = resolveCavemanMcpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "caveman-code" };
}

export function resolveCavemanMcpToolSummaryAction(
  toolName: string | null | undefined,
): CavemanMcpToolSummaryAction | null {
  return resolveCavemanMcpToolDefinition(toolName)?.summaryAction ?? null;
}
