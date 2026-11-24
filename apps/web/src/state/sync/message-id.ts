// Ids a runtime derives, told here before it has: what a device shows meanwhile is then what the runtime's own
// takes the place of. Each is the runtime's own sum (packages/runtime session-protocol/store.ts); the two are pinned
// to one value on both sides (message-id.test.ts, the runtime's store.test.ts).
const sha256 = async (text: string): Promise<Uint8Array | null> => (globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))) : null);
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The runtime's item id for the message a turn.submit sends (submittedMessageId): its message.done replaces whatever
 * the device shows meanwhile (an echo, a queued send). A chat's first message, sent with its start, is the request
 * `<start's request id>:task`.
 */
export async function submittedMessageId(sessionId: string, requestId: string): Promise<string | null> {
  const digest = await sha256(`${sessionId}\0${requestId}`);
  return digest && `sp-msg:${hex(digest).slice(0, 24)}`;
}

/**
 * The workspace id a Cloud computer's runtime gives the chat Cloud placed as workspace `placed` (placedWorkspaceId,
 * CONTRACT §6.8): the route of a chat started in Cloud, from Send. Null where the browser has no WebCrypto (a page
 * not served over https): the start then waits for its computer's own answer.
 */
export async function placedWorkspaceId(placed: string): Promise<string | null> {
  const digest = await sha256(`caveman:placed-workspace\0${placed.toLowerCase()}`);
  if (!digest) return null;
  const sum = digest.slice(0, 16);
  sum[6] = (sum[6]! & 0x0f) | 0x40;
  sum[8] = (sum[8]! & 0x3f) | 0x80;
  const h = hex(sum);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
