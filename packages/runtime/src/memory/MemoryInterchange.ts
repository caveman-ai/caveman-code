/**
 * The one-time, consented import of Claude Agent's own memories
 * (`<CLAUDE_CONFIG_DIR>/projects/<sanitized cwd>/memory/*.md`) into the
 * store (docs/memory.md "How people see it").
 * Every note comes in as a draft through the commit path (never told), so
 * none reaches a brief until the user pins or edits it. A
 * project folder is matched to a repository this account has opened by its
 * sanitized path; notes of unmatched projects come in only when they hold
 * everywhere (type user or feedback).
 *
 * @module memory/MemoryInterchange
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseNote } from "./MemoryCopy.ts";
import { clean, type MemoryStore, type WriterContext } from "./MemoryStore.ts";

/** Claude Code's project folder name for a working directory. */
export const sanitizeClaudePath = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * `text` cleaned as the commit path cleans it, then cut to `max` characters, ending in `…`. Cleaned first: a value
 * the cut fell inside would be kept in part, where no scrubber knows it, and a mask longer than its value would push
 * a note that fit past the limit. A mask the cut falls inside goes whole.
 */
const fit = (ctx: WriterContext, text: string, max: number) => {
  const cleaned = clean(ctx, text);
  if (cleaned.length <= max) return cleaned;
  let end = max - 1;
  const mask = cleaned.lastIndexOf("[secret:", end);
  if (mask !== -1 && cleaned.indexOf("]", mask) >= end) end = mask;
  return `${cleaned.slice(0, end).trimEnd()}…`;
};

const noteFiles = (claudeHome: string) => {
  const projects = path.join(claudeHome, "projects");
  if (!fs.existsSync(projects)) return [];
  const out: Array<{ readonly project: string; readonly file: string; readonly full: string }> = [];
  for (const project of fs.readdirSync(projects)) {
    const dir = path.join(projects, project, "memory");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) if (file.endsWith(".md") && file !== "MEMORY.md") out.push({ project, file, full: path.join(dir, file) });
  }
  return out;
};

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
}

export function importClaudeMemories(store: MemoryStore, ctx: WriterContext, claudeHome: string, projects: ReadonlyMap<string, string>): ImportResult {
  const bySanitized = new Map([...projects].map(([repoPath, repo]) => [sanitizeClaudePath(repoPath), repo]));
  let imported = 0;
  let skipped = 0;
  for (const { project, file, full } of noteFiles(claudeHome)) {
    const content = fs.readFileSync(full, "utf8");
    const { meta, facts } = parseNote(content);
    const type = typeof meta.type === "string" ? meta.type : undefined;
    const everywhere = type === "user" || type === "feedback";
    const repo = bySanitized.get(project);
    if (!everywhere && !repo) {
      skipped += facts.length || 1;
      continue;
    }
    // Cleaned before it is lowercased, as scope() cleans a path: a secret's value lowercased is no value the scrubber knows.
    const base = `${clean(ctx, file.replace(/\.md$/, "")).toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}.md`;
    const target = everywhere ? `user/${base}` : `repos/${repo}/${base}`;
    const source = fit(ctx, `import:claude:${project}/${file}`, 300);
    const result = store.commit(
      ctx,
      facts.map((fact, i) => ({
        path: facts.length > 1 ? target.replace(/\.md$/, `-${i + 1}.md`) : target,
        text: fit(ctx, fact, 500),
        source,
        meta: {
          ...(meta.name ? { name: meta.name } : {}),
          ...(meta.description ? { description: meta.description } : {}),
          ...(type ? { type } : {}),
          ...(meta.why ? { why: meta.why } : {}),
          ...(meta.how ? { how: meta.how } : {}),
        },
      })),
    );
    imported += result.saved.length;
    skipped += result.rejected.length;
  }
  return { imported, skipped };
}

/** How many Claude note files are there to import. */
importClaudeMemories.count = (claudeHome: string) => noteFiles(claudeHome).length;
