// Test-only: the part of Caveman Cloud a phone reaches, in front of the stand-in (testCloud.ts), on one origin as the
// real one is. A phone has no cookie and no runtime of its own, so it uses these, with Cloud's shapes and refusals:
// - the device sign-in with the "code" connection (control-api device.go): POST /api/v1/auth/device/code, the approve
//   page at /activate (here: opening it approves, as `user-1`; tests call `approve`), POST .../device/token (pending,
//   then the grant, once), .../device/ack, GET /api/v1/auth/me, POST /api/v1/auth/refresh (JSON, each refresh token
//   good once) and /api/v1/auth/logout;
// - POST /api/v1/code/desktop-token (code_desktop_token.go): a short bearer for the chat routes and relay attach only,
//   minted from the sign-in and ended with it;
// - the chat routes on that bearer (the stand-in's own, for the person the bearer is), and wake-hint, which resumes a
//   sleeping Cloud computer's row (a test starts its runtime, as the computers service would);
// - on the sign-in itself (Caveman Cloud the spec): GET /api/v1/code/computers (the person's own, asleep ones too),
//   POST /api/v1/code/workspaces with `computer: {kind: "cloud"}` (placed on the person's Cloud computer; the client
//   starts the chat on its runtime, as the web does) and GET /api/v1/code/projects;
// - the relay's client side, GET /relay/v1/runtimes/{id} as a WebSocket (relay conn.go): the bearer beside the
//   subprotocol or in Authorization, refused before the upgrade without one (401), closed 4404 when the runtime is not
//   connected and 4401 when the bearer stops being good, each client socket one stream on the runtime's relay link.
// Answers carry CORS headers, so the phone app's web build on another port reaches it in a browser.
import { randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import type { RelaySide, TestCloud } from "./testCloud.ts";

interface Grant {
  readonly person: string;
  access: string;
  accessExpiresAt: number;
  refresh: string;
}

export async function startPhoneCloud(
  cloud: TestCloud,
  options: {
    readonly accessTtlMs?: number;
    readonly bearerTtlMs?: number;
    readonly intervalSeconds?: number;
    readonly computersRoute?: boolean;
    /** A port to listen on (a stage a built app points at); any free one by default. */ readonly port?: number;
  } = {},
) {
  const state = {
    /** Sign-ins started, by device code: approved once `person` is set, handed out once. */
    codes: new Map<
      string,
      { user_code: string; expiresAt: number; person?: string; taken?: true }
    >(),
    grants: new Set<Grant>(),
    /** Relay bearers (`cvdt_`): who they are for, the grant that minted them, and when they lapse. */
    bearers: new Map<string, { person: string; grant: Grant; expiresAt: number }>(),
    emails: new Map<string, string>([["user-1", "ada@example.com"]]),
    accessTtlMs: options.accessTtlMs ?? 15 * 60_000,
    bearerTtlMs: options.bearerTtlMs ?? 60 * 60_000,
    /** Every request, in order (method and path), and every relay attach with how it ended. */
    seen: [] as Array<{ method: string; path: string; status: number }>,
    attaches: [] as Array<{ runtime_id: string; outcome: "bridged" | "401" | "404" | "4404" }>,
    wakes: [] as Array<string>,
    /** Workspaces a sign-in asked for on a Cloud computer (POST workspaces), with the computer Cloud placed each on. */
    workspaces: [] as Array<{
      id: string;
      title: string;
      repo: string;
      base_branch: string;
      engine: string;
      computer_id: string;
      created_by: string;
    }>,
    /** False: a Cloud from before the spec, which refuses the sign-in its computers and workspaces (403). */
    computersRoute: options.computersRoute ?? true,
    /** Cloud's refusal of the next wake hints (402 nothing pays for the time, 409 a limit); undefined: it wakes. */
    refuseWakes: undefined as { status: number; code: string; message: string } | undefined,
    /** Cloud's refusal of a workspace on a Cloud computer; undefined: it places it. */
    refuseWorkspaces: undefined as { status: number; code: string; message: string } | undefined,
    /** What the install says about direct channels to Macs (the chat list's `direct`); undefined: it says nothing. */
    direct: undefined as { enabled: boolean; stun_servers: ReadonlyArray<string> } | undefined,
  };
  /**
   * The relay between a phone and its Mac, which a test may play as hostile: every text frame it carried each way,
   * a rewrite of frames on their way to the phone, and frames of its own sent either way on the newest phone socket.
   */
  const relayed = {
    frames: [] as Array<{ to: "phone" | "mac"; text: string }>,
    /** Rewrites a frame on its way to the phone; return it unchanged to pass it. */
    tamper: undefined as ((text: string) => string) | undefined,
    /** Sends `text` to the newest phone socket, as if the runtime had (a replayed or forged frame). */
    toPhone: (_text: string): void => undefined,
    /** Sends `text` to the runtime on the newest phone socket's stream, as if the phone had. */
    toMac: (_text: string): void => undefined,
    /** Whether the runtime closed the newest phone socket's stream. */
    closedByMac: (): boolean => false,
  };
  const sockets = new Set<{ socket: WebSocket; bearer: string }>();
  const secret = (prefix: string) => `${prefix}${randomBytes(24).toString("base64url")}`;
  const grantOf = (access: string | undefined) =>
    [...state.grants].find((g) => g.access === access && g.accessExpiresAt > Date.now());
  const bearerOf = (token: string | undefined) => {
    const held = token === undefined ? undefined : state.bearers.get(token);
    return held && held.expiresAt > Date.now() && state.grants.has(held.grant) ? held : undefined;
  };
  /** The stand-in's own bearer for `person`: its chat routes take a person by theirs. */
  const personToken = (person: string) =>
    [...cloud.state.chats.persons].find(([, p]) => p === person)?.[0];
  /** Bearers that stopped being good end their relay sockets (the relay's 30 s recheck, at once here). */
  const recheck = () => {
    for (const held of sockets)
      if (!bearerOf(held.bearer)) held.socket.close(4401, "sign in again");
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const cors = {
      "access-control-allow-origin": request.headers.origin ?? "*",
      "access-control-allow-headers": "authorization, content-type, accept",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      vary: "origin",
    };
    const reply = (status: number, body?: unknown, type = "application/json") => {
      state.seen.push({ method: request.method ?? "GET", path: url.pathname, status });
      response.writeHead(status, {
        ...cors,
        ...(body === undefined ? {} : { "content-type": type }),
      });
      response.end(
        body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      );
    };
    const refuse = (status: number, code: string, message = code) =>
      reply(status, { error: { code, message } });
    if (request.method === "OPTIONS") return reply(204);
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      // Cloud takes JSON only on these routes (415 otherwise: auth/refresh).
      if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
        return refuse(415, "cave_unsupported_media_type");
      try {
        body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return refuse(400, "cave_bad_request");
      }
    }
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /api/v1/auth/device/code") {
      if (body.connection !== "code") return refuse(400, "cave_bad_request", "connection is code.");
      const device_code = secret("dc_");
      const letters = randomBytes(8).toString("hex").toUpperCase();
      const user_code = `${letters.slice(0, 4)}-${letters.slice(4, 8)}`;
      state.codes.set(device_code, { user_code, expiresAt: Date.now() + 600_000 });
      const base = `http://${request.headers.host}`;
      return reply(200, {
        device_code,
        user_code,
        verification_uri: `${base}/activate`,
        verification_uri_complete: `${base}/activate?user_code=${user_code}&connection=code`,
        expires_in: 600,
        interval: options.intervalSeconds ?? 1,
      });
    }
    if (route === "GET /activate") {
      const ok = approve(url.searchParams.get("user_code") ?? "");
      return reply(
        ok ? 200 : 404,
        `<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px">${ok ? "Signed in. Go back to Caveman Code." : "That code is not waiting."}</body>`,
        "text/html",
      );
    }
    if (route === "POST /api/v1/auth/device/token") {
      const code = state.codes.get(String(body.device_code));
      if (!code || code.taken) return reply(400, { error: "invalid_grant" });
      if (code.expiresAt <= Date.now()) return reply(400, { error: "expired_token" });
      if (code.person === undefined) return reply(400, { error: "authorization_pending" });
      code.taken = true;
      const grant: Grant = {
        person: code.person,
        access: secret("at_"),
        accessExpiresAt: Date.now() + state.accessTtlMs,
        refresh: secret("rt_"),
      };
      state.grants.add(grant);
      return reply(200, {
        access_token: grant.access,
        token_type: "Bearer",
        expires_in: Math.round(state.accessTtlMs / 1000),
        refresh_token: grant.refresh,
        scope: "org:read code:read code:write",
        delivery_ack_token: "ack-1",
      });
    }
    if (route === "POST /api/v1/auth/device/ack")
      return grantOf(bearer)
        ? reply(200, { acknowledged: true })
        : refuse(401, "cave_unauthorized");
    if (route === "POST /api/v1/auth/refresh") {
      const grant = [...state.grants].find((g) => g.refresh === body.refresh_token);
      if (!grant) return refuse(401, "cave_unauthorized");
      // Rotated: the old pair is spent.
      grant.access = secret("at_");
      grant.accessExpiresAt = Date.now() + state.accessTtlMs;
      grant.refresh = secret("rt_");
      return reply(200, { access_token: grant.access, refresh_token: grant.refresh });
    }
    if (route === "POST /api/v1/auth/logout") {
      const grant =
        grantOf(bearer) ?? [...state.grants].find((g) => g.refresh === body.refresh_token);
      if (grant) state.grants.delete(grant);
      recheck();
      return reply(200, {});
    }
    if (route === "GET /api/v1/auth/me") {
      const grant = grantOf(bearer);
      if (!grant) return refuse(401, "cave_unauthorized");
      return reply(200, {
        user: {
          id: grant.person,
          email: state.emails.get(grant.person) ?? `${grant.person}@example.com`,
          organization_id: cloud.state.organizationId,
          role: "owner",
        },
      });
    }
    if (route === "POST /api/v1/code/desktop-token") {
      // A signed-in session only: a relay bearer mints nothing.
      const grant = grantOf(bearer);
      if (!grant) return refuse(401, "cave_unauthorized");
      const token = secret("cvdt_");
      const expiresAt = Date.now() + state.bearerTtlMs;
      state.bearers.set(token, { person: grant.person, grant, expiresAt });
      return reply(200, { token, expires_at: new Date(expiresAt).toISOString() });
    }
    // The sign-in's own routes beside the token mint (Caveman Cloud the spec, codeAppPatterns): the person's computers,
    // asleep ones too, a workspace on a Cloud computer, and their projects. A relay bearer reads 401 on them, as on
    // Cloud; a Cloud from before 0165 refuses the first two to the sign-in as well (`state.computersRoute` false).
    if (
      route === "GET /api/v1/code/computers" ||
      route === "POST /api/v1/code/workspaces" ||
      route === "GET /api/v1/code/projects"
    ) {
      const grant = grantOf(bearer);
      if (!grant) return refuse(401, "cave_unauthorized");
      if (route === "GET /api/v1/code/projects") {
        const token = personToken(grant.person);
        if (token === undefined) return refuse(403, "cave_forbidden");
        const answer = await fetch(`${cloud.url}${url.pathname}${url.search}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        return reply(
          answer.status,
          await answer.text(),
          answer.headers.get("content-type") ?? "application/json",
        );
      }
      if (!state.computersRoute)
        return refuse(
          403,
          "cave_agent_operation_forbidden",
          "This operation is not available to an agent connection.",
        );
      if (route === "GET /api/v1/code/computers")
        return reply(200, { computers: cloud.computersOf(grant.person), cloud_computers: true });
      // Cloud takes these fields and no other (a body naming a person or an organization is refused whole).
      const known = new Set([
        "title",
        "repo",
        "base_branch",
        "branch",
        "engine",
        "computer_id",
        "computer",
      ]);
      const computer = body.computer as { kind?: unknown } | undefined;
      if (
        Object.keys(body).some((key) => !known.has(key)) ||
        typeof body.title !== "string" ||
        body.title === "" ||
        typeof body.engine !== "string" ||
        computer?.kind !== "cloud"
      )
        return refuse(400, "cave_bad_request", "Invalid JSON.");
      if (typeof body.repo !== "string" || body.repo === "")
        return refuse(400, "cave_bad_request", "A Cloud computer needs a repository on GitHub.");
      if (state.refuseWorkspaces)
        return refuse(
          state.refuseWorkspaces.status,
          state.refuseWorkspaces.code,
          state.refuseWorkspaces.message,
        );
      // Placement is Cloud's (CONTRACT §6.3): the person's Cloud computer, woken when it sleeps, else a new one.
      const computerId = cloud.state.chats.cloudComputerFor(grant.person);
      const placed = cloud.state.chats.computers.get(computerId)!;
      if (placed.state === "suspended" || placed.state === "stopped") placed.state = "starting";
      const workspace = {
        id: randomUUID(),
        title: body.title,
        repo: body.repo,
        base_branch: typeof body.base_branch === "string" ? body.base_branch : "",
        engine: body.engine,
        computer_id: computerId,
        created_by: grant.person,
      };
      state.workspaces.push(workspace);
      return reply(201, { ...workspace, status: "active", sessions: [] });
    }
    // The relay bearer's allowlist: the chat routes, wake hints and latency reports.
    const wake = /^\/api\/v1\/code\/computers\/([^/]+)\/wake-hint$/.exec(url.pathname);
    if (
      url.pathname === "/api/v1/code/chats" ||
      url.pathname.startsWith("/api/v1/code/chats/") ||
      wake ||
      url.pathname === "/api/v1/code/telemetry/latency"
    ) {
      const held = bearerOf(bearer);
      if (!held) return refuse(401, "cave_unauthorized");
      if (wake) {
        // Only the person's own Cloud computer, and only one that sleeps is resumed (Caveman Cloud chats_wake.go).
        const id = decodeURIComponent(wake[1]!);
        const computer = cloud.state.chats.computers.get(id);
        if (
          !computer ||
          computer.kind !== "cloud" ||
          computer.person !== held.person ||
          computer.state === "deleted"
        )
          return refuse(404, "cave_not_found", "Computer not found.");
        if (state.refuseWakes)
          return refuse(
            state.refuseWakes.status,
            state.refuseWakes.code,
            state.refuseWakes.message,
          );
        state.wakes.push(id);
        const resumed = computer.state === "suspended";
        if (resumed) computer.state = "starting";
        return reply(202, { resumed, throttled: false, computer_state: computer.state });
      }
      if (url.pathname === "/api/v1/code/telemetry/latency") return reply(204);
      const token = personToken(held.person);
      if (token === undefined) return refuse(403, "cave_forbidden");
      const answer = await fetch(`${cloud.url}${url.pathname}${url.search}`, {
        method: request.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: request.headers.accept ?? "application/json",
          ...(raw.length > 0 ? { "content-type": "application/json" } : {}),
        },
        ...(raw.length > 0 ? { body: raw } : {}),
      });
      const text = await answer.text();
      // The install's word on direct channels rides the list, as Cloud sends it.
      if (answer.ok && url.pathname === "/api/v1/code/chats" && state.direct !== undefined)
        return reply(200, { ...(JSON.parse(text) as object), direct: state.direct });
      return reply(
        answer.status,
        text === "" ? undefined : text,
        answer.headers.get("content-type") ?? "application/json",
      );
    }
    // Everything else the bearer or the sign-in is not let near (GET /api/v1/code/runtimes among it: 403 for both).
    if (url.pathname.startsWith("/api/v1/"))
      return grantOf(bearer) || bearerOf(bearer)
        ? refuse(403, "cave_agent_operation_forbidden")
        : refuse(401, "cave_unauthorized");
    refuse(404, "not_found");
  });

  /** The person approves a sign-in on Cloud's page. */
  function approve(userCode: string, person = "user-1"): boolean {
    const code = [...state.codes.values()].find(
      (c) => c.user_code === userCode && c.person === undefined && c.expiresAt > Date.now(),
    );
    if (!code) return false;
    code.person = person;
    return true;
  }

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has("caveman.session.v1") ? "caveman.session.v1" : false,
  });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/relay\/v1\/runtimes\/([^/?]+)/.exec(request.url ?? "");
    const runtimeId = match ? decodeURIComponent(match[1]!) : "";
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim());
    const beside = offered.find((p) => p.startsWith("base64url.bearer."));
    const bearer =
      request.headers.authorization?.replace(/^Bearer /, "") ??
      (beside
        ? Buffer.from(beside.slice("base64url.bearer.".length), "base64url").toString("utf8")
        : undefined);
    const held = bearerOf(bearer);
    const refuse = (status: number, outcome: "401" | "404") => {
      state.attaches.push({ runtime_id: runtimeId, outcome });
      socket.end(
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\ncontent-length: 0\r\n\r\n`,
      );
    };
    if (!match || !held) return refuse(401, "401");
    // Only the person's own runtimes: another's reads as absent.
    const runtime = cloud.state.runtimes.get(runtimeId);
    if (!runtime || runtime.status !== "active" || (runtime.person ?? "user-1") !== held.person)
      return refuse(404, "404");
    wss.handleUpgrade(request, socket, head, (client) => {
      const side: RelaySide | undefined = cloud.state.relays.findLast(
        (s) =>
          s.ws.readyState === s.ws.OPEN &&
          !s.blackhole &&
          cloud.state.tokens.get(s.token)?.runtimeId === runtimeId,
      );
      if (!side) {
        state.attaches.push({ runtime_id: runtimeId, outcome: "4404" });
        return client.close(4404, "the runtime is not connected");
      }
      state.attaches.push({ runtime_id: runtimeId, outcome: "bridged" });
      const entry = { socket: client, bearer: bearer! };
      sockets.add(entry);
      const stream = side.open({ user_id: held.person });
      let closedByMac = false;
      const onFrame = (data: Buffer) => {
        if (!data.subarray(1, 17).equals(stream)) return;
        if (data[0] === 2) {
          const text = data.subarray(17).toString("utf8");
          relayed.frames.push({ to: "phone", text });
          client.send(relayed.tamper ? relayed.tamper(text) : text);
        } else if (data[0] === 4) {
          closedByMac = true;
          client.close(1000, data.subarray(17).toString("utf8").slice(0, 100));
        }
      };
      const onGone = () => client.close(4404, "the runtime is not connected");
      side.ws.on("message", onFrame);
      side.ws.on("close", onGone);
      relayed.toPhone = (text) => client.send(text);
      relayed.toMac = (text) => side.send(stream, text);
      relayed.closedByMac = () => closedByMac;
      client.on("message", (data) => {
        const text = data.toString("utf8");
        relayed.frames.push({ to: "mac", text });
        side.send(stream, text);
      });
      client.on("close", () => {
        sockets.delete(entry);
        side.ws.off("message", onFrame);
        side.ws.off("close", onGone);
        side.close(stream, "the client left");
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    relayed,
    approve,
    /** Every relay bearer stops being good now (an hour passed, in one step): open relay sockets close 4401. */
    lapseBearers: () => {
      for (const held of state.bearers.values()) held.expiresAt = 0;
      recheck();
    },
    /** Every access token lapses now (15 minutes passed): the next call on one is refused until it is refreshed. */
    lapseAccess: () => {
      for (const grant of state.grants) grant.accessExpiresAt = 0;
    },
    /** The sign-in is revoked in Cloud (signed out elsewhere, or a month old): nothing refreshes it. */
    revoke: () => {
      state.grants.clear();
      recheck();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type PhoneCloudStandIn = Awaited<ReturnType<typeof startPhoneCloud>>;
