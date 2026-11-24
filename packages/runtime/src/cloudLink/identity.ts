// The runtime's identity in Caveman Cloud (Cloud's runtime token contract):
// an Ed25519 key kept beside the runtime id Cloud issued, and the short-lived
// ccrt_ tokens minted by signing an assertion with that key. The key never
// leaves the directory: This Mac makes it in the runtime's state dir; on a
// Cloud computer the computers service mounts both files.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { toolsSocket } from "./tools.ts";

export const RECORD_FILE = "runtime.json";
export const KEY_FILE = "runtime.key";
/**
 * What a signed-out computer keeps of its enrollment: which Cloud computer it was and its last runtime there, never
 * a key. Cloud keeps that computer's chats past the sign-out, so the next enrollment with that Cloud re-keys it.
 */
export const LEFT_FILE = "runtime.left.json";

export interface Identity {
  /** Cloud's app origin, e.g. https://app.caveman.so: the API is under /api/v1, the relay under /relay/v1. */
  readonly cloudUrl: string;
  readonly runtimeId: string;
  readonly organizationId: string;
  readonly computerId: string;
  readonly key: KeyObject;
  /**
   * The Cloud user this runtime belongs to, when Cloud named one (the
   * enrolling person on This Mac; the computer's owner on a Cloud computer):
   * the only relay principal that may use its secrets.
   */
  readonly userId?: string | undefined;
}

/** Cloud refused or failed a call; `code` is Cloud's error code when it sent one. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** How long Cloud said to wait before asking again (Retry-After), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Cloud said no for this person (revoked runtime, a computer shared with someone else's work, asleep, idle, no access). */
export const refused = (error: unknown) => error instanceof CloudError && (error.status === 401 || error.status === 403);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** https, or http to a loopback host (a local stack); never a credential in the URL. */
export function cloudOrigin(raw: string): string {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("the Cloud URL must be https");
  if (url.username || url.password) throw new Error("the Cloud URL must not carry credentials");
  return url.origin;
}

/** The enrolled identity in `dir`; throws saying what is missing or wrong. */
export function loadIdentity(dir: string): Identity {
  const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8")) as Record<string, unknown>;
  const { cloud_url, runtime_id, organization_id, computer_id, user_id } = record;
  if (typeof cloud_url !== "string" || ![runtime_id, organization_id, computer_id].every((id) => typeof id === "string" && UUID.test(id)))
    throw new Error(`${RECORD_FILE} needs cloud_url and the runtime, organization and computer ids`);
  const key = createPrivateKey(fs.readFileSync(path.join(dir, KEY_FILE), "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${KEY_FILE} is not an Ed25519 key`);
  return {
    cloudUrl: cloudOrigin(cloud_url),
    runtimeId: runtime_id as string,
    organizationId: organization_id as string,
    computerId: computer_id as string,
    key,
    ...(typeof user_id === "string" && user_id !== "" ? { userId: user_id } : {}),
  };
}

/** CAVEMAN_CLOUD_URL as set: the origin, or the raw value when it is not one (then nothing signs in anywhere). */
export interface PinnedCloud {
  readonly cloudUrl: string;
  readonly valid: boolean;
}

/**
 * CAVEMAN_CLOUD_URL, the Cloud an IT team pins This Mac to (`caveman-runtime
 * apply` and the desktop's telemetry read the same variable): Settings shows
 * it and cannot change it, and an enrollment, sign-in or credits key kept for
 * another Cloud is not used, nor told. Unset or empty: no pin. Never on a
 * Cloud computer, whose Cloud the computers service names.
 */
export function pinnedCloud(env: NodeJS.ProcessEnv = process.env): PinnedCloud | undefined {
  const raw = env.CAVEMAN_CLOUD_URL?.trim();
  if (!raw || toolsSocket(env) !== undefined) return undefined;
  try {
    return { cloudUrl: cloudOrigin(raw), valid: true };
  } catch {
    return { cloudUrl: raw, valid: false };
  }
}

/** Whether a pin (if any) allows `cloudUrl`. */
export const pinAllows = (cloudUrl: string, pin: PinnedCloud | undefined = pinnedCloud()): boolean => pin === undefined || cloudUrl === pin.cloudUrl;

/** The enrolled identity in `dir`; undefined when there is none, it is damaged, or it is for a Cloud other than the pinned one. */
export function readIdentity(dir: string): Identity | undefined {
  try {
    const identity = loadIdentity(dir);
    return pinAllows(identity.cloudUrl) ? identity : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A warm Cloud computer's runtime before its claim: started by the computer image's entrypoint with
 * CAVEMAN_RUNTIME_LINK_WAIT=1 and no identity in its link dir yet (cloudLink/index.ts `claimed`).
 */
export const awaitingClaim = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CAVEMAN_RUNTIME_LINK_WAIT === "1" && !!env.CAVEMAN_CLOUD_LINK_DIR && readIdentity(env.CAVEMAN_CLOUD_LINK_DIR) === undefined;

/** The enrollment `dir` signed out of (LEFT_FILE), if any. */
function leftEnrollment(dir: string): Pick<Identity, "cloudUrl" | "runtimeId" | "computerId"> | undefined {
  try {
    const { cloud_url, runtime_id, computer_id } = JSON.parse(fs.readFileSync(path.join(dir, LEFT_FILE), "utf8")) as Record<string, unknown>;
    if (typeof cloud_url !== "string" || ![runtime_id, computer_id].every((id) => typeof id === "string" && UUID.test(id))) return undefined;
    return { cloudUrl: cloudOrigin(cloud_url), runtimeId: runtime_id as string, computerId: computer_id as string };
  } catch {
    return undefined;
  }
}

/** Forgets the enrollment in `dir` (signed out), keeping which computer it was (LEFT_FILE) for the next one. */
export function forgetIdentity(dir: string): void {
  try {
    const { cloud_url, runtime_id, computer_id } = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8")) as Record<string, unknown>;
    const file = path.join(dir, LEFT_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ cloud_url, runtime_id, computer_id }, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // No enrollment here (or none readable): nothing to keep, and whatever an earlier sign-out kept stays.
  }
  for (const file of [KEY_FILE, RECORD_FILE]) fs.rmSync(path.join(dir, file), { force: true });
}

/** The raw 32-byte Ed25519 public key, base64, as Cloud's enroll takes it. */
export const publicKeyOf = (key: KeyObject) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

/** The exact bytes Cloud verifies (code.AssertionMessage). */
export const assertionMessage = (organizationId: string, runtimeId: string, issuedAt: number) =>
  `caveman-code-runtime-token/v1\n${organizationId}\n${runtimeId}\n${issuedAt}`;

export const signAssertion = (identity: Identity, issuedAt: number) =>
  sign(null, Buffer.from(assertionMessage(identity.organizationId, identity.runtimeId, issuedAt)), identity.key).toString("base64");

export async function cloudFailure(response: Response): Promise<CloudError> {
  const body = (await response.json().catch(() => undefined)) as { error?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
  const code = body?.error?.code ?? body?.code;
  const message = body?.error?.message ?? body?.message ?? `Cloud answered ${response.status}`;
  const after = Number(response.headers.get("retry-after"));
  return new CloudError(response.status, message, code, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
}

/**
 * Enrolls this runtime with a person's Caveman Cloud session (a bearer Cloud
 * accepts for code:write: the access token of a Cloud sign-in). The bearer is
 * used for this enrollment only and never stored. Every enrollment makes a
 * fresh key, so signing in again after a revoke (a leaked key, say) never
 * trusts the old key again; an earlier enrollment with this Cloud, signed out
 * since or not, re-keys the same local computer and its runtime is revoked.
 * Writes runtime.key and runtime.json only once Cloud accepted the key.
 */
export async function enroll(input: { readonly dir: string; readonly cloudUrl: string; readonly bearer: string; readonly name: string; readonly fetch?: typeof fetch }): Promise<Identity> {
  const cloudUrl = cloudOrigin(input.cloudUrl);
  const call = input.fetch ?? fetch;
  const headers = { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" };
  fs.mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const previous = readIdentity(input.dir) ?? leftEnrollment(input.dir);
  const current = previous?.cloudUrl === cloudUrl ? previous : undefined;
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(input.dir, KEY_FILE);
  fs.rmSync(`${keyFile}.new`, { force: true });
  fs.writeFileSync(`${keyFile}.new`, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const post = (computerId?: string) =>
    call(`${cloudUrl}/api/v1/code/runtimes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ public_key: publicKeyOf(privateKey), name: input.name, ...(computerId ? { computer_id: computerId } : {}) }),
    });
  try {
    // Cloud answers 404 for a computer that is gone or another organization's: then this is a new computer.
    let response = await post(current?.computerId);
    if (response.status === 404 && current) response = await post();
    if (response.status !== 201) throw await cloudFailure(response);
    const runtime = (await response.json()) as { id: string; organization_id: string; computer_id: string; user_id?: unknown };
    const record = {
      cloud_url: cloudUrl,
      runtime_id: runtime.id,
      organization_id: runtime.organization_id,
      computer_id: runtime.computer_id,
      ...(typeof runtime.user_id === "string" ? { user_id: runtime.user_id } : {}),
    };
    const file = path.join(input.dir, RECORD_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(`${keyFile}.new`, keyFile);
    fs.renameSync(`${file}.tmp`, file);
    fs.rmSync(path.join(input.dir, LEFT_FILE), { force: true });
  } finally {
    fs.rmSync(`${keyFile}.new`, { force: true });
  }
  const identity = readIdentity(input.dir);
  if (identity === undefined) throw new CloudError(502, "Cloud's enrollment answer was not a runtime");
  // The runtime this one replaces: its key is gone from here, so nothing should accept it.
  if (current && current.runtimeId !== identity.runtimeId)
    await call(`${cloudUrl}/api/v1/code/runtimes/${current.runtimeId}/revoke`, { method: "POST", headers }).then((r) => r.body?.cancel(), () => undefined);
  return identity;
}
