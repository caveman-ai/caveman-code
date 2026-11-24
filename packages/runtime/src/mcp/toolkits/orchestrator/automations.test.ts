// The automation tools through the MCP server, with the access each declares: what a chat agent sees.
import { checkProject, parseAgentFile, templates } from "@caveman-app/automations";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { afterEach, describe, expect, it } from "vitest";

import { layer as filesLayer } from "../../../automations/files.ts";
import { automationsSkill } from "../../../automations/skill.ts";
import { DIGEST, fakeRunner, projectStoreFor, testRepo, type TestRepo } from "../../../automations/testing.ts";
import { BUILTIN_AGENT_TYPES } from "../../../agents/agentTypes.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { DELEGATED_AGENT_STARTS_NO_THREADS } from "../../delegationPolicy.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { AutomationToolkit, automationHandlers } from "./automations.ts";

const PROJECT = "caveman-repo:mcp";
const lead = ThreadId.make("thread:lead");
const delegated = ThreadId.make("thread:delegated");
const autoChat = ThreadId.make("thread:auto-accept-edits");
const supervisedChat = ThreadId.make("thread:approval-required");
const repos: TestRepo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.remove()));

const caller = (threadId: ThreadId | undefined, clientAccess: "full-access" | "auto-accept-edits" | "approval-required" = "full-access"): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test",
  thread: threadId === undefined ? undefined : { threadId, providerSessionId: `provider:${threadId}`, providerInstanceId: ProviderInstanceId.make("codex") },
  client: threadId === undefined ? { sessionId: "s", label: "Claude Code", access: clientAccess } : undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-test", version: "1" } },
  getClient: Effect.die("unused"),
});

/** The tools on an MCP server, over a checkout that is the lead thread's worktree. */
function server(files: Record<string, string>) {
  const r = testRepo(files);
  repos.push(r);
  const runner = fakeRunner();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        id === delegated
          ? { ...liveThreadShell(id), worktreePath: r.root, lineage: { rootThreadId: lead, parentThreadId: lead, relationshipToParent: "subagent" as const } }
          : {
              ...liveThreadShell(id, { runtimeMode: id === autoChat ? "auto-accept-edits" : id === supervisedChat ? "approval-required" : "full-access" }),
              projectId: PROJECT as never,
              worktreePath: r.root,
            },
      ),
  });
  const layer = McpHttpServer.toolkitRegistration(AutomationToolkit, McpToolAccess.toLayer(AutomationToolkit, automationHandlers)).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(threads),
    Layer.provideMerge(filesLayer.pipe(Layer.provide(projectStoreFor({ [PROJECT]: r.root })))),
    Layer.provideMerge(runner.layer),
  );
  const call = (tool: string, scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown> = {}) =>
    Effect.runPromise(
      McpServer.McpServer.pipe(
        Effect.flatMap((s) => s.callTool({ name: tool, arguments: args })),
        Effect.map((result) => ({ error: result.isError === true, json: JSON.parse(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")) })),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.provide(layer),
        Effect.scoped,
      ) as Effect.Effect<{ error: boolean; json: any }>,
    );
  return { r, call, admitted: runner.admitted };
}

describe("automation tools", () => {
  it("checks the caller's own worktree, unsaved text included, and says what to fix", async () => {
    const { r, call } = server({ ".caveman/automations/digest.yaml": DIGEST });
    // Text only, starting with the list (automation_list folded in, B19).
    expect((await call("automation_check", caller(lead))).json).toEqual({ text: "Automations:\ndigest (Project): Every 6h · By hand\n\nNo problems." });
    r.write(".caveman/automations/digest.yaml", DIGEST.replace("model: fast", "modle: fast"));
    const broken = await call("automation_check", caller(lead));
    expect(Object.keys(broken.json)).toEqual(["text"]);
    expect(broken.json.text).toMatch(/^No automations load in this checkout\.\nNot loaded: \.caveman\/automations\/digest\.yaml\.\n\n/);
    expect(broken.json.text).toContain('.caveman/automations/digest.yaml:5:5  Unknown key "modle" in step "digest". Did you mean "model"?');
    const unsaved = await call("automation_check", caller(lead), { files: [{ path: ".caveman/automations/digest.yaml", text: DIGEST }] });
    expect(unsaved.json.text).toMatch(/No problems\.$/);
  });

  it("explains for any caller; an outside client names the project", async () => {
    const { call } = server({ ".caveman/automations/digest.yaml": DIGEST });
    const explained = await call("automation_explain", caller(undefined), { name: "digest", projectId: PROJECT });
    expect(explained.json.text).toMatch(/^digest · Project/);
    expect((await call("automation_explain", caller(undefined), { name: "digest" })).json).toMatchObject({ code: "target_required" });
    expect((await call("automation_explain", caller(lead), { name: "digets" })).json).toMatchObject({ code: "invalid_request", message: "No automation digets; there is digest." });
  });

  it("runs from the worktree as a dry run for the lead, and refuses an agent another agent started", async () => {
    const { call, admitted } = server({ ".caveman/automations/digest.yaml": DIGEST });
    const ran = await call("automation_run", caller(lead), { name: "digest" });
    // It has no outputs, so nothing waits to be applied.
    expect(ran.json).toEqual({ text: "Started run r_1 of digest. It shows on the Automations page." });
    expect(admitted[0]).toMatchObject({ projectId: PROJECT, apply: false, trigger: { kind: "manual", trusted: true } });
    const refused = await call("automation_run", caller(delegated), { name: "digest" });
    expect(refused.json).toEqual({ _tag: "OrchestratorMcpFailure", code: "capability_denied", message: DELEGATED_AGENT_STARTS_NO_THREADS });
    expect(admitted).toHaveLength(1);
    // Reads stay open to it.
    expect((await call("automation_check", caller(delegated))).error).toBe(false);
  });

  it("starts a run only for a full-access caller, since a run works unattended", async () => {
    const { call, admitted } = server({ ".caveman/automations/digest.yaml": DIGEST });
    const refusals = [];
    for (const scope of [caller(autoChat), caller(supervisedChat), caller(undefined, "auto-accept-edits"), caller(undefined, "approval-required")]) {
      refusals.push((await call("automation_run", scope, { name: "digest", projectId: PROJECT })).json);
    }
    expect({ refusals, admitted: admitted.length }).toEqual({
      refusals: Array.from({ length: 4 }, () => expect.objectContaining({ code: "runtime_mode_escalation_denied" })),
      admitted: 0,
    });
    expect((await call("automation_run", caller(undefined), { name: "digest", projectId: PROJECT })).error).toBe(false);
    expect(admitted).toHaveLength(1);
  });

  it("hands out the guide and the templates, and a template's files by id", async () => {
    const { call } = server({});
    const all = (await call("automation_templates", caller(lead))).json;
    expect(all.guide).toContain("## Workflow");
    expect(all.guide.startsWith("---")).toBe(false);
    expect(all.text.split("\n").slice(1).map((line: string) => line.split(" ")[0])).toEqual(templates.map((t) => t.id));
    const one = (await call("automation_templates", caller(lead), { id: "pr-review" })).json;
    expect(Object.keys(one)).toEqual(["text"]);
    for (const file of templates.find((t) => t.id === "pr-review")!.files) expect(one.text).toContain(`${file.path}:\n${file.text}`);
  });
});

describe("the automations skill", () => {
  it("is short, and every example in it checks clean", () => {
    const text = automationsSkill();
    expect(text.split("\n").length).toBeLessThanOrEqual(150);
    expect(text).toMatch(/^---\nname: automations\ndescription: .+\n---\n/);
    const yaml = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const md = [...text.matchAll(/```md\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(yaml).toHaveLength(2);
    const agents = md.map((body) => parseAgentFile({ path: ".caveman/agents/issue-triage.md", text: body }, "project").agent!);
    const registry = [
      ...BUILTIN_AGENT_TYPES.map((t) => ({ name: t.name, description: t.description, source: "builtin" as const, ...(t.decides ? { decides: t.decides } : {}) })),
      ...agents,
    ];
    yaml.forEach((body, i) => {
      const check = checkProject({ files: [{ path: `.caveman/automations/example-${i}.yaml`, text: body }], agents: registry });
      expect(check.diagnostics, body).toEqual([]);
    });
  });
});
