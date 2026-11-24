#!/usr/bin/env node
// Differential against the installed Codex CLI's own config reader. Never
// starts an MCP process or model; all CLI homes are new, empty temp folders.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexConfig } from "../packages/runtime/src/session-protocol/setupScan.ts";

const codex = process.env.CODEX_BIN ?? execFileSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
const cases = [
  ["multiline", `[mcp_servers.multiline]\ncommand = "node"\nargs = [\n "-e", # an inline comment\n "process.stdout.write('hello')",\n]\n`],
  ["literal", `[mcp_servers.literal]\ncommand = 'node'\nargs = ['''a\nb''', 'x#y', 'C:\\fixture\\helper.js']\n`],
  ["with.dot", `[mcp_servers."with.dot"]\ncommand = 'node'\nargs = ['--', 'unicode Ω', '']\n`],
  ["inline", `mcp_servers = { inline = { command = 'node', args = ['--version', 'x#y'] } }\n`],
  ["disabled", `[mcp_servers.disabled]\ncommand = 'node'\nargs = ['--version']\nenabled = false\nenv_vars = ['DEMO_PUBLIC_NAME']\n[mcp_servers.disabled.env]\nDEMO_LITERAL = 'fixture'\n`],
  ["remote", `[mcp_servers.remote]\nurl = 'https://example.invalid/mcp'\n[mcp_servers.remote.env_http_headers]\nX-Demo = 'DEMO_PUBLIC_HEADER_NAME'\n`],
];
let comparisons = 0;
for (const [name, text] of cases) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-codex-config-oracle-"));
  try {
    fs.writeFileSync(path.join(home, "config.toml"), text);
    const env = { ...process.env, HOME: home, CODEX_HOME: home };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_AUTH_TOKEN;
    const reference = JSON.parse(execFileSync(codex, ["mcp", "get", name, "--json"], { cwd: home, env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
    const parsed = readCodexConfig(text);
    assert.equal(parsed.problem, undefined, name);
    const imported = parsed.servers.find((server) => server.name === name);
    assert.ok(imported, name);
    assert.equal(imported.problem, undefined, name);
    const transport = reference.transport;
    if (transport.type === "stdio") {
      assert.equal(imported.command, transport.command, name);
      assert.deepEqual(imported.args ?? [], transport.args ?? [], name);
      comparisons += 2;
    } else {
      assert.equal(imported.url, transport.url, name);
      comparisons++;
    }
    assert.equal(imported.enabled ?? true, reference.enabled, name);
    const expectedEnv = [...Object.keys(transport.env ?? {}), ...(transport.env_vars ?? [])].sort();
    assert.deepEqual([...imported.env].sort(), [...new Set(expectedEnv)].sort(), name);
    const expectedHeaders = [...Object.keys(transport.http_headers ?? {}), ...Object.keys(transport.env_http_headers ?? {}), ...(transport.bearer_token_env_var ? ["Authorization"] : [])];
    assert.deepEqual([...imported.headers].sort(), [...new Set(expectedHeaders)].sort(), name);
    comparisons += 3;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
// Codex accepts cwd; the importer must refuse that unsupported path contract
// rather than silently importing a different executable invocation.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-codex-config-oracle-"));
try {
  const env = { ...process.env, HOME: home, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_AUTH_TOKEN;
  const unsupported = `[mcp_servers.cwd]\ncommand = 'node'\nargs = ['--version']\ncwd = '/fixture-only'\n`;
  fs.writeFileSync(path.join(home, "config.toml"), unsupported);
  const reference = JSON.parse(execFileSync(codex, ["mcp", "get", "cwd", "--json"], { cwd: home, env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(reference.transport.cwd, "/fixture-only");
  assert.match(readCodexConfig(unsupported).servers[0].problem, /cwd/);
  comparisons++;
  const malformed = `[mcp_servers.bad]\nargs = ["fixture-marker-never-in-diagnostic"\n`;
  fs.writeFileSync(path.join(home, "config.toml"), malformed);
  const refused = spawnSync(codex, ["mcp", "get", "bad", "--json"], { cwd: home, env, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.error, undefined);
  const diagnostic = readCodexConfig(malformed);
  assert.equal(diagnostic.servers.length, 0);
  assert.match(diagnostic.problem, /not valid TOML/);
  assert.equal(diagnostic.problem.includes("fixture-marker-never-in-diagnostic"), false);
  comparisons++;
  console.log(`PASS: ${comparisons} comparisons against ${execFileSync(codex, ["--version"], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()} through its actual mcp get entry point: six valid forms, unsupported cwd and malformed input. No MCP process, model, real home or provider login was used.`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
