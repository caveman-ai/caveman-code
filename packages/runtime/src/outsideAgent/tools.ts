// The 14 tools of `caveman-code mcp`, in their fixed order (docs/ §3), and the
// server's instructions. Definitions only: bridge.ts runs them, server.ts registers them in this order, so the list a
// client caches never changes shape.
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

const { optionalKey } = Schema;
const text = (description: string) => Schema.String.annotate({ description });
const chat = text("The chat's id, or its title (or a unique part of it).");
const images = Schema.Array(Schema.String).annotate({
  description:
    "Images to attach: each a data URL (data:image/png;base64,...) or plain base64 (PNG, JPEG, GIF or WebP, 10 MB at most). At Full access also an image file's absolute path.",
});

/** Every tool's answer is plain text (and image blocks for chat_read's images view); a failure is a result with isError. */
const answer = { success: Schema.String, failure: Schema.String, failureMode: "return" as const };

export const INSTRUCTIONS = [
  "Caveman Code runs coding agents in chats, one task per chat, each in its own worktree; you operate it as an outside agent.",
  "Start with `chats` to see what is going on.",
  "Name chats and projects by id or by title.",
  "Use `chat_wait` instead of polling: it returns as soon as a chat finishes, fails, asks something or opens a pull request.",
  "The project defaults to the one holding your working folder.",
  "Approvals, secrets and grill rounds are the person's to answer: when a chat waits on one, tell your user it waits for them in Caveman Code.",
].join(" ");

const Chats = Tool.make("chats", {
  description:
    "Start here. Chats across projects, newest first, one line each: [id] title · project · state · engine. Default: everything but finished chats the person has already read.",
  parameters: Schema.Struct({
    state: optionalKey(
      Schema.Literals(["needs_you", "can_answer", "working", "finished", "failed", "all"]).annotate({
        description:
          "needs_you: waits on the person (an approval, a secret). can_answer: asks a question you may answer. finished: done and unread by the person. all: every chat.",
      }),
    ),
    project: optionalKey(text("Only this project: its id, name, path or owner/name.")),
    query: optionalKey(text("Search titles and transcripts.")),
    limit: optionalKey(Schema.Int.annotate({ description: "How many lines (25 by default, 100 at most)." })),
    archived: optionalKey(Schema.Boolean.annotate({ description: "Include archived chats." })),
  }),
  ...answer,
})
  .annotate(Tool.Title, "List chats")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const Projects = Tool.make("projects", {
  description: "The projects chats start in: name, id, path, repository, default engine. The one holding your working folder is the default.",
  parameters: Tool.EmptyParams,
  ...answer,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const Engines = Tool.make("engines", {
  description:
    "Connected engines (Claude Agent, Codex, Caveman, ...): their models and efforts, the access modes each honours, the default, and which ones you can start chats on at your level.",
  parameters: Tool.EmptyParams,
  ...answer,
})
  .annotate(Tool.Title, "List engines")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const ChatStart = Tool.make("chat_start", {
  description:
    "Start a chat on a task. Returns its digest as soon as it exists; then chat_wait. With no engine: the default engine when it honours your level, else the first that does. Access left out: your level's. At Supervised that is \"ask\": its chats can read any file your user can and run commands they already allowed; other commands and every edit wait for them. The same call within 2 minutes returns the chat it already started.",
  parameters: Schema.Struct({
    task: text("What the chat should do, as you would tell a colleague."),
    project: optionalKey(text("Its id, name, path or owner/name. Default: the project holding your working folder.")),
    engine: optionalKey(text("An engine's id or label (see engines).")),
    model: optionalKey(text("A model id of that engine (see engines).")),
    effort: optionalKey(text("One of the model's efforts (see engines).")),
    access: optionalKey(
      Schema.Literals(["ask", "auto", "review", "full"]).annotate({
        description: "ask: Supervised. auto: edits go through. review: the engine's own review approves routine actions. full: no approvals. Never above your level.",
      }),
    ),
    title: optionalKey(text("A title; else Caveman Code names it.")),
    images: optionalKey(images),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Start a chat")
  .annotate(Tool.OpenWorld, true);

const ChatSend = Tool.make("chat_send", {
  description:
    "Send a chat a message. auto (default) starts a turn when the chat is idle and queues it otherwise; steer puts it into the running turn; queue waits for the turn to end. A message to a chat that waits on the person is queued, and a steer then is queued too: it never cancels their wait.",
  parameters: Schema.Struct({
    chat,
    text: text("The message."),
    mode: optionalKey(Schema.Literals(["auto", "steer", "queue"])),
    model: optionalKey(text("Switch the model from this turn on.")),
    effort: optionalKey(text("Switch the effort from this turn on.")),
    images: optionalKey(images),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Message a chat")
  .annotate(Tool.OpenWorld, true);

const ChatRead = Tool.make("chat_read", {
  description:
    "Read a chat. digest (default): its state, task, latest answer, what it waits on, changed files, branch, PR and a Next call. transcript: the newest ~24 KB, earlier pages with before. images: its latest screenshots and attached images (3 by default).",
  parameters: Schema.Struct({
    chat,
    view: optionalKey(Schema.Literals(["digest", "transcript", "images"])),
    before: optionalKey(Schema.Int.annotate({ description: "transcript, images: the page before this cursor (a page's answer says which to pass)." })),
    limit: optionalKey(Schema.Int.annotate({ description: "images: how many (3 by default, 8 at most). transcript: how many entries at most." })),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Read a chat")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const ChatWait = Tool.make("chat_wait", {
  description:
    "Wait for chats instead of polling. Returns at once with every change not reported to you yet (finished, failed, asking, answered by the person, PR opened), else waits for the next one. Default: the chats you started, messaged or answered. A timeout is not an error: call it again.",
  parameters: Schema.Struct({
    chats: optionalKey(Schema.Array(Schema.String).annotate({ description: "Chats by id or title." })),
    timeout_s: optionalKey(Schema.Number.annotate({ description: "45 by default; at most 110 (55 for Codex)." })),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Wait for chats")
  .annotate(Tool.Readonly, true);

const ChatAnswer = Tool.make("chat_answer", {
  description:
    "Answer the question card a chat waits on (chat_read shows it). recommended: true takes every recommended option. Approvals, secrets and grill rounds are the person's: tell your user instead.",
  parameters: Schema.Struct({
    chat,
    ask_id: optionalKey(text("The ask's id from the digest; a stale one answers \"already answered\".")),
    answers: optionalKey(
      Schema.Array(
        Schema.Struct({
          question: optionalKey(text("The question's id or prompt; leave it out on a one-question card.")),
          pick: optionalKey(Schema.Array(Schema.String).annotate({ description: "Option ids or labels." })),
          text: optionalKey(text("Your own words, where the card takes them.")),
        }),
      ),
    ),
    recommended: optionalKey(Schema.Boolean.annotate({ description: "Answer every question with its recommended option." })),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Answer a chat's question")
  .annotate(Tool.OpenWorld, true);

const ChatStop = Tool.make("chat_stop", {
  description: "Stop a chat's running turn, and the agents it delegated to.",
  parameters: Schema.Struct({ chat }),
  ...answer,
})
  .annotate(Tool.Title, "Stop a chat")
  .annotate(Tool.Destructive, true);

const ChatDiff = Tool.make("chat_diff", {
  description: "What a chat changed: files with +/- counts. With path, that file's patch (cut at 24 KB).",
  parameters: Schema.Struct({
    chat,
    scope: optionalKey(Schema.Literals(["all", "latest_turn"]).annotate({ description: "all (default): against its base branch. latest_turn: the latest finished turn." })),
    path: optionalKey(text("A file in the chat's worktree.")),
  }),
  ...answer,
})
  .annotate(Tool.Title, "A chat's changes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const ChatUndo = Tool.make("chat_undo", {
  description: "Put back the files the chat's latest finished turn changed. The transcript stays.",
  parameters: Schema.Struct({ chat }),
  ...answer,
})
  .annotate(Tool.Title, "Undo a chat's latest turn")
  .annotate(Tool.Destructive, true);

const ChatOrganize = Tool.make("chat_organize", {
  description: "Rename a chat, archive it, or mark it done in the person's inbox.",
  parameters: Schema.Struct({
    chat,
    action: Schema.Literals(["rename", "archive", "mark_done"]),
    title: optionalKey(text("rename: the new title.")),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Organize a chat")
  .annotate(Tool.Destructive, true);

const ChatShip = Tool.make("chat_ship", {
  description:
    "Ship a chat's work (Full access). commit: commit its changes with this message. pr: commit any changes (commit as the message, else the title), push, open the pull request and return its URL.",
  parameters: Schema.Struct({
    chat,
    commit: optionalKey(text("The commit message.")),
    pr: optionalKey(Schema.Struct({ title: text("The pull request's title."), body: optionalKey(text("Its description (markdown).")) })),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Commit, push, open a PR")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ProjectAdd = Tool.make("project_add", {
  description: "Add a git repository as a project (Full access): a folder on this computer, or a URL or owner/name to clone.",
  parameters: Schema.Struct({
    path: optionalKey(text("A folder inside the repository.")),
    url: optionalKey(text("A git URL, a web URL or owner/name.")),
    name: optionalKey(text("A name; else the folder's.")),
  }),
  ...answer,
})
  .annotate(Tool.Title, "Add a project")
  .annotate(Tool.OpenWorld, true);

/** The fixed order tools/list answers in. */
export const TOOLS = [Chats, Projects, Engines, ChatStart, ChatSend, ChatRead, ChatWait, ChatAnswer, ChatStop, ChatDiff, ChatUndo, ChatOrganize, ChatShip, ProjectAdd] as const;

export type AnyTool = (typeof TOOLS)[number];
export type ToolName = AnyTool["name"];
export type ParamsOf<N extends ToolName> = Tool.Parameters<Extract<AnyTool, { readonly name: N }>>;
