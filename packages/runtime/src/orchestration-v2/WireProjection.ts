// ), apps/server/src/orchestration-v2/WireProjection.ts @ ab3a3cd1.
import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@caveman-app/protocol";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@caveman-app/shared/toolOutput";

import { isImageGeneration, readGeneratedImagePaths } from "@caveman-app/shared/imageGeneration";
import { isBoundedImagePath } from "../generatedImage.ts";

// A checkpoint over vendored or generated trees can list 15k+ files; the card needs a prefix.
const MAX_WIRE_CHECKPOINT_FILES = 200;
const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;

/** What follows a text cut for transport. */
export const TRUNCATED_FOR_TRANSPORT = "\n… output truncated for transport";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATED_FOR_TRANSPORT, "utf8");

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // The marker counts toward the cap, so projecting truncated text again leaves it unchanged.
  const budget = maxBytes - TRUNCATION_MARKER_BYTES;
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, budget), "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}${TRUNCATED_FOR_TRANSPORT}`;
}

/**
 * Bounds the text a provider file change keeps in the event log and its
 * projection. Clients never receive more than this (see projectTurnItemForWire),
 * so a full diff of a large file would only grow the database and the heap that
 * reads it back. Agents reading the thread over MCP get the bounded text.
 */
export function boundFileChangeForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "file_change") return item;
  const { diffStr, oldStr, newStr } = item;
  const bounded = {
    ...item,
    ...(diffStr === undefined ? {} : { diffStr: truncateDetail(diffStr) }),
    ...(oldStr === undefined ? {} : { oldStr: truncateDetail(oldStr) }),
    ...(newStr === undefined ? {} : { newStr: truncateDetail(newStr) }),
  };
  return bounded.diffStr === diffStr && bounded.oldStr === oldStr && bounded.newStr === newStr
    ? item
    : bounded;
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

type CheckpointFiles = Pick<OrchestrationV2Checkpoint, "files" | "filesTotal">;

// Same input, same output object: snapshot compaction relies on shared item identity.
const cappedCheckpointFiles = new WeakMap<object, object>();

function capCheckpointFiles<T extends CheckpointFiles>(value: T): T {
  if (value.files.length <= MAX_WIRE_CHECKPOINT_FILES || value.filesTotal !== undefined) {
    return value;
  }
  const cached = cappedCheckpointFiles.get(value);
  if (cached !== undefined) return cached as T;
  let additions = 0;
  let deletions = 0;
  for (const file of value.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const capped = {
    ...value,
    files: value.files.slice(0, MAX_WIRE_CHECKPOINT_FILES),
    filesTotal: { count: value.files.length, additions, deletions },
  };
  cappedCheckpointFiles.set(value, capped);
  return capped;
}

/** Idempotent; bounded snapshots that skip `projectThreadProjectionForWire` still need it. */
export function capProjectionCheckpointFilesForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const checkpoints = projection.checkpoints.map(capCheckpointFiles);
  const turnItems = projection.turnItems.map(capCheckpointItemFiles);
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    const item = capCheckpointItemFiles(row.item);
    return item === row.item ? row : { ...row, item };
  });
  const unchanged = (next: ReadonlyArray<unknown>, previous: ReadonlyArray<unknown>) =>
    next.every((value, index) => value === previous[index]);
  return unchanged(checkpoints, projection.checkpoints) &&
    unchanged(turnItems, projection.turnItems) &&
    unchanged(visibleTurnItems, projection.visibleTurnItems)
    ? projection
    : { ...projection, checkpoints, turnItems, visibleTurnItems };
}

function capCheckpointItemFiles(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return item.type === "checkpoint" ? capCheckpointFiles(item) : item;
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "checkpoint":
      return capCheckpointFiles(item);
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      // A successful search can print "ENOENT" or "exit code 2", so output text
      // decides only when the provider reported no exit code.
      const failed =
        item.exitCode === undefined
          ? item.outputIndicatesFailure === true ||
            (output !== undefined &&
              toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)))
          : item.exitCode !== 0;
      // A call that failed outright (refused, timed out: no exit code) keeps its error, bounded.
      // A command that ran and exited non-zero is ordinary output: withheld.
      const error = item.status === "failed" && item.exitCode === undefined ? failureText(output) : undefined;
      return {
        ...projected,
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(error !== undefined ? { output: error } : output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      // File identity and counts are enough for activity. Full diffs come from
      // checkpoint diffs; storage keeps only a bounded copy of this text.
      const { diffStr, oldStr: _old, newStr: _new, ...projected } = item;
      // A failed edit stores the provider's error where the diff would be.
      return item.status === "failed" && diffStr?.trim()
        ? { ...projected, diffStr: truncateDetail(diffStr) }
        : projected;
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      // A failed call keeps its error, bounded, as a failed edit keeps diffStr.
      // Native/dynamic/MCP imagegen publishes bounded local references, not bytes.
      // Keep the generic metadata compactor in place; never exempt arbitrary output.
      const image = isImageGeneration(item.toolName ?? "") ? projectImageGenerationOutput(rawOutput) : undefined;
      const error = item.status === "failed" ? image?.error ?? failureText(rawOutput) : undefined;
      const metadata = compactDynamicToolOutput(rawOutput);
      const compact = image === undefined ? metadata : { ...metadata, ...image };
      const output = error === undefined ? compact : { ...compact, isError: true, error };
      return {
        ...projected,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(hasDynamicValue(rawOutput) ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

const MAX_FAILURE_TEXT_BYTES = 2_048;

function projectImageGenerationOutput(raw: unknown): {
  saved_path?: string;
  saved_paths?: string[];
  revised_prompt?: string;
  transparent_background?: boolean;
  error?: string;
} | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const paths = readGeneratedImagePaths(value.saved_paths);
  const output = {
    ...(paths === undefined ? {} : { saved_paths: paths }),
    ...(isBoundedImagePath(value.saved_path) ? { saved_path: value.saved_path } : {}),
    ...(typeof value.revised_prompt === "string" ? { revised_prompt: truncateDetail(value.revised_prompt, 8_192) ?? "" } : {}),
    ...(typeof value.transparent_background === "boolean" ? { transparent_background: value.transparent_background } : {}),
    ...(typeof value.error === "string" && value.error.trim() !== "" ? { error: truncateDetail(value.error, MAX_FAILURE_TEXT_BYTES) ?? "" } : {}),
  };
  return Object.keys(output).length === 0 ? undefined : output;
}

/** A JSON object's value, else undefined. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A failed tool's text: the output as is, or its content blocks' text. An MCP result that came as JSON text (the
 * Caveman engine's declared tools) is read as that result, and the runtime's own refusal (OrchestratorMcpFailure)
 * by its message, so the person reads "Not delegated: …", not the envelope.
 */
function failureText(raw: unknown): string | undefined {
  const output = typeof raw === "string" ? (jsonObject(raw) ?? raw) : raw;
  const structured = typeof output === "object" && output !== null ? (output as { structuredContent?: unknown }).structuredContent : undefined;
  const refusal = mcpFailureMessage(structured);
  if (refusal !== undefined) return truncateDetail(refusal, MAX_FAILURE_TEXT_BYTES);
  const content = typeof output === "object" && output !== null && !Array.isArray(output) ? (output as { content?: unknown }).content : output;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
        : "";
  // The refusal may ride only in the text block, as its JSON.
  const inner = mcpFailureMessage(jsonObject(text.trim()));
  if (inner !== undefined) return truncateDetail(inner, MAX_FAILURE_TEXT_BYTES);
  return text.trim() === "" ? undefined : truncateDetail(text.trim(), MAX_FAILURE_TEXT_BYTES);
}

/** The runtime's own refusal (OrchestratorMcpFailure) by its message. */
function mcpFailureMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { _tag, message } = value as { _tag?: unknown; message?: unknown };
  return _tag === "OrchestratorMcpFailure" && typeof message === "string" && message.trim() !== "" ? message.trim() : undefined;
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    // Compact, so measuring does not inflate the value; clients indent it.
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

/**
 * Projects one item for an on-demand detail read: keeps the input and output
 * the timeline withholds, bounded so a huge result cannot stall the socket.
 * Image bytes are left out; clients load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "file_change":
      return {
        ...projectTurnItemForWire(item),
        ...(item.diffStr === undefined
          ? {}
          : { diffStr: truncateDetail(item.diffStr, MAX_ON_DEMAND_BYTES) }),
        ...(!item.diffStr?.trim() && item.oldStr !== undefined
          ? { oldStr: truncateDetail(item.oldStr, MAX_ON_DEMAND_BYTES) }
          : {}),
        ...(!item.diffStr?.trim() && item.newStr !== undefined
          ? { newStr: truncateDetail(item.newStr, MAX_ON_DEMAND_BYTES) }
          : {}),
      };
    case "handoff":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    checkpoints: projection.checkpoints.map(capCheckpointFiles),
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "context-handoff.updated"
      ? { ...event, payload: projectContextHandoffForWire(event.payload) }
      : event.type === "checkpoint.captured"
        ? { ...event, payload: capCheckpointFiles(event.payload) }
        : event;
}
