// The direct path, the laptop's side (DESIGN S14). A device on a relayed stream to This Mac, once This Mac allowed it
// (S13), may offer a WebRTC data channel to the runtime itself (direct.offer, direct.candidate). The runtime answers
// with node-datachannel (libdatachannel through N-API prebuilds, loaded only when the first offer comes), and serves
// the channel as one more Session Protocol connection: the same person's principal, and the device check run again on
// it, so the channel is approved on its own, end to end, never on the relay's word. The DTLS fingerprint the channel
// must present is the one in the offer that came over the approved stream; libdatachannel refuses any other.
//
// Only SDP and candidates cross Caveman Cloud. A Cloud computer never gets here (its relayed streams go straight to
// the server, which refuses direct.offer); nor does a local client or the channel itself.
import { DIRECT_SDP_MAX, ErrorCodes, Methods, type ErrorReason } from "@caveman-app/session-protocol";
import { DIRECT_CHANNEL_LABEL, DirectReader, directMessages } from "@caveman-app/session-protocol/direct-wire";
import * as Schema from "effect/Schema";

import type { RelayStream, StreamSink } from "./relay.ts";

/** The parts of node-datachannel this uses (its PeerConnection and DataChannel). */
export interface NdcChannel {
  getLabel(): string;
  sendMessage(message: string): boolean;
  sendMessageBinary(buffer: Uint8Array): boolean;
  bufferedAmount(): number;
  maxMessageSize(): number;
  setBufferedAmountLowThreshold(bytes: number): void;
  onBufferedAmountLow(cb: () => void): void;
  onMessage(cb: (message: string | Buffer | ArrayBuffer) => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (error: string) => void): void;
  close(): void;
}
export interface NdcPeer {
  setRemoteDescription(sdp: string, type: "offer"): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (channel: NdcChannel) => void): void;
  close(): void;
}
export interface Ndc {
  readonly PeerConnection: new (name: string, config: { iceServers: Array<string>; disableFingerprintVerification?: boolean; maxMessageSize?: number }) => NdcPeer;
}

export interface DirectPeersOptions {
  readonly log: (message: string) => void;
  /** STUN servers for this side's candidates, as `stun:host:port`. Default Google's public one; [] keeps to the network. */
  readonly iceServers?: ReadonlyArray<string>;
  /** Loads node-datachannel (tests stand in their own). */
  readonly load?: () => Promise<Ndc>;
  /** Attempts and channels at once, across every stream. */
  readonly maxPeers?: number;
  /** An attempt whose channel has not opened by then is dropped. */
  readonly openTimeoutMs?: number;
  /** An open channel this quiet is pinged; one silent for `silenceMs` (no frame, no pong) is ended. */
  readonly pingMs?: number;
  readonly silenceMs?: number;
}

/** Used when neither this computer nor the device's offer names STUN servers (an install that says nothing). */
export const FALLBACK_STUN = ["stun:stun.l.google.com:19302"];

/**
 * STUN for the laptop's own candidates, set on this computer: `CAVEMAN_DIRECT_STUN` (comma-separated; empty for none).
 * Undefined when unset: the install's list then comes with the device's offer (Caveman Cloud advertises it to
 * devices), and Google's public STUN only when the offer carries none.
 */
export const directIceServers = (env: NodeJS.ProcessEnv = process.env): Array<string> | undefined =>
  env.CAVEMAN_DIRECT_STUN === undefined
    ? undefined
    : env.CAVEMAN_DIRECT_STUN.split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");

/** A STUN server a device may name for this side: `stun:`/`stuns:` with a host, no credentials (no TURN here). */
const STUN_URL = /^stuns?:[A-Za-z0-9.[\]:-]{1,253}$/;

const MAX_PEERS = 32;
/** Attempts one stream may have waiting for their channel; a newer offer replaces the oldest. */
const PENDING_PER_STREAM = 2;
const OPEN_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 5_000;
/** Above this many unsent bytes on a channel, a send waits for it to drain (the relay's own is 4 MiB). */
export const HIGH_WATER = 1024 * 1024;
/**
 * Liveness from this side: a channel quiet this long is pinged (the device answers at once, whatever its own timers
 * do in a hidden tab), and one that has said nothing for SILENCE_MS is ended, its attachments with it.
 */
const PING_MS = 5_000;
const SILENCE_MS = 20_000;

interface Peer {
  readonly id: string;
  readonly stream: RelayStream;
  readonly pc: NdcPeer;
  channel: NdcChannel | null;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ends its channel's stream (set once the channel is served). */
  end?: (reason: string) => void;
}

const decodeOffer = Schema.decodeUnknownExit(Methods["direct.offer"].params as unknown as Schema.Codec<{ id: string; sdp: string; ice_servers?: ReadonlyArray<string> }>);
const decodeCandidate = Schema.decodeUnknownExit(Methods["direct.candidate"].params as unknown as Schema.Codec<{ id: string; candidate: string; mid?: string }>);
const textDecoder = new TextDecoder();

const rpcError = (id: unknown, reason: ErrorReason, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: ErrorCodes[reason], message, data: { reason, ...(reason === "unsupported" ? { capability: "direct" } : {}) } } });

/** Whether a frame from a device is a direct.* call, read only as far as needed (every frame passes here). */
const directMethodOf = (frame: string | Uint8Array): { id: unknown; method: "direct.offer" | "direct.candidate"; params: unknown } | undefined => {
  if (typeof frame !== "string" || frame.length > DIRECT_SDP_MAX + 1024 || !frame.includes('"direct.')) return undefined;
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    message = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (message === null || typeof message !== "object" || (message.method !== "direct.offer" && message.method !== "direct.candidate") || message.id === undefined) return undefined;
  return { id: message.id, method: message.method, params: message.params };
};

export const makeDirectPeers = (options: DirectPeersOptions) => {
  const peers = new Set<Peer>();
  const local = options.iceServers ?? directIceServers();
  /** This computer's own setting, else the install's list from the offer, else the fallback. */
  const iceServersFor = (offered: ReadonlyArray<string> | undefined) =>
    local !== undefined ? [...local] : offered !== undefined ? offered.filter((url) => STUN_URL.test(url)).slice(0, 4) : [...FALLBACK_STUN];
  let loading: Promise<Ndc> | undefined;
  const load = () => (loading ??= (options.load ?? (async () => (await import("node-datachannel")) as unknown as Ndc))());

  const close = (peer: Peer, why: string) => {
    if (peer.closed) return;
    peer.closed = true;
    peers.delete(peer);
    clearTimeout(peer.timer);
    if (why) options.log(`direct ${peer.id}: ${why}`);
    try {
      peer.channel?.close();
    } catch {
      // Already closed.
    }
    try {
      peer.pc.close();
    } catch {
      // Already closed.
    }
    peer.end?.(why || "the direct connection ended");
  };

  /** A channel that opened, as a stream the device check and the server take, like a relayed one. */
  const serveChannel = (peer: Peer, dc: NdcChannel, serve: (stream: RelayStream) => StreamSink) => {
    let ended = false;
    let sink: StreamSink | undefined;
    const drained: Array<() => void> = [];
    let heardAt = Date.now();
    const every = options.pingMs ?? PING_MS;
    const silence = options.silenceMs ?? SILENCE_MS;
    const ping = new Uint8Array(9);
    ping[0] = 3;
    const pinger = setInterval(() => {
      const quiet = Date.now() - heardAt;
      if (quiet > silence) return end("the device stopped answering on the direct channel");
      if (quiet < every) return;
      try {
        new DataView(ping.buffer).setFloat64(1, Date.now());
        dc.sendMessageBinary(ping);
      } catch {
        end("the direct channel failed");
      }
    }, Math.max(20, Math.floor(every / 2)));
    pinger.unref?.();
    dc.setBufferedAmountLowThreshold(HIGH_WATER / 4);
    dc.onBufferedAmountLow(() => {
      for (const resolve of drained.splice(0)) resolve();
    });
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      clearInterval(pinger);
      for (const resolve of drained.splice(0)) resolve();
      close(peer, "");
      sink?.closed(reason);
    };
    peer.end = end;
    const stream: RelayStream = {
      send: (data) =>
        new Promise<void>((resolve) => {
          if (ended) return resolve();
          const text = typeof data === "string" ? data : textDecoder.decode(data);
          try {
            // libdatachannel's send answers false when it queued the message rather than sent it: not a failure. Only a
            // throw (the channel closed) is; the queue is paced below.
            for (const message of directMessages(text, dc.maxMessageSize())) {
              if (typeof message === "string") dc.sendMessage(message);
              else dc.sendMessageBinary(message);
            }
          } catch (error) {
            options.log(`direct ${peer.id}: ${(error as Error).message}`);
            end("the direct channel failed");
            return resolve();
          }
          if (dc.bufferedAmount() > HIGH_WATER) drained.push(resolve);
          else resolve();
        }),
      close: (reason = "") => end(reason || "the runtime closed the direct channel"),
    };
    const reader = new DirectReader();
    sink = serve(stream);
    dc.onMessage((message) => {
      if (ended) return;
      heardAt = Date.now();
      let input;
      try {
        input = reader.read(message);
      } catch (error) {
        options.log(`direct ${peer.id}: ${(error as Error).message}`);
        return end("a direct message was malformed");
      }
      if (input.kind === "frame") sink?.message(input.text);
      else if (input.kind === "ping") {
        // The device may have closed the channel since it pinged: the send throws, and a throw out of this native
        // callback aborts the whole process.
        try {
          dc.sendMessageBinary(input.reply);
        } catch (error) {
          options.log(`direct ${peer.id}: ${(error as Error).message}`);
          end("the direct channel failed");
        }
      }
    });
    dc.onClosed(() => end("the device closed the direct channel"));
    dc.onError((error) => {
      options.log(`direct ${peer.id}: ${error}`);
      end("the direct channel failed");
    });
  };

  const offer = async (stream: RelayStream, id: unknown, params: unknown, channel: (stream: RelayStream) => StreamSink) => {
    const decoded = decodeOffer(params);
    if (decoded._tag === "Failure") return stream.send(rpcError(id, "invalid_params", "params do not match direct.offer"));
    const { id: attempt, sdp, ice_servers: offered } = decoded.value;
    let ndc: Ndc;
    try {
      ndc = await load();
    } catch (error) {
      options.log(`direct connections are off: node-datachannel did not load (${(error as Error).message})`);
      return stream.send(rpcError(id, "unsupported", "This computer cannot open a direct connection."));
    }
    // A newer offer from the same stream replaces its oldest that never opened; past the cap, none.
    const waiting = [...peers].filter((p) => p.stream === stream && p.channel === null);
    for (const old of waiting.slice(0, Math.max(0, waiting.length - PENDING_PER_STREAM + 1))) close(old, "replaced by a newer offer");
    for (const same of [...peers]) if (same.stream === stream && same.id === attempt) close(same, "offered again");
    if (peers.size >= (options.maxPeers ?? MAX_PEERS)) return stream.send(rpcError(id, "rate_limited", "Too many direct connections are open."));
    let pc: NdcPeer;
    try {
      pc = new ndc.PeerConnection(`caveman-direct-${attempt.slice(0, 8)}`, { iceServers: iceServersFor(offered), disableFingerprintVerification: false });
    } catch (error) {
      options.log(`direct ${attempt}: ${(error as Error).message}`);
      return stream.send(rpcError(id, "unsupported", "This computer cannot open a direct connection."));
    }
    const peer: Peer = { id: attempt, stream, pc, channel: null, closed: false, timer: undefined };
    peers.add(peer);
    peer.timer = setTimeout(() => peer.channel === null && close(peer, "its channel did not open in time"), options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    peer.timer.unref?.();
    let answered: (sdp: string) => void = () => undefined;
    const answer = new Promise<string>((resolve) => (answered = resolve));
    pc.onLocalDescription((local, type) => type === "answer" && answered(local));
    pc.onLocalCandidate((candidate, mid) => {
      if (peer.closed || peer.channel !== null) return;
      void stream.send(JSON.stringify({ jsonrpc: "2.0", method: "direct.candidate", params: { id: attempt, candidate, mid } }));
    });
    pc.onStateChange((state) => {
      if (state === "failed" || state === "closed") close(peer, state === "failed" ? "the connection failed" : "");
    });
    pc.onDataChannel((dc) => {
      if (peer.closed || peer.channel !== null || dc.getLabel() !== DIRECT_CHANNEL_LABEL) {
        try {
          dc.close();
        } catch {
          // Already closed.
        }
        return;
      }
      peer.channel = dc;
      clearTimeout(peer.timer);
      serveChannel(peer, dc, channel);
    });
    try {
      pc.setRemoteDescription(sdp, "offer");
    } catch (error) {
      close(peer, `its offer was refused: ${(error as Error).message}`);
      return stream.send(rpcError(id, "invalid_params", "The offer is not a WebRTC data-channel offer."));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const local = await Promise.race([answer, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS)))]);
    clearTimeout(timer);
    if (local === undefined || peer.closed) {
      close(peer, "no answer");
      return stream.send(rpcError(id, "internal", "The direct connection could not be answered."));
    }
    return stream.send(JSON.stringify({ jsonrpc: "2.0", id, result: { sdp: local } }));
  };

  const candidate = (stream: RelayStream, id: unknown, params: unknown) => {
    const decoded = decodeCandidate(params);
    if (decoded._tag === "Failure") return stream.send(rpcError(id, "invalid_params", "params do not match direct.candidate"));
    const { id: attempt, candidate: line, mid } = decoded.value;
    const peer = [...peers].find((p) => p.stream === stream && p.id === attempt);
    // A candidate for an attempt that ended (or opened already) changes nothing; it is not an error worth a retry.
    if (peer && peer.channel === null && line !== "") {
      try {
        peer.pc.addRemoteCandidate(line, mid ?? "0");
      } catch (error) {
        options.log(`direct ${attempt}: a candidate was refused (${(error as Error).message})`);
      }
    }
    return stream.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  };

  return {
    /**
     * A relayed stream that passed its device check, as the server should get it: direct.offer and direct.candidate
     * are answered here, everything else goes to `inner`. A channel that opens is served by `channel`, which runs the
     * device check again before the server sees it. When the stream ends, its attempts that never opened end too;
     * a channel that opened lives on (the relay going does not take the direct path with it).
     */
    serve(stream: RelayStream, inner: StreamSink, channel: (stream: RelayStream) => StreamSink): StreamSink {
      let chain: Promise<unknown> = Promise.resolve();
      return {
        message: (data) => {
          const call = directMethodOf(data);
          if (!call) return inner.message(data);
          chain = chain
            .then(() => (call.method === "direct.offer" ? offer(stream, call.id, call.params, channel) : candidate(stream, call.id, call.params)))
            .catch((error: unknown) => options.log(`direct: ${(error as Error).message}`));
        },
        closed: (reason) => {
          for (const peer of [...peers]) if (peer.stream === stream && peer.channel === null) close(peer, "");
          inner.closed(reason);
        },
      };
    },
    /** Remote control went off (or the link stopped): every attempt and channel ends. */
    closeAll(): void {
      for (const peer of [...peers]) close(peer, "");
    },
    /** Attempts and open channels. */
    count: (): number => peers.size,
    /** Open channels. */
    open: (): number => [...peers].filter((p) => p.channel !== null).length,
  };
};

export type DirectPeers = ReturnType<typeof makeDirectPeers>;
