// A stand-in Caveman Cloud for scripts/first-run-e2e.mjs where no real one is reachable (a Windows runner): the device
// sign-in Caveman Code uses (packages/runtime session-protocol/cloudSignin.ts), approved the way Cloud's activate page
// approves it (POST /api/v1/auth/device/approve, as packages/runtime cloudLink/realCloud.e2e.test.ts does against a
// real stack), then who approved, the organization, and enrolling this computer. Signed in, the page reads the
// person's chats and computers as Cloud's ListChats sends them (its desktop token, GET /api/v1/code/chats and the
// stream), with the person's other Mac on it: one signed in during its own first run that Cloud has never heard from,
// last_seen_at null, as this one is until its link runs. Two such Macs once left the window blank (0.1.5). Anything
// else answers 404, as an older Cloud would; the runtime treats that as "not offered". Every request is recorded, so
// the run can show what the app asked for.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// Ids are UUIDs, as Cloud's are: the runtime keeps an enrollment only with UUID ids (cloudLink/identity.ts).
export const E2E_PERSON = { id: randomUUID(), email: "ada@example.com", role: "owner", organization_id: randomUUID() };

export async function startE2eCloud() {
  const codes = new Map(); // device_code -> { user_code, approved, delivered }
  const requests = [];
  const owner = `owner-${randomBytes(8).toString("hex")}`;
  // This computer once enrolled, and the person's other Mac, never heard from (no sync there, so no link).
  const enrolled = [];
  const otherMac = { runtime_id: randomUUID(), computer_id: randomUUID(), kind: "laptop", name: "Ada's other Mac", online: false, last_seen_at: null, seq: 0 };
  const desktopTokens = new Set();
  const streams = new Set();
  // The page reads Cloud from its own origin (caveman-code://app), as it reads the hosted Cloud.
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept, x-cave-csrf", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", date: new Date().toUTCString(), ...cors });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      requests.push({ method: req.method, path: url.pathname, at: Date.now() });
      const route = `${req.method} ${url.pathname}`;
      if (req.method === "OPTIONS") return void (res.writeHead(204, cors), res.end());
      if (route === "POST /api/v1/auth/device/code") {
        const device_code = randomBytes(16).toString("hex");
        const user_code = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
        codes.set(device_code, { user_code, approved: false, connection: body.connection, provider: body.provider, intent: body.intent });
        const verification_uri = `${origin}/activate`;
        return json(res, 200, { device_code, user_code, verification_uri, verification_uri_complete: `${verification_uri}?user_code=${user_code}&connection=code`, interval: 1, expires_in: 600 });
      }
      if (route === "POST /api/v1/auth/device/approve") {
        if (bearer !== owner) return json(res, 401, { error: { code: "unauthorized" } });
        const entry = [...codes.values()].find((c) => c.user_code === body.user_code);
        if (!entry) return json(res, 404, { error: { code: "not_found", message: "no such code" } });
        entry.approved = true;
        return json(res, 200, { approved: true });
      }
      if (route === "POST /api/v1/auth/device/token") {
        const entry = codes.get(body.device_code);
        if (!entry) return json(res, 400, { error: "expired_token" });
        if (!entry.approved) return json(res, 400, { error: "authorization_pending" });
        entry.delivered = true;
        return json(res, 200, { access_token: `person-${randomBytes(8).toString("hex")}`, refresh_token: `refresh-${randomBytes(8).toString("hex")}`, delivery_ack_token: "ack" });
      }
      if (route === "POST /api/v1/auth/device/ack" || route === "POST /api/v1/auth/logout") return json(res, 200, {});
      if (route === "GET /api/v1/auth/me") return bearer ? json(res, 200, { user: E2E_PERSON }) : json(res, 401, { error: { code: "unauthorized" } });
      if (route === "GET /api/v1/org") return json(res, 200, { id: E2E_PERSON.organization_id, name: "Ada's team" });
      if (route === "POST /api/v1/code/runtimes") {
        const runtime = { id: randomUUID(), organization_id: E2E_PERSON.organization_id, computer_id: body.computer_id ?? randomUUID(), user_id: E2E_PERSON.id };
        enrolled.push({ ...runtime, name: body.name });
        return json(res, 201, runtime);
      }
      // The page's own bearer for the chat routes, minted from the sign-in (code_desktop_token.go).
      if (route === "POST /api/v1/code/desktop-token") {
        if (!bearer) return json(res, 401, { error: { code: "unauthorized" } });
        const token = `desktop-${randomBytes(8).toString("hex")}`;
        desktopTokens.add(token);
        return json(res, 200, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (url.pathname.startsWith("/api/v1/code/chats") && !desktopTokens.has(bearer)) return json(res, 401, { error: { code: "unauthorized" } });
      if (route === "GET /api/v1/code/chats") {
        // RuntimeState.LastSeenAt is a *time.Time: null until a heartbeat. ORDER BY last_seen_at DESC NULLS LAST, id.
        const mine = enrolled.map((r) => ({ runtime_id: r.id, computer_id: r.computer_id, kind: "laptop", name: r.name ?? "", online: false, last_seen_at: null, seq: 0 }));
        const runtimes = [...mine, otherMac].sort((a, b) => a.runtime_id.localeCompare(b.runtime_id));
        return json(res, 200, { chats: [], runtimes, settings: [], seq: 1, direct: { enabled: false, stun_servers: [] } });
      }
      if (route === "GET /api/v1/code/chats/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
        res.write(": open\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (/^POST \/api\/v1\/code\/runtimes\/[^/]+\/token$/.test(route)) return json(res, 200, { token: `runtime-${randomBytes(8).toString("hex")}` });
      return json(res, 404, { error: { code: "not_found", message: `${route} is not offered here` } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    /** The activate page's approval, with the owner's session. */
    approve: async (userCode) => {
      const response = await fetch(`${origin}/api/v1/auth/device/approve`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ user_code: userCode }) });
      if (!response.ok) throw new Error(`approve answered ${response.status}: ${await response.text()}`);
    },
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const stream of streams) stream.end();
        server.close(() => resolve());
      }),
  };
}

/** A real Cloud (CAVEMAN_E2E_CLOUD_URL with CAVEMAN_E2E_EMAIL and CAVEMAN_E2E_PASSWORD): approve as its person does. */
export async function realCloud(origin, email, password) {
  const login = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`sign-in to ${origin} answered ${login.status}: ${await login.text()}`);
  const { access_token } = await login.json();
  const api = (method, path, body) =>
    fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${access_token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return {
    origin,
    approve: async (userCode) => {
      const projects = await (await api("GET", "/api/v1/projects")).json();
      const response = await api("POST", "/api/v1/auth/device/approve", {
        user_code: userCode,
        project_id: projects.data[0].id,
        agent_connection: { name: "Caveman Code", scopes: ["org:read", "code:read", "code:write", "billing:write", "org:update"] },
      });
      if (!response.ok) throw new Error(`approve answered ${response.status}: ${await response.text()}`);
    },
    requests: [],
    close: async () => undefined,
  };
}
