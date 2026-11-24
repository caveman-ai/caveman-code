// What a provider's answer says about the connection a request went out on, read the way Cloud's data plane reads it
// (Caveman Cloud cloud/relay/engine/signals.go, checked there against the claude and codex binaries), so a Mac that
// attaches a connection's credential itself (macConnections.ts) says "used up" and "connect it again" for the same
// answers a Cloud computer does. Change one and change the other.

/** The longest reset a provider is believed about: a plan's longest window, with room. */
const MAX_WAIT_MS = 31 * 24 * 3600_000;

type Headers = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

const header = (headers: Headers, name: string): string => {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : (value as string | undefined)) ?? "";
};

/** The error body of Anthropic's API (`{type: "error", error}`) and of compact Codex backend (`{error}`). */
const errorOf = (
  body: string,
): {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly resets_at?: unknown;
  readonly resets_in_seconds?: unknown;
} => {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    return parsed !== null &&
      typeof parsed === "object" &&
      parsed.error !== null &&
      typeof parsed.error === "object"
      ? (parsed.error as object)
      : {};
  } catch {
    return {};
  }
};

/** A reset a provider can mean: after now and within MAX_WAIT_MS; undefined otherwise. */
const within = (untilMs: number, now: number): number | undefined =>
  Number.isFinite(untilMs) && untilMs > now && untilMs - now <= MAX_WAIT_MS ? untilMs : undefined;

/**
 * Whether an answer says the person's plan is used up, and until when (`until` undefined: the provider named no time).
 * Undefined: it does not say so.
 *
 * A Claude plan: 429 with `anthropic-ratelimit-unified-status: rejected` and no extra usage to fall back on, until
 * `anthropic-ratelimit-unified-reset` (epoch seconds), else `retry-after`. A compact plan: 429 whose error type is
 * `usage_limit_reached`, until `resets_at` (epoch seconds), else `resets_in_seconds` from now. A key's 429 is a rate
 * limit, never a plan.
 */
export function planUsedUp(
  kind: string,
  status: number,
  headers: Headers,
  body: string,
  now: number,
): { readonly until: number | undefined } | undefined {
  if (status !== 429) return undefined;
  if (kind === "claude_plan") {
    if (header(headers, "anthropic-ratelimit-unified-status") !== "rejected") return undefined;
    const overage = header(headers, "anthropic-ratelimit-unified-overage-status");
    if (overage === "allowed" || overage === "allowed_warning") return undefined;
    const reset = Number.parseFloat(header(headers, "anthropic-ratelimit-unified-reset").trim());
    const named = Number.isFinite(reset) ? within(Math.trunc(reset) * 1000, now) : undefined;
    if (named !== undefined) return { until: named };
    const after = Number.parseFloat(header(headers, "retry-after").trim());
    return { until: Number.isFinite(after) ? within(now + after * 1000, now) : undefined };
  }
  if (kind === "chatgpt_plan") {
    const error = errorOf(body);
    if (error.type !== "usage_limit_reached") return undefined;
    const at =
      typeof error.resets_at === "number"
        ? within(Math.trunc(error.resets_at) * 1000, now)
        : undefined;
    if (at !== undefined) return { until: at };
    return {
      until:
        typeof error.resets_in_seconds === "number"
          ? within(now + error.resets_in_seconds * 1000, now)
          : undefined,
    };
  }
  return undefined;
}

/** Anthropic's sentence for a plan token that was revoked or has expired: nothing else on a 401 or 403 is the token's fault. */
const CLAUDE_TOKEN_GONE = /^OAuth (?:access )?token has (?:been revoked|expired)\b/;

/**
 * Whether an answer says the credential that went with the request is no good. A compact sign-in: any 401 (Cloud
 * refreshes it). A Claude plan: Anthropic's own sentence, on a 401 or the 403 it also revokes with. A key or a
 * gateway: never, since a 401 on a key can be had with a header the caller chooses.
 */
export function credentialRefused(kind: string, status: number, body: string): boolean {
  if (kind === "api_key" || kind === "gateway") return false;
  if (kind === "claude_plan") {
    if (status !== 401 && status !== 403) return false;
    const message = errorOf(body).message;
    return typeof message === "string" && CLAUDE_TOKEN_GONE.test(message);
  }
  return status === 401;
}
