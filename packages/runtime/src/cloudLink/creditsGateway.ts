// What every call to Cloud's gateway on a Caveman credits key shares (web search, web/credits.ts; calls and dictation,
// chief/voice/deepgram.ts): the headers it is asked with and the error body it answers with. The Caveman engine's
// credits models send the same client header (provider-caveman credits.ts); without it the broker refuses plan usage.
import { RUNTIME_VERSION } from "../runtimeVersion.ts";

/** The `x-caveman-client` value: this build of Caveman Code. */
export const CREDITS_CLIENT = `caveman-code/${RUNTIME_VERSION}`;

/** A JSON request on a credits key, for the chat `session` names (Cloud's `x-caveman-session`) when there is one. */
export const creditsHeaders = (creditsKey: string, session?: string): Record<string, string> => ({
  Authorization: `Bearer ${creditsKey}`,
  "x-caveman-client": CREDITS_CLIENT,
  ...(session === undefined ? {} : { "x-caveman-session": session }),
  "Content-Type": "application/json",
  Accept: "application/json",
});

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The gateway's error body (`{ error: { code, message, details } }`): its code, its words (short) and details. */
export const gatewayFailure = async (response: { text(): Promise<string> }) => {
  const text = await response.text().catch(() => "");
  try {
    const error = record(record(JSON.parse(text)).error);
    const words = (str(error.message) || str(error.code)).replace(/\s+/g, " ").slice(0, 200);
    return { code: str(error.code), words, details: record(error.details) };
  } catch {
    // Not JSON: the status says enough.
    return {
      code: "",
      words: text.replace(/\s+/g, " ").slice(0, 200),
      details: {} as Record<string, unknown>,
    };
  }
};

/** `on 1 November` from Cloud's `resets_at`; nothing when it sent none (or not a date). */
export const resetsOn = (value: unknown) => {
  const at = typeof value === "string" ? new Date(value) : undefined;
  if (at === undefined || Number.isNaN(at.getTime())) return undefined;
  return `on ${at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`;
};
