// ), packages/shared/src/t3McpToolPresentation.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";

import {
  CAVEMAN_CODE_MCP_TOOL_NAMES,
  resolveCavemanMcpSummaryAction,
  resolveCavemanMcpToolId,
  resolveCavemanMcpToolDefinition,
  resolveCavemanMcpToolPresentation,
} from "./cavemanMcpToolPresentation.ts";

describe("resolveCavemanMcpToolPresentation", () => {
  it("recognizes every Caveman Code tool across provider prefixes and completion suffixes", () => {
    for (const tool of CAVEMAN_CODE_MCP_TOOL_NAMES) {
      const presentation = resolveCavemanMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__caveman-code__",
        "mcp__caveman_code__",
        "mcp__cavemancode__",
        "Caveman-code.",
        "cavemancode.",
        "caveman-code-direct.",
        "mcp__caveman_code_direct__",
        "t3-code-direct.",
        "mcp__t3_code_direct__",
        "caveman_code/",
        "cavemancode:",
        "mcp_caveman-code_",
        "Caveman Code ",
        "caveman-code · ",
      ]) {
        expect(resolveCavemanMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveCavemanMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Caveman Code MCP tool names", () => {
    expect(resolveCavemanMcpToolPresentation("mcp__caveman-code__thread_read")).toEqual({
      displayName: "Read a thread",
      logo: "caveman-code",
    });
  });

  it("pretty prints Codex Caveman Code MCP tool names", () => {
    expect(resolveCavemanMcpToolPresentation("caveman-code.create_threads")).toEqual({
      displayName: "Create threads",
      logo: "caveman-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveCavemanMcpToolPresentation("mcp__caveman-code__thread_update")).toEqual({
      displayName: "Update thread metadata",
      logo: "caveman-code",
    });
  });

  it("pretty prints bare Caveman Code MCP toolkit names", () => {
    expect(resolveCavemanMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "caveman-code",
    });
  });

  it("pretty prints worktree Caveman Code MCP tool names", () => {
    expect(resolveCavemanMcpToolPresentation("mcp__caveman-code__worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "caveman-code",
    });
    expect(resolveCavemanMcpToolPresentation("caveman-code.worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "caveman-code",
    });
  });

  it("pretty prints preview Caveman Code MCP tool names", () => {
    expect(resolveCavemanMcpToolPresentation("Caveman-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "caveman-code",
    });
    expect(resolveCavemanMcpToolPresentation("mcp__caveman-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "caveman-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_caveman-code_delegate_task",
      "caveman_code:delegate_task",
      "cavemancode/delegate_task",
      "caveman-code delegate_task",
      "Caveman Code delegate_task",
      "caveman-code__delegate_task",
    ]) {
      expect(resolveCavemanMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveCavemanMcpToolPresentation("caveman-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveCavemanMcpToolPresentation("caveman-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveCavemanMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveCavemanMcpToolPresentation("caveman-code.not_a_real_tool")).toBeNull();
  });
});

describe("resolveCavemanMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveCavemanMcpToolDefinition("mcp__caveman-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveCavemanMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveCavemanMcpToolDefinition("thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveCavemanMcpToolDefinition("thread_fork")?.displayName);
    expect(resolveCavemanMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("tools on other threads", () => {
  it("say a question, an answer and a plain send apart, each with the verbs it names a thread with", () => {
    const send = (input: object) =>
      resolveCavemanMcpToolDefinition("mcp__caveman-code__thread_send", input);
    expect(send({ threadId: "t", message: "Hi" })?.named).toEqual([
      "Send to",
      "Sending to",
      "Sent to",
    ]);
    expect(send({ threadId: "t", message: "Which?", expectReply: true })?.named).toEqual([
      "Ask",
      "Asking",
      "Asked",
    ]);
    expect(
      send({ threadId: "t", message: "This", inReplyTo: "m1", expectReply: true })?.named,
    ).toEqual(["Reply to", "Replying to", "Replied to"]);
    expect(send({})?.labels).toEqual(["Send", "Sending", "Sent", "to a thread"]);
    expect(resolveCavemanMcpToolDefinition("caveman-code.thread_wait")?.named).toEqual([
      "Wait for",
      "Waiting for",
      "Waited for",
    ]);
    // An interrupt is a request; thread_configure without a model only reads.
    expect(resolveCavemanMcpToolDefinition("caveman-code.thread_interrupt")?.named?.[2]).toBe(
      "Requested an interrupt of",
    );
    expect(
      resolveCavemanMcpToolDefinition("caveman-code.thread_configure", { threadId: "t" })
        ?.named?.[2],
    ).toBe("Read the settings of");
    expect(
      resolveCavemanMcpToolDefinition("caveman-code.thread_configure", {
        threadId: "t",
        modelSelection: { model: "m" },
      })?.named?.[2],
    ).toBe("Configured");
    // A tool on no thread has none.
    expect(
      resolveCavemanMcpToolDefinition("caveman-code.list_scheduled_tasks")?.named,
    ).toBeUndefined();
  });

  it("knows the runtime's other own tools, so none reads as a connector", () => {
    for (const name of ["register_preview", "propose_setup_change", "memory_sql"]) {
      expect(resolveCavemanMcpToolDefinition(`mcp__caveman-code__${name}`), name).not.toBeNull();
    }
  });
});

describe("resolveCavemanMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveCavemanMcpSummaryAction("mcp__caveman-code__queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveCavemanMcpSummaryAction("queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveCavemanMcpSummaryAction("thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveCavemanMcpSummaryAction("thread_configure", {})).toBe("thread-configuration");
    expect(resolveCavemanMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveCavemanMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});

// Stored transcripts must keep working without rewriting their wire names.
describe("legacy Caveman Code MCP transcript names", () => {
  it.each([
    ["mcp__t3-code__t3_thread_send", "thread_send"],
    ["mcp__t3_code__t3_thread_read", "thread_read"],
    ["t3-code.t3_thread_read", "thread_read"],
    ["t3-code__t3_background_wait", "background_wait"],
    ["t3-code-thread_with_underscores_t3_thread_send", "thread_send"],
    ["t3-code-thread_t3_thread_send_attachments", "thread_send_attachments"],
    ["t3-code-thread_delegate_task", "delegate_task"],
    ["t3-code-thread_task_status", "task_status"],
    ["t3_thread_wait", "thread_wait"],
    ["mcp__t3code__t3_thread_read", "thread_read"],
    ["t3_code/t3_thread_read", "thread_read"],
    ["T3 Code t3_thread_read completed", "thread_read"],
    ["caveman-code.thread_read", "thread_read"],
    ["caveman-code-thread_with_underscores_thread_send", "thread_send"],
  ])("maps %s to %s", (legacy, canonical) => {
    expect(resolveCavemanMcpToolId(legacy)).toBe(canonical);
    expect(resolveCavemanMcpToolDefinition(legacy)).toEqual(
      resolveCavemanMcpToolDefinition(canonical),
    );
    expect(resolveCavemanMcpToolPresentation(legacy)?.logo).toBe("caveman-code");
  });

  it("maps legacy action IDs before resolving action summaries", () => {
    expect(resolveCavemanMcpSummaryAction("mcp__t3-code__t3_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveCavemanMcpSummaryAction("t3-code.t3_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveCavemanMcpSummaryAction("t3_thread_configure", {})).toBe("thread-configuration");
    expect(resolveCavemanMcpToolId("mcp__other__t3_thread_send")).toBeNull();
    expect(resolveCavemanMcpToolId("t3-code.not_a_tool")).toBeNull();
  });

  it("names a schedule set on Cloud as one, and its later changes as any schedule's", () => {
    expect(
      resolveCavemanMcpToolDefinition("mcp__caveman-code__schedule_task", {
        where: "cloud",
        prompt: "x",
      })?.labels[2],
    ).toBe("Scheduled");
    expect(
      resolveCavemanMcpToolDefinition("schedule_task", { where: "cloud", prompt: "x" })?.labels[3],
    ).toBe("a task on Cloud");
    expect(
      resolveCavemanMcpToolDefinition("schedule_task", {
        where: "cloud",
        scheduledTaskId: "cloud-schedule:1",
      })?.labels[3],
    ).toBe("a task");
    expect(resolveCavemanMcpToolDefinition("schedule_task", { prompt: "x" })?.labels[3]).toBe(
      "a task",
    );
  });
});
