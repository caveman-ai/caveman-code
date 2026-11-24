// An answer to what an agent asks, from wherever you gave it (a summary card in the Needs you list, the Queue, a
// Chief's deck, the thread's dock): it happens on the board at once, so the ask leaves every list, deck and dock in
// the same moment and nothing lingers where you tapped ("the need you cards need to disappear
// after i click them"). The way back is the shell's toast, "Allowed pnpm db:migrate · Undo", for UNDO_MS; the engine
// hears the answer only once that has passed (board/script.ts respond's `hold`), so Undo leaves no trace and puts the
// card back where it was (asks keep their place by when they asked). A second answer to the same ask inside those
// seconds does nothing, and a control that just moved under the thumb (a card arriving, a list closing up) is deaf for
// ARM_MS, so the second tap of a double tap never answers the next ask.
import type { Chat } from "../board/model";
import * as script from "../board/script";
import type { Reply } from "../board/script";
import type { IconName } from "../components/Icon";
import { ARM_MS } from "../components/ui/Choices";
import { notice } from "../shell/ui";
import { store } from "../store/store";

export type { Reply };
export { ARM_MS };

/** How long an answer can be taken back: the toast's Undo, then the engine hears it. */
export const UNDO_MS = 4000;
/** The engine hears it a beat after the Undo goes, so a tap on Undo in its last moment still wins. */
const HEARD_AFTER_MS = UNDO_MS + 80;

interface Held {
  /** The chat as it was when it asked: Undo puts it back. */
  asked: Chat;
  reply: Reply;
  timer: ReturnType<typeof setTimeout>;
}

const held = new Map<string, Held>();

/** A command in a few words, its flags left out ("pnpm db:migrate --env staging" is "pnpm db:migrate"). */
export function gist(command: string | undefined): string {
  if (!command) return "it";
  const words: string[] = [];
  let skip = false;
  for (const word of command.split(/\s+/)) {
    if (skip) skip = false;
    else if (word.startsWith("--") && !word.includes("=")) skip = true;
    else if (!word.startsWith("-")) words.push(word);
  }
  return words.slice(0, 3).join(" ") || command;
}

/** Your own words, cut at a word to fit the toast. */
const cut = (text: string, max = 30) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
};

/** What the toast says an answer did, and its glyph: "Allowed pnpm db:migrate", "Told it: Remove it". */
export function saidOf(asked: Chat, reply: Reply): { text: string; icon: IconName } {
  const need = asked.need;
  const command = need?.kind === "approval" ? need.command : asked.ask;
  if (need?.kind !== "question" && command) {
    if (reply.kind === "allow") return { text: `Allowed ${gist(command)}`, icon: "check" };
    const instead = reply.kind === "deny" ? reply.instead : reply.kind === "told" ? reply.text : reply.kind === "option" ? reply.option.label : undefined;
    return instead ? { text: `Told it: ${cut(instead)}`, icon: "comment" } : { text: `Denied ${gist(command)}`, icon: "close" };
  }
  const options = need?.kind === "question" ? need.options : [];
  const told =
    reply.kind === "option"
      ? reply.option.label
      : reply.kind === "told"
        ? reply.text
        : reply.kind === "deny"
          ? (reply.instead ?? "Leave it")
          : ((options.find((o) => o.recommended) ?? options[0])?.label ?? "Go ahead");
  return { text: `Told it: ${cut(told)}`, icon: "comment" };
}

/**
 * Answers what `asker` asks: at once on the board, behind the toast's Undo for UNDO_MS, then heard. Returns false when
 * it isn't asking any more, or an answer to it is already in hand (a second tap).
 */
export function act(asker: string, reply: Reply): boolean {
  if (held.has(asker)) return false;
  const chat = store.get().board.chats.find((c) => c.id === asker);
  if (!chat || chat.phase !== "needs") return false;
  const asked = script.respond(asker, reply, HEARD_AFTER_MS);
  if (!asked) return false;
  moved();
  const timer = setTimeout(() => {
    held.delete(asker);
  }, UNDO_MS);
  held.set(asker, { asked, reply, timer });
  const given = saidOf(asked, reply);
  // An answer its computer cannot hear yet is queued, and the toast says so too: never "Allowed" for what has not been.
  const queued = store.get().board.chats.find((c) => c.id === asker)?.wait?.words.split(" · ")[0];
  const said = queued ? { ...given, text: given.text.replace(/^(Allowed|Denied)\b/, queued) } : given;
  // The verb, then what it was about: in the bar row's narrow slot the two stand as two lines, never a cut word.
  const split = /^(Allowed|Denied|Allow queued|Deny queued|Told it:)\s+(.+)$/.exec(said.text);
  notice({ id: `answer-${asker}-${Date.now()}`, text: split ? split[1]! : said.text, detail: split?.[2], tone: "info", icon: said.icon, ms: UNDO_MS, action: { label: "Undo", onPress: () => undo(asker) } });
  return true;
}

/** Deny an approval (a question hears "leave it"). */
export const no = (asker: string, instead?: string) => act(asker, { kind: "deny", instead });

/** Takes an answer back while its Undo holds: the ask is back as it was, in its place. */
export function undo(asker: string) {
  const was = held.get(asker);
  if (!was) return;
  clearTimeout(was.timer);
  held.delete(asker);
  script.takeBack(was.asked);
  moved();
}

// ---------------------------------------------------------------- arming

let movedAt = 0;

/** Asks came, went or moved: what sits under the thumb may be another ask now. */
export function moved() {
  movedAt = Date.now();
}

/** Whether a tap on an answer is meant: not within ARM_MS of `since` (the control appearing) or of the asks moving. */
export const armed = (since: number) => Date.now() - Math.max(since, movedAt) >= ARM_MS;
