// The egress proxy a Cloud computer's pod names (HTTPS_PROXY / HTTP_PROXY, NO_PROXY), for the runtime's own
// WebSocket to Caveman Cloud's relay. With a `[network] allow` list the computer reaches the internet only through
// that proxy (Caveman Cloud C5); Node's fetch and http follow the variables themselves (NODE_USE_ENV_PROXY), the
// `ws` client does not, so the relay dials through an HTTP CONNECT tunnel the proxy opens to Cloud's host.
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

/** The proxy for `target` from the environment, or undefined: none set, or NO_PROXY names the host. */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const raw = target.protocol === "wss:" || target.protocol === "https:" ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return undefined;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = target.port || (target.protocol === "wss:" || target.protocol === "https:" ? "443" : "80");
  const skip = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const [name, onlyPort] = entry.split(/:(?=\d+$)/) as [string, string | undefined];
      if (onlyPort !== undefined && onlyPort !== port) return false;
      const bare = name.replace(/^\*?\./, "");
      return host === bare || host.endsWith(`.${bare}`);
    });
  if (skip) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

/** How long a dial through the egress proxy may take, its CONNECT and then TLS together, before it fails. */
const TUNNEL_TIMEOUT_MS = 15_000;

/**
 * Opens a CONNECT tunnel through `proxy` to host:port; TLS on top when the target speaks it. An https:// proxy is
 * spoken to over TLS (on 443 unless it names a port), as curl and Node's own env proxy do: its CONNECT carries the
 * proxy's credentials. A proxy that takes the connection and never answers, or a tunnel that never finishes TLS, fails
 * the dial after `timeoutMs` (audit K): the relay link then dials again, where a hung dial kept it down while the
 * computer's heartbeats said it was up.
 */
function tunnel(proxy: URL, host: string, port: number, secure: boolean, timeoutMs: number, done: (error: Error | null, socket?: net.Socket) => void) {
  const auth = proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {};
  let socket: net.Socket | undefined;
  let finished = false;
  const finish = (error: Error | null, result?: net.Socket) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(error, result);
  };
  const overTls = proxy.protocol === "https:";
  const request = (overTls ? https : http).request({
    host: proxy.hostname,
    port: Number(proxy.port || (overTls ? 443 : 80)),
    method: "CONNECT",
    path: `${host}:${port}`,
    headers: { host: `${host}:${port}`, ...auth },
  });
  const expire = () => {
    if (finished) return;
    request.destroy();
    socket?.destroy();
    finish(new Error(`the egress proxy did not answer within ${timeoutMs / 1000} s`));
  };
  const timer = setTimeout(expire, timeoutMs);
  request.once("connect", (response, raw) => {
    socket = raw;
    if (response.statusCode !== 200) {
      raw.destroy();
      return finish(new Error(`the egress proxy refused ${host}:${port} (${response.statusCode} ${response.statusMessage ?? ""})`.trim()));
    }
    if (!secure) return finish(null, raw);
    const wrapped = tls.connect({ socket: raw, servername: host });
    socket = wrapped;
    wrapped.once("secureConnect", () => finish(null, wrapped));
    wrapped.once("error", (error) => finish(error));
  });
  request.once("error", (error) => finish(error));
  request.end();
}

/**
 * An agent whose every connection is a tunnel through `proxy` to `target`'s host (for `ws`, which takes an agent):
 * an https one for wss, since Node pairs a request's protocol with its agent's.
 */
export function tunnelAgent(proxy: URL, target: URL, options: { readonly timeoutMs?: number } = {}): http.Agent {
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (
    connection: { host?: string; hostname?: string; port?: number | string; servername?: string },
    oncreate: (error: Error | null, socket?: net.Socket) => void,
  ) => {
    const host = connection.servername || connection.hostname || connection.host || target.hostname;
    tunnel(proxy, host, Number(connection.port || (secure ? 443 : 80)), secure, options.timeoutMs ?? TUNNEL_TIMEOUT_MS, oncreate);
    return undefined;
  };
  return agent;
}
