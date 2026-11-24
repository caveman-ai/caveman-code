// An approval prints its command once: on the code line of its card (components/ui/Choices.tsx CommandChip), docked
// over the box or lying in a list. What else would say it keeps quiet while the card is up. An ask whose own words are
// only the command again is asked plainly, "Run this command?" (select.ts shortAsk); and the work step for the very
// command that waits is left out of the transcript until the ask is answered (components/transcript/Parts.tsx
// RunParts). Plain functions with no store behind them, so the rule is tested without a screen.
import type { Chat, Item, Step } from "../board/model";

/** The question an approval asks when its own words would only say its command again. */
export const PLAIN_ASK = "Run this command?";

/** A command as two places write it, made comparable: no "$" before it, one space between words, no case. */
const flat = (text: string) =>
  text
    .trim()
    .replace(/^\$\s+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** The same, without the mark that ends a sentence: "echo smoke?" reads "echo smoke". */
const core = (text: string) => flat(text).replace(/[.?]+$/, "");

/** Words without the verb that leads them: "Ran pnpm test" and "Run pnpm test?" both read "pnpm test". */
const afterVerb = (text: string) => core(text).replace(/^(run|ran|running)\s+/, "");

/**
 * Whether words say a command and nothing more: the command itself ("echo smoke?"), or the command after "Run"
 * ("Run echo smoke?", a step's "Ran echo smoke"). Words that say what the command is for ("Run a staging migration?")
 * do not.
 */
export function saysOnly(words: string, command: string): boolean {
  const cmd = core(command);
  return cmd !== "" && (core(words) === cmd || afterVerb(words) === cmd);
}

/**
 * The work step an open approval would print a second time: the last step of the run right above the ask, when that
 * step is the very command the ask waits on. Null when nothing waits, when it waits on a question, and once you have
 * answered, heard by its computer or not (`pending`): the card is gone by then, so the step is the command's one
 * place again. An ask may also go without ever being answered (its computer went to sleep and took it back), which
 * needs nothing here: with no ask, no step is held back.
 */
export function askedStep(items: readonly Item[]): Step | null {
  const at = items.findLastIndex((item) => item.kind === "ask" && !item.answer && !item.pending);
  const ask = items[at];
  const above = items[at - 1];
  if (ask?.kind !== "ask" || !ask.command || above?.kind !== "work") return null;
  const last = above.steps.at(-1);
  return last && last.tool === "run" && saysOnly(last.text, ask.command) ? last : null;
}

/**
 * The work a chat did on the way to asking, as a card lists it over the ask: its runs' steps since your last message,
 * the latest last, without the step the ask's own command already says (`askedStep`), so a command reads once.
 */
export function stepsBeforeAsk(items: readonly Item[]): readonly Step[] {
  const held = askedStep(items);
  const steps: Step[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "you") break;
    if (item.kind === "work") steps.unshift(...item.steps.filter((step) => step !== held));
  }
  return steps;
}

/**
 * Every step held back right now, across the chats that wait on you: a part of the transcript that ends on one of
 * these leaves it out. By the step itself, never by its words, so the same command run earlier in the chat, or in
 * another chat, stays where it is.
 */
export function heldBack(chats: readonly Pick<Chat, "phase" | "items">[]): ReadonlySet<Step> {
  const held = new Set<Step>();
  for (const chat of chats) {
    const step = chat.phase === "needs" ? askedStep(chat.items) : null;
    if (step) held.add(step);
  }
  return held;
}
