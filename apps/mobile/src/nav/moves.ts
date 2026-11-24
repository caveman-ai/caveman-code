// Where opening a chat or a Chief lands on the stack, decided from the stack alone (nav/ref.ts carries it out). Every
// way in goes through these (a link in a chat or a Chief's words, the floating row, the agents sheet, Details, the
// toast, Search, Settings), so the stack never holds the same screen twice in a row: a second tap in the same frame
// finds the first tap's screen already on top, a chat that sits right under the top is gone back to rather than pushed
// over itself, and a Chief already on the stack is gone back to, since two live copies of one Chief would each run
// their own call and clock over one shared draft.

/** A screen on the stack, as React Navigation keeps it. */
export interface Stop {
  name: string;
  key?: string;
  params?: object;
}

export interface Stack {
  index: number;
  routes: readonly Stop[];
}

export type Move =
  /** It is the screen on top already: nothing moves. */
  | { kind: "stay"; key?: string }
  /** It is under the top: back to it, this many screens popped. */
  | { kind: "back"; count: number; key?: string }
  /** These chats go on over the top in order, the last one on top (a subagent's parents go in under it). */
  | { kind: "push"; ids: readonly string[] }
  /** It takes the top screen's place, so Back still goes where it did. */
  | { kind: "replace" };

/** How it opens: over what's showing, or in its place (the sibling strip, Next, a Chief's menu). */
export type How = "push" | "inPlace";

/** A chat's or a Chief's id, from its params. */
export function idOf(stop: Stop | undefined): string | undefined {
  const id = (stop?.params as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

const is = (stop: Stop | undefined, name: "Thread" | "Chief", id: string) => stop?.name === name && idOf(stop) === id;

/**
 * Opening a chat. `family` runs from the top of its family down to the chat itself (its parents first, then it). Only
 * the screen right under the top is gone back to: a chat further down stays where it is, so a link never throws away
 * the screens you came through.
 */
export function chatMove(stack: Stack, family: readonly string[], how: How = "push"): Move {
  const id = family.at(-1);
  if (!id) return { kind: "stay" };
  const top = stack.routes[stack.index];
  const under = stack.routes[stack.index - 1];
  if (is(top, "Thread", id)) return { kind: "stay", key: top?.key };
  if (is(under, "Thread", id)) return { kind: "back", count: 1, key: under?.key };
  if (how === "inPlace") return { kind: "replace" };
  // A subagent opens over its parent, as if you had come through it: from the nearest relative in the run of chats on
  // top (the top itself, or a parent under the sibling you came through), the rest of the family goes on over the top,
  // so Back walks up the family and no relative goes on a second time. A Chief ends the run: a relative behind it is
  // another visit, and the chat goes on whole.
  let from = 0;
  for (let i = stack.index; i >= 0 && stack.routes[i]?.name === "Thread"; i--) {
    const at = family.indexOf(idOf(stack.routes[i]) ?? "");
    if (at < 0) continue;
    from = Math.min(at + 1, family.length - 1);
    break;
  }
  return { kind: "push", ids: family.slice(from) };
}

/** Opening a Chief: the one already on the stack if there is one (the nearest the top), matched by its id. */
export function chiefMove(stack: Stack, id: string, how: How = "push"): Move {
  for (let i = stack.index; i >= 0; i--) {
    const stop = stack.routes[i];
    if (!is(stop, "Chief", id)) continue;
    return i === stack.index ? { kind: "stay", key: stop?.key } : { kind: "back", count: stack.index - i, key: stop?.key };
  }
  return how === "inPlace" ? { kind: "replace" } : { kind: "push", ids: [id] };
}
