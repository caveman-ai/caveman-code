// What a chat's pane says about where its events come from, in one plain line (S4, S12): nothing while it is live;
// why it is static while it is not, and that it comes back by itself. Never a silent freeze.
import type { FeedState } from "./chat-feed.ts";
import type { WhereView } from "./chats-view.ts";

/**
 * `queued`: this window has a call queued in Cloud for the chat, waiting for its computer. `approval`: the chat's Mac
 * has not allowed this device yet (or said no): that, with the code to check, says why the view is Cloud's copy (K4).
 */
export function sourceLine(feed: FeedState | null, where: WhereView | undefined, queued = false, approval: { readonly title: string; readonly detail: string } | null = null): string | null {
  if (!feed) return null;
  if (approval) return `${approval.title}. ${approval.detail}`;
  switch (feed.kind) {
    case "loading":
    case "live":
      return null;
    case "reconnecting":
      return "Reconnecting";
    case "ended":
      return `${feed.message} Reconnecting`;
    case "copy":
      if (!where) return "Showing Caveman's copy. Reconnecting";
      // Something was sent: it is waking now, not something sending would do.
      if (where.kind === "cloud" && (where.asleep || !where.online) && queued) return `Waking ${where.name}`;
      if (where.kind === "cloud" && where.asleep) return "Asleep. Sending wakes it.";
      if (!where.online && where.kind !== "cloud") return `${where.name} is asleep. Sending continues this chat on a Cloud computer.`;
      if (!where.online) return `${where.name} is not answering. Sending wakes it.`;
      return `Can't reach ${where.name} right now. Showing Caveman's copy. Reconnecting`;
  }
}

/**
 * How long a reattach may take before the chat says "Reconnecting". A chat shown again reattaches (its effects stop
 * while hidden), which is a round trip, not news: said at once, the line mounted for a frame or two above the composer
 * and the whole chat jumped 30px up and back on every switch. A real outage still says so, a moment later.
 */
export const RECONNECT_GRACE_MS = 1500;

/** The feed state the line reads: a reconnect still inside its grace reads as live. */
export function heldFeed(feed: FeedState | null, overdue: boolean): FeedState | null {
  return feed?.kind === "reconnecting" && !overdue ? { kind: "live" } : feed;
}
