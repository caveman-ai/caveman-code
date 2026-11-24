// The `computer` tool: a Cloud computer's Linux desktop (session-protocol/desktop.ts)
// for every engine, by Anthropic's action names. McpHttpServer registers it only on
// a Cloud computer, so This Mac never offers it.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ACTIONS, Desktop, SCREEN } from "../../../session-protocol/desktop.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Point = Schema.Tuple([Schema.Int, Schema.Int]);

export const ComputerTool = Tool.make("computer", {
  description: `Use this Cloud computer's Linux desktop (${SCREEN.width}x${SCREEN.height}, display :99) by sight: screenshot, click, type, press keys, scroll and drag. Every action but cursor_position returns a screenshot of the screen after it; coordinates are in screenshot pixels. The desktop starts on your first call, so take a screenshot before starting a window from your shell (DISPLAY=:99 is set there) in the background: \`chrome --no-first-run --user-data-dir=/tmp/desktop-chrome https://example.com >/dev/null 2>&1 &\` (any X app the computer has works the same way). For web pages prefer the preview_* browser tools; use this for what they can't reach: desktop apps, native dialogs, a page you must drive by sight. key takes X keysym names joined by + (\`ctrl+s\`, \`Return\`, \`alt+F4\`; several separated by spaces). While a person has taken over the desktop, actions other than screenshot, wait and cursor_position fail; take a screenshot to watch.`,
  parameters: Schema.Struct({
    action: Schema.Literals(ACTIONS),
    coordinate: Schema.optional(Point.annotate({ description: "[x, y] in screenshot pixels: where to click, move, or scroll." })),
    start_coordinate: Schema.optional(Point.annotate({ description: "left_click_drag: [x, y] where the drag starts." })),
    text: Schema.optional(Schema.String.annotate({ description: "type: the text. key: the keys, as X keysym names." })),
    scroll_direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])),
    scroll_amount: Schema.optional(Schema.Int.annotate({ description: "scroll: wheel clicks, default 3." })),
    duration: Schema.optional(Schema.Number.annotate({ description: "wait: seconds, at most 60." })),
  }),
  success: Schema.Struct({
    action: Schema.String,
    x: Schema.optional(Schema.Int),
    y: Schema.optional(Schema.Int),
    screenshot: Schema.optional(
      Schema.Struct({ mimeType: Schema.Literal("image/png"), data: Schema.String, width: Schema.Int, height: Schema.Int }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService, Desktop],
})
  .annotate(Tool.Title, "Use the desktop")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerToolkit = Toolkit.make(ComputerTool);
