#!/usr/bin/env node
// Unified Caveman Code CLI entrypoint living beside apps/desktop in caveman-ai/caveman-code.
// Shares workspaces, sessions, approvals, MCP servers, and auth with Caveman Code Desktop.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';

export function resolveCommand(argv) {
  const [sub = 'help', ...rest] = argv;
  const known = new Set(['help', '--help', '-h', 'version', '--version', 'chat', 'auth', 'project', 'mcp', 'server', 'automation', 'trace', 'browser', 'config']);
  if (!known.has(sub)) return { ok: false, error: `Unknown command: ${sub}`, code: 2 };
  return { ok: true, command: sub, args: rest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = resolveCommand(args);
  if (!res.ok) {
    process.stderr.write(`${res.error}\nRun "caveman-code help" for available commands.\n`);
    process.exit(res.code);
  }
  if (res.command === 'version' || res.command === '--version') {
    process.stdout.write('caveman-code 1.0.0\n');
    process.exit(0);
  }
  if (res.command === 'help' || res.command === '--help' || res.command === '-h') {
    process.stdout.write([
      'caveman-code 1.0.0 — Caveman Code CLI (shared runtime with Desktop)',
      '',
      'Usage: caveman-code <command> [options]',
      '',
      'Commands:',
      '  chat         Start or attach to an interactive coding session',
      '  server       Manage the local Caveman Code daemon',
      '  project      List or open workspaces',
      '  auth         Inspect or connect model providers & Caveman Cloud',
      '  mcp          Inspect configured MCP servers',
      '  automation   Run or inspect .caveman/automations workflows',
      '  trace        Inspect session traces and usage',
      '  config       Read or update Caveman Code configuration',
    ].join('\n') + '\n');
    process.exit(0);
  }
  const runtimeCli = resolve(import.meta.dirname, '../../../packages/runtime/src/cli/app.ts');
  process.stdout.write(JSON.stringify({ command: res.command, args: res.args, runtimeCliPresent: existsSync(runtimeCli) }) + '\n');
}
