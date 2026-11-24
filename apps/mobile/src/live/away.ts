// A chat whose computer does not answer: what Cloud's routes the phone uses for it take. What the phone says of it is
// in words.ts.
//
// Whether a chat can run somewhere else is what Cloud lists of it before anyone asks (CONTRACT §11.1: `movable`, and
// the code of why not, worded in words.ts staysWords); Cloud's own check of a move stays the backstop. No import from
// the app, so the runtime's tests run it as it is.
import type { DeviceKey } from "@caveman-app/session-protocol/devices";

import type { CloudChat, MoveTo, PhoneCloud, QueuedCall, SavedPage, Signed } from "./cloud.ts";
import { staysWords } from "./words.ts";

/** Cloud's routes for chats whose computer does not answer, as source.ts uses them; link.ts makes it from cloud.ts and this phone's key. */
export interface Away {
  /** The person's open chats as Cloud lists them, on every computer. */
  chats(): Promise<ReadonlyArray<CloudChat>>;
  queue(
    sessionId: string,
    call: {
      readonly request_id: string;
      readonly method: "turn.submit" | "turn.interrupt" | "ask.respond";
      readonly params: Record<string, unknown>;
      readonly device?: Signed;
    },
  ): Promise<QueuedCall>;
  queued(sessionId: string, requestId: string): Promise<QueuedCall | null>;
  move(
    sessionId: string,
    move: { readonly request_id: string; readonly to: MoveTo; readonly device?: Signed },
  ): Promise<{ readonly pending: boolean; readonly computer_id?: string }>;
  /** What Cloud saved of a chat, a page after `after`; absent where there is none to read. */
  saved?(sessionId: string, epoch: number, after: number): Promise<SavedPage>;
  /** This phone's signature over a call or a move (a Mac runs only what its devices signed); undefined with no key to sign with. */
  sign(call: {
    readonly session_id: string;
    readonly request_id: string;
    readonly method: string;
    readonly params: unknown;
  }): Promise<Signed | undefined>;
}

/**
 * Cloud's routes as this phone: each call and move signed with the phone's own key, over its params as Cloud and the
 * runtime read them back (devices.ts queuedCallFields; a move is a call of "session.move" over `{to}`, as signMove).
 */
export const cloudAway = (
  cloud: Pick<PhoneCloud, "chats" | "queue" | "queued" | "move"> &
    Partial<Pick<PhoneCloud, "saved">>,
  device: () => Promise<DeviceKey>,
): Away => ({
  chats: () => cloud.chats(),
  queue: (sessionId, call) => cloud.queue(sessionId, call),
  queued: (sessionId, requestId) => cloud.queued(sessionId, requestId),
  move: (sessionId, move) => cloud.move(sessionId, move),
  ...(cloud.saved
    ? {
        saved: (sessionId: string, epoch: number, after: number) =>
          cloud.saved!(sessionId, epoch, after),
      }
    : {}),
  // Loaded when first signed with: the words below are read on a scripted morning too, which never pays for the key's code.
  sign: async (call) =>
    (
      await (
        await import("@caveman-app/session-protocol/devices")
      ).queuedCallFields(await device(), call)
    ).device,
});

/**
 * Why a chat cannot run somewhere else, by what Cloud lists of it: one it does not list has nothing saved to run
 * anywhere, and one it lists as staying says why by its code. Null when it can move, and when its runtime has not
 * said either way (one from before the fields): Cloud's move decides then. The words are words.ts's (`staysWords`);
 * this name is what the runtime's tests of the phone know it by.
 */
export const whyNotCloud = (chat: CloudChat | undefined): string | null =>
  !chat
    ? staysWords("not_saved")
    : chat.movable === false
      ? staysWords(chat.stays?.code, { engine: chat.engine, cloud: chat.where.kind === "cloud" })
      : null;

/**
 * What a call that waits in Cloud says by Cloud's word on it, naming its computer; null once it ran. The source's own
 * default (source.ts SourceWords), which the runtime's tests of the phone read. The app never shows it: a person reads
 * words.ts's `waitingLine`, which names no computer of Cloud's.
 */
export function queuedLine(
  call: Pick<QueuedCall, "status" | "waiting" | "error">,
  where: { readonly name: string; readonly cloud: boolean },
): string | null {
  const name = where.name || "its computer";
  switch (call.status) {
    case "queued":
      if (call.waiting?.reason === "not_movable")
        return call.waiting.detail ?? `Waiting for ${name}`;
      if (call.waiting?.reason === "laptop_asleep") return `Waiting for ${name}`;
      return where.cloud ? `Queued · waking ${name}` : `Queued · ${name}`;
    case "delivered":
      return `Delivered · ${name}`;
    case "expired":
      return "Not sent";
    case "failed":
      return call.error?.message || "Not sent";
    case "done":
      return null;
  }
}

/** Whether a queued call still waits to run. */
export const waits = (call: Pick<QueuedCall, "status">) =>
  call.status === "queued" || call.status === "delivered";
