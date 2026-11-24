// The tools the Caveman engine sees declared (provider-caveman runtimeTools.ts): the waiting ones
// and the ones that answer with a screenshot, built from the toolkits the MCP servers serve, so
// their names, descriptions and schemas never drift.
import type { CavemanDirectTool, CavemanRuntimeTools } from "@caveman-app/provider-caveman/server";
import { Tool } from "effect/ai";

import { GRILL_MCP_SERVER, GRILL_SKILL_PATH, GRILL_TOOL_TIMEOUT_MS, grillMcpEndpoint, takeGrillSkillMention } from "../grill/grill.ts";
import { CLIENT_MCP_SERVER, CLIENT_TOOL_TIMEOUT_MS, clientMcpEndpoint, clientToolThreads } from "./clientToolThreads.ts";
import { MAX_WAIT_TIMEOUT_MS } from "./OrchestratorMcpService.ts";
import { setupThreads } from "../session-protocol/environments.ts";
import { ComputerTool } from "./toolkits/computer/tools.ts";
import { DesktopTool } from "./toolkits/desktop/tools.ts";
import { offered as macDesktopOffered } from "../session-protocol/macDesktop/service.ts";
import { GrillToolkit } from "./toolkits/grill/tools.ts";
import { PreviewSnapshotTool } from "./toolkits/preview/tools.ts";
import { SETUP_MCP_SERVER, SETUP_TOOL_TIMEOUT_MS, setupMcpEndpoint, SetupToolkit } from "./toolkits/setup/tools.ts";
import { AUTOMATION_TOOLS } from "./toolkits/orchestrator/automations.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { WEB_MCP_SERVER, WEB_TOOL_TIMEOUT_MS, webMcpEndpoint, WebToolkit } from "./toolkits/web/tools.ts";

const declare = (tool: Tool.Any, timeoutMs: number): CavemanDirectTool => ({
  tool: tool.name,
  description: Tool.getDescription(tool) ?? tool.name,
  input: Tool.getJsonSchema(tool) as Record<string, unknown>,
  timeoutMs,
});

const { delegate_task, thread_wait, request_secret } = OrchestratorToolkit.tools;
/** A check or explain answers in well under a second; a run answers once it is admitted. */
const AUTOMATION_TOOL_TIMEOUT_MS = 60_000;
/** computer's wait holds up to 60 s before its screenshot; the server's default would cut it off. */
const IMAGE_TOOL_TIMEOUT_MS = 90_000;

export const cavemanRuntimeTools: CavemanRuntimeTools = {
  waiting: [
    // mode=wait and thread_wait wait up to the server's own cap.
    declare(delegate_task, MAX_WAIT_TIMEOUT_MS + 60_000),
    declare(thread_wait, MAX_WAIT_TIMEOUT_MS + 60_000),
    // A person answers the card, like a grill round.
    declare(request_secret, GRILL_TOOL_TIMEOUT_MS),
    // Automation files: an agent writes them with its own tools, then checks, explains and runs them as tools.
    ...AUTOMATION_TOOLS.map((tool) => declare(tool, AUTOMATION_TOOL_TIMEOUT_MS)),
  ],
  images: {
    browser: [declare(PreviewSnapshotTool, IMAGE_TOOL_TIMEOUT_MS)],
    desktop: [declare(ComputerTool, IMAGE_TOOL_TIMEOUT_MS)],
    // Computer use on this Mac waits on the person the first time a chat uses an app, as request_secret does.
    local: macDesktopOffered() ? [declare(DesktopTool, GRILL_TOOL_TIMEOUT_MS)] : [],
  },
  grill: {
    server: GRILL_MCP_SERVER,
    endpoint: grillMcpEndpoint,
    tools: Object.values(GrillToolkit.tools).map((tool) => declare(tool, GRILL_TOOL_TIMEOUT_MS)),
    skillPath: GRILL_SKILL_PATH,
    takeSkillMention: takeGrillSkillMention,
  },
  setup: {
    server: SETUP_MCP_SERVER,
    endpoint: setupMcpEndpoint,
    tools: Object.values(SetupToolkit.tools).map((tool) => declare(tool, SETUP_TOOL_TIMEOUT_MS)),
    has: (threadId) => setupThreads.has(threadId),
  },
  // An agent file's custom tools, declared on its thread only: a call waits for whoever drives the session.
  client: {
    server: CLIENT_MCP_SERVER,
    endpoint: clientMcpEndpoint,
    tools: (threadId) =>
      (clientToolThreads.get(threadId) ?? []).map((tool) => ({ tool: tool.name, description: tool.description || tool.name, input: { ...tool.input_schema }, timeoutMs: CLIENT_TOOL_TIMEOUT_MS })),
  },
  // Declared beside the coding tools: a lookup should not cost a code cell.
  web: {
    server: WEB_MCP_SERVER,
    endpoint: webMcpEndpoint,
    tools: Object.values(WebToolkit.tools).map((tool) => declare(tool, WEB_TOOL_TIMEOUT_MS)),
  },
};
