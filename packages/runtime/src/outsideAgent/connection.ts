// How `caveman-code mcp` reaches Caveman Code (docs/ §2): the runtime that owns
// the home (liveRuntime), or the desktop app opened hidden when none runs; a Session Protocol client whose handshake
// is `outside_agent.become`, so every socket it opens (the first, every reconnect) is this agent's before anything
// else goes out on it; and a new client, same agent_id, when the runtime restarted on another port. The owner token
// is read from its 0600 file for each attempt and never logged or shown.
import * as fs from "node:fs";

import type { MethodName, OutsideAgentLevel, Params, Result, RpcError, Workspace } from "@caveman-app/session-protocol";
import { connect, HandshakeRefused, SessionProtocolError, type Client, type ConnectOptions, type ConnectionState } from "@caveman-app/session-protocol/client";
import { discoverRuntime, runtimeTokenPath, type PublishedRuntime } from "@caveman-app/shared/runtimeDiscovery";

export const NOT_RUNNING = "Caveman Code isn't running. Tell your user to open it (or run `caveman-code` in a terminal), then call again.";
export const STARTING = "Caveman Code is starting; call again in a few seconds.";
export const NOT_ANSWERING = "Caveman Code isn't answering right now; call again in a few seconds.";
export const TOO_OLD =
  "This Caveman Code is too old for outside agents. Tell your user to update it (Caveman Code > Check for Updates), then call again.";
export const disconnected = (name: string) =>
  `Disconnected in Caveman Code > Settings > Caveman MCP. Tell your user; they can allow ${name} there.`;

export interface Agent {
  /** As the runtime keeps it (stripped, capped, " (agent)" when it would pass for the person). */
  readonly name: string;
  /** As of `become`: the runtime applies the current one to every call. */
  readonly level: OutsideAgentLevel;
}

/** The Session Protocol calls the tools make, every one as this agent. */
export interface AgentClient {
  call<M extends MethodName>(method: M, params: Params<M>, options?: { readonly timeoutMs?: number }): Promise<Result<M>>;
}

export interface Connected {
  readonly client: AgentClient;
  readonly agent: Agent;
}

export type Acquired = { readonly ok: true; readonly session: Connected } | { readonly ok: false; readonly text: string };

/** What the tools need from the connection; tests stand in for it. */
export interface AgentLink {
  /** This agent's session, connecting (and opening the app) first when needed; else what to tell the agent. */
  acquire(name: string): Promise<Acquired>;
  /** Every workspace.changed this agent may read. */
  onWorkspace(handler: (workspace: Workspace) => void): () => void;
  /** Each time a socket became this agent's (the first and every reconnect): what was missed meanwhile can be read. */
  onReady(handler: (client: AgentClient) => void): () => void;
  close(): void;
}

/**
 * A call that took longer than its deadline, the link being down included. It never goes out after this; one that
 * changes something and had already gone out may still have run (`mayHaveRun`).
 */
export class LinkTimeout extends Error {
  readonly method: MethodName;
  readonly mayHaveRun: boolean;
  constructor(method: MethodName, mayHaveRun = false) {
    super(
      mayHaveRun
        ? `Caveman Code didn't answer ${method} in time, and it may still have gone through. Check before you call again.`
        : `Caveman Code didn't answer ${method} in time; call again in a few seconds.`,
    );
    this.name = "LinkTimeout";
    this.method = method;
    this.mayHaveRun = mayHaveRun;
  }
}

/** The runtime stopped taking this agent mid-session (the person disconnected it): what to tell the agent. */
export class LinkRefused extends Error {
  constructor(text: string) {
    super(text);
    this.name = "LinkRefused";
  }
}

/** A refusal of `become` that retrying won't change: a blocked name, a runtime without outside agents. */
const permanent = (error: RpcError) =>
  error.code === -32601 || ["forbidden", "invalid_params", "unsupported", "not_found"].includes(error.data?.reason ?? "");

export const refusalText = (error: RpcError, name: string) =>
  error.code === -32601 ? TOO_OLD : error.data?.reason === "forbidden" ? disconnected(name) : `Caveman Code refused this connection: ${error.message}`;

export interface RuntimeLinkOptions {
  readonly home: string;
  /** Made once per process: the same across reconnects and runtime restarts, so receipts and its chats survive. */
  readonly agentId: string;
  readonly atMost?: "read" | "supervised" | undefined;
  /** The desktop app to open, hidden, when no runtime runs (macOS with the app installed); else nothing starts. */
  readonly app?: string | undefined;
  /** liveRuntime from cli/code.ts. */
  readonly find: (home: string) => Promise<PublishedRuntime | undefined>;
  readonly discover?: (home: string) => PublishedRuntime | undefined;
  readonly openApp?: (app: string) => void;
  readonly connect?: (url: string, token: () => string, onState: (state: ConnectionState, error?: Error) => void, options: ConnectOptions) => Client;
  /** How long a first call waits for the app to start its runtime. */
  readonly startMs?: number;
  /** How long a call waits for the socket to open (or reopen) and become this agent's. */
  readonly readyMs?: number;
  /** A call's deadline from when it was made, the link being down included. */
  readonly callMs?: number;
  readonly pollMs?: number;
}

interface Live {
  readonly url: string;
  /** Set right after connect() returns; nothing reads it before. */
  client: Client;
  agent: Agent | undefined;
  ready: boolean;
  opened: boolean;
  refused: RpcError | undefined;
  /** Settles when the handshake first answers: the agent, or the refusal. */
  readonly first: Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });
const TIMEOUT = Symbol("timeout");

export class RuntimeLink implements AgentLink {
  private live: Live | undefined;
  private establishing: Promise<Acquired> | undefined;
  private found: Promise<PublishedRuntime | undefined> | undefined;
  private openedAppAt: number | undefined;
  private name: string | undefined;
  private closed = false;
  private readonly workspaceHandlers = new Set<(workspace: Workspace) => void>();
  private readonly readyHandlers = new Set<(client: AgentClient) => void>();
  private readonly options: Required<Omit<RuntimeLinkOptions, "atMost" | "app">> & Pick<RuntimeLinkOptions, "atMost" | "app">;

  constructor(options: RuntimeLinkOptions) {
    this.options = {
      discover: discoverRuntime,
      openApp: () => undefined,
      connect: (url, token, onState, connectOptions) => connect(url, token, onState, connectOptions),
      startMs: 40_000,
      readyMs: 15_000,
      // Inside Codex's 60 s for a tool call; pushes, pull requests and clones ask for longer.
      callMs: 50_000,
      pollMs: 400,
      ...options,
    };
  }

  /** Finding the runtime starts at launch, in the background (SPEC §2.1): the first call then needn't wait for it. */
  prefetch(): void {
    this.found ??= this.options.find(this.options.home).catch(() => undefined);
  }

  onWorkspace(handler: (workspace: Workspace) => void): () => void {
    this.workspaceHandlers.add(handler);
    return () => this.workspaceHandlers.delete(handler);
  }

  onReady(handler: (client: AgentClient) => void): () => void {
    this.readyHandlers.add(handler);
    return () => this.readyHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.live?.client.close();
    this.live = undefined;
  }

  async acquire(name: string): Promise<Acquired> {
    if (this.closed) return { ok: false, text: NOT_ANSWERING };
    // The name is fixed by the first call: `become` binds this agent_id to it.
    this.name ??= name;
    const live = this.live;
    if (live && live.refused === undefined) {
      if (live.ready && live.agent) return this.connected(live);
      if (await this.readyWithin(live, this.options.readyMs)) return this.connected(live);
      if (live.refused !== undefined) return { ok: false, text: refusalText(live.refused, this.name) };
      // Not back in time: the runtime may be gone, or have restarted elsewhere.
      const now = this.options.discover(this.options.home);
      if (now !== undefined && now.url === live.url) return { ok: false, text: NOT_ANSWERING };
      this.drop(live);
    } else if (live) {
      // Refused before (a name the person had disconnected): they may have allowed it since, so `become` again.
      this.drop(live);
    }
    this.establishing ??= this.establish().finally(() => (this.establishing = undefined));
    return this.establishing;
  }

  private async readyWithin(live: Live, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    await within(live.first, ms).catch(() => undefined);
    while (!(live.ready && live.agent) && live.refused === undefined && Date.now() < deadline && this.live === live) await sleep(50);
    return live.ready && live.agent !== undefined && this.live === live;
  }

  private drop(live: Live): void {
    if (this.live === live) this.live = undefined;
    live.client.close();
  }

  private async establish(): Promise<Acquired> {
    const { home, find } = this.options;
    const name = this.name!;
    const prefetched = this.found;
    this.found = undefined;
    let runtime = await prefetched;
    // Found at launch, maybe long ago: only while it is still the home's runtime.
    if (runtime !== undefined && this.options.discover(home)?.url !== runtime.url) runtime = undefined;
    runtime ??= await find(home).catch(() => undefined);
    if (runtime === undefined) {
      const app = this.options.app;
      if (app === undefined) return { ok: false, text: NOT_RUNNING };
      // Hidden and without focus; the app owns the runtime, as it does for `caveman-code`. Once per start.
      if (this.openedAppAt === undefined || Date.now() - this.openedAppAt > 3 * this.options.startMs) {
        this.openedAppAt = Date.now();
        this.options.openApp(app);
      }
      const deadline = Date.now() + this.options.startMs;
      while (runtime === undefined && Date.now() < deadline && !this.closed) {
        await sleep(this.options.pollMs);
        runtime = await find(home).catch(() => undefined);
      }
      if (runtime === undefined) return { ok: false, text: STARTING };
    }
    this.openedAppAt = undefined;
    if (this.closed) return { ok: false, text: NOT_ANSWERING };
    const live = this.open(runtime, name);
    await within(live.first, this.options.readyMs).catch(() => undefined);
    if (live.refused !== undefined) return { ok: false, text: refusalText(live.refused, name) };
    if (!(await this.readyWithin(live, 1_000))) return { ok: false, text: NOT_ANSWERING };
    return this.connected(live);
  }

  private open(runtime: PublishedRuntime, name: string): Live {
    const { home, agentId, atMost } = this.options;
    let settle!: () => void;
    const first = new Promise<void>((resolve) => (settle = resolve));
    const tokenPath = runtimeTokenPath(home);
    // A restart writes a new token: read it before every attempt. The first comes from the runtime just found.
    let firstToken: string | undefined = runtime.token;
    const token = () => {
      const fresh = firstToken ?? fs.readFileSync(tokenPath, "utf8").trim();
      firstToken = undefined;
      return fresh;
    };
    const live: Live = {
      url: runtime.url,
      agent: undefined,
      ready: false,
      opened: false,
      refused: undefined,
      first,
      client: undefined as unknown as Client,
    };
    const handshake: ConnectOptions["handshake"] = async (link) => {
      live.ready = false;
      try {
        const result = (await link.call("outside_agent.become", {
          agent_id: agentId,
          name,
          ...(atMost !== undefined ? { at_most: atMost } : {}),
        })) as Agent;
        live.agent = { name: result.name, level: result.level };
      } catch (error) {
        if (error instanceof SessionProtocolError && permanent(error.error)) {
          live.refused = error.error;
          settle();
          throw new HandshakeRefused(error.error);
        }
        throw error;
      }
    };
    const onState = (state: ConnectionState) => {
      if (state === "open") {
        live.ready = true;
        live.opened = true;
        settle();
        const client = this.agentClient(live);
        for (const handler of this.readyHandlers) handler(client);
        return;
      }
      live.ready = false;
      if (state !== "connecting" || !live.opened || this.live !== live) return;
      // The runtime restarted on another port and token: a new client, the same agent_id (SPEC §2.8).
      const now = this.options.discover(home);
      if (now !== undefined && now.url !== live.url) {
        this.drop(live);
        if (!this.closed) void this.acquire(name);
      }
    };
    live.client = this.options.connect(runtime.url, token, onState, { handshake, timeoutMs: this.options.callMs });
    live.client.on("workspace.changed", (workspace) => {
      for (const handler of this.workspaceHandlers) handler(workspace);
    });
    this.live = live;
    return live;
  }

  private agentClient(live: Live): AgentClient {
    const callMs = this.options.callMs;
    const name = this.name ?? "this agent";
    return {
      call: async (method, params, options) => {
        const ms = options?.timeoutMs ?? callMs;
        const giveUp = new AbortController();
        let sent = false;
        try {
          const outcome = await within(live.client.call(method, params, { timeoutMs: ms, signal: giveUp.signal, onSent: () => (sent = true) }), ms);
          if (outcome === TIMEOUT) {
            // Taken back from the client: left waiting there, it would go out on the next socket after the agent
            // was told to call again, under a request_id its retry doesn't share.
            giveUp.abort();
            throw new LinkTimeout(method, sent && typeof (params as { request_id?: unknown }).request_id === "string");
          }
          return outcome;
        } catch (error) {
          // A reconnect's `become` was refused: every call on this client fails with it.
          if (live.refused !== undefined) throw new LinkRefused(refusalText(live.refused, name));
          throw error;
        }
      },
    };
  }

  private connected(live: Live): Acquired {
    return { ok: true, session: { client: this.agentClient(live), agent: live.agent! } };
  }
}
