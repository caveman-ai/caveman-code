// The device's side of device approval (devices.ts, DESIGN S13) as a client Handshake (client.ts): on a laptop
// runtime's device.challenge it signs and says hello, waits while the Mac asks its person, and once allowed encrypts
// every frame the client sends on that connection and decrypts every frame the Mac sends back. Transport-neutral: it talks only through the HandshakeLink, so it
// runs the same over the relay's WebSocket or a WebRTC data channel (ConnectOptions.socket).
import { HandshakeRefused, SessionProtocolError, type Handshake, type HandshakeLink } from "./client.ts";
import { DEVICE_REQUEST_TTL_MS, channelKeys, deviceCode, ephemeralKey, helloPayload, normalizePairingCode, openFrame, pairProof, sealFrame, toBase64url, verifyPairAnswer, type Bytes, type DeviceKey } from "./devices.ts";
import { ErrorCodes, type DeviceStatus, type NotificationParams } from "./protocol.ts";

export type DeviceStatusParams = NotificationParams<"device.status">;

/** What a runtime is, as the device knows it from Cloud's list: a laptop challenges; a Cloud computer never does. */
export type RuntimeKind = "laptop" | "cloud";

/** How long to wait for a challenge from a laptop runtime before speaking to it as an older one (it checks nothing). */
export const CHALLENGE_WAIT_MS = 10_000;
/**
 * The same for a runtime of unknown kind: short at first, so a Cloud computer is barely delayed, and doubled (to
 * CHALLENGE_WAIT_MS) each time it passes with none, so a slow laptop's late challenge is waited for on the next socket
 * (the client drops a socket whose runtime challenges after the handshake gave up).
 */
export const UNKNOWN_CHALLENGE_WAIT_MS = 1_500;

export interface DeviceHandshakeOptions {
  /** This device's key (made on first use). */
  readonly device: DeviceKey | (() => Promise<DeviceKey>);
  /** The runtime's kind, asked on every socket; undefined when the device does not know it yet. */
  readonly kind?: () => RuntimeKind | undefined;
  /**
   * What the runtime said about this device: the waiting screen and Settings show it. Its `code` is always this
   * device's own (deviceCode of its key), never one the runtime's answer carries: the relay carries that answer, and
   * could put there the code of a key it swapped in, which the Mac's screen then shows too (A-1). `role` "mac" comes
   * only after a hello that proved a pairing code, once the Mac's first sealed frame proves under that same code that
   * its screen took this Mac as one of the person's (devices.ts pairAnswer): never from a plain frame, which the relay
   * could have made (m-h).
   */
  readonly onStatus?: (status: DeviceStatusParams) => void;
  /**
   * The code another of the person's Macs shows (Settings, Devices, Add a Mac), typed into this Mac's desktop app to
   * join that Mac as one of the person's Macs (decision 31): the first v2 hello proves it (pairProof), once, whatever
   * the answer. Only a Mac's desktop key pairs; the hellos after it carry none.
   */
  readonly pairing?: string;
}

const refusal = (message: string) =>
  new HandshakeRefused({ code: ErrorCodes.device_not_approved, message, data: { reason: "device_not_approved" } });

/** A Handshake for every connection to one runtime. */
export function deviceHandshake(options: DeviceHandshakeOptions): Handshake {
  let device: Promise<DeviceKey> | undefined;
  const deviceKey = () => {
    device ??= typeof options.device === "function" ? options.device() : Promise.resolve(options.device);
    device.catch(() => (device = undefined));
    return device;
  };
  let unknownWait = UNKNOWN_CHALLENGE_WAIT_MS;
  let pairing = options.pairing;
  if (pairing !== undefined && normalizePairingCode(pairing) === undefined) {
    const typed = pairing;
    pairing = undefined;
    return async () => {
      throw refusal(`${typed ? `"${typed}" is not` : "That is not"} a code from your other Mac: it is 12 letters and digits, as XXXX-XXXX-XXXX.`);
    };
  }
  return async (link: HandshakeLink) => {
    const kind = options.kind?.();
    if (kind === "cloud") return;
    let challenge: { nonce: string; runtime_id: string; key: string; runtime_name: string; hello?: number };
    try {
      challenge = (await link.next("device.challenge", kind === "laptop" ? CHALLENGE_WAIT_MS : unknownWait)) as typeof challenge;
    } catch {
      // No challenge: a Cloud computer, or a laptop runtime from before device approval. Nothing to answer.
      if (kind === undefined) unknownWait = Math.min(unknownWait * 2, CHALLENGE_WAIT_MS);
      return;
    }
    const name = challenge.runtime_name || "the computer";
    // A key store that failed (a busy IndexedDB) is tried again on the next connection, not taken as a no.
    const own = await deviceKey().catch((error: unknown) => {
      throw new Error(`This device cannot answer ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const ephemeral = await ephemeralKey();
    // A runtime that offers the v2 hello gets this device's kind and name signed too (an older one checks v1 only).
    const v2 = challenge.hello === 2 ? { kind: own.kind ?? ("device" as const), name: own.name } : undefined;
    // The code has one try, on this hello: a Mac's desktop key only, to a Mac whose hello signs the kind it pairs as.
    const code = pairing;
    pairing = undefined;
    if (code !== undefined && own.kind !== "mac") throw refusal("Only a Mac's own Caveman Code app joins another of your Macs.");
    if (code !== undefined && !v2) throw refusal(`${name} runs an older Caveman Code: update it there, then show a new code and join it again.`);
    const payload = helloPayload({ runtime_id: challenge.runtime_id, nonce: challenge.nonce, runtime_key: challenge.key, device_key: ephemeral.public_key, ...(v2 ? { v2 } : {}) });
    const signature = await own.sign(payload);
    // The proof names this key, so it holds for no key the relay could sign these same bytes with (A-1).
    const pair = code === undefined ? undefined : await pairProof(code, own.device_id, payload);
    const keys = await channelKeys({
      privateKey: ephemeral.privateKey,
      peer_key: challenge.key,
      runtime_id: challenge.runtime_id,
      nonce: challenge.nonce,
      runtime_key: challenge.key,
      device_key: ephemeral.public_key,
    });
    let answer: { status: DeviceStatus; code: string };
    try {
      answer = (await link.call("device.hello", {
        device_id: own.device_id,
        name: own.name,
        public_key: own.public_key,
        key: ephemeral.public_key,
        signature: toBase64url(signature),
        ...(v2 ? { kind: v2.kind } : {}),
        ...(pair ? { pair } : {}),
      })) as typeof answer;
    } catch (error) {
      // The runtime would not take this device's answer at all (it closes the stream too). A connection that dropped
      // mid-hello is not that: the client tries again.
      // A Mac with too many devices waiting asks this one to come back later: not a no.
      if (error instanceof SessionProtocolError && error.error.data?.reason !== "rate_limited") throw refusal(error.message);
      throw error;
    }
    let status = answer.status;
    // The code this device shows is its own: the person checks it against the one the Mac's screen shows. Plain frames
    // name no role: only the sealed answer below does.
    const ownCode = deviceCode(own.device_id);
    options.onStatus?.({ status, runtime_name: challenge.runtime_name, code: ownCode });
    // Waiting for the person at the Mac: as long as the Mac keeps the request (then this socket ends and asks again).
    while (status === "pending") {
      const next = (await link.next("device.status", DEVICE_REQUEST_TTL_MS + 30_000)) as DeviceStatusParams;
      status = next.status;
      options.onStatus?.({ status: next.status, runtime_name: next.runtime_name, code: ownCode });
    }
    if (status !== "approved") throw refusal(`${name} did not allow this device.`);
    // From here every frame either way is encrypted under its direction's key, numbered from 1.
    let sent = 0;
    let read = 0;
    return {
      seal: (frame: string) => sealFrame(keys.to_runtime, ++sent, frame, "to_runtime"),
      // Each frame's sequence number is its place in arrival order, so frames open side by side (client.ts receive). One
      // that does not open there ends the socket.
      open: async (frame: string) => {
        const seq = ++read;
        const text = await openFrame(keys.to_device, seq, frame, "to_device");
        // A Join: the Mac's first sealed frame is its answer, proved under the code (m-h). Anything else there is none.
        if (code !== undefined && seq === 1 && text !== undefined && (await joinedAsMac(text, code, own.device_id, payload)))
          options.onStatus?.({ status: "approved", runtime_name: challenge.runtime_name, code: ownCode, role: "mac" });
        return text;
      },
    };
  };
}

/** Whether a frame the Mac sealed is its answer to a Join: a device.status naming the role "mac", proved under the code. */
async function joinedAsMac(text: string, code: string, deviceId: string, hello: Bytes): Promise<boolean> {
  let frame: { method?: unknown; params?: { status?: unknown; role?: unknown; proof?: unknown } } | null;
  try {
    frame = JSON.parse(text) as typeof frame;
  } catch {
    return false;
  }
  const params = frame?.method === "device.status" ? frame.params : undefined;
  return params?.status === "approved" && params.role === "mac" && (await verifyPairAnswer(code, deviceId, hello, params.proof));
}
