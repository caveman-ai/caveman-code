// ), apps/server/src/mcp/toolkits/worktree/registration.test.ts @ ab3a3cd1.
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as Desktop from "../../../session-protocol/desktop.ts";
import { Grill } from "../../../session-protocol/grill.ts";
import { SetupChats } from "../../../session-protocol/environments.ts";
import { ChatPreviews } from "../../../session-protocol/previewHandlers.ts";
import { WebTools } from "../../../web/WebTools.ts";
import { WEB_MCP_PATH } from "../web/tools.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(Grill)({}),
  // Off a Cloud computer: the desktop tool is not registered.
  Desktop.layerFor(undefined),
  Layer.mock(SetupChats)({}),
  Layer.mock(ChatPreviews)({}),
  Layer.mock(WebTools)({ search: (_threadId, input) => Effect.succeed(`Searched "${input.query}" with Brave Search: no results.`) }),
  McpProviderSessions.layer,
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(layerStubServices),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const auth = credential!.config.authorizationHeader;
      const listTools = (path: string) =>
        Effect.gen(function* () {
          const initResponse = yield* httpClient.post(path, {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: auth,
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          expect(initResponse.status).toBe(200);
          const sessionId = initResponse.headers["mcp-session-id"];

          const listResponse = yield* httpClient.post(path, {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: auth,
              "mcp-protocol-version": "2025-06-18",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const bodyText = yield* listResponse.text;
          return { raw: bodyText, tools: (yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0])).result.tools };
        });
      const { raw, tools } = yield* listTools("/mcp");
      const toolNames = tools.map((tool) => tool.name);
      // Grill mode lives only on its own endpoint, which adapters attach in grill mode:
      // a default-mode engine reads no grill tool, schema value or word.
      expect(raw).not.toMatch(/grill/i);
      const grillTools = (yield* listTools(McpHttpServer.GRILL_MCP_PATH)).tools;
      expect(grillTools.map((tool) => tool.name)).toEqual(["grill_round", "grill_finish"]);
      // The web tools too: the Caveman adapter attaches /mcp/web for credentials with the `web` capability.
      expect(toolNames).not.toContain("web_search");
      const webTools = (yield* listTools(WEB_MCP_PATH)).tools;
      expect(webTools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
      expect(webTools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.openWorldHint === true)).toBe(true);
      expect(toolNames).toContain("worktree_handoff");
      expect(toolNames).toContain("worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");
      // Every chat registers how to serve what it built (session-protocol/previewHandlers.ts); it runs nothing itself.
      expect(tools.find((tool) => tool.name === "register_preview")?.annotations?.destructiveHint).toBe(false);

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // A web call answers with its text as the only content (no structuredContent copy), for a credential with `web`.
      const webCredential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-web"),
        providerInstanceId: ProviderInstanceId.make("caveman"),
        capabilities: new Set(["orchestration", "web"]),
      });
      const webAuth = webCredential!.config.authorizationHeader;
      const webInit = yield* httpClient.post(WEB_MCP_PATH, {
        headers: { accept: "application/json, text/event-stream", authorization: webAuth },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const webSession = webInit.headers["mcp-session-id"];
      const called = yield* httpClient.post(WEB_MCP_PATH, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: webAuth,
          "mcp-protocol-version": "2025-06-18",
          ...(webSession ? { "mcp-session-id": webSession } : {}),
        },
        body: HttpBody.text(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"effect schema"}}}`, "application/json"),
      });
      const callText = yield* called.text;
      expect(JSON.parse(callText.match(/\{.*\}/s)![0]).result).toEqual({
        isError: false,
        content: [{ type: "text", text: 'Searched "effect schema" with Brave Search: no results.' }],
      });

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of [...tools, ...grillTools, ...webTools]) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" }).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        DocumentText.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      ),
    ),
  ),
);
