// A lead's builders, in the desktop's words: what became of each (Workspace.builder, said by the runtime its lead
// runs on) and the one result once their work came together (message.done `builders_result`). The phone reads both
// from the runtime and words them here, as apps/web words them (panels/agents/states.ts builderRow, state/generated.ts).
//
// Pure, with only types from the protocol, so builders.test.ts pins every word and the runtime's tests can read it.
import type { BuilderState, BuildersResult } from "@caveman-app/session-protocol";

/** A builder's row: its one state in words, and the one colour that state has. */
export interface BuilderWords {
  readonly words: string;
  /** Grey for a plain state, amber for one that waits or was left out, red for one that failed. */
  readonly tone: "quiet" | "warn" | "bad";
  /** At work: its row may say what it is doing right now in the state's place. */
  readonly working: boolean;
}

/** When a paused builder's plan resets, in the person's own clock: "11:08 PM" today, "Sat 7:44 AM" after. */
function resetTime(until: string | undefined, now: number, timeZone?: string): string | undefined {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at) || at <= now) return undefined;
  const say = (ms: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), ...options })
      .format(ms)
      .replace(/\s/g, " ");
  const day = (ms: number) => say(ms, { year: "numeric", month: "short", day: "numeric" });
  const time = say(at, { hour: "numeric", minute: "2-digit" });
  return day(at) === day(now) ? time : `${say(at, { weekday: "short" })} ${time}`;
}

/**
 * What became of a builder: "Working", "Done", "Merged", "Left out: conflicts in a.ts", "Paused until 11:08 PM"
 * ("Paused" when its plan named no time), "Failed: its agent stopped". A row reads this and nothing else.
 */
export function builderWords(builder: BuilderState, now: number, timeZone?: string): BuilderWords {
  const why = builder.why?.trim();
  switch (builder.state) {
    case "working":
      return { words: "Working", tone: "quiet", working: true };
    case "done":
      return { words: "Done", tone: "quiet", working: false };
    case "merged":
      return { words: "Merged", tone: "quiet", working: false };
    case "left_out":
      return { words: why ? `Left out: ${why}` : "Left out", tone: "warn", working: false };
    case "paused": {
      const until = resetTime(builder.until, now, timeZone);
      return { words: until ? `Paused until ${until}` : "Paused", tone: "warn", working: false };
    }
    case "failed":
      return { words: why ? `Failed: ${why}` : "Failed", tone: "bad", working: false };
  }
}

/** "28 of 30 merged · 2 left out · PR #128": a lead's builders' one result, with "no pull request" where none was opened. */
export function resultLine(
  result: Pick<BuildersResult, "total" | "merged" | "left_out" | "pull_requests">,
): string {
  const left = result.left_out.length;
  const prs =
    result.pull_requests.length === 0
      ? "no pull request"
      : `PR ${result.pull_requests.map((p) => `#${p.number}`).join(", ")}`;
  return `${result.merged} of ${result.total} merged${left > 0 ? ` · ${left} left out` : ""} · ${prs}`;
}

const BUILDER_LINE = /^\[Builder "([^"\n]+)" (finished its turn|was stopped|failed)\b/;
const SUMMARY_LINE = /^\[Caveman Code\] Your builders have finished\./;
const VERB = {
  "finished its turn": "finished",
  "was stopped": "stopped",
  failed: "failed",
} as const;

/** A message the runtime wrote for the agent, read from history written before it said so (its bracket lines). */
function legacyLine(text: string): string | null {
  const said = text.trimStart();
  const builder = BUILDER_LINE.exec(said);
  if (builder) return `${builder[1]} ${VERB[builder[2] as keyof typeof VERB]}`;
  if (!SUMMARY_LINE.test(said)) return null;
  const counted = /(\d+) of (\d+)\b[^.\n]*?\bmerged\b/.exec(said);
  if (!counted) return "Agents finished";
  const merged = Number(counted[1]);
  const total = Number(counted[2]);
  const numbers = [...said.matchAll(/https:\/\/[^\s)]+\/pull\/(\d+)/g)].map((m) => ({
    number: Number(m[1]),
  }));
  const left = Math.max(0, total - merged);
  return `${merged} of ${total} merged${left > 0 ? ` · ${left} left out` : ""} · ${numbers.length === 0 ? "no pull request" : `PR ${numbers.map((p) => `#${p.number}`).join(", ")}`}`;
}

/**
 * The one line a person reads of a user-role message the runtime wrote for the agent, not the person: a builder's
 * result ("Port the settings page finished"), its builders' one result, the word to carry on after a plan's reset.
 * Never the instructions the agent was given, and never as the person's own message. Null for a message that is the
 * person's own, or another chat's agent's.
 */
export function generatedLine(message: {
  readonly text: string;
  readonly from?: { readonly title: string } | undefined;
  readonly generated?: { readonly shown: string } | undefined;
  readonly builders_result?: BuildersResult | undefined;
}): string | null {
  if (!message.generated) return legacyLine(message.text);
  if (message.builders_result) {
    const result = message.builders_result;
    // No pull request was opened: why, in the runtime's one sentence for a person.
    return result.problem ? `${resultLine(result)}\n\n${result.problem}` : resultLine(result);
  }
  const shown = message.generated.shown.trim() || "Agent finished";
  const named = message.from && shown.toLowerCase().includes(message.from.title.toLowerCase());
  return message.from && !named ? `${message.from.title}: ${shown}` : shown;
}
