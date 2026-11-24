// A chat that did not start in Cloud, in one sentence a person can use: "The chat didn't start: <our sentence>."
// with Try again and Discard beside it. What failed underneath (a driver's words, git's, a status code) is never the
// sentence: it waits behind Details. Shared by the page a start waits on (CloudStart.tsx) and the Cloud side of it
// (shell/PendingCloudStart.tsx).
import { refusalView } from "../state/cloud.ts";

/** What is said when nothing better is known. */
export const COULD_NOT_START = "Cloud couldn't start it.";

/** One of our own sentences: short, on one line, starting like a sentence and carrying no machine's words. */
const reads = (text: string) =>
  /^[A-Z][^\n]{0,159}$/.test(text) &&
  !/(\bat \/|\/[\w.-]+\/[\w.-]+\/|Error:|E[A-Z]{4,}\b|[{}[\]]|\b\d{3}\b|https?:\/\/)/.test(text);

export interface StartFailure {
  /** "The chat didn't start: Cloud is busy. Trying again." */
  readonly line: string;
  /** What failed underneath, when the line does not already say it: shown on a click. */
  readonly detail?: string;
}

/** `what`: "The chat", or "The chat on acme/api" where the page shows no project. */
export function startFailure(error: unknown, what = "The chat"): StartFailure {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  // Cloud's own refusals (a limit, a plan with nothing left) are written for the person: said as they are.
  const cloud = typeof error === "string" ? null : refusalView(error);
  const sentence =
    cloud !== null && (cloud.billing || cloud.computers) ? cloud.text : reads(raw) ? raw : null;
  const said = sentence ?? COULD_NOT_START;
  return {
    line: `${what} didn't start: ${/[.!?…]$/.test(said) ? said : `${said}.`}`,
    ...(sentence === null && raw !== "" ? { detail: raw } : {}),
  };
}
