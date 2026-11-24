// A user-role message the runtime wrote for the agent, not the person (message.done `generated`): a builder's result,
// its builders' one result, the word to carry on after a plan's reset. A chat draws it as one quiet row, never as the
// person's own bubble and never with the instructions the agent was given: `generated.shown`, or with
// `builders_result` the result row ("28 of 30 merged · 2 left out · PR #128"). History written before that field has
// the runtime's bracket lines instead ([Builder "…" finished its turn …], [Caveman Code] Your builders have
// finished.), read here into the same rows so they are never shown to a person.
import type { BuildersResult } from "@caveman-app/session-protocol";
import { CONTINUED_LINE, isContinueNote } from "./sleep-stop.ts";

export interface BuildersResultView {
  readonly total: number;
  readonly merged: number;
  /** Builders whose work is not in. History before builders_result names none, only how many (`leftOutCount`). */
  readonly leftOut: ReadonlyArray<{
    readonly workspaceId?: string;
    readonly title: string;
    readonly why: string;
  }>;
  readonly leftOutCount: number;
  readonly pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly url: string;
    readonly repo?: string;
  }>;
  /** No pull request opened, and why, in one sentence of ours. */
  readonly problem?: string;
}

export interface GeneratedView {
  /** The one line a person reads. */
  readonly line: string;
  /** The chat that wrote it, when the line does not already name it: said before the line, and opens it. */
  readonly sender?: { readonly title: string; readonly workspaceId?: string };
  /** A lead's builders came together: the row is their result. */
  readonly result?: BuildersResultView;
  /** Read from history written before `generated` (a bracket line). */
  readonly legacy?: true;
  /** Another chat (a builder) wrote it: the row wears the builders' mark. */
  readonly fromChat?: true;
}

type From = { readonly workspace_id?: string; readonly title: string };

const resultView = (r: BuildersResult): BuildersResultView => ({
  total: r.total,
  merged: r.merged,
  leftOut: r.left_out.map((b) => ({
    ...(b.workspace_id ? { workspaceId: b.workspace_id } : {}),
    title: b.title,
    why: b.why,
  })),
  leftOutCount: r.left_out.length,
  pullRequests: r.pull_requests.map((p) => ({
    number: p.number,
    url: p.url,
    ...(p.repo ? { repo: p.repo } : {}),
  })),
  ...(r.problem ? { problem: r.problem } : {}),
});

/** "28 of 30 merged · 2 left out": the result row's words before its pull requests. */
export function resultHead(
  r: Pick<BuildersResultView, "total" | "merged" | "leftOutCount">,
): string {
  return `${r.merged} of ${r.total} merged${r.leftOutCount > 0 ? ` · ${r.leftOutCount} left out` : ""}`;
}

/** "PR #128", "PR #128, #57", "no pull request". */
export function resultPrs(r: Pick<BuildersResultView, "pullRequests">): string {
  return r.pullRequests.length === 0
    ? "no pull request"
    : `PR ${r.pullRequests.map((p) => `#${p.number}`).join(", ")}`;
}

/** The whole row as one string: "28 of 30 merged · 2 left out · PR #128". */
export const resultLine = (r: BuildersResultView): string => `${resultHead(r)} · ${resultPrs(r)}`;

const BUILDER_LINE = /^\[Builder "([^"\n]+)" (finished its turn|was stopped|failed)\b/;
const SUMMARY_LINE = /^\[Caveman Code\] Your builders have finished\./;
const VERB = {
  "finished its turn": "finished",
  "was stopped": "stopped",
  failed: "failed",
} as const;

/**
 * A message from history written before `generated` that the runtime wrote: a builder's result ("<title> finished",
 * "stopped", "failed") or its builders' summary (their count merged and the pull request's number when it names
 * them, else "Agents finished"). Null for anything else, a person's own words included.
 */
export function legacyGenerated(text: string): GeneratedView | null {
  const t = text.trimStart();
  // The follow-up Continue sends after a sleep stop (state/sleep-stop.ts): a quiet row, not the person's bubble.
  if (isContinueNote(t)) return { line: CONTINUED_LINE };
  const builder = BUILDER_LINE.exec(t);
  if (builder)
    return { line: `${builder[1]} ${VERB[builder[2] as keyof typeof VERB]}`, legacy: true };
  if (!SUMMARY_LINE.test(t)) return null;
  const counts = /(\d+) of (\d+)\b[^.\n]*?\bmerged\b/.exec(t);
  if (!counts) return { line: "Agents finished", legacy: true };
  const merged = Number(counts[1]);
  const total = Number(counts[2]);
  const pullRequests = [...t.matchAll(/https:\/\/[^\s)]+\/pull\/(\d+)/g)].map((m) => ({
    number: Number(m[1]),
    url: m[0],
  }));
  const result: BuildersResultView = {
    total,
    merged,
    leftOut: [],
    leftOutCount: Math.max(0, total - merged),
    pullRequests,
  };
  return { line: resultLine(result), result, legacy: true };
}

/**
 * How a user-role message.done reads when the runtime wrote it: from `generated` (with `builders_result`, the result
 * row), else from a bracket line of older history. Null: the person's own message (or another chat's agent's, which
 * keeps its own header), drawn as it always was.
 */
export function generatedOf(p: {
  readonly text: string;
  readonly from?: From | undefined;
  readonly generated?: { readonly shown: string } | undefined;
  readonly builders_result?: BuildersResult | undefined;
}): GeneratedView | null {
  if (p.generated) {
    if (p.builders_result) {
      const result = resultView(p.builders_result);
      return { line: resultLine(result), result };
    }
    const shown = p.generated.shown.trim() || "Agent finished";
    const named = p.from && shown.toLowerCase().includes(p.from.title.toLowerCase());
    return {
      line: shown,
      ...(p.from ? { fromChat: true as const } : {}),
      ...(p.from && !named
        ? {
            sender: {
              title: p.from.title,
              ...(p.from.workspace_id ? { workspaceId: p.from.workspace_id } : {}),
            },
          }
        : {}),
    };
  }
  const legacy = legacyGenerated(p.text);
  if (!legacy) return null;
  // The bracket line names its builder already; the from header would say it twice.
  return legacy;
}
