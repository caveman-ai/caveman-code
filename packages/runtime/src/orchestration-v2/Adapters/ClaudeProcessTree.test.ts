// On Windows the Claude Agent CLI is stopped with its whole tree: kill() alone would orphan what it started.
import { execFileSync } from "node:child_process";

import { expect, test } from "vitest";

import { spawnClaudeProcessTree } from "./ClaudeAdapterV2.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A CLI that starts a long-lived child of its own (a tool command, an MCP server) and prints its pid.
const CLI = `
const { spawn } = require("node:child_process");
const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
process.stdout.write(tool.pid + "\\n");
setInterval(() => {}, 1000);
`;

test.runIf(process.platform === "win32")("stops the CLI and what it started", async () => {
  const child = spawnClaudeProcessTree({ command: process.execPath, args: ["-e", CLI], env: process.env, signal: new AbortController().signal });
  const tool = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
  expect(alive(tool)).toBe(true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  expect(child.kill("SIGTERM")).toBe(true);
  await exited;
  for (let i = 0; i < 50 && alive(tool); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(alive(tool)).toBe(false);
});

test.runIf(process.platform === "win32")("an aborted spawn stops the tree too", async () => {
  const abort = new AbortController();
  const child = spawnClaudeProcessTree({ command: process.execPath, args: ["-e", CLI], env: process.env, signal: abort.signal });
  child.on("error", () => {});
  const tool = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  abort.abort();
  await exited;
  for (let i = 0; i < 50 && alive(tool); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(alive(tool)).toBe(false);
  // Nothing of it is left under the test's own process either.
  expect(execFileSync("tasklist", ["/FI", `PID eq ${tool}`], { encoding: "utf8", windowsHide: true })).not.toContain(String(tool));
});
