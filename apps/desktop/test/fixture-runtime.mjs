// A stand-in runtime for the shell's own tests: it reads the desktop's
// bootstrap envelope from --bootstrap-fd, checks the token on the WebSocket
// upgrade and answers Session Protocol engine.list and device.agents. It is not the runtime;
// the smoke test uses it only with --fixture, until packages/runtime serves
// Session Protocol. Test knobs: FIXTURE_EXIT_CODE exits at once with that code (after FIXTURE_EXIT_AFTER_MS, if set);
// FIXTURE_OWNED_BY_PID exits 78 (state dir owned) while that process lives, as the runtime's lock does;
// FIXTURE_IGNORE_STOP=1 ignores SIGTERM and stdin EOF, forcing the supervisor's SIGKILL (Windows: taskkill);
// FIXTURE_CHILD=1 starts a child of its own, as the runtime starts engines, and prints its pid;
// FIXTURE_HANG_FIRST_UPGRADE=1 never answers the first upgrade, as the runtime does with one sent before it serves;
// FIXTURE_REFUSE_DATA=<message> logs the runtime's DatabaseNewerThanRuntime error line and exits 1, as its migration
// guard does when a newer build wrote the database; FIXTURE_SAY_REFUSE_AFTER_MS serves, then that long after
// listening prints the same line and exits 1, as a runtime that ran a while might echo it before crashing.
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const fd = Number(process.argv[process.argv.indexOf("--bootstrap-fd") + 1]);
const bootstrap = JSON.parse(readFileSync(fd, "utf8").split("\n")[0]);
console.log(`fixture runtime t3Home=${bootstrap.t3Home ?? "(default)"}`);
// The agents key's public half only, logged (agentsKey.test.ts compares it with the sealed key's) and answered as
// device.agents does (the smoke test's check).
const agentsJwk = bootstrap.agentsKey === undefined ? undefined : createPublicKey(bootstrap.agentsKey).export({ format: "jwk" });
console.log(`fixture runtime agents key ${agentsJwk?.x ?? "none"}`);
const agents = agentsJwk && {
  device_id: createHash("sha256").update(`{"crv":"${agentsJwk.crv}","kty":"${agentsJwk.kty}","x":"${agentsJwk.x}","y":"${agentsJwk.y}"}`).digest("base64url"),
  public_key: { kty: agentsJwk.kty, crv: agentsJwk.crv, x: agentsJwk.x, y: agentsJwk.y },
};
const exitNow = () => {
  if (process.env.FIXTURE_EXIT_CODE !== "78") console.error(`fixture runtime: Error: cannot start, exiting ${process.env.FIXTURE_EXIT_CODE}`);
  process.exit(Number(process.env.FIXTURE_EXIT_CODE));
};
// FIXTURE_EXIT_AFTER_MS: a slow start that still fails, never listening.
if (process.env.FIXTURE_EXIT_CODE && process.env.FIXTURE_EXIT_AFTER_MS) await new Promise((r) => setTimeout(r, Number(process.env.FIXTURE_EXIT_AFTER_MS)));
if (process.env.FIXTURE_EXIT_CODE) exitNow();
if (process.env.FIXTURE_REFUSE_DATA) {
  console.log(`[00:00:01.000] ERROR (#1): DatabaseNewerThanRuntimeError: ${process.env.FIXTURE_REFUSE_DATA}`);
  process.exitCode = 1;
  await new Promise(() => setTimeout(() => process.exit(1), 20));
}
if (process.env.FIXTURE_OWNED_BY_PID) {
  try {
    process.kill(Number(process.env.FIXTURE_OWNED_BY_PID), 0);
    process.exit(78);
  } catch {
    // The owner is gone: this one may serve.
  }
}
// The contract: stdin reaching EOF means the desktop died, or on Windows that it stops the runtime.
const stopBy = (how) => {
  if (process.env.FIXTURE_IGNORE_STOP) return;
  // Exits once the line is out: a pipe's writes are asynchronous on POSIX.
  process.stdout.write(`fixture runtime: stopping on ${how}\n`, () => process.exit(0));
};
process.stdin.on("end", () => stopBy("stdin EOF"));
process.stdin.resume();
if (process.env.FIXTURE_CHILD) {
  const engine = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  console.log(`fixture runtime child pid=${engine.pid}`);
}

const engine = {
  id: "caveman",
  label: "Caveman (fixture)",
  capabilities: {
    structured: true, fork: false, steer: false, interrupt: false, tool_hooks: false,
    resume_across_machines: false, approvals: false, plans: false, subagents: false, images: false, mcp: false,
  },
  models: [],
  auth: { state: "unavailable", accounts: [], message: "fixture runtime" },
};

// Auth as the contract has it: `Authorization: Bearer` (Node) or the
// `base64url.bearer.<token>` subprotocol beside caveman.session.v1 (browsers).
const SUBPROTOCOL = "caveman.session.v1";
const BEARER = "base64url.bearer.";
const bearerOf = (req) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const encoded = offered.find((p) => p.startsWith(BEARER));
  return encoded ? Buffer.from(encoded.slice(BEARER.length), "base64url").toString() : undefined;
};

let hung = false;
const server = new WebSocketServer({
  host: bootstrap.host,
  port: bootstrap.port,
  path: "/session/v1",
  verifyClient: ({ req }, done) => {
    if (process.env.FIXTURE_HANG_FIRST_UPGRADE && !hung) return void (hung = true);
    if (bearerOf(req) === bootstrap.desktopBootstrapToken) done(true);
    else done(false, 401, "Unauthorized");
  },
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});
server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id === undefined) return;
    socket.send(
      JSON.stringify(
        msg.method === "engine.list"
          ? { jsonrpc: "2.0", id: msg.id, result: { engines: [engine] } }
          : msg.method === "device.agents"
            ? { jsonrpc: "2.0", id: msg.id, result: { ...(agents ? { agents } : {}), name: "fixture", vouched: false } }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fixture runtime: no ${msg.method}` } },
      ),
    );
  });
});
server.on("listening", () => {
  console.log(`fixture runtime listening on ${bootstrap.host}:${bootstrap.port}`);
  if (process.env.FIXTURE_SAY_REFUSE_AFTER_MS)
    setTimeout(() => {
      console.log("[00:00:09.000] ERROR (#1): DatabaseNewerThanRuntimeError: an engine echoed this");
      process.exit(1);
    }, Number(process.env.FIXTURE_SAY_REFUSE_AFTER_MS));
});
process.on("SIGTERM", () => stopBy("SIGTERM"));
