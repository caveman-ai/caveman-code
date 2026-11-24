// The Changes tab's last fs.diff answer, for the range it asked about. The tab stays mounted across a scope switch,
// so an answer for another range (the scope before) is never shown under the new scope's name, while the new one
// loads or when it fails; only a failed Refresh of the same range keeps its files ("Couldn't refresh").

import { reuseUnchanged, type Diff } from "./parsePatch.ts";

export interface Answer {
  /** rangeOf the request it answers. */
  readonly range: string;
  readonly diff: Diff | null;
  readonly error: string | null;
}

/** The range fs.diff is asked for: everything against the base is "". */
export const rangeOf = (from: string | undefined, to: string | undefined): string =>
  to ? `${from ?? ""}..${to}` : "";

/** What the tab shows for `range`. */
export const answerFor = (answer: Answer, range: string): Answer =>
  answer.range === range ? answer : { range, diff: null, error: null };

/** fs.diff answered: unchanged files keep their objects, so only changed ones re-render. */
export function answered(prev: Answer, range: string, next: Diff): Answer {
  const shown = answerFor(prev, range);
  const diff = reuseUnchanged(shown.diff, next);
  return diff === shown.diff && shown.error === null ? shown : { range, diff, error: null };
}

export const failed = (prev: Answer, range: string, error: string): Answer => ({
  ...answerFor(prev, range),
  error,
});
