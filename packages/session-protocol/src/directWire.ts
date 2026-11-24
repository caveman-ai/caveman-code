// How Session Protocol frames ride a WebRTC data channel between a device and a laptop's runtime (DESIGN S14). Both
// ends speak this: the device's client (direct.ts) and the runtime (packages/runtime cloudLink/direct.ts).
//
// - A text message is one whole frame, as on a WebSocket. Almost every frame goes this way.
// - A frame too large for one SCTP message goes as binary fragments of its UTF-8: byte 0 is MORE (1) or LAST (2), the
//   rest a slice. The channel is reliable and ordered, so fragments arrive whole and in order.
// - PING (3) and PONG (4), with an 8-byte payload echoed back, are the channel's own liveness check and round-trip
//   time; neither reaches Session Protocol.

/** The one data channel a device opens; the runtime closes any other. */
export const DIRECT_CHANNEL_LABEL = "caveman.session.v1";
/** The largest message either end sends: every WebRTC stack takes 64 KiB, and SDP may say less. */
export const DIRECT_MAX_MESSAGE = 64 * 1024;
/** The longest frame reassembled: past it the channel is broken (the relay's own cap is 24 MiB). */
export const DIRECT_MAX_FRAME = 32 * 1024 * 1024;

const MORE = 1;
const LAST = 2;
const PING = 3;
const PONG = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One frame as the messages to send for it: itself when it fits, else its UTF-8 in fragments. `max` is the
 * channel's largest message (SDP's max-message-size), capped at DIRECT_MAX_MESSAGE.
 */
export function directMessages(frame: string, max = DIRECT_MAX_MESSAGE): Array<string | Uint8Array> {
  const limit = Math.max(1024, Math.min(max, DIRECT_MAX_MESSAGE));
  // A UTF-16 unit is at most 3 bytes of UTF-8: a short frame needs no encoding to know it fits.
  if (frame.length * 3 <= limit) return [frame];
  const bytes = encoder.encode(frame);
  if (bytes.length <= limit) return [frame];
  const out: Uint8Array[] = [];
  const step = limit - 1;
  for (let at = 0; at < bytes.length; at += step) {
    const end = Math.min(at + step, bytes.length);
    const part = new Uint8Array(end - at + 1);
    part[0] = end === bytes.length ? LAST : MORE;
    part.set(bytes.subarray(at, end), 1);
    out.push(part);
  }
  return out;
}

export const directPing = (stamp: number): Uint8Array => stampMessage(PING, stamp);
const stampMessage = (kind: number, stamp: number) => {
  const out = new Uint8Array(9);
  out[0] = kind;
  new DataView(out.buffer).setFloat64(1, stamp);
  return out;
};

export type DirectInput =
  /** A whole frame for Session Protocol. */
  | { readonly kind: "frame"; readonly text: string }
  /** The other end pinged: send `reply` back. */
  | { readonly kind: "ping"; readonly reply: Uint8Array }
  /** The answer to our ping stamped `stamp`. */
  | { readonly kind: "pong"; readonly stamp: number }
  /** A fragment of a frame still arriving. */
  | { readonly kind: "partial" };

/** Reads one channel's messages back into frames. Throws on a message no end of this wire would send. */
export class DirectReader {
  private parts: Uint8Array[] = [];
  private size = 0;

  read(data: string | ArrayBuffer | ArrayBufferView): DirectInput {
    if (typeof data === "string") {
      if (this.parts.length > 0) throw new Error("a text frame arrived inside a fragmented one");
      return { kind: "frame", text: data };
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const kind = bytes[0];
    if (kind === PING && bytes.length === 9) {
      const reply = bytes.slice();
      reply[0] = PONG;
      return { kind: "ping", reply };
    }
    if (kind === PONG && bytes.length === 9) return { kind: "pong", stamp: new DataView(bytes.buffer, bytes.byteOffset, 9).getFloat64(1) };
    if (kind !== MORE && kind !== LAST) throw new Error(`unknown direct message ${kind ?? "(empty)"}`);
    this.size += bytes.length - 1;
    if (this.size > DIRECT_MAX_FRAME) throw new Error("a direct frame is over the size limit");
    this.parts.push(bytes.subarray(1));
    if (kind === MORE) return { kind: "partial" };
    const whole = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      whole.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.size = 0;
    return { kind: "frame", text: decoder.decode(whole) };
  }
}
