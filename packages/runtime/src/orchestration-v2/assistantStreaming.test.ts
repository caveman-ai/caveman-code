// ), apps/server/src/orchestration-v2/assistantStreaming.test.ts @ ab3a3cd1; live mode is ours.
import { describe, expect, it } from "vitest";
import { MessageId, NodeId, ProviderDriverKind, ThreadId, TurnItemId } from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import { LIVE_STREAMING_MIN_GAP_MS, makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const message = (text: string, streaming = true): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it("delivers an answer from its first word, and every later change", () => {
    const filter = makeAssistantStreamingFilter("live");
    expect(filter(message(""), 0)).toBeNull();
    expect(filter(message("Ok"), 1)).toMatchObject({ message: { text: "Ok" } });
    // One paragraph is never held to its end, nor a word to its sentence's.
    expect(filter(message("Ok, the ans"), 60)).toMatchObject({ message: { text: "Ok, the ans" } });
    expect(filter(message("Ok, the ans"), 120)).toBeNull();
    const final = message("Ok, the answer.", false);
    expect(filter(final, 121)).toBe(final);
  });

  it("holds an engine that emits every token to one update per gap, never the first or the last", () => {
    const filter = makeAssistantStreamingFilter("live");
    expect(filter(message("a"), 0)).toMatchObject({ message: { text: "a" } });
    expect(filter(message("ab"), LIVE_STREAMING_MIN_GAP_MS - 1)).toBeNull();
    expect(filter(message("abc"), LIVE_STREAMING_MIN_GAP_MS)).toMatchObject({ message: { text: "abc" } });
    const final = message("abcd", false);
    expect(filter(final, LIVE_STREAMING_MIN_GAP_MS + 1)).toBe(final);
  });

  it("passes markdown through unchanged: the client renders the unfinished tail", () => {
    const filter = makeAssistantStreamingFilter("live");
    const open = turnItem("Intro\n\n```ts\nconst x = 1");
    expect(filter(open, 0)).toBe(open);
    const table = turnItem("Intro\n\n```ts\nconst x = 1\n```\n\n| a | b |\n");
    expect(filter(table, 100)).toBe(table);
  });

  it("holds streaming text until the full response completes in turn mode", () => {
    const running = message("partial");
    const final = message("complete", false);
    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(running, 0)).toBeNull();
    expect(buffered(message("First\n\nSecond\n\n"), 500)).toBeNull();
    expect(buffered(final, 501)).toBe(final);
  });

  it("shows a thought's line the moment it starts, before it has text", () => {
    const filter = makeAssistantStreamingFilter("live");
    const started = turnItem("", true, "reasoning");
    expect(filter(started, 0)).toBe(started);
    expect(filter(turnItem("", true, "reasoning"), 100)).toBeNull();
    const text = turnItem("**Reading the repo**\n\nLooking", true, "reasoning");
    expect(filter(text, 200)).toBe(text);
  });

  it.each(["assistant_message", "reasoning"] as const)("streams %s and flushes the final item", (type) => {
    const item = (text: string, streaming = true) => turnItem(text, streaming, type);
    const filter = makeAssistantStreamingFilter("live");
    expect(filter(item("First"), 0)).toMatchObject({ turnItem: { text: "First", streaming: true, type } });
    expect(filter(item("First sentence. Sec"), 50)).toMatchObject({ turnItem: { text: "First sentence. Sec" } });
    const final = item("First sentence. Second.", false);
    expect(filter(final, 60)).toBe(final);

    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(item("First\n\nSecond"), 0)).toBeNull();
    expect(buffered(final, 1)).toBe(final);
  });

  it.each(["turn", "live"] as const)(
    "suppresses running assistant nodes in %s mode while delivering tool and completed nodes",
    (mode) => {
      const filter = makeAssistantStreamingFilter(mode);
      const running: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> = {
        type: "node.updated",
        driver: ProviderDriverKind.make("codex"),
        node: {
          id: NodeId.make("node"),
          threadId: ThreadId.make("thread"),
          runId: null,
          parentNodeId: null,
          rootNodeId: NodeId.make("root"),
          kind: "assistant_message",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      };
      expect(filter(running, 0)).toBeNull();
      const completed = { ...running, node: { ...running.node, status: "completed" as const } };
      expect(filter(completed, 1)).toBe(completed);
      const tool = { ...running, node: { ...running.node, kind: "tool_call" as const } };
      expect(filter(tool, 2)).toBe(tool);
    },
  );
});
