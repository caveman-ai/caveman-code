// ), apps/server/src/orchestration-v2/assistantStreaming.ts @ ab3a3cd1.
// Departs from T3 on purpose (README.md): T3 delivers finished paragraphs at most every 400 ms, so a
// one-paragraph answer or a long first thought showed only when done. Here text goes out as it arrives and the
// client keeps the unfinished tail's markdown from reshaping (packages/ui src/ai/streaming-markdown.ts).
import type { ResponseStreamingMode } from "@caveman-app/protocol";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

/**
 * The shortest gap between two deliveries of one streaming item. Claude's, Codex's and the Caveman engine's adapters
 * already batch their deltas every 50 ms, so for them nothing is held; an engine that emits every token gets ~25
 * updates a second instead of one per token. The first text of an item is never held, and the final one always goes.
 */
export const LIVE_STREAMING_MIN_GAP_MS = 40;

/**
 * Which streaming assistant messages and reasoning reach the read model.
 * - `live`: the text as it arrives, the first of each item at once (a thought with no text yet too, so its line
 *   shows the moment the engine starts thinking), later changes at most every LIVE_STREAMING_MIN_GAP_MS.
 * - `turn`: nothing until the item is final.
 * Running assistant nodes never pass: the turn item carries the streaming text, the node lands with the final one.
 */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const delivered = new Map<string, { text: string; at: number }>();
  return (
    event: ProviderAdapter.ProviderAdapterV2Event,
    now: number,
  ): ProviderAdapter.ProviderAdapterV2Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      delivered.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const previous = delivered.get(key);
    if (previous === undefined) {
      // An answer shows from its first word; a thought shows its line from its start.
      const reasoning = event.type === "turn_item.updated" && event.turnItem.type === "reasoning";
      if (message.text.length === 0 && !reasoning) return null;
    } else if (message.text === previous.text || now - previous.at < LIVE_STREAMING_MIN_GAP_MS) {
      return null;
    }
    delivered.set(key, { text: message.text, at: now });
    return event;
  };
}
