// Crash reports (docs/): what an automatic crash
// report may carry when it leaves the computer for Caveman's crash service
// (Sentry). The same rules as a problem report (redact() in ./index.ts) run
// over every string in the event: secrets by their shapes and names, emails,
// the home folder and user name, code blocks and over-long lines. Beyond that
// a crash report keeps only what places a crash: the error, its stack, the
// app's own context, and lifecycle breadcrumbs. Never the request, the user
// beyond an anonymous id, local variables, source lines, or a trail of what
// the person clicked, typed or logged.
//
// Structural, with no Sentry types: browser-safe and dependency-free, so the
// desktop's main process, its page and the runtime run the same function.
import { redact, REDACTION_VERSION, type RedactionContext } from "./index.ts";

/** Sent with each report as the `redaction` tag, so a report says which rules it passed. */
export const CRASH_REDACTION_VERSION = REDACTION_VERSION;

/**
 * The environment's override, as the v4 CLI reads it: DO_NOT_TRACK, or CAVEMAN_TELEMETRY set to anything but
 * 1/true/on, turns off usage stats and crash reports alike, whatever a switch says.
 */
export const telemetryOffByEnv = (env: {
  readonly DO_NOT_TRACK?: string | undefined;
  readonly CAVEMAN_TELEMETRY?: string | undefined;
}): boolean => {
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") return true;
  const set = env.CAVEMAN_TELEMETRY?.trim().toLowerCase();
  return set !== undefined && set !== "" && !["1", "true", "on"].includes(set);
};

/** Fields that carry no text of the person's: kept as they are. */
const KEPT = new Set([
  "event_id",
  "timestamp",
  "start_timestamp",
  "level",
  "platform",
  "release",
  "dist",
  "environment",
  "type",
  "sdk",
  "debug_meta",
  "fingerprint",
]);

/**
 * Fields never sent: the page or HTTP request (URL, headers, cookies), the machine's name, the installed modules,
 * and anything Sentry would attach about a person beyond the anonymous id.
 */
const DROPPED = new Set(["request", "server_name", "modules", "user"]);

/** Keys dropped wherever they appear: a frame's local variables and source lines. */
const DROPPED_DEEP = new Set(["vars", "pre_context", "context_line", "post_context"]);

/**
 * Breadcrumbs kept: the app's own lifecycle (Electron's app, window and power events), navigation between the
 * app's screens, and Sentry's note of an earlier report. Console output, clicks, keys and requests stay here.
 */
const KEPT_BREADCRUMBS = /^(electron|navigation|sentry\.event)(\.|$)/;

/** Deeper than this, a value is cut: a crash report's context is a few levels, a cycle or a blob is not. */
const MAX_DEPTH = 12;

const scrubDeep = (value: unknown, ctx: RedactionContext, depth: number): unknown => {
  if (typeof value === "string") return redact(value, ctx).text;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[cut: too deep]";
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, ctx, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_DEEP.has(key)) continue;
    out[redact(key, ctx).text] = scrubDeep(item, ctx, depth + 1);
  }
  return out;
};

const keptBreadcrumbs = (value: unknown, ctx: RedactionContext): unknown => {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (crumb) =>
        typeof crumb === "object" &&
        crumb !== null &&
        KEPT_BREADCRUMBS.test(String((crumb as { category?: unknown }).category ?? "")),
    )
    .map((crumb) => scrubDeep(crumb, ctx, 1));
};

/**
 * The event as it may leave: every string redacted, the fields above dropped, and the user reduced to the
 * anonymous install id when it has one. Idempotent, like redact(): the desktop runs it again over what its page and
 * runtime already scrubbed.
 */
export function scrubCrashEvent<E extends object>(event: E, ctx: RedactionContext = {}): E {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (DROPPED.has(key)) continue;
    if (KEPT.has(key)) out[key] = value;
    else if (key === "breadcrumbs") {
      const crumbs = keptBreadcrumbs(value, ctx);
      if (crumbs !== undefined) out[key] = crumbs;
    } else out[key] = scrubDeep(value, ctx, 1);
  }
  const id = (event as { user?: { id?: unknown } }).user?.id;
  if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) out.user = { id };
  return out as E;
}
