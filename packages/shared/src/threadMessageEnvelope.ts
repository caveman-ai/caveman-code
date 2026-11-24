/**
 * What a receiving model reads when another thread wrote the message: who sent
 * it, how to reply, and a body that cannot close or forge the envelope.
 */
export interface ThreadMessageEnvelopeInput {
  readonly senderTitle: string;
  readonly senderThreadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly inReplyTo?: string | undefined;
  readonly expectsReply?: boolean | undefined;
  /** The receiver has thread_send and may send to the sender's thread. */
  readonly canReply: boolean;
}

/** Escapes `<thread_message` and `</thread_message` so text cannot open or close an envelope. */
export function escapeThreadMessageTags(text: string): string {
  return text.replace(/<(\s*\/?\s*thread_message)/gi, "&lt;$1");
}

/**
 * At most `end` UTF-16 code units, never ending on half a surrogate pair:
 * providers reject a lone surrogate, so every later turn would fail.
 */
export function truncateCodeUnits(text: string, end: number): string {
  if (text.length <= end) return text;
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

export function threadMessageEnvelope(input: ThreadMessageEnvelopeInput): string {
  const inReplyTo = input.inReplyTo;
  // A reply never asks for a reply, so no exchange can loop by itself.
  const expectsReply = inReplyTo === undefined && input.expectsReply === true;
  const attributes = [
    `from="${escapeAttribute(input.senderTitle)}"`,
    `from_thread_id="${escapeAttribute(input.senderThreadId)}"`,
    `message_id="${escapeAttribute(input.messageId)}"`,
    ...(inReplyTo === undefined ? [] : [`in_reply_to="${escapeAttribute(inReplyTo)}"`]),
    ...(expectsReply ? ['expects_reply="true"'] : []),
  ].join(" ");
  const envelope = `<thread_message ${attributes}>\n${escapeThreadMessageTags(input.text)}\n</thread_message>`;
  if (inReplyTo !== undefined) return envelope;
  const send = `thread_send(threadId=${JSON.stringify(input.senderThreadId)}, inReplyTo=${JSON.stringify(input.messageId)})`;
  const line = expectsReply
    ? input.canReply
      ? `Reply with ${send}, or just answer: your final message this turn is sent back.`
      : "Your final message this turn is sent back."
    : input.canReply
      ? `Reply only if needed: ${send}.`
      : "";
  return `${envelope}\nFrom a teammate agent working for the same user.${line === "" ? "" : ` ${line}`}`;
}
