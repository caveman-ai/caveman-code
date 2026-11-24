// A chat New chat just started, handed to the chat's pane: its first message, as the new chat already showed it
// under the docked box. The pane draws it, and its working line, where they will stand until the chat's history is in,
// so the new chat becomes the chat with nothing on screen moving (upstream draft thread becoming the thread).
import type { TranscriptItem } from "./transcript-model.ts";

export type FirstMessage = Extract<TranscriptItem, { kind: "user" }>;

const started = new Map<string, FirstMessage>();

/** New chat made `workspaceId` with this first message: its pane shows it until the history is in. */
export function handOff(workspaceId: string, first: FirstMessage): void {
  started.set(workspaceId, first);
}

/** The first message New chat handed this chat, if its history has not come in yet. */
export function handedOff(workspaceId: string): FirstMessage | undefined {
  return started.get(workspaceId);
}

/** The chat's history is in: what was handed over is history too. */
export function dropHandOff(workspaceId: string): void {
  started.delete(workspaceId);
}

/** The first message as the chat will draw it, sent just now. */
export function firstMessage(text: string, attachments: FirstMessage["attachments"]): FirstMessage {
  return {
    kind: "user",
    id: "new-chat-first",
    text,
    at: new Date().toISOString(),
    delivery: "message",
    pending: true,
    ...(attachments?.length ? { attachments } : {}),
  };
}
