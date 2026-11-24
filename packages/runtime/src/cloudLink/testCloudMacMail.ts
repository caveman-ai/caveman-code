// The test Cloud's mail between a person's Macs (Caveman Cloud Caveman Cloud API, as the app
// calls it; cloudLink/macMail.ts). It keeps the rules the app relies on: only a Mac (a laptop computer) sends or looks
// up, for its own person and organization (the runtime's enroller, never the payload); the sending chat is on the
// caller's computer; the receiving chat is the same person's, on another of their Macs, not archived; one mail is kept
// once per message id; each is numbered among the mail to its receiving chat; a chat's unread backlog is bounded; and
// mail is taken on channel "mac" by whichever computer the receiving chat is on now, leased for 30 s and renewed while
// that computer holds it (mailbox.go, as a queued call's mail). Cloud checks shape only: the
// signature is each Mac's to verify, so a test can carry a forged or altered mail by writing the store directly.
import { createHash } from "node:crypto";

import type { TestChatSession } from "./testCloud.ts";
import { refusalFor, type FieldKind, type TreeEnvelope, type TreeState } from "./testCloudMail.ts";

export const MAC_CHANNEL = "mac";
/** How long a take or a renew holds mail on channel mac (mailbox.go CallMailLeaseTTL, which it shares). */
export const MAC_MAIL_LEASE_MS = 30_000;

const MAIL_FIELDS: Readonly<Record<string, FieldKind>> = {
  mail: {
    organization_id: "string",
    user_id: "string",
    message_id: "string",
    from_workspace_id: "string",
    from_title: "string",
    to_workspace_id: "string",
    expects_reply: "bool",
    in_reply_to: "string",
    runtime_mode: "string",
    interaction_mode: "string",
    body_sha256: "string",
    signer: { device_id: "string", public_key: { kty: "string", crv: "string", x: "string", y: "string" } },
    at: "string",
    signature: "string",
  },
  body: "string",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function macMailState() {
  return {
    /** Past this many unread mails to one chat, a sender is refused (MaxMacMailBacklog). */
    backlog: 200,
    /** Every POST mail/mac as sent, with the status it got. */
    sends: [] as Array<{ status: number; code?: string; body: Record<string, unknown> }>,
    /** Takes of mail on channel mac, by computer. */
    takes: [] as Array<string>,
    /** Every renew of mail on channel mac: the ids it held longer. */
    renews: [] as Array<{ ids: ReadonlyArray<string>; at: number }>,
    /** A send Cloud refuses, with what it answers (its asker moved to a Cloud computer, say), by the body as sent. */
    refuse: undefined as ((body: Record<string, unknown>) => { readonly status: number; readonly code: string } | undefined) | undefined,
  };
}
export type MacMailState = ReturnType<typeof macMailState>;

interface Caller {
  readonly computerId: string;
  readonly person: string;
}

interface Deps {
  readonly organizationId: string;
  readonly tree: TreeState;
  readonly mac: MacMailState;
  readonly sessions: ReadonlyMap<string, TestChatSession>;
  readonly computers: ReadonlyMap<string, { readonly kind: "laptop" | "cloud"; readonly name: string; readonly person: string; readonly state: string }>;
  /** A chat's title, as its runtime last told Cloud. */
  readonly titleOf: (sessionId: string) => string;
  /** Chats a test archived (Cloud's workspace status). */
  readonly archived?: (workspaceId: string) => boolean;
}

const sessionOf = (deps: Deps, workspaceId: string) => [...deps.sessions.values()].find((s) => s.workspace_id === workspaceId);

/** The undelivered mail on channel mac for chats on `computerId` now, in id order. */
const waitingFor = (deps: Deps, computerId: string, now: number) =>
  deps.tree.mail.filter(
    (m) =>
      m.channel === MAC_CHANNEL &&
      !m.delivered &&
      m.to_workspace_id !== null &&
      sessionOf(deps, m.to_workspace_id)?.computer_id === computerId &&
      (m.lease === undefined || m.lease.expiresAt < now),
  );

const view = (m: TreeEnvelope) => ({
  id: m.id,
  verb: m.verb,
  authority: "agent",
  channel: m.channel,
  from_workspace_id: m.from_workspace_id,
  to_workspace_id: m.to_workspace_id,
  to_user_id: null,
  body: m.body,
  wakes: m.wakes,
  reply_to: m.reply_to,
  created_at: m.created_at,
  attempts: 1,
  payload: m.payload,
});

/** Answers true when it served the request. `caller`: the calling runtime's computer and person, undefined without a valid token. */
export async function macMailRoutes(
  deps: Deps,
  input: { method: string; url: URL; body: Record<string, unknown>; caller: Caller | undefined; now: number },
  reply: (status: number, body: unknown) => void,
): Promise<boolean> {
  const { method, url, body, caller, now } = input;
  const route = url.pathname.replace(/^\/api\/v1\/code\//, "");
  const peerRoute = /^mail\/mac\/([^/]+)$/.exec(route);
  const mine =
    (route === "mail/mac" && method === "POST") ||
    (peerRoute !== null && method === "GET") ||
    (route === "mail/deliveries" && method === "POST" && url.searchParams.get("channel") === MAC_CHANNEL) ||
    (route === "mail/deliveries/renew" && method === "POST" && Array.isArray(body.ids) && (body.ids as Array<unknown>).some((id) => deps.tree.mail.some((m) => m.id === id && m.channel === MAC_CHANNEL))) ||
    (route === "mail/wait" && method === "GET" && !url.searchParams.has("workspace_id") && url.searchParams.get("channel") === MAC_CHANNEL);
  if (!mine) return false;
  const refuse = (status: number, code: string, message = code) => {
    if (route === "mail/mac") deps.mac.sends.push({ status, code, body });
    reply(status, { error: { code, message } });
    return true;
  };
  if (caller === undefined) return refuse(401, "cave_unauthorized");
  if (deps.tree.down !== undefined) return refuse(deps.tree.down, "cave_unavailable", "down");
  const laptop = deps.computers.get(caller.computerId)?.kind === "laptop";

  /** The person's chat `workspaceId` on another of their Macs, with its session; a refusal otherwise. */
  const peer = (workspaceId: string): { s: TestChatSession; refusal?: undefined } | { refusal: readonly [number, string] } => {
    const s = sessionOf(deps, workspaceId);
    if (s === undefined || s.person !== caller.person) return { refusal: [404, "cave_not_found"] };
    if (deps.archived?.(workspaceId)) return { refusal: [409, "cave_code_workspace_archived"] };
    const at = deps.computers.get(s.computer_id);
    if (s.computer_id === caller.computerId || at === undefined || at.kind !== "laptop" || at.person !== caller.person || at.state === "deleted") return { refusal: [409, "cave_code_mac_mail_not_another_mac"] };
    return { s };
  };

  if (peerRoute !== null) {
    if (!laptop) return refuse(403, "cave_forbidden");
    const found = peer(decodeURIComponent(peerRoute[1]!));
    if (found.refusal) return refuse(404, "cave_not_found");
    const s = found.s;
    reply(200, { workspace_id: s.workspace_id, session_id: s.session_id, title: deps.titleOf(s.session_id), computer_id: s.computer_id, computer_name: deps.computers.get(s.computer_id)!.name });
    return true;
  }

  if (route === "mail/wait") {
    const deadline = Date.now() + Math.min(Number(url.searchParams.get("timeout_ms") ?? 25_000), 25_000);
    while (waitingFor(deps, caller.computerId, Date.now()).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const ready = waitingFor(deps, caller.computerId, Date.now()).length > 0;
    reply(200, { ready, timed_out: !ready });
    return true;
  }

  if (route === "mail/deliveries") {
    deps.mac.takes.push(caller.computerId);
    const token = createHash("sha256").update(`${caller.computerId}:${now}:${Math.random()}`).digest("hex").slice(0, 32);
    const taken = waitingFor(deps, caller.computerId, now);
    for (const m of taken) m.lease = { token, expiresAt: now + MAC_MAIL_LEASE_MS };
    reply(200, { lease_token: taken.length > 0 ? token : null, messages: taken.map(view) });
    return true;
  }

  if (route === "mail/deliveries/renew") {
    // mailbox.go RenewDeliveries: the token's unacknowledged, unexpired mail held another lease.
    const ids = body.ids as Array<unknown>;
    if (typeof body.lease_token !== "string" || ids.length === 0 || ids.length > 100 || Object.keys(body).some((k) => k !== "lease_token" && k !== "ids"))
      return refuse(400, "cave_bad_request", "lease_token and 1 to 100 ids are required.");
    const renewed: Array<string> = [];
    for (const m of deps.tree.mail) {
      if (!ids.includes(m.id) || m.delivered || m.lease?.token !== body.lease_token || m.lease.expiresAt <= now) continue;
      m.lease = { token: m.lease.token, expiresAt: now + MAC_MAIL_LEASE_MS };
      renewed.push(m.id);
    }
    deps.mac.renews.push({ ids: renewed, at: now });
    reply(200, { renewed, lost: ids.filter((id) => !renewed.includes(String(id))) });
    return true;
  }

  // POST mail/mac
  const strict = refusalFor(MAIL_FIELDS, body);
  if (strict !== undefined) {
    deps.tree.refused.push({ route, why: strict });
    return refuse(400, "cave_bad_request", "Invalid JSON.");
  }
  const mail = (body.mail ?? {}) as Record<string, unknown>;
  const text = String(body.body ?? "");
  const digest = createHash("sha256").update(text, "utf8").digest("base64url");
  if (text === "" || Buffer.byteLength(text) > 64 * 1024 || mail.body_sha256 !== digest || typeof mail.message_id !== "string" || !UUID.test(mail.message_id)) return refuse(400, "cave_bad_request");
  if (typeof mail.in_reply_to === "string" && mail.in_reply_to !== "" && !UUID.test(mail.in_reply_to)) return refuse(400, "cave_bad_request");
  if (mail.expects_reply === true && mail.in_reply_to !== "") return refuse(400, "cave_bad_request");
  if (mail.organization_id !== deps.organizationId || mail.user_id !== caller.person) return refuse(403, "cave_forbidden");
  if (!laptop) return refuse(403, "cave_forbidden");
  const no = deps.mac.refuse?.(body);
  if (no !== undefined) return refuse(no.status, no.code);
  const from = sessionOf(deps, String(mail.from_workspace_id));
  if (from === undefined || from.person !== caller.person) return refuse(404, "cave_not_found");
  if (from.computer_id !== caller.computerId) return refuse(409, "cave_code_session_elsewhere");
  const verb = mail.in_reply_to !== "" ? "answer" : mail.expects_reply === true ? "ask" : "note";
  const requestId = `mac:${mail.message_id}`;
  const prior = deps.tree.mail.find((m) => m.tree === from.workspace_id && m.request_id === requestId);
  if (prior !== undefined) {
    if (prior.verb !== verb) return refuse(409, "cave_code_request_conflict");
    deps.mac.sends.push({ status: 200, body });
    reply(200, view(prior));
    return true;
  }
  const to = peer(String(mail.to_workspace_id));
  if (to.refusal) return refuse(to.refusal[0], to.refusal[1]);
  const mine2 = deps.tree.mail.filter((m) => m.channel === MAC_CHANNEL && m.to_workspace_id === to.s.workspace_id);
  if (mine2.filter((m) => !m.delivered).length >= deps.mac.backlog) return refuse(429, "cave_code_mac_mail_backlog");
  const seq = mine2.reduce((max, m) => Math.max(max, (m.payload as { recipient_seq?: number }).recipient_seq ?? 0), 0) + 1;
  const envelope: TreeEnvelope = {
    id: deps.tree.nextId(),
    tree: from.workspace_id,
    request_id: requestId,
    verb,
    channel: MAC_CHANNEL,
    from_workspace_id: from.workspace_id,
    to_workspace_id: to.s.workspace_id,
    body: text,
    wakes: true,
    reply_to: null,
    payload: { kind: "mac", mail, session_id: to.s.session_id, recipient_seq: seq, from_session_id: from.session_id },
    created_at: new Date(now).toISOString(),
    delivered: false,
  };
  deps.tree.mail.push(envelope);
  deps.mac.sends.push({ status: 200, body });
  reply(200, view(envelope));
  return true;
}
