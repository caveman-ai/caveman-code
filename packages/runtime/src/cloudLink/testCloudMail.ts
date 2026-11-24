// The test Cloud's session mailbox for trees that span computers (Caveman Cloud Caveman Cloud API
// mailbox.go, as the app calls it; builders.ts, mail.ts). A lead's own Cloud workspace is the one its chat's
// registration made (the chat stand-in in testCloud.ts answers PUT runtime/sessions/{id}; observeRegistration keeps
// what the runtime sent, so the tree knows the lead's repo and branch). It keeps Cloud's rules
// that the app relies on: a runtime speaks only for workspaces on its own computer, a receiver must be in the
// sender's tree, each write is idempotent by request_id within the tree, only a lead spawns, a lead on a laptop
// gets a fresh computer only with `where: "cloud"`, a named `computer_id` is the lead's own or a Cloud computer the
// tree's person made (never a laptop, never with `where`), and deliveries are leased per computer and channel.
import { randomUUID } from "node:crypto";

export interface TreeWorkspace {
  readonly id: string;
  readonly root: string;
  readonly parent: string | null;
  readonly computer: string;
  status: "active" | "archived";
  readonly title: string;
  readonly repo: string;
  readonly base_branch: string;
  readonly branch: string;
  readonly engine: string;
  readonly session_id: string;
}

export interface TreeEnvelope {
  readonly id: string;
  readonly tree: string;
  readonly request_id: string;
  readonly verb: string;
  readonly channel: string;
  readonly from_workspace_id: string | null;
  readonly to_workspace_id: string | null;
  readonly body: string;
  readonly wakes: boolean;
  readonly reply_to: string | null;
  readonly payload: unknown;
  readonly created_at: string;
  delivered: boolean;
  lease?: { token: string; expiresAt: number };
}

export function treeState() {
  let seq = 0;
  const st = {
    workspaces: new Map<string, TreeWorkspace>(),
    mail: [] as Array<TreeEnvelope>,
    claims: [] as Array<{ tree: string; path: string; workspace_id: string }>,
    /** Computers a laptop runtime's computer is (driver local): a lead there keeps builders unless it asks for Cloud. */
    laptops: new Set<string>(),
    /** The computer the next spawns that need a fresh one land on (the test enrolled their runtimes), in order. */
    nextComputers: [] as Array<string>,
    /**
     * A project's other computers ("cells", SPEC §8.1): with none queued in nextComputers, a builder that needs another
     * computer goes to the first of these with room, by the capacity its heartbeat last reported less the builders
     * placed there since. None has room: Cloud would fork a new cell; here the spawn is refused, so a test sees it.
     */
    cells: [] as Array<string>,
    /** A computer's last reported capacity (set by testCloud from its heartbeats). */
    capacityOf: undefined as ((computerId: string) => { readonly chats: number; readonly used: number } | undefined) | undefined,
    /** A computer as a named spawn's placement reads it (set by testCloud from its chat stand-in's computers). */
    computer: undefined as ((id: string) => { readonly laptop: boolean; readonly person: string; readonly deleted: boolean } | undefined) | undefined,
    /** Whose work a tree is: its lead chat's person (Cloud's lead.created_by), set by testCloud. */
    personOf: undefined as ((lead: TreeWorkspace) => string | undefined) | undefined,
    /** Every spawn as asked (the body), and where it went. */
    spawns: [] as Array<{ body: Record<string, unknown>; computer: string; made: boolean }>,
    /** Chats registered with Cloud (PUT runtime/sessions/{id}, which the chat stand-in answers), as each runtime sent them. */
    registrations: new Map<string, { body: Record<string, unknown>; computer: string }>(),
    /** Cloud's workspace of a registered chat (set by testCloud from its chat stand-in). */
    resolve: undefined as ((workspaceId: string) => { session_id: string; computer_id: string } | undefined) | undefined,
    /** Computer-wide waits runtimes held (a runtime reading tree mail holds Cloud's long wait, never a poll). */
    computerWaits: 0,
    /** Bodies Cloud's strict decoder would refuse (an unknown field, a wrong type), by route: each answered 400. */
    refused: [] as Array<{ route: string; why: string }>,
    /** Takes of tree mail (mail/deliveries?channel=tree), by any runtime. */
    takes: 0,
    /** A Cloud from before the computer-wide wait: it answers that wait 404, as one without the route would. */
    oldCloud: false,
    /** When set, every mail route answers this status (Cloud away) until cleared. */
    down: undefined as number | undefined,
    /** Mail ids sort by when they were sent, as Cloud's UUIDv7 ids do. */
    nextId: () => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
    /** Posts mail as another computer's runtime would (a builder's result, a lead's message). */
    post: (mail: { from: string; to: string; verb: string; body: string; reply_to?: string; wakes?: boolean; request_id?: string; payload?: unknown }) => {
      const from = st.workspaces.get(mail.from)!;
      const envelope: TreeEnvelope = {
        id: st.nextId(),
        tree: from.root,
        request_id: mail.request_id ?? randomUUID(),
        verb: mail.verb,
        channel: "tree",
        from_workspace_id: mail.from,
        to_workspace_id: mail.to,
        body: mail.body,
        wakes: mail.wakes ?? mail.verb !== "note",
        reply_to: mail.reply_to ?? null,
        payload: mail.payload ?? null,
        created_at: new Date().toISOString(),
        delivered: false,
      };
      st.mail.push(envelope);
      return envelope;
    },
  };
  return st;
}
export type TreeState = ReturnType<typeof treeState>;

/** Keeps a chat registration's fields (the chat stand-in answers the route itself). */
export function observeRegistration(st: TreeState, input: { method: string; url: URL; body: Record<string, unknown>; computer: string | undefined }) {
  const register = /^\/api\/v1\/code\/runtime\/sessions\/([^/]+)$/.exec(input.url.pathname);
  if (register === null || input.method !== "PUT" || input.computer === undefined) return;
  st.registrations.set(decodeURIComponent(register[1]!), { body: input.body, computer: input.computer });
}

/** Cloud's long wait for tree mail to any workspace on the caller's computer (mail/wait?channel=tree, no workspace). */
export async function treeComputerWait(st: TreeState, input: { method: string; url: URL; computer: string | undefined; now: number }, reply: (status: number, body: unknown) => void) {
  const route = input.url.pathname.replace(/^\/api\/v1\/code\//, "");
  if (route !== "mail/wait" || input.method !== "GET" || input.url.searchParams.has("workspace_id") || input.url.searchParams.get("channel") !== "tree") return false;
  if (input.computer === undefined) return (reply(401, { error: { code: "cave_unauthorized", message: "cave_unauthorized" } }), true);
  if (st.oldCloud) return (reply(404, { error: { code: "cave_not_found", message: "Workspace not found." } }), true);
  if (st.down !== undefined) return (reply(st.down, { error: { code: "cave_unavailable", message: "down" } }), true);
  st.computerWaits++;
  const deadline = Date.now() + Math.min(Number(input.url.searchParams.get("timeout_ms") ?? 25_000), 25_000);
  const ready = () =>
    st.mail.some((m) => !m.delivered && m.channel === "tree" && m.to_workspace_id !== null && lookup(st, m.to_workspace_id)?.computer === input.computer && (m.lease === undefined || m.lease.expiresAt < Date.now()));
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return (reply(200, { ready: ready(), timed_out: !ready() }), true);
}

/** A tree workspace by Cloud's id: one the tree made, or a registered chat's (a lead), made a tree root on first use. */
function lookup(st: TreeState, id: string): TreeWorkspace | undefined {
  const known = st.workspaces.get(id);
  if (known !== undefined) return known;
  const chat = st.resolve?.(id);
  if (chat === undefined) return undefined;
  const fields = st.registrations.get(chat.session_id)?.body ?? {};
  const made: TreeWorkspace = {
    id,
    root: id,
    parent: null,
    computer: chat.computer_id,
    status: "active",
    title: String(fields.title ?? "Chat"),
    repo: String(fields.repo ?? ""),
    base_branch: String(fields.base_branch ?? ""),
    branch: String(fields.branch ?? ""),
    engine: String(fields.engine ?? "caveman"),
    session_id: chat.session_id,
  };
  st.workspaces.set(id, made);
  return made;
}

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
  ...(m.payload === null ? {} : { payload: m.payload }),
});
const workspaceView = (w: TreeWorkspace) => ({
  id: w.id,
  title: w.title,
  repo: w.repo,
  base_branch: w.base_branch,
  branch: w.branch,
  engine: w.engine,
  computer_id: w.computer,
  parent_id: w.parent,
  status: w.status,
});

/**
 * The request bodies Cloud's mail routes decode (mailbox.go SpawnInput, MailInput, ClaimInput, ReleaseInput, AckInput;
 * mail_api.go MailDeliveries), field by field. Cloud decodes strictly (httpx.DecodeJSON, DisallowUnknownFields): an
 * unknown field or a value of the wrong type is a 400 "Invalid JSON.", and so it is here.
 */
export type FieldKind =
  | "string"
  | "strings"
  | "int"
  | "bool"
  /** json.RawMessage: any JSON. */
  | "raw"
  /** time.Time: an RFC 3339 string. */
  | "time"
  /** MoveTarget: "cloud", or an object naming exactly one of runtime_id and computer_id. */
  | "target"
  /** A nested struct, decoded as strictly. */
  | { readonly [field: string]: FieldKind }
  /** A list of one kind. */
  | readonly [FieldKind];
const INPUTS: Record<string, Readonly<Record<string, FieldKind>>> = {
  "mail/spawn": {
    request_id: "string",
    from_workspace_id: "string",
    title: "string",
    brief: "string",
    engine: "string",
    branch: "string",
    computer_id: "string",
    where: "string",
    model: "string",
    lead_session_id: "string",
    schedule: "raw",
  },
  "mail/task": { request_id: "string", from_workspace_id: "string", to_workspace_id: "string", body: "string", channel: "string", reply_to: "string" },
  "mail/claim": { request_id: "string", from_workspace_id: "string", paths: "strings", ttl_seconds: "int" },
  "mail/release": { request_id: "string", from_workspace_id: "string", paths: "strings" },
  "mail/deliveries": { limit: "int" },
  "mail/deliveries/ack": { lease_token: "string", ids: "strings" },
};
INPUTS["mail/note"] = INPUTS["mail/task"]!;
INPUTS["mail/ask"] = INPUTS["mail/task"]!;

/** Why Cloud's decoder would refuse `body` for `route`, or undefined when it takes it. */
export function strictRefusal(route: string, body: Record<string, unknown>): string | undefined {
  const fields = INPUTS[route];
  return fields === undefined ? undefined : refusalFor(fields, body);
}

/**
 * Why Go's encoding/json with DisallowUnknownFields (httpx.DecodeJSON) would refuse `body` for a struct of `fields`:
 * an unknown field at any depth, or a value of the wrong type (null is every type's zero). undefined when it decodes.
 */
export function refusalFor(fields: Readonly<Record<string, FieldKind>>, body: unknown, at = ""): string | undefined {
  if (body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) return `json: cannot unmarshal ${Array.isArray(body) ? "array" : typeof body} into ${at || "the body"}`;
  for (const [key, value] of Object.entries(body)) {
    const kind = fields[key];
    if (kind === undefined) return `json: unknown field "${at}${key}"`;
    const why = misfit(kind, value, `${at}${key}`);
    if (why !== undefined) return why;
  }
  return undefined;
}

const misfit = (kind: FieldKind, value: unknown, at: string): string | undefined => {
  if (value === null || kind === "raw") return undefined;
  const wrong = () => `json: cannot unmarshal ${Array.isArray(value) ? "array" : typeof value} into field ${at}`;
  if (kind === "string") return typeof value === "string" ? undefined : wrong();
  if (kind === "int") return typeof value === "number" && Number.isInteger(value) ? undefined : wrong();
  if (kind === "bool") return typeof value === "boolean" ? undefined : wrong();
  if (kind === "strings") return Array.isArray(value) && value.every((v) => typeof v === "string") ? undefined : wrong();
  if (kind === "time") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) ? undefined : `parsing time ${JSON.stringify(value)} for field ${at}`;
  if (kind === "target") {
    if (value === "cloud") return undefined;
    const to = value as { runtime_id?: unknown; computer_id?: unknown };
    const named = (v: unknown) => typeof v === "string" && v !== "";
    return typeof value === "object" && !Array.isArray(value) && named(to.runtime_id) !== named(to.computer_id) ? undefined : `to is "cloud", {"runtime_id": …} or {"computer_id": …}`;
  }
  if (Array.isArray(kind)) {
    if (!Array.isArray(value)) return wrong();
    for (const [i, item] of value.entries()) {
      const why = misfit(kind[0]!, item, `${at}[${i}]`);
      if (why !== undefined) return why;
    }
    return undefined;
  }
  return refusalFor(kind as Readonly<Record<string, FieldKind>>, value, `${at}.`);
};

/** Answers true when it served the request. `computer`: the calling runtime's computer, undefined without a valid token. */
export async function treeRoutes(
  st: TreeState,
  input: { method: string; url: URL; body: Record<string, unknown>; computer: string | undefined; now: number },
  reply: (status: number, body: unknown) => void,
): Promise<boolean> {
  const { method, url, body, computer } = input;
  const route = url.pathname.replace(/^\/api\/v1\/code\//, "");
  const mine =
    /^mail\/(spawn|task|note|ask|claim|release)$/.test(route) ||
    // A workspace's wait; the computer's own (no workspace_id) is the chat stand-in's.
    (route === "mail/wait" && url.searchParams.has("workspace_id")) ||
    (route === "mail/deliveries" && url.searchParams.get("channel") === "tree") ||
    (route === "mail/deliveries/ack" && Array.isArray(body.ids) && (body.ids as Array<string>).some((id) => st.mail.some((m) => m.id === id)));
  if (!mine) return false;
  const refuse = (status: number, code: string, message = code) => (reply(status, { error: { code, message } }), true);
  if (computer === undefined) return refuse(401, "cave_unauthorized");
  if (st.down !== undefined) return refuse(st.down, "cave_unavailable", "down");
  const strict = method === "POST" ? strictRefusal(route, body) : undefined;
  if (strict !== undefined) {
    st.refused.push({ route, why: strict });
    return refuse(400, "cave_bad_request", "Invalid JSON.");
  }
  const sender = (id: unknown): { w: TreeWorkspace; refusal?: undefined } | { refusal: readonly [number, string] } => {
    const w = typeof id === "string" ? lookup(st, id) : undefined;
    if (w === undefined) return { refusal: [404, "cave_not_found"] };
    if (w.computer !== computer) return { refusal: [409, "cave_code_session_elsewhere"] };
    if (w.status !== "active") return { refusal: [409, "cave_code_workspace_archived"] };
    return { w };
  };
  const replay = (from: TreeWorkspace, requestId: string, verb: string) => {
    const prior = st.mail.find((m) => m.tree === from.root && m.request_id === requestId);
    if (prior === undefined) return undefined;
    if (prior.verb !== verb || prior.from_workspace_id !== from.id) return "conflict" as const;
    return prior;
  };
  const post = (from: TreeWorkspace, requestId: string, e: { verb: string; channel: string; to: string | null; body: string; wakes: boolean; reply_to?: string | null; payload?: unknown }) => {
    const envelope: TreeEnvelope = {
      id: st.nextId(),
      tree: from.root,
      request_id: requestId,
      verb: e.verb,
      channel: e.channel,
      from_workspace_id: from.id,
      to_workspace_id: e.to,
      body: e.body,
      wakes: e.wakes,
      reply_to: e.reply_to ?? null,
      payload: e.payload ?? null,
      created_at: new Date(input.now).toISOString(),
      delivered: false,
    };
    st.mail.push(envelope);
    return envelope;
  };

  if (route === "mail/spawn" && method === "POST") {
    const named = typeof body.computer_id === "string" && body.computer_id !== "" ? body.computer_id : undefined;
    if (named !== undefined && typeof body.where === "string" && body.where !== "") return refuse(400, "cave_bad_request", "Name computer_id or where, not both.");
    const found = sender(body.from_workspace_id);
    if (found.refusal) return refuse(found.refusal[0], found.refusal[1]);
    const lead = found.w;
    if (lead.parent !== null) return refuse(409, "cave_code_not_lead");
    const requestId = String(body.request_id ?? "");
    if (requestId === "") return refuse(400, "cave_bad_request");
    const prior = replay(lead, requestId, "spawn");
    if (prior === "conflict") return refuse(409, "cave_code_request_conflict");
    if (prior !== undefined) return (reply(201, { workspace: workspaceView(st.workspaces.get(prior.to_workspace_id!)!), message: view(prior) }), true);
    if (typeof body.lead_session_id === "string" && body.lead_session_id !== "" && body.lead_session_id !== lead.session_id) return refuse(404, "cave_not_found");
    if (typeof body.model === "string" && (body.model.length > 200 || /\s/.test(body.model))) return refuse(400, "cave_bad_request");
    // A schedule for the builder to hold (mailbox.go scheduleOf): one small JSON object, passed on as is.
    const schedule = body.schedule === undefined || body.schedule === null ? undefined : body.schedule;
    if (schedule !== undefined && (typeof schedule !== "object" || Array.isArray(schedule) || JSON.stringify(schedule).length > 4096)) return refuse(400, "cave_bad_request");
    const active = [...st.workspaces.values()].filter((w) => w.parent === lead.id && w.status === "active").length;
    // mailbox.go MaxBuilders, counting the ones at work; the runtime's own ceiling for one lead (builders.ts) is the same.
    if (active >= 64) return refuse(409, "cave_code_builder_limit");
    // placeBuilder: the computer named (the lead's own, or a Cloud computer of the tree's person), else as before.
    if (named !== undefined && named !== lead.computer) {
      const c = st.computer?.(named);
      if (c === undefined || c.deleted || c.laptop || st.laptops.has(named)) return refuse(404, "cave_not_found", "Computer not found.");
      if (c.person !== st.personOf?.(lead))
        return refuse(403, "cave_code_computer_not_yours", "A builder runs on its lead's computer or on a Cloud computer the person whose work this is made, never on someone else's.");
    }
    const laptop = st.laptops.has(lead.computer);
    const made = named === undefined && (!laptop || body.where === "cloud");
    const engine = String(body.engine || lead.engine);
    if (made && laptop && engine !== "caveman" && engine !== "claude-agent" && engine !== "codex")
      return refuse(400, "cave_code_engine_unavailable", "ACP agents don't run on a Cloud computer yet: their CLI isn't on the computer. Pick the Caveman engine, Claude Agent or Codex.");
    // The scheduler's part (SPEC §2 rule 6): among the project's cells, the first whose reported capacity still has
    // room for one more chat, counting the builders placed there that it may not have reported yet.
    const placedOn = (computer: string) => [...st.workspaces.values()].filter((w) => w.computer === computer && w.parent !== null && w.status === "active").length;
    const cell =
      made && st.nextComputers.length === 0
        ? st.cells.find((id) => {
            const capacity = st.capacityOf?.(id);
            return capacity !== undefined && Math.max(capacity.used, placedOn(id)) < capacity.chats;
          })
        : undefined;
    // No cell with room: real Cloud places the chat on a sleeping computer or a new one, or refuses with the limit it
    // met (control-api project_computers.go); it has no "every computer is full" refusal, so neither does this.
    const place = named ?? (made ? (cell ?? st.nextComputers.shift() ?? randomUUID()) : lead.computer);
    st.spawns.push({ body, computer: place, made });
    const id = randomUUID();
    const builder: TreeWorkspace = {
      id,
      root: lead.root,
      parent: lead.id,
      computer: place,
      status: "active",
      title: String(body.title || String(body.brief ?? "").split("\n")[0]),
      repo: lead.repo,
      base_branch: lead.branch,
      branch: String(body.branch ?? ""),
      engine,
      session_id: randomUUID(),
    };
    st.workspaces.set(id, builder);
    const message = post(lead, requestId, {
      verb: "spawn",
      channel: "tree",
      to: id,
      body: String(body.brief ?? ""),
      wakes: true,
      payload: { kind: "spawn", workspace_id: id, session_id: builder.session_id, title: builder.title, repo: builder.repo, base_branch: builder.base_branch, branch: builder.branch, engine: builder.engine, lead_workspace_id: lead.id, lead_session_id: lead.session_id, ...(typeof body.model === "string" && body.model !== "" ? { model: body.model } : {}), ...(schedule === undefined ? {} : { schedule }) },
    });
    return (reply(201, { workspace: workspaceView(builder), message: view(message) }), true);
  }

  const send = /^mail\/(task|note|ask)$/.exec(route);
  if (send && method === "POST") {
    const verb = send[1]!;
    const found = sender(body.from_workspace_id);
    if (found.refusal) return refuse(found.refusal[0], found.refusal[1]);
    const from = found.w;
    const requestId = String(body.request_id ?? "");
    if (requestId === "" || String(body.body ?? "").trim() === "") return refuse(400, "cave_bad_request");
    const prior = replay(from, requestId, verb);
    if (prior === "conflict") return refuse(409, "cave_code_request_conflict");
    if (prior !== undefined) return (reply(200, view(prior)), true);
    const to = lookup(st, String(body.to_workspace_id));
    if (to === undefined || to.root !== from.root) return refuse(404, "cave_not_found");
    if (to.status !== "active") return refuse(409, "cave_code_workspace_archived");
    let wakes = verb !== "note";
    const replyTo = typeof body.reply_to === "string" && body.reply_to !== "" ? body.reply_to : null;
    if (replyTo !== null) {
      const asked = st.mail.find((m) => m.id === replyTo && m.tree === from.root);
      if (asked === undefined) return refuse(404, "cave_not_found");
      wakes = wakes || (asked.verb === "ask" && asked.from_workspace_id === to.id && asked.to_workspace_id === from.id);
    }
    const message = post(from, requestId, { verb, channel: String(body.channel ?? ""), to: to.id, body: String(body.body), wakes, reply_to: replyTo });
    return (reply(200, view(message)), true);
  }

  if (route === "mail/wait" && method === "GET") {
    const found = sender(url.searchParams.get("workspace_id"));
    if (found.refusal) return refuse(found.refusal[0], found.refusal[1]);
    const me = found.w;
    const after = url.searchParams.get("after") ?? "";
    const deadline = input.now + Math.min(Number(url.searchParams.get("timeout_ms") ?? 25_000), 25_000);
    for (;;) {
      // Mail between Macs is never read through a chat's wait (mailbox.go waitOnce): Macs take it on channel mac.
      const messages = st.mail.filter((m) => m.to_workspace_id === me.id && m.from_workspace_id !== me.id && m.id > after && m.channel !== "mac").map(view);
      const children = [...st.workspaces.values()].filter((w) => w.parent === me.id);
      const finished = children.filter((w) => w.status === "archived").map(workspaceView);
      const done = messages.some((m) => m.wakes) || (children.length > 0 && finished.length === children.length);
      if (done || Date.now() >= deadline) return (reply(200, { messages, finished, timed_out: !done }), true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  if ((route === "mail/claim" || route === "mail/release") && method === "POST") {
    const found = sender(body.from_workspace_id);
    if (found.refusal) return refuse(found.refusal[0], found.refusal[1]);
    const me = found.w;
    const paths = ((body.paths as Array<string>) ?? []).map((p) => p.trim());
    if (route === "mail/release") {
      const released = st.claims.filter((c) => c.tree === me.root && c.workspace_id === me.id && (paths.length === 0 || paths.includes(c.path))).map((c) => c.path);
      st.claims = st.claims.filter((c) => !(c.tree === me.root && c.workspace_id === me.id && released.includes(c.path)));
      return (reply(200, { released }), true);
    }
    const overlaps = (a: string, b: string) => a === b || a === "." || b === "." || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
    for (const path of paths) {
      const others = st.claims.filter((c) => c.tree === me.root && c.workspace_id !== me.id && overlaps(c.path, path));
      if (others.length === 0 && !st.claims.some((c) => c.tree === me.root && c.workspace_id === me.id && c.path === path)) st.claims.push({ tree: me.root, path, workspace_id: me.id });
    }
    const live = st.claims.filter((c) => c.tree === me.root);
    return (
      reply(200, {
        claims: live.filter((c) => c.workspace_id === me.id).map(({ path, workspace_id }) => ({ path, workspace_id })),
        conflicts: live.filter((c) => c.workspace_id !== me.id && paths.some((p) => overlaps(p, c.path))).map(({ path, workspace_id }) => ({ path, workspace_id })),
      }),
      true
    );
  }

  if (route === "mail/deliveries" && method === "POST") {
    st.takes++;
    const token = randomUUID();
    const taken = st.mail.filter(
      (m) =>
        !m.delivered &&
        m.channel === "tree" &&
        m.to_workspace_id !== null &&
        lookup(st, m.to_workspace_id)?.computer === computer &&
        (m.lease === undefined || m.lease.expiresAt < input.now),
    );
    for (const m of taken) m.lease = { token, expiresAt: input.now + 5 * 60_000 };
    return (reply(200, { lease_token: taken.length > 0 ? token : null, messages: taken.map(view) }), true);
  }

  if (route === "mail/deliveries/ack" && method === "POST") {
    const ids = body.ids as Array<string>;
    const delivered: Array<string> = [];
    for (const m of st.mail) {
      if (ids.includes(m.id) && m.lease?.token === body.lease_token && !m.delivered) {
        m.delivered = true;
        delivered.push(m.id);
      }
    }
    return (reply(200, { delivered, lost: ids.filter((id) => !delivered.includes(id)) }), true);
  }
  return false;
}
