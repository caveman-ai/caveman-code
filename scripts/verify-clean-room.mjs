#!/usr/bin/env node
// Proves caveman-code contains zero private internal memos, design drafts,
// debug screenshots, internal .claude skills, vendored tarballs, or private
// repo/user path leaks before any public push.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

for (const forbidden of [
  'docs/WHY.md',
  'docs/decisions',
  'docs/design',
  'packages/agent-sdk',
  'vendor',
  '.claude',
  'a-focused.png',
  'dbg-a.png',
  'dbg-b.png',
]) {
  if (existsSync(join(root, forbidden))) failures.push(`Forbidden private path exists: ${forbidden}`);
}

for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  if (!existsSync(join(root, required))) {
    failures.push(`Missing required licensing file: ${required}`);
  }
}
if (!existsSync(join(root, 'apps/cli/bin/caveman-code.mjs'))) {
  failures.push('Missing unified apps/cli/bin/caveman-code.mjs');
}
if (!existsSync(join(root, 'docs/nav.json'))) {
  failures.push('Missing docs/nav.json');
}

const provPkg = JSON.parse(readFileSync(join(root, 'packages/provider-caveman/package.json'), 'utf8'));
for (const dep of ['@caveman-ai/harness', '@caveman-ai/agent']) {
  if ((provPkg.dependencies?.[dep] ?? '').includes('vendor/')) {
    failures.push(`provider-caveman still points at vendor/ for ${dep}`);
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.turbo', '.next']);
const FORBIDDEN_CONTENT = [
  ['Caveman-Cloud', /\bCaveman-Cloud\b/],
  ['caveman-code-app', /\bcaveman-code-app\b/],
  ['agent-sdk-private', /\bagent-sdk-private\b/],
  ['caveman-site', /\bcaveman-site\b/],
  ['caveman-model-research', /\bcaveman-model-research\b/],
  ['caveman-v5-staging', /\bcaveman-v5-staging\b/],
  ['local-user-path', /\/Users\/(?:julb|julius)\b/],
  ['vendor-tgz', /vendor\/caveman-ai-/],
  ['internal-design-doc', /\bdocs\/(design\/|decisions\/|WHY\.md|implementation\/)/],
  ['founder-note', /\((?:the\s+)?founder\b|\bfounder\s+(?:ruling|call)\b/i],
  ['internal-handle', /["']masa["']/],
  ['upstream-slug-leak', /\bpingdotgg\/t3code\b|\bt3code-ref\b/i],
  ['competitor-capy', /\bcapy\b/i],
  ['competitor-monocode', /\bmonocode\b/i],
  ['competitor-eval-obs', /\b(Headroom|Braintrust|LangSmith|Helicone|Portkey|PromptLayer|Humanloop|Daytona|E2B|Martian|Promptfoo|DeepEval|Ragas|langevals|Runloop|Blaxel|boat\.dev)\b/i],
];

function scan(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    const rel = relative(root, full);
    if (ent.isDirectory()) {
      scan(full);
      continue;
    }
    if (rel === 'scripts/verify-clean-room.mjs' || rel === 'THIRD_PARTY_NOTICES.md' || rel === 'NOTICE' || rel === 'apps/cli/THIRD_PARTY_NOTICES.md' || rel === 'apps/cli/NOTICE') continue;
    if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|wasm|pdf|zip|gz|tgz|icns|svg|lock)$/i.test(ent.name) || ent.name === 'pnpm-lock.yaml') continue;
    let text;
    try {
      if (statSync(full).size > 1_000_000) continue;
      text = readFileSync(full, 'utf8');
    } catch { continue; }
    for (const [label, re] of FORBIDDEN_CONTENT) {
      if (re.test(text)) failures.push(`Forbidden ${label} reference in ${rel}`);
    }
  }
}
scan(root);

if (failures.length > 0) {
  console.error('CLEAN-ROOM SCRUB AUDIT FAILED:\n' + failures.slice(0, 40).map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: 'clean-room privacy scrub, zero vendor/, zero .claude/, zero private refs, T3 notices, unified CLI, harness wiring, docs/nav.json' }));
