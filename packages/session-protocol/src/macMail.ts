// Agent mail between a person's Macs (RESEARCH-W2 decision 33; THREAT-MODEL T16-T21, devices-2026-10-31): a chat on
// one Mac asks or tells a chat on another of the person's Macs (thread_send to `mac:<workspace>`). Cloud carries
// the mail in the person's mailbox (channel "mac"), numbered per receiver, and can neither write nor change one a Mac
// takes: each is signed by the sending Mac's agents key, which that Mac's desktop key vouched for in the person's
// device log (an "agents" statement, devices.ts), and the receiving Mac starts a turn only for mail signed by an agents
// key a Mac it trusts vouched for. The sending chat's modes are signed as the most the mail may run with: a receiving
// chat with broader ones refuses it. Platform-neutral: WebCrypto only.
import { cleanDeviceName, deviceIdOf, publicKeyOf, toBase64url, verifyDeviceSignature, type Bytes, type DeviceKey, type DevicePublicKey } from "./devices.ts";

/** The thread id a chat on another of the person's Macs goes by (`mac:<its workspace>`). */
export const MAC_THREAD = "mac:";
export const AGENT_MAIL_CONTEXT = "caveman-agent-mail-v1";
/** A sending chat's title is cut to this many characters and loses control characters. */
export const AGENT_MAIL_TITLE_MAX = 200;
/** The most a mail's body takes, as UTF-8. Cloud refuses more. */
export const AGENT_MAIL_BODY_MAX_BYTES = 64 * 1024;

/** What the sending Mac says of a mail, besides its body, under its agents key. */
export interface AgentMailFields {
  readonly organization_id: string;
  readonly user_id: string;
  /** A UUID the sender makes: the receiver runs one mail once, by signer and message id. */
  readonly message_id: string;
  /** Cloud's workspace ids: the sending chat's and the receiving chat's. */
  readonly from_workspace_id: string;
  readonly from_title: string;
  readonly to_workspace_id: string;
  /** An ask: the receiver answers when its turn ends. */
  readonly expects_reply: boolean;
  /** The message id this one answers, or "". An answer never asks back. */
  readonly in_reply_to: string;
 /** The sending chat's modes (upstream runtime and interaction modes): the most the mail may run with. */
  readonly runtime_mode: string;
  readonly interaction_mode: string;
}

/** A signed mail's envelope: its fields, the SHA-256 of its body, the agents key that signed it and when. */
export interface AgentMail extends AgentMailFields {
  readonly body_sha256: string;
  readonly signer: { readonly device_id: string; readonly public_key: DevicePublicKey };
  readonly at: string;
  readonly signature: string;
}

const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("this platform has no WebCrypto");
  return s;
};

/** A chat's title as the receiver shows it: no control characters, at most AGENT_MAIL_TITLE_MAX characters. */
export function cleanMailTitle(title: unknown): string {
  const text = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim() : "";
  return [...(text || "A chat")].slice(0, AGENT_MAIL_TITLE_MAX).join("").trimEnd();
}

/** The body's SHA-256, base64url: what the signature covers of it. */
export async function bodyDigest(body: string): Promise<string> {
  return toBase64url(new Uint8Array(await subtle().digest("SHA-256", utf8(body))));
}

/** The bytes a mail's signature covers: one field per line, each free of line breaks, in a fixed order. */
export function agentMailPayload(m: Omit<AgentMail, "signature">): Bytes {
  return utf8(
    [
      AGENT_MAIL_CONTEXT,
      m.organization_id,
      m.user_id,
      m.message_id,
      m.from_workspace_id,
      m.from_title,
      m.to_workspace_id,
      m.expects_reply ? "1" : "",
      m.in_reply_to,
      m.runtime_mode,
      m.interaction_mode,
      m.body_sha256,
      m.signer.device_id,
      m.signer.public_key.x,
      m.signer.public_key.y,
      m.at,
    ].join("\n"),
  );
}

/** `agents` (this Mac's agents key) signs a mail of `body`. */
export async function signAgentMail(agents: DeviceKey, fields: AgentMailFields, body: string, now = Date.now()): Promise<AgentMail> {
  const unsigned: Omit<AgentMail, "signature"> = {
    organization_id: fields.organization_id,
    user_id: fields.user_id,
    message_id: fields.message_id,
    from_workspace_id: fields.from_workspace_id,
    from_title: cleanMailTitle(fields.from_title),
    to_workspace_id: fields.to_workspace_id,
    expects_reply: fields.expects_reply,
    in_reply_to: fields.in_reply_to,
    runtime_mode: fields.runtime_mode,
    interaction_mode: fields.interaction_mode,
    body_sha256: await bodyDigest(body),
    signer: { device_id: agents.device_id, public_key: agents.public_key },
    at: new Date(now).toISOString(),
  };
  return { ...unsigned, signature: toBase64url(await agents.sign(agentMailPayload(unsigned))) };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODE = /^[a-z][a-z-]{0,39}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * The mail in `raw` with `body`, rebuilt from its own fields only, when it is one and its signature holds over them and
 * the body: undefined for anything else (a field missing or of the wrong shape, a title that is not clean, a signer id
 * that is not its key's thumbprint, a body whose digest differs, a signature that does not verify). Whether the signer
 * counts, and whether the mail is this Mac's person's and still in date, is the receiving Mac's call.
 */
export async function verifyAgentMail(raw: unknown, body: string): Promise<AgentMail | undefined> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  for (const field of [r.organization_id, r.user_id, r.from_workspace_id, r.to_workspace_id]) if (typeof field !== "string" || !ID.test(field)) return undefined;
  if (typeof r.message_id !== "string" || !UUID.test(r.message_id)) return undefined;
  if (typeof r.in_reply_to !== "string" || (r.in_reply_to !== "" && !UUID.test(r.in_reply_to))) return undefined;
  if (typeof r.from_title !== "string" || cleanMailTitle(r.from_title) !== r.from_title) return undefined;
  if (typeof r.expects_reply !== "boolean") return undefined;
  // An answer never asks back.
  if (r.expects_reply && r.in_reply_to !== "") return undefined;
  if (typeof r.runtime_mode !== "string" || !MODE.test(r.runtime_mode) || typeof r.interaction_mode !== "string" || !MODE.test(r.interaction_mode)) return undefined;
  if (typeof r.body_sha256 !== "string" || !DIGEST.test(r.body_sha256)) return undefined;
  if (typeof r.at !== "string" || r.at.length > 40 || !Number.isFinite(Date.parse(r.at)) || /\s/.test(r.at)) return undefined;
  if (typeof r.signature !== "string") return undefined;
  const signerRaw = r.signer as Record<string, unknown> | null | undefined;
  if (signerRaw === null || typeof signerRaw !== "object") return undefined;
  const signerKey = publicKeyOf(signerRaw.public_key);
  if (!signerKey || signerRaw.device_id !== (await deviceIdOf(signerKey))) return undefined;
  if (utf8(body).length > AGENT_MAIL_BODY_MAX_BYTES || (await bodyDigest(body)) !== r.body_sha256) return undefined;
  const unsigned: Omit<AgentMail, "signature"> = {
    organization_id: r.organization_id as string,
    user_id: r.user_id as string,
    message_id: r.message_id,
    from_workspace_id: r.from_workspace_id as string,
    from_title: r.from_title,
    to_workspace_id: r.to_workspace_id as string,
    expects_reply: r.expects_reply,
    in_reply_to: r.in_reply_to,
    runtime_mode: r.runtime_mode,
    interaction_mode: r.interaction_mode,
    body_sha256: r.body_sha256,
    signer: { device_id: signerRaw.device_id as string, public_key: signerKey },
    at: r.at,
  };
  if (!(await verifyDeviceSignature(signerKey, agentMailPayload(unsigned), r.signature))) return undefined;
  return { ...unsigned, signature: r.signature };
}

/** How the receiving chat names where a mail came from: "<chat title> on <Mac name>". */
export const mailFrom = (mail: Pick<AgentMail, "from_title">, macName: string) => `${mail.from_title} on ${cleanDeviceName(macName)}`;
