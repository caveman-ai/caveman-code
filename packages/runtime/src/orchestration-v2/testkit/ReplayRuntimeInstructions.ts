// ), apps/server/src/orchestration-v2/testkit/ReplayRuntimeInstructions.ts @ ab3a3cd1.
import type { ProviderDriverKind, ProviderReplayTranscript } from "@caveman-app/protocol";

import { buildRuntimeInstructions } from "@caveman-app/engine-core/server/runtimeInstructions";

/** Adds current runtime context to legacy prompt expectations, keeping outbound matching exact. */
export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  if (runtime.driver === "muse") return museRuntimeInstructions(transcript, runtime.model);
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          lastPart.text === instructions
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}

/**
 * Muse turns open with the runtime's instructions as their first input. upstream
 * recorded its own wording; the expectation becomes ours for the same model and
 * effort, so outbound matching stays exact.
 */
function museRuntimeInstructions(transcript: ProviderReplayTranscript, model: string): ProviderReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame as { method?: unknown; params?: { input?: unknown; reasoningEffort?: unknown } } | null;
      const input = frame?.params?.input;
      if (frame?.method !== "turn/start" || !Array.isArray(input)) return entry;
      const first = input[0] as { type?: unknown; text?: unknown } | undefined;
      if (first?.type !== "text" || typeof first.text !== "string" || !first.text.startsWith("<runtime_info>")) return entry;
      const effort = typeof frame.params!.reasoningEffort === "string" ? frame.params!.reasoningEffort : undefined;
      const text = buildRuntimeInstructions({ harness: "Muse Code", model, reasoningEffort: effort });
      return { ...entry, frame: { ...frame, params: { ...frame.params, input: [{ ...first, text }, ...input.slice(1)] } } };
    }),
  };
}
