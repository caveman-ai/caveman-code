// The `desktop` tool: computer use on this Mac (session-protocol/macDesktop) for every engine, through Vercel's
// agent-desktop. McpHttpServer registers it only where the runtime offers it (a Mac with agent-desktop, never a Cloud
// computer, whose desktop is the `computer` tool). Its answer is text for the agent to read, an image for a screenshot.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { COMMAND_NAMES } from "../../../session-protocol/macDesktop/commands.ts";
import { MacDesktop } from "../../../session-protocol/macDesktop/service.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Command = Schema.Literals(COMMAND_NAMES as [string, ...Array<string>]).annotate({ description: "An agent-desktop command." });
const Args = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: "The command's arguments by agent-desktop's names: ref_id, text, value, combo, role, name, root, skeleton, surface, direction, amount, timeout_ms, …",
});

export const DesktopTool = Tool.make("desktop", {
  description: `Use apps on this Mac like a person, in the background: read an app's interface as an outline of its accessibility tree and act on its elements. It never moves the person's pointer or takes focus; your actions show as your own labelled cursor on their screen. The first time this chat uses an app, the person is asked to allow it. Terminals, password managers and Caveman Code are never available.

The loop: \`snapshot\` the app (its window as an outline, a ref like @s8f3k2p9:e5 on everything you can act on), act on a ref, then snapshot again to check. A window's snapshot leaves out static text; to read text (a document, a field, a result), snapshot {root: "@ref"} of that part, which comes whole. Act with \`click\`, \`type\` {text}, \`set-value\` {value}, \`select\` {value}, \`check\`/\`uncheck\`, \`expand\`, \`scroll\` {direction, amount}, \`right-click\`. Refs last until the UI changes: on STALE_REF, snapshot again. A big app: \`snapshot\` {skeleton: true}, then {root: "@ref"} to drill in; \`find\` {role, name, text} finds elements without a whole snapshot. Menus and dialogs: {surface: "menubar" | "menu" | "sheet" | "alert"}. \`press\` {combo: "cmd+s"} sends keys to the app without focusing it. \`launch\` opens an app, \`close-app\` quits it, \`list-windows\` lists windows (pass window_id when an app has several). \`wait\` {element | text | event: "window-opened", timeout}. \`screenshot\` shows the app's window as an image when the outline isn't enough. The clipboard is app "Clipboard" (clipboard-get, clipboard-set); notifications, app "Notification Center" (list-notifications). \`steps\` runs several commands in order in one call and stops at the first failure. Retry an action only when its result says retry: safe. For a web page you are building, prefer the browser tools. \`skills\` returns agent-desktop's full guide.`,
  parameters: Schema.Struct({
    app: Schema.optional(
      Schema.String.annotate({
        description: 'The app, as macOS names it ("Safari", "System Settings", "Notes") or its bundle id. Every call that touches an app names it; a ref\'s app is known from its snapshot.',
      }),
    ),
    command: Schema.optional(Command),
    args: Schema.optional(Args),
    steps: Schema.optional(
      Schema.Array(Schema.Struct({ command: Command, args: Schema.optional(Args) })).annotate({ description: "Several commands, run in order on the one app; stops at the first failure. Instead of command." }),
    ),
  }),
  success: Schema.Struct({
    app: Schema.optional(Schema.String),
    text: Schema.String,
    screenshot: Schema.optional(Schema.Struct({ mimeType: Schema.Literal("image/png"), data: Schema.String, width: Schema.Int, height: Schema.Int })),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService, MacDesktop],
})
  .annotate(Tool.Title, "Use apps on this Mac")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const DesktopToolkit = Toolkit.make(DesktopTool);
