// A pane switching chats keeps the chat on screen until the next one's history is in (upstream ChatView holds the last
// ready timeline the same way, `resolveThreadSwitchTimeline`): the switch happens in one frame, never through an empty
// pane or a loading line that shows for a moment. It holds only a little while (PaneFrame HOLD_MS); after that the
// next chat shows, with its loading line at once.

export interface Switch {
  /** The pane is on screen (not hidden with its tab, or behind the Chief: then there is nothing to hold). */
  readonly onScreen: boolean;
  /** The chat the pane is on now. */
  readonly current: string | null;
  /** The chat on screen. */
  readonly showing: string | null;
  /** `current`'s history is in. */
  readonly ready: boolean;
  /** The chat whose hold ran out. */
  readonly waited: string | null;
  /** The chats the pane keeps rendered: the one on screen must still be one of them to stay. */
  readonly kept: ReadonlyArray<string>;
}

/** Whether the pane keeps `showing` on screen while `current` loads. */
export function holds(s: Switch): boolean {
  return (
    s.onScreen &&
    s.current !== null &&
    s.showing !== null &&
    s.showing !== s.current &&
    !s.ready &&
    s.waited !== s.current &&
    s.kept.includes(s.showing)
  );
}
