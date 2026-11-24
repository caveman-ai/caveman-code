// ), apps/server/src/orchestration-v2/WireProjection.test.ts @ ab3a3cd1.
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "@caveman-app/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import { MAX_TOOL_OUTPUT_IMAGES, toolOutputImages } from "@caveman-app/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("saved_paths survives repeated wire projection with native paths and compact metadata", () => {
    const output = { saved_paths: ["/tmp/one.png", "/tmp/two.webp"], saved_path: "/tmp/native.png", threadId: "known-thread", revised_prompt: "Revised", transparent_background: false, private_body: "x".repeat(1_000_000) };
    for (const toolName of ["image_generation", "mcp__studio__generate_images", "studio.imagegen"]) {
      const projected = projectTurnItemForWire({ ...base, toolName, output });
      expect(projected.type === "dynamic_tool" && projected.output).toEqual({ saved_paths: output.saved_paths, saved_path: output.saved_path, threadId: "known-thread", revised_prompt: "Revised", transparent_background: false });
      expect(projectTurnItemForWire(projected)).toEqual(projected);
      expect(JSON.stringify(projected).length).toBeLessThan(2_048);
    }
    expect(projectTurnItemForWire({ ...base, toolName: "ordinary_tool", output })).not.toHaveProperty("output.saved_paths");
  });

  it("saved_paths cannot bypass count, type or byte limits and does not conceal failures", () => {
    for (const saved_paths of [Array(9).fill("/tmp/a.png"), ["data:image/png;base64,AAAA"], ["//host/a.png"], ["/tmp/a.svg"], Array(8).fill("/" + "x".repeat(2_000) + ".png")]) {
      const projected = projectTurnItemForWire({ ...base, toolName: "images.generate_image", status: "failed", output: { saved_paths, error: "Provider refused", result: "x".repeat(1_000_000), threadId: "known-thread" } });
      expect(projected.type === "dynamic_tool" && projected.output).toEqual({ isError: true, error: "Provider refused", threadId: "known-thread" });
      expect(projected).toMatchObject({ status: "failed" });
    }
  });

  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("preserves provider notices in bounded items and live events", () => {
    const item = {
      ...base,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    expect(projectTurnItemForWire(item)).toEqual(item);
    const event = {
      id: EventId.make("notice-wire-event"),
      type: "turn-item.updated" as const,
      threadId: item.threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
    expect(projectDomainEventForWire(event)).toEqual(event);
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected).not.toHaveProperty("output");
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it.each([
    [" \t\r\n\n  first\t line  \r\n" + "x\n".repeat(10_000), "first line"],
    [" \n".repeat(10_000), "Large tool output"],
    ["a".repeat(160) + "\n" + "x".repeat(20_000), "a".repeat(160)],
    ["a".repeat(161) + "\n" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["a".repeat(159) + "\t b" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["  café\u00a0\u2003😀 \t\r\n" + "x".repeat(20_000), "café 😀"],
  ])("preserves bounded input summary normalization for case %#", (input, summary) => {
    const projected = projectTurnItemForWire({ ...base, input });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary,
      truncated: true,
    });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("serializes an oversized structured input only once for its summary", () => {
    let serializations = 0;
    const input = {
      toJSON() {
        serializations += 1;
        return { text: "x".repeat(100_000) };
      },
    };
    const projected = projectTurnItemForWire({ ...base, input });
    expect(serializations).toBe(1);
    expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
      truncated: true,
    });
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const marker = "\n… output truncated for transport";
    const prefixBytes = 32_768 - Buffer.byteLength(marker);
    const progress = "a".repeat(prefixBytes - 1) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "漢".repeat(12_000),
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(
      Buffer.byteLength(projected.type === "subagent" ? projected.prompt : ""),
    ).toBeLessThanOrEqual(32_768);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(prefixBytes - 1) + marker,
    );
    expect(item.progress).toBe(progress);
  });

  it.each(["", "small output", "x".repeat(1_048_576)])(
    "omits command output of every size, case %#",
    (output) => {
      const item = { ...base, type: "command_execution" as const, input: "test", output };
      const projected = projectTurnItemForWire(item);
      expect(projected).not.toHaveProperty("output");
      expect(projected).toMatchObject({ input: "test", status: "completed" });
      // Clients fetch withheld output on demand, so they need to know it exists.
      expect(projected.type === "command_execution" ? projected.outputOmitted : null).toBe(
        output ? true : undefined,
      );
      expect(item.output).toBe(output);
    },
  );

  it.each([
    ["echo ok", "echo ok"],
    [
      "a".repeat(262_143) + "😀",
      // The marker counts toward the 256 KiB cap.
      "a".repeat(262_144 - Buffer.byteLength("\n… output truncated for transport")) +
        "\n… output truncated for transport",
    ],
  ])("bounds fetched command input without changing persistence, case %#", (input, expected) => {
    const item = { ...base, type: "command_execution" as const, input, output: "ok" };
    const projected = projectTurnItemForDetail(item);
    expect(projected).toMatchObject({ input: expected, output: "ok" });
    expect(item.input).toBe(input);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__caveman-code__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    // The truncated text block plus a fixed number of markers, however many images there are.
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps a failed tool's error, bounded, and nothing of a successful one", () => {
    const failed = projectTurnItemForWire({ ...base, status: "failed", output: "mcp_tool_error:caveman-code/delegate_task: target.model must not be empty" });
    expect(failed.type === "dynamic_tool" ? failed.output : null).toEqual({
      isError: true,
      error: "mcp_tool_error:caveman-code/delegate_task: target.model must not be empty",
    });
    const mcp = projectTurnItemForWire({ ...base, status: "failed", output: { content: [{ type: "text", text: "x".repeat(10_000) }], isError: true } });
    const error = mcp.type === "dynamic_tool" ? (mcp.output as { error?: string }).error : undefined;
    expect(error?.startsWith("xxx")).toBe(true);
    expect(error!.length).toBeLessThan(2_100);
    const ok = projectTurnItemForWire({ ...base, output: "fine" });
    expect(ok.type === "dynamic_tool" ? ok.output : null).toBeUndefined();
    // The Caveman engine's declared tool hands back the CallToolResult as JSON text: the runtime's refusal reads as its message.
    const refusal = "Not delegated: 1 delegated agents are already working in this task.";
    const refused = projectTurnItemForWire({
      ...base,
      status: "failed",
      output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code: "limit_reached", message: refusal }) }], structuredContent: { _tag: "OrchestratorMcpFailure", code: "limit_reached", message: refusal }, isError: true }),
    });
    expect(refused.type === "dynamic_tool" ? (refused.output as { error?: string }).error : undefined).toBe(refusal);
    // As the runtime sends it today: the failure only in the text block, as its JSON.
    const textOnly = projectTurnItemForWire({
      ...base,
      status: "failed",
      output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code: "limit_reached", message: refusal }) }], isError: true }),
    });
    expect(textOnly.type === "dynamic_tool" ? (textOnly.output as { error?: string }).error : undefined).toBe(refusal);
    const plain = projectTurnItemForWire({ ...base, status: "failed", output: JSON.stringify({ content: [{ type: "text", text: "boom" }], isError: true }) });
    expect(plain.type === "dynamic_tool" ? (plain.output as { error?: string }).error : undefined).toBe("boom");
  });

  it("keeps the error of a command that failed outright, bounded", () => {
    const failed = projectTurnItemForWire({
      ...base,
      type: "command_execution" as const,
      status: "failed",
      input: "sleep 900",
      output: "caveman-code: all 8 command sessions are still live; kill one first",
    });
    expect(failed).toMatchObject({ output: "caveman-code: all 8 command sessions are still live; kill one first" });
    expect(failed).not.toHaveProperty("outputOmitted");
    // Codex marks a non-zero exit failed: that output is the command's own and stays withheld.
    const exited = projectTurnItemForWire({
      ...base,
      type: "command_execution" as const,
      status: "failed",
      input: "cat .env",
      exitCode: 1,
      output: "SECRET=value\nboom",
    });
    expect(exited).toMatchObject({ outputOmitted: true, outputIndicatesFailure: true });
    expect(exited).not.toHaveProperty("output");
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output: %s", (output) => {
    const projected = projectTurnItemForWire({
      ...base,
      type: "command_execution" as const,
      input: "rg -n error logs fixtures",
      output,
      exitCode: 0,
    });
    expect(projected).not.toHaveProperty("outputIndicatesFailure");
    expect(projected).toMatchObject({ exitCode: 0, outputOmitted: true });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    expect(projectTurnItemForDetail(item)).toMatchObject({ diffStr: "+new code" });
    expect(projectTurnItemForDetail(item)).not.toHaveProperty("oldStr");
    expect(projectTurnItemForDetail(item)).not.toHaveProperty("newStr");
    const { diffStr: _diff, ...contentOnly } = item;
    expect(projectTurnItemForDetail(contentOnly)).toMatchObject({
      oldStr: "old code",
      newStr: "new code",
    });
    expect(projectTurnItemForWire(contentOnly)).not.toHaveProperty("newStr");
    // A failed edit keeps the provider's error so expanding the row can show it.
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("does not serialize raw dynamic output to discard it", () => {
    const output = {
      toJSON: () => {
        throw new Error("Raw output must not be serialized");
      },
    };
    expect(projectTurnItemForWire({ ...base, output })).not.toHaveProperty("output");
  });

  it("caps a large checkpoint's files for the wire and keeps totals for all of them", () => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `vendor/file-${index}.ts`,
      kind: "modified" as const,
      additions: 2,
      deletions: 1,
    }));
    const checkpointId = CheckpointId.make("checkpoint-large");
    const scopeId = CheckpointScopeId.make("scope-large");
    const checkpoint = {
      id: checkpointId,
      threadId: base.threadId,
      scopeId,
      runId: null,
      nodeId: NodeId.make("node-large"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: null,
      ref: CheckpointRef.make("refs/caveman/checkpoints/large"),
      status: "ready" as const,
      files,
      capturedAt: base.updatedAt,
    };
    const captured = projectDomainEventForWire({
      id: EventId.make("checkpoint-captured"),
      type: "checkpoint.captured" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: checkpoint,
    });
    const item = projectTurnItemForWire({ ...base, type: "checkpoint", checkpointId, scopeId, files });
    const filesTotal = { count: 250, additions: 500, deletions: 250 };
    expect(captured.payload).toMatchObject({ files: files.slice(0, 200), filesTotal });
    expect(item).toMatchObject({ files: files.slice(0, 200), filesTotal });
    // Idempotent, and the stored checkpoint keeps every file (Undo and the diff read it).
    expect(projectTurnItemForWire(item)).toBe(item);
    expect(checkpoint.files).toHaveLength(250);
    // A small checkpoint goes out as it is, with no totals.
    const small = { ...checkpoint, files: files.slice(0, 3) };
    expect(projectDomainEventForWire({ id: EventId.make("small"), type: "checkpoint.captured" as const, threadId: base.threadId, occurredAt: base.updatedAt, payload: small }).payload).toBe(small);
  });
});
