import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveCommand } from '../bin/caveman-code.mjs';

const bin = resolve(import.meta.dirname, '../bin/caveman-code.mjs');

test('caveman-code CLI resolves supported commands and rejects unknown ones', () => {
  assert.deepEqual(resolveCommand(['chat', '--cwd', '.']), { ok: true, command: 'chat', args: ['--cwd', '.'] });
  const bad = resolveCommand(['nonsense']);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 2);
});

test('caveman-code --help and --version execute cleanly and locate shared runtime CLI', () => {
  const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.match(help, /Caveman Code CLI/);
  const ver = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.match(ver, /caveman-code 1\.0\.0/);
  const probe = JSON.parse(execFileSync(process.execPath, [bin, 'project'], { encoding: 'utf8' }));
  assert.equal(probe.command, 'project');
  assert.equal(probe.runtimeCliPresent, true);
});
