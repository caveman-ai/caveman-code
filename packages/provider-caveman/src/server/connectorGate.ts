/**
 * Cloud's connector gate, as `caveman-runtime agent exec` reaches it: one endpoint per session
 * (`POST {relay}/relay/v1/sessions/{session_id}/mcp`), JSON-RPC over plain JSON, with no handshake, session id or
 * event stream. `tools/list` answers the deployment's tool card, read once when the session opens, so the tools the
 * model is told of never change inside it. `tools/call` runs one call; a call Cloud refuses is a normal result
 * (`isError: true`) whose one line is written for the model, and it reaches the model as it is.
 *
 * The bearer is the session's model key: every request carries it, and a redirect is never followed, so it never
 * reaches another origin. A call is never sent twice (a second send could run a write twice). When nothing usable
 * comes back, the model reads one line of this client's own, in the gate's words.
 *
 * @module provider-caveman/server/connectorGate
 */
import type * as Harness from "@caveman-ai/harness";

/** What a connector tool does, as the card says: it reads, it writes in the connector, or it acts outside it. */
export type ConnectorEffect = "read" | "write" | "external";

export interface ConnectorGate {
  /** The card's tools, in the card's order. `qualified` is the flat name, `server` the connector, `name` the tool. */
  readonly tools: ReadonlyArray<Harness.McpToolHandle>;
  /** Each tool's effect, by its flat name. */
  readonly effects: ReadonlyMap<string, ConnectorEffect>;
  readonly card: string;
  readonly revision: number | undefined;
}

export interface ConnectorGateOptions {
  /** The session's endpoint (CAVEMAN_CONNECTORS_URL). */
  readonly url: string;
  /** The session's model key. */
  readonly bearer: string;
  readonly fetch?: typeof fetch;
  /** What the gate sent that this client leaves out, and a key the gate refused: diagnostics, never the model's. */
  readonly notice?: (line: string) => void;
  /** Awaited before a call whose effect is not read leaves this process. */
  readonly beforeSend?: (call: {
    readonly qualified: string;
    readonly effect: ConnectorEffect;
  }) => void | Promise<void>;
}

const VARIABLE = "CAVEMAN_CONNECTORS_URL";
const EFFECTS: ReadonlySet<string> = new Set(["read", "write", "external"]);
/** The harness's rule for a name the model calls (McpToolHandle.qualified). */
const FLAT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The loopback names http is allowed on, as the runtime's MCP sign-in allows them (runtime auth/McpOAuth.ts). */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MIB = 1024 * 1024;
const LIST_TIMEOUT_MS = 30_000;
const LIST_LIMIT_BYTES = 4 * MIB;
const CALL_TIMEOUT_MS = 120_000;
/** A call's answer, bounded as the harness's own MCP transport bounds a message: the gate's 4 MiB answer, escaped, fits. */
const CALL_LIMIT_BYTES = 16 * MIB;

// A model reads these when nothing usable came back, in the gate's own words (Caveman Cloud
// cloud/internal/gatelines/gatelines.go: NoAnswer, MayHaveRun without the arguments, Unreachable). The names are
// already the harness's [A-Za-z0-9_-], so only gatelines' `called` (- as _) applies.
const called = (connector: string, tool: string) =>
  `${connector.replaceAll("-", "_")}.${tool.replaceAll("-", "_")}`;
/** gatelines NoAnswer: a call that reads got no complete answer. */
const noAnswer = (connector: string, tool: string) =>
  `failed: ${called(connector, tool)} got no answer from ${connector}. Reading again is safe.`;
/** gatelines MayHaveRun: a call that writes or has outside effects was sent and got no complete answer. */
const mayHaveRun = (connector: string, tool: string) =>
  `may_have_run: ${called(connector, tool)} was sent and no answer was recorded. Check before sending it again.`;
/** gatelines Unreachable: nothing was run. */
const unreachable = (connector: string) => `unreachable: ${connector} did not answer. Not run.`;

/** The endpoint out of CAVEMAN_CONNECTORS_URL, or a sentence saying what is wrong with it. */
export function parseConnectorsUrl(value: string): URL | string {
  const raw = value.trim();
  if (raw === "")
    return `${VARIABLE} is empty; set it to the session's connector endpoint, or unset it`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${VARIABLE} is not a URL`;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return `${VARIABLE} must be an https URL (http only on loopback: 127.0.0.1, localhost or [::1])`;
  }
  if (url.username !== "" || url.password !== "") {
    return `${VARIABLE} must not carry credentials; the session's model key is its bearer`;
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    return `${VARIABLE} must not carry a query or a fragment`;
  }
  return url;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What one request got: an HTTP status and, on a 200, its body as JSON; or why nothing came back. */
type Answer = { readonly status: number; readonly body?: unknown } | { readonly failed: string };

/** A response's body, or undefined once it passes `limit` bytes (the rest is never read). */
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Why a request got nothing, in a few words that never carry a body, a header or the key. */
function failureOf(cause: unknown): string {
  const inner = cause instanceof Error ? cause.cause : undefined;
  if (inner instanceof Error && /redirect/i.test(inner.message))
    return "a redirect, which this client never follows";
  const code = isRecord(inner) ? inner.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "a network error";
}

/** The `result` of a JSON-RPC answer to request `id`, or undefined when the body is not one. */
function resultOf(body: unknown, id: number): Record<string, unknown> | undefined {
  if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== id || !isRecord(body.result))
    return undefined;
  return body.result;
}

/** A tool of the card, or why it is left out. */
function cardTool(tool: unknown):
  | {
      readonly flat: string;
      readonly connector: string;
      readonly name: string;
      readonly effect: ConnectorEffect;
      readonly description: string;
      readonly inputSchema: Record<string, unknown>;
    }
  | string {
  const flat = isRecord(tool) ? tool.name : undefined;
  if (typeof flat !== "string" || !FLAT_NAME.test(flat)) {
    return "whose name is not 1 to 64 letters, digits, _ and -";
  }
  const meta = isRecord(tool) && isRecord(tool._meta) ? tool._meta : {};
  const split = flat.indexOf("__");
  const connector = split > 0 ? flat.slice(0, split) : "";
  const name = split > 0 ? flat.slice(split + 2) : "";
  if (
    connector === "" ||
    name === "" ||
    meta["caveman/connector"] !== connector ||
    meta["caveman/tool"] !== name
  ) {
    return "whose name does not split at its first __ into the connector and tool its _meta names";
  }
  const effect = meta["caveman/effect"];
  if (typeof effect !== "string" || !EFFECTS.has(effect))
    return "whose effect is not read, write or external";
  const record = tool as Record<string, unknown>;
  if (!isRecord(record.inputSchema)) return "whose inputSchema is not an object";
  return {
    flat,
    connector,
    name,
    effect: effect as ConnectorEffect,
    description: typeof record.description === "string" ? record.description : "",
    inputSchema: record.inputSchema,
  };
}

/** A tool's name as a notice prints it: quoted, escaped, bounded. */
const shown = (tool: unknown): string => {
  const name = isRecord(tool) ? tool.name : undefined;
  return typeof name === "string" ? JSON.stringify(name.slice(0, 100)) : "a tool with no name";
};

/**
 * Reads the session's tool card once and answers its tools as the harness's MCP handles. A card that cannot be read
 * rejects with one sentence (never the gate's body): the session does not start without its tools.
 */
export async function openConnectorGate(options: ConnectorGateOptions): Promise<ConnectorGate> {
  const url = parseConnectorsUrl(options.url);
  if (typeof url === "string") throw new Error(url);
  const bearer = options.bearer;
  const fetchFn = options.fetch ?? fetch;
  const notice = (line: string) =>
    options.notice?.(bearer.length >= 8 ? line.split(bearer).join("[redacted]") : line);
  let ids = 0;

  /** One request: POST, the bearer, plain JSON, never a redirect; ended by its timeout or the caller's signal. */
  const send = async (
    id: number,
    method: string,
    params: Record<string, unknown> | undefined,
    bounds: { readonly timeoutMs: number; readonly limit: number },
    signal?: AbortSignal,
  ): Promise<Answer> => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const controller = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      controller.abort();
    }, bounds.timeoutMs);
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status };
      }
      const text = await boundedText(response, bounds.limit);
      if (text === undefined) return { failed: `an answer over ${bounds.limit / MIB} MiB` };
      try {
        return { status: 200, body: JSON.parse(text) as unknown };
      } catch {
        return { status: 200 };
      }
    } catch (cause) {
      return {
        failed: late
          ? `no answer within ${bounds.timeoutMs / 1_000} s`
          : signal?.aborted === true
            ? "stopped"
            : failureOf(cause),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };

  const listId = ++ids;
  const listed = await send(listId, "tools/list", undefined, {
    timeoutMs: LIST_TIMEOUT_MS,
    limit: LIST_LIMIT_BYTES,
  });
  if ("failed" in listed)
    throw new Error(`Cloud's connector gate did not answer (${listed.failed}).`);
  if (listed.status === 401)
    throw new Error("Cloud's connector gate refused this session's key (HTTP 401).");
  if (listed.status !== 200)
    throw new Error(`Cloud's connector gate did not answer (HTTP ${listed.status}).`);
  const list = resultOf(listed.body, listId);
  if (list === undefined || !Array.isArray(list.tools)) {
    throw new Error("Cloud's connector gate did not answer with a tools/list result.");
  }

  const tools: Array<Harness.McpToolHandle> = [];
  const effects = new Map<string, ConnectorEffect>();
  for (const tool of list.tools as ReadonlyArray<unknown>) {
    const kept = cardTool(tool);
    if (typeof kept === "string") {
      notice(`Cloud's connector gate listed ${shown(tool)} ${kept}; it is left out.`);
      continue;
    }
    if (effects.has(kept.flat)) {
      notice(`Cloud's connector gate listed ${shown(tool)} twice; the second is left out.`);
      continue;
    }
    const { flat, connector, name, effect } = kept;
    /** One call, sent once: its result as received, or the line the model reads when nothing usable came back. */
    const run = async (
      args: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ): Promise<{ readonly result: Record<string, unknown> } | { readonly line: string }> => {
      // Stopped before it left: nothing was sent, and the harness ends the call as stopped.
      const stopped = () => {
        if (signal?.aborted === true)
          throw signal.reason instanceof Error ? signal.reason : new Error("stopped");
      };
      stopped();
      if (effect !== "read") await options.beforeSend?.({ qualified: flat, effect });
      stopped();
      const id = ++ids;
      const answer = await send(
        id,
        "tools/call",
        { name: flat, arguments: args },
        { timeoutMs: CALL_TIMEOUT_MS, limit: CALL_LIMIT_BYTES },
        signal,
      );
      if (!("failed" in answer) && answer.status === 401) {
        notice(
          `Cloud's connector gate refused this session's key (HTTP 401) on ${flat}; the call was not run.`,
        );
        return { line: unreachable(connector) };
      }
      const result =
        "failed" in answer || answer.status !== 200 ? undefined : resultOf(answer.body, id);
      const usable =
        result !== undefined &&
        Array.isArray(result.content) &&
        result.content.every((part) => isRecord(part) && typeof part.type === "string");
      if (!usable)
        return {
          line: effect === "read" ? noAnswer(connector, name) : mayHaveRun(connector, name),
        };
      return { result };
    };
    tools.push({
      server: connector,
      name,
      qualified: flat,
      description: kept.description,
      inputSchema: kept.inputSchema,
      call: async (args, signal) => {
        const answer = await run(args, signal);
        if ("line" in answer) return { text: answer.line, isError: true };
        const content = answer.result.content as ReadonlyArray<Record<string, unknown>>;
        const text = content
          .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
          .join("\n");
        return { text, isError: answer.result.isError === true };
      },
      callRaw: async (args, signal) => {
        const answer = await run(args, signal);
        if ("line" in answer)
          return { content: [{ type: "text", text: answer.line }], isError: true };
        return answer.result as unknown as Harness.CallToolResult;
      },
    });
    effects.set(flat, effect);
  }
  const meta = isRecord(list._meta) ? list._meta : {};
  const card = meta["caveman/card"];
  const revision = meta["caveman/revision"];
  return {
    tools,
    effects,
    card: typeof card === "string" ? card : "",
    revision: typeof revision === "number" && Number.isFinite(revision) ? revision : undefined,
  };
}
