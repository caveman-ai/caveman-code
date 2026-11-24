// Harness smoke against a real `node packages/runtime/src/bin.ts` in a scratch
// home: Cursor, OpenCode and Muse Code show in engine.list (not connected),
// engine.providers gives each its add form, engine.scan turns nothing on in a
// home with no logins, and an OpenCode account goes through add, tag, activate
// and remove. Nothing signs in and no model is
// called; an installed opencode is probed in the scratch home, so it reports
// no login. Without opencode on PATH that part is skipped, never passed.
//
//   node packages/runtime/scripts/harness-smoke.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-harness-smoke-"));
const home = path.join(scratch, "home");
const runtimeHome = path.join(scratch, "runtime");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(runtimeHome, "userdata"), { recursive: true });

const log = (...parts: Array<unknown>) => console.log("[harness-smoke]", ...parts);
const fail = (message: string): never => {
  throw new Error(`HARNESS SMOKE FAILED: ${message}`);
};
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const port = await new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const p = (server.address() as net.AddressInfo).port;
    server.close(() => resolve(p));
  });
});
const opencode = (() => {
  try {
    return execFileSync("which", ["opencode"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

let runtime: ChildProcess | undefined;
try {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CAVEMAN_CODE_HOME: runtimeHome, CAVEMAN_CODE_NO_BROWSER: "1" };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_API_KEY", "OPENCODE_CONFIG_CONTENT"]) delete env[name];
  runtime = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  log(`runtime pid ${runtime.pid}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 90_000);
  const token = () => fs.readFileSync(path.join(runtimeHome, "userdata", "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  const list = async () => (await client.call("engine.list", {})).engines;
  for (const id of ["cursor", "opencode", "muse"] as const) {
    const engine = (await list()).find((e) => e.id === id) ?? fail(`no ${id} engine`);
    log(`${id}: "${engine.label}" auth=${engine.auth.state} capabilities=${JSON.stringify(engine.capabilities)} access=${engine.access_modes ?? "all"} — ${engine.auth.message ?? ""}`);
    if (engine.auth.state !== "signed_out" || engine.auth.accounts.length !== 0) fail(`${id} should wait to be connected`);
    const { providers } = await client.call("engine.providers", { engine: id });
    log(`${id} form: ${JSON.stringify(providers[0])}`);
    if (providers.length !== 1) fail(`${id} has no add form`);
  }

  // engine.scan in a home with no logins: a harness stays on exactly when the scan found it ready (OpenCode
  // can be: its free built-in models need no login), Cursor without ~/.cursor is not here, and every other
  // harness goes back as it was. OpenCode is then turned back off, so the round trip below starts from off.
  const scanned = (await client.call("engine.scan", { request_id: "h0" })).engines;
  log(`scan: ${JSON.stringify(scanned)}`);
  const harnessIds = ["cursor", "opencode", "muse", "grok", "pi", "antigravity"];
  if (scanned.find((e) => e.engine === "cursor")?.found !== "not_found") fail("Cursor without ~/.cursor counted as on this computer");
  for (const e of await list()) {
    if (!harnessIds.includes(e.id)) continue;
    const ready = scanned.find((s) => s.engine === e.id)?.found === "ready";
    if (ready !== e.auth.accounts.length > 0) fail(`${e.id}: the scan said ${ready ? "ready" : "not ready"} but left ${e.auth.accounts.length} accounts on`);
    if (ready) await client.call("engine.account.remove", { request_id: `h0-${e.id}`, engine: e.id, account_id: e.auth.accounts[0]!.id });
  }

  if (opencode === undefined) {
    log("SKIPPED: no opencode on PATH; the OpenCode account round trip did not run");
  } else {
    const added = await client.call("engine.account.add", { request_id: "h1", engine: "opencode" });
    log(`opencode add -> sign_in ${JSON.stringify(added.sign_in)}; accounts ${JSON.stringify(added.accounts)}`);
    if (added.sign_in?.command !== "opencode auth login" || added.accounts.length !== 1) fail("opencode add did not turn its account on");
    const id = added.accounts[0]!.id;
    await until("opencode's probe", async () => {
      const engine = (await list()).find((e) => e.id === "opencode")!;
      return engine.auth.state !== "checking" && engine.version !== undefined;
    }, 60_000);
    const probed = (await list()).find((e) => e.id === "opencode")!;
    log(`opencode probed: version=${probed.version} auth=${probed.auth.state} models=${probed.models.length}`);
    const tagged = await client.call("engine.account.tag", { request_id: "h2", engine: "opencode", account_id: id, tag: "OC1" });
    if (tagged.accounts[0]?.tag !== "OC1") fail("the tag did not stick");
    const second = await client.call("engine.account.add", { request_id: "h3", engine: "opencode" });
    const other = second.accounts.find((a) => a.id !== id) ?? fail("a second account was not added");
    if (!other.id.startsWith("opencode-account-")) fail(`unexpected account id ${other.id}`);
    await client.call("engine.account.activate", { request_id: "h4", engine: "opencode", account_id: other.id });
    const left = await client.call("engine.account.remove", { request_id: "h5", engine: "opencode", account_id: other.id });
    log(`after remove: ${JSON.stringify(left.accounts)}`);
    if (left.accounts.length !== 1 || left.accounts[0]!.id !== id) fail("remove left the wrong accounts");
    if ((await list()).filter((e) => e.id === "opencode").length !== 1) fail("an extra account showed as its own engine");
  }
  client.close();
  log("PASS");
} finally {
  if (runtime && runtime.exitCode === null) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
