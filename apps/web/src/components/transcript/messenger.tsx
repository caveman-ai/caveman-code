// The Chief's conversation as a messenger draws it ("more like a real messaging agent",
// for clean mobile navigation; docs/chief.md "Its screen"): its replies as a chat's are, plain words at the left (the
// no bubbles for the agent writing back), its name over each run of them and its character beside
// the run's last row, and while it works, three dots where its next words will be. Only the Chief's transcript turns it
// on (Transcript `messenger`).
import type { ChiefAvatar } from "@caveman-app/session-protocol";
import { createContext, type ReactNode } from "react";
import type { ChiefReaction } from "../../state/transcript-model.ts";
import { ChiefSprite } from "../ChiefSprite.tsx";

/** Whether the rows under it are a messenger's (the Chief's conversation). */
export const MessengerContext = createContext(false);

/** Its reactions on your messages (SessionView.reactions, by message id) and its name, for your bubbles. */
export const MessengerReactions = createContext<{
  readonly by: ReadonlyMap<string, ChiefReaction>;
  readonly name: string | null;
} | null>(null);

/**
 * Its reaction on one of your bubbles, as iMessage draws a tapback: a 20px round chip over the bubble's top-left
 * corner, in the deck's grey with a ring of the page's colour, so it reads apart from your ink. It overlaps the
 * corner, so nothing in the conversation moves; a screen reader hears who reacted with what.
 */
export function ReactionBadge({ emoji, name }: { emoji: ChiefReaction; name: string | null }) {
  return (
    <span
      role="img"
      aria-label={name ? `${name} reacted ${emoji}` : `Reacted ${emoji}`}
      data-reaction={emoji}
      className="pointer-events-none absolute -left-2.5 -top-2.5 grid size-5 select-none place-items-center rounded-full bg-secondary text-[12px] leading-none ring-2 ring-background"
    >
      {emoji}
    </span>
  );
}

/** Your bubble's tail, curling out of its bottom-right corner (styles.css `.bubble-tail`). */
export function BubbleTail() {
  return <span aria-hidden className="bubble-tail" />;
}

/** Its name over a run of its rows, where a messenger names who is talking. */
export function MessengerName({ name }: { name: string }) {
  return (
    <p data-messenger-name="" className="mb-1.5 ml-1 text-[12px] text-muted-foreground">
      {name}
    </p>
  );
}

/**
 * A row of the Chief's side: its content in the column its words start on, and in the gutter left of it, at the run's
 * last row, its character, feet on the row's bottom edge.
 */
export function MessengerRow({
  avatar,
  end,
  working,
  children,
}: {
  avatar: ChiefAvatar | null;
  end: boolean;
  working: boolean;
  children: ReactNode;
}) {
  return (
    <div data-messenger-end={end || undefined} className="flex items-end gap-2.5">
      <span
        aria-hidden
        data-messenger-avatar={end || undefined}
        className="flex w-7 shrink-0 justify-center pb-1"
      >
        {end ? (
          <ChiefSprite avatar={avatar} pose={working ? "working" : "idle"} animate={working} />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** While it works: three dots where its next words will be, and that it is working. */
export function MessengerTyping({ label = "Working" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex h-9 items-center gap-2.5 text-[13.5px] text-muted-foreground"
    >
      <span aria-hidden className="messenger-dots flex items-center gap-[3px]">
        <span />
        <span />
        <span />
      </span>
      <span className="lucy-shimmer">{label}</span>
    </div>
  );
}
