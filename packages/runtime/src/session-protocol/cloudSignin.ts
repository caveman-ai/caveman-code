// The Caveman sign-in, driven by the runtime (cloud.signin): Caveman Cloud's
// device flow with the "code" connection (the activate page grants org:read,
// code:read, code:write, and billing:write when the role holds it), and the
// provider a signed-out person signs in with there when the client names one
// (GitHub or Google), an email to prefill, and whether the person is signing in
// or making an account (signin or signup) (an older Cloud ignores fields
// it does not know). The runtime polls for the person's approval, acknowledges delivery, reads which
// account approved and enrolls This Mac as cloud.enroll does. With `keep`
// the session is handed to the runtime's secret store for Settings ->
// Account (cloudLink/account.ts); without it, it is signed out. Either way
// it is never logged, returned or traced. The approving account is kept
// beside the identity and shown here: whoever approves a code controls this
// computer, so the handler leaves Remote control off until the person
// switches it on. When Cloud refuses to register this computer (a role that
// cannot hold a runtime) or cannot be reached, the account is still kept,
// with no runtime identity, and Remote control is off (UX plan N11): the
// person is signed in and can try again. A device code that expires before
// the person approves is replaced by a new one, a few times. cloud.signout
// revokes the runtime with its own token, signs the kept session out and
// forgets the link.
import * as fs from "node:fs";
import * as path from "node:path";

import * as Context from "effect/Context";

import type { AccountSession } from "../cloudLink/account.ts";
import { HOSTED_CLOUD, serviceOrigin } from "../cloudLink/hosted.ts";
import { CloudError, cloudFailure, cloudOrigin, enroll, forgetIdentity, KEY_FILE, pinAllows, readIdentity, RECORD_FILE, signAssertion, type Identity } from "../cloudLink/identity.ts";

export { HOSTED_CLOUD };

/** The Cloud account that approved this computer's sign-in (runtime.json `account`). */
export interface CloudAccount {
  readonly email: string;
  readonly organization_name?: string;
  /** Their org role then: owner and admin may install for the team. */
  readonly role?: "owner" | "admin" | "member";
}

/** Cloud's role names as the app's three: Owner, Admin, anything else a member. */
export const appRole = (role: unknown): CloudAccount["role"] =>
  typeof role !== "string" ? undefined : /^owner$/i.test(role) ? "owner" : /^admin$/i.test(role) ? "admin" : "member";

/** Who signs a signed-out person in on Cloud's approve page (cloud.signin `provider`). */
export type SigninProvider = "github" | "google";
/** Whether a signed-out person signs in or makes an account on Cloud's approve page (cloud.signin `intent`). */
export type SigninIntent = "signin" | "signup";

export interface PendingSignin {
  readonly cloudUrl: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_at: string;
  /** Ends the poll (a newer sign-in or a sign-out). */
  readonly cancel: () => void;
}

/** The sign-in in progress, or why the last one ended without enrolling. One per runtime. */
export interface SigninState {
  current?: PendingSignin | undefined;
  error?: string | undefined;
}
export class CloudSigninState extends Context.Reference<SigninState>("caveman/cloudSignin/State", { defaultValue: () => ({}) }) {}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const post = (fetchImpl: typeof fetch, url: string, body: unknown, bearer?: string) =>
  fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

/** How many times a device code that ran out unapproved is replaced by a new one before the sign-in ends. */
const MAX_RENEWALS = 3;
const EXPIRED = "The code expired. Sign in again.";

/**
 * Starts a sign-in and returns the code to show; the poll runs on in the
 * background and leaves its outcome in `state` (an identity in `dir`, or
 * `state.error`). `onDone` runs after either: with the identity, or without
 * it and with the account when Cloud approved but did not register this
 * computer (the account is kept, and `state.error` says why). A computer
 * enrolled before that Cloud refused to enrol again is still the identity.
 */
export async function startSignin(input: {
  readonly state: SigninState;
  readonly cloudUrl: string;
  readonly dir: string;
  readonly name: string;
  readonly fetch?: typeof fetch;
  readonly onDone?: (enrolled: Identity | undefined, account?: CloudAccount) => void;
  /** Keeps the approved session (undefined: forget it); without it the session is signed out after enrolling. */
  readonly keep?: (session: AccountSession | undefined) => Promise<void>;
  /** The approve page signs a signed-out person in with this provider; a Cloud that does not know the field ignores it. */
  readonly provider?: SigninProvider | undefined;
  /** Prefills Cloud's sign-in; never a password. */
  readonly email?: string | undefined;
  /** Opens Cloud's sign-in or new-account form for a signed-out person, without asking which. */
  readonly intent?: SigninIntent | undefined;
}): Promise<PendingSignin> {
  const fetchImpl = input.fetch ?? fetch;
  const cloudUrl = cloudOrigin(input.cloudUrl);
  input.state.current?.cancel();
  const email = input.email?.trim() || undefined;
  // The approve page is this Cloud's own: the client opens it as a link.
  const sameCloud = (uri: string | undefined) => {
    try {
      return uri === undefined || new URL(uri).origin === cloudUrl;
    } catch {
      return false;
    }
  };
  // One abort ends the sign-in, whichever code it is on.
  const abort = new AbortController();
  /** Asks Cloud for a device code (the first, or the next once one ran out) and the pending sign-in that shows it. */
  const ask = async (): Promise<{ code: DeviceCode; pending: PendingSignin; expiresAt: number }> => {
    const response = await post(fetchImpl, `${cloudUrl}/api/v1/auth/device/code`, {
      connection: "code",
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(email === undefined ? {} : { email }),
      ...(input.intent === undefined ? {} : { intent: input.intent }),
    });
    if (!response.ok) {
      const failure = await cloudFailure(response);
      throw failure.code === "cave_device_login_disabled" ? new CloudError(403, "This Caveman server does not allow device sign-in.", failure.code) : failure;
    }
    const code = (await response.json()) as DeviceCode;
    if (!sameCloud(code.verification_uri) || !sameCloud(code.verification_uri_complete)) throw new CloudError(502, "Caveman sent an approve page on another site.");
    const expiresAt = Date.now() + code.expires_in * 1000;
    const pending: PendingSignin = {
      cloudUrl,
      user_code: code.user_code,
      verification_uri: code.verification_uri,
      verification_uri_complete:
        code.verification_uri_complete ??
        `${code.verification_uri}?user_code=${encodeURIComponent(code.user_code)}&connection=code${input.provider === undefined ? "" : `&provider=${input.provider}`}${input.intent === undefined ? "" : `&intent=${input.intent}`}` +
        // The email rides the fragment, as Cloud's own link carries it: a fragment never reaches a server, a log or a Referer.
        `${email === undefined ? "" : `#email=${encodeURIComponent(email)}`}`,
      expires_at: new Date(expiresAt).toISOString(),
      cancel: () => abort.abort(),
    };
    return { code, pending, expiresAt };
  };
  let active = await ask();
  input.state.current = active.pending;
  input.state.error = undefined;

  const finish = (enrolled: Identity | undefined, error?: string, account?: CloudAccount) => {
    if (input.state.current !== active.pending) return; // a newer sign-in or a sign-out took over
    input.state.current = undefined;
    input.state.error = error;
    input.onDone?.(enrolled, account);
  };
  let renewals = 0;
  /** A new code in place of the one that ran out unapproved; false when Cloud gave none or the sign-in ended meanwhile. */
  const renew = async () => {
    if (renewals >= MAX_RENEWALS) return false;
    const next = await ask().catch(() => undefined);
    // Signed out or taken over while Cloud answered: this sign-in is no longer the one shown.
    if (next === undefined || abort.signal.aborted || input.state.current !== active.pending) return false;
    renewals++;
    active = next;
    input.state.current = next.pending;
    return true;
  };
  const pollEvery = () => Math.max(1, active.code.interval ?? 5) * 1000;
  void (async () => {
    let interval = pollEvery();
    while (!abort.signal.aborted) {
      await sleep(interval, abort.signal);
      if (abort.signal.aborted) return;
      if (Date.now() >= active.expiresAt) {
        if (!(await renew())) return finish(undefined, EXPIRED);
        interval = pollEvery();
        continue;
      }
      let grant: { access_token?: string; refresh_token?: string; delivery_ack_token?: string; gateway_url?: string; error?: string };
      try {
        const answer = await post(fetchImpl, `${cloudUrl}/api/v1/auth/device/token`, { device_code: active.code.device_code });
        if (answer.status >= 500 || answer.status === 429) continue; // Cloud busy or failing for a moment: keep waiting
        grant = (await answer.json().catch(() => ({ error: `http_${answer.status}` }))) as typeof grant;
      } catch {
        continue; // Cloud unreachable for a moment: keep waiting until the code expires
      }
      if (grant.error === "authorization_pending") continue;
      if (grant.error === "slow_down") {
        interval += 5_000;
        continue;
      }
      if (grant.error === "expired_token") {
        if (!(await renew())) return finish(undefined, EXPIRED);
        interval = pollEvery();
        continue;
      }
      if (grant.error === "access_denied") return finish(undefined, "The sign-in was denied in the browser. Sign in again if that was you.");
      if (grant.error || !grant.access_token) return finish(undefined, "Caveman refused the sign-in. Sign in again.");
      return finish(...(await useOnce(fetchImpl, cloudUrl, active.code.device_code, grant, { dir: input.dir, name: input.name, signal: abort.signal, keep: input.keep })));
    }
  })();
  return active.pending;
}

/** The approved credential: acknowledge delivery, read who approved, keep it (or not), enroll; sign it out unless kept. */
async function useOnce(
  fetchImpl: typeof fetch,
  cloudUrl: string,
  deviceCode: string,
  grant: { access_token?: string; refresh_token?: string; delivery_ack_token?: string; gateway_url?: string },
  input: { readonly dir: string; readonly name: string; readonly signal: AbortSignal; readonly keep?: ((session: AccountSession | undefined) => Promise<void>) | undefined },
): Promise<[Identity | undefined, string?, CloudAccount?]> {
  const bearer = grant.access_token!;
  let kept = false;
  let enrolled = false;
  try {
    if (grant.delivery_ack_token) {
      await post(fetchImpl, `${cloudUrl}/api/v1/auth/device/ack`, { device_code: deviceCode, ack_token: grant.delivery_ack_token }, bearer).catch(() => undefined);
    }
    const account = await approver(fetchImpl, cloudUrl, bearer);
    if (input.keep) {
      // The gateway this Cloud runs (its CAVE_GATEWAY_URL), for its credits keys and Auto: a company's own install names its own.
      const gateway = serviceOrigin(cloudUrl, grant.gateway_url);
      await input.keep({ cloud_url: cloudUrl, access_token: bearer, refresh_token: grant.refresh_token, ...(gateway ? { gateway_url: gateway } : {}) });
      kept = true;
    }
    const previous = readIdentity(input.dir);
    let identity: Identity;
    try {
      identity = await enroll({ dir: input.dir, cloudUrl, bearer, name: input.name, fetch: fetchImpl });
    } catch (error) {
      // Cloud refused the credential itself: nothing about this sign-in holds.
      if (error instanceof CloudError && error.status === 401) throw error;
      // Cloud knows the account but did not register this computer (a role that holds no runtime: 403) or could not
      // be reached. A computer enrolled before stays exactly as it was (only a sign-out revokes it), and the error is
      // said beside it. Otherwise the person stays signed in with no runtime identity and Remote control off (the
      // handler's onDone).
      if (input.signal.aborted) {
        // Switched off or signed out meanwhile: the session goes with it.
        await input.keep?.(undefined);
        kept = false;
        return [undefined];
      }
      if (previous) return [previous, notRegistered(error)];
      // Without `keep` the session is signed out below: nothing stays signed in to report.
      if (!kept) return [undefined, notRegistered(error)];
      writeAccountOnly(input.dir, cloudUrl, account);
      return [undefined, notRegistered(error), account];
    }
    enrolled = true;
    writeAccount(input.dir, identity, account);
    // The enrollment this one replaces: its key is gone from here and the grant may only enroll, so end it with that key.
    if (previous && previous.runtimeId !== identity.runtimeId) await revokeInCloud(previous, undefined, fetchImpl);
    if (input.signal.aborted) {
      // Switched off or signed out while Cloud enrolled this computer: undo it.
      if (kept) await input.keep?.(undefined);
      kept = false;
      await revokeInCloud(identity, undefined, fetchImpl);
      if (readIdentity(input.dir)?.runtimeId === identity.runtimeId) forgetIdentity(input.dir);
      return [undefined];
    }
    return [identity];
  } catch (error) {
    // Failed before the person was signed in (or Cloud refused the credential): no half sign-in is left kept.
    if (kept && !enrolled) {
      await input.keep?.(undefined).catch(() => undefined);
      kept = false;
    }
    return [undefined, notRegistered(error)];
  } finally {
    // Not kept: the session existed only for this; end it so the credential is worthless anywhere it might linger.
    if (!kept) await post(fetchImpl, `${cloudUrl}/api/v1/auth/logout`, grant.refresh_token ? { refresh_token: grant.refresh_token } : {}, bearer).catch(() => undefined);
  }
}

/**
 * Why Remote control is off after an approval: Cloud's 403 for a role that cannot hold a runtime, else what went wrong
 * (Cloud's own sentence, or the network's). Said beside the signed-in account (cloud.status `signin_error`).
 */
function notRegistered(error: unknown): string {
  if (error instanceof CloudError && error.status === 403) return "Your role in your Caveman organization cannot turn on remote control (Engineer, Admin or Owner can).";
  return `Caveman did not register this computer: ${error instanceof Error ? error.message : String(error)}`;
}

/** The account (and its organization's name, when Cloud tells) whose approval the bearer carries. */
async function approver(fetchImpl: typeof fetch, cloudUrl: string, bearer: string): Promise<CloudAccount> {
  const get = (route: string) => fetchImpl(`${cloudUrl}${route}`, { headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
  const me = await get("/api/v1/auth/me");
  if (!me.ok) throw await cloudFailure(me);
  const user = ((await me.json()) as { user?: { email?: unknown; role?: unknown } }).user;
  const email = user?.email;
  if (typeof email !== "string" || email === "") throw new CloudError(502, "Caveman did not say which account approved");
  const role = appRole(user?.role);
  const org = await get("/api/v1/org").then((r) => (r.ok ? (r.json() as Promise<{ name?: unknown }>) : undefined), () => undefined);
  return { email, ...(typeof org?.name === "string" && org.name !== "" ? { organization_name: org.name } : {}), ...(role === undefined ? {} : { role }) };
}

/** Keeps the approving account in runtime.json beside the identity it enrolled (not a secret). */
function writeAccount(dir: string, identity: Identity, account: CloudAccount): void {
  const file = path.join(dir, RECORD_FILE);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (record.runtime_id !== identity.runtimeId) return;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...record, account }, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Keeps the approving account in runtime.json with no runtime identity (Cloud did not register this computer): the
 * record has no runtime, organization or computer id, so readIdentity answers none, and the next enrollment writes its
 * own record over it. Never next to a key.
 */
function writeAccountOnly(dir: string, cloudUrl: string, account: CloudAccount): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(dir, KEY_FILE), { force: true });
  const file = path.join(dir, RECORD_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ cloud_url: cloudUrl, account }, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Whether runtime.json in `dir` holds an account and no runtime identity (writeAccountOnly's record). */
function accountOnly(dir: string): boolean {
  try {
    const { runtime_id, account } = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8")) as { runtime_id?: unknown; account?: unknown };
    return runtime_id === undefined && account !== undefined;
  } catch {
    return false;
  }
}

/**
 * The account that approved this computer's sign-in in `dir`, with or without a runtime identity (Cloud may have
 * refused to register the computer); undefined for an enrollment cloud.enroll made, none, or a Cloud this computer is
 * not pinned to.
 */
export function readAccount(dir: string): CloudAccount | undefined {
  try {
    const { account, cloud_url } = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8")) as { account?: CloudAccount; cloud_url?: unknown };
    if (typeof cloud_url === "string" && !pinAllows(cloud_url)) return undefined;
    if (typeof account?.email !== "string") return undefined;
    const role = appRole(account.role);
    return { email: account.email, ...(typeof account.organization_name === "string" ? { organization_name: account.organization_name } : {}), ...(role === undefined ? {} : { role }) };
  } catch {
    return undefined;
  }
}

/** One runtime token for a single call (the link's own may be off): issued_at on Cloud's clock, retried once if refused. */
async function mintOnce(identity: Identity, fetchImpl: typeof fetch): Promise<string> {
  let issuedAt = Math.floor(Date.now() / 1000);
  for (let attempt = 0; ; attempt++) {
    const response = await post(fetchImpl, `${identity.cloudUrl}/api/v1/code/runtimes/${identity.runtimeId}/token`, {
      organization_id: identity.organizationId,
      issued_at: issuedAt,
      signature: signAssertion(identity, issuedAt),
    });
    if (response.ok) return ((await response.json()) as { token: string }).token;
    if (attempt === 1 || response.status !== 401) throw await cloudFailure(response);
    // A fresh second past the link's last assertion, on Cloud's clock.
    const cloudNow = Date.parse(response.headers.get("date") ?? "");
    await new Promise((r) => setTimeout(r, 1_100));
    issuedAt = Math.max(issuedAt + 1, Number.isNaN(cloudNow) ? 0 : Math.floor(cloudNow / 1000) + 1);
  }
}

/** Ends a runtime in Cloud with its own token (the link's, or one minted for this call). Returns why not, if it could not. */
async function revokeInCloud(identity: Identity, token: string | undefined, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await post(fetchImpl, `${identity.cloudUrl}/api/v1/code/runtime/revoke`, {}, token ?? (await mintOnce(identity, fetchImpl)));
    // 401/404: already revoked or gone; nothing left to end.
    if (!response.ok && response.status !== 401 && response.status !== 404) return (await cloudFailure(response)).message;
  } catch (error) {
    // A revoked runtime cannot mint (401): it is already signed out in Cloud.
    if (!(error instanceof CloudError && error.status === 401)) return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/**
 * Revokes this runtime in Cloud and forgets the link here, whatever Cloud
 * answered: the person asked to sign out. Which computer this was stays
 * (forgetIdentity), so signing in again is this computer again and its chats
 * Cloud holds are still its own. Returns why Cloud was not told, if it was not.
 */
export async function signOut(input: { readonly dir: string; readonly identity: Identity | undefined; readonly token?: string | undefined; readonly fetch?: typeof fetch }): Promise<string | undefined> {
  const problem = input.identity ? await revokeInCloud(input.identity, input.token, input.fetch ?? fetch) : undefined;
  // An account kept with no identity has no computer to remember: forgetIdentity would overwrite the one an earlier sign-out kept.
  if (accountOnly(input.dir)) fs.rmSync(path.join(input.dir, RECORD_FILE), { force: true });
  else forgetIdentity(input.dir);
  return problem;
}
