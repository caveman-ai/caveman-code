// How much context the runtime hands an agent before it reads a word of the user's request: the
// orchestration instructions each engine gets, and the tools/list JSON the shared /mcp endpoint
// advertises. Every thread pays for both on every turn, so a change to either should say what it did
// to these numbers. Tokens are estimated as characters / 4.
//
//   node packages/runtime/scripts/agent-context-size.ts          # table
//   node packages/runtime/scripts/agent-context-size.ts --json   # machine-readable
//   node packages/runtime/scripts/agent-context-size.ts --tools  # one line per advertised tool
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { cavemanAcpPromptWithInstructions } from "@caveman-app/engine-core/server/orchestrationInstructions";

import { makeClaudeQueryOptions } from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { buildCodexAdditionalContext } from "../src/provider/CodexDeveloperInstructions.ts";
import { AttachmentToolkit } from "../src/mcp/toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "../src/mcp/toolkits/environment/tools.ts";
import { HtmlPreviewTool, HtmlRenderToolkit } from "../src/mcp/toolkits/html/tools.ts";
import { MemoryToolkit } from "../src/mcp/toolkits/memory/tools.ts";
import { OrchestratorToolkit } from "../src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewSnapshotTool, PreviewStandardToolkit } from "../src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../src/mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../src/mcp/toolkits/pullRequests/tools.ts";
import { ProposeToolkit } from "../src/mcp/toolkits/setup/propose.ts";
import { ThreadToolkit } from "../src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../src/mcp/toolkits/worktree/tools.ts";

const tokens = (chars: number) => Math.round(chars / 4);

// --- Instructions, each built by the code the engine's adapter calls -----------------------------

const claudeAppend = (() => {
  const options = makeClaudeQueryOptions({
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-5" } as never,
    nativeThreadId: "00000000-0000-4000-8000-000000000000",
    resume: false,
    cwd: null,
    mcpServers: { "caveman-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  const prompt = options.systemPrompt;
  return typeof prompt === "object" && prompt !== null && "append" in prompt ? (prompt.append ?? "") : "";
})();

const codexContext = Object.values(
  buildCodexAdditionalContext({ model: "gpt-5.5", reasoningEffort: "high" }, { browser: true, device: false }),
)
  .map((entry) => entry.value)
  .join("\n");

const acpInstructions = cavemanAcpPromptWithInstructions({
  prompt: "",
  state: { interactionMode: "default", hasCavemanMcp: true },
});

const instructions = {
  "Claude Agent (system prompt append)": claudeAppend.length,
  "Codex (turn additionalContext)": codexContext.length,
  "ACP (first prompt)": acpInstructions.length,
};

// --- tools/list, registered the way McpHttpServer registers it -----------------------------------

/**
 * The shared `/mcp` toolkits, in McpHttpServer's `layer` order. The Cloud-only `computer` tool and the
 * grill, setup and web endpoints are left out: most threads never see them.
 */
const toolkits: ReadonlyArray<Toolkit.Toolkit<Record<string, Tool.Any>>> = [
  PreviewStandardToolkit,
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  HtmlRenderToolkit,
  MemoryToolkit,
  ProposeToolkit,
] as never;
/** Registered by hand (they answer with an image), with no output schema. */
const handRegistered: ReadonlyArray<Tool.Any> = [PreviewSnapshotTool, HtmlPreviewTool];

interface Advertising {
  readonly inputSchema: (tool: Tool.Any) => unknown;
  readonly register: (toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>) => Effect.Effect<void, never, never>;
}

/** The server's own advertising, when it has one (`advertisedJsonSchema.ts`); else Effect's. */
const advertising = async (): Promise<Advertising> => {
  const plain: Advertising = {
    inputSchema: (tool) => Tool.getJsonSchema(tool),
    register: (toolkit) => McpServer.registerToolkit(toolkit) as never,
  };
  const path = "../src/mcp/advertisedJsonSchema.ts";
  const module = (await import(path).catch(() => undefined)) as
    | {
        readonly advertisedJsonSchema?: (tool: Tool.Any) => unknown;
        readonly withAdvertisedSchemas?: (toolkit: unknown, registration: unknown) => Effect.Effect<void>;
      }
    | undefined;
  if (module?.advertisedJsonSchema === undefined || module.withAdvertisedSchemas === undefined) return plain;
  const { advertisedJsonSchema, withAdvertisedSchemas } = module;
  return {
    inputSchema: advertisedJsonSchema,
    register: (toolkit) => withAdvertisedSchemas(toolkit, McpServer.registerToolkit(toolkit)) as never,
  };
};

const stubHandlers = (toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>) =>
  toolkit.toLayer(
    Object.fromEntries(Object.keys(toolkit.tools).map((name) => [name, () => Effect.die("not called")])) as never,
  );

const listTools = async () => {
  const advertise = await advertising();
  const program = Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const toolkit of toolkits) {
      yield* advertise.register(toolkit).pipe(Effect.provide(stubHandlers(toolkit)));
    }
    for (const tool of handRegistered) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: advertise.inputSchema(tool) as never,
        }),
        annotations: tool.annotations,
        handle: () => Effect.die("not called"),
      });
    }
    return server.tools.map(({ tool }) => tool);
  });
  return Effect.runPromise(program.pipe(Effect.provide(McpServer.McpServer.layer as Layer.Layer<McpServer.McpServer>)) as never) as Promise<
    ReadonlyArray<McpSchema.Tool>
  >;
};

const tools = await listTools();
const encode = (value: unknown) => JSON.stringify(value);
const toolsList = encode({ tools });
/** What the model reads: engines turn each tool into name, description and input schema. */
const modelVisible = encode(
  tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
);
const perTool = tools
  .map((tool) => ({
    name: tool.name,
    chars: encode(tool).length,
    description: (tool.description ?? "").length,
    inputSchema: encode(tool.inputSchema).length,
    outputSchema: encode(tool.outputSchema ?? null).length,
  }))
  .toSorted((a, b) => b.chars - a.chars);

const sum = (key: "description" | "inputSchema" | "outputSchema") =>
  perTool.reduce((total, tool) => total + tool[key], 0);

if (process.argv.includes("--json")) {
  console.log(
    encode({
      instructions,
      toolsList: {
        tools: tools.length,
        chars: toolsList.length,
        modelVisibleChars: modelVisible.length,
        descriptions: sum("description"),
        inputSchemas: sum("inputSchema"),
        outputSchemas: sum("outputSchema"),
      },
    }),
  );
} else {
  const row = (label: string, chars: number) =>
    console.log(`${label.padEnd(44)} ${String(chars).padStart(8)} chars ${String(tokens(chars)).padStart(7)} tokens`);
  console.log("Orchestration instructions (tokens = chars / 4)");
  for (const [label, chars] of Object.entries(instructions)) row(`  ${label}`, chars);
  console.log(`MCP tools/list on /mcp: ${tools.length} tools`);
  row("  whole response", toolsList.length);
  row("  model-visible (name, description, input)", modelVisible.length);
  row("  descriptions", sum("description"));
  row("  input schemas", sum("inputSchema"));
  row("  output schemas", sum("outputSchema"));
  if (process.argv.includes("--tools")) {
    for (const tool of perTool) {
      console.log(
        `  ${tool.name.padEnd(36)} ${String(tool.chars).padStart(6)} (description ${tool.description}, input ${tool.inputSchema}, output ${tool.outputSchema})`,
      );
    }
  }
}
