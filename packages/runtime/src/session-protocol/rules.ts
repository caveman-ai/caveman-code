// Rules (rule.list / rule.read / rule.save): the instruction files each engine
// reads at session start, at home and in each project, and editing them in place.
//
// Which engine reads which file, confirmed 2026-10-17:
// - Claude Agent runs the `claude` CLI with settingSources user, project and local
//   (plugins/resolve.ts projectForClaudeAgent; the SDK loads all three when
//   omitted). The CLI (2.1.302 and the SDK's bundled 0.3.300 binary) reads
//   `<CLAUDE_CONFIG_DIR or ~/.claude>/CLAUDE.md` (User), `<project>/CLAUDE.md`
//   (Project), `<project>/CLAUDE.local.md` (Local) and `<project>/.claude/CLAUDE.md`,
//   and by default ("claude-md-or-agents-md") a project with no CLAUDE.md of its
//   own gets its AGENTS.md instead (in every session only from 2.1.281, so the
//   model manifest recommends that version). ~/.claude/AGENTS.md is not read.
// - Codex (app-server, project_doc_fallback_filenames ["CLAUDE.md"] set by
//   orchestration-v2/Adapters/CodexAdapterV2.ts CODEX_THREAD_CONFIG) reads
//   AGENTS.override.md, else AGENTS.md, else CLAUDE.md, per directory from the
//   git root to the cwd (codex-rs core/src/agents_md.rs), and AGENTS.override.md,
//   else AGENTS.md, in CODEX_HOME (codex-home instructions; the fallback is not
// read there, checked on codex 0.161.0). CODEX_HOME is the person's own only on their compact login;
//   an API-key Codex runs in a home the runtime manages (as setup.scan says).
// - The Caveman engine reads nothing itself (@caveman-ai/agent takes text);
//   the runtime gives it AGENTS.md, else CLAUDE.md (with its `@path` imports
//   inside the checkout, four hops deep, as Claude Code reads them), per
//   directory from the checkout root down (instructions/EngineInstructions.ts
//   repositorySections).
//
// ponytail: a project's files are those at its root; nested and ancestor
// directories' files, which Codex, Claude and the Caveman engine also read, are not listed.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EngineId, RuleInfo } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { openNoFollow } from "../openNoFollow.ts";
import type { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { type Handler, ProtocolError } from "./handlers.ts";
import { rejectSecretInput } from "./secrets.ts";
import type { SetupHomes } from "./setupScan.ts";

type Rule = typeof RuleInfo.Type;

/** A rule file bigger than this is not read. */
const MAX_RULE_BYTES = 1024 * 1024;

const sizeOf = (file: string) => fs.promises.stat(file).then((s) => (s.isFile() ? s.size : undefined), () => undefined);

interface Candidate {
  readonly name: string;
  readonly engines: ReadonlyArray<EngineId>;
  /** Listed only when it exists. */
  readonly optional?: boolean;
}

async function rulesIn(
  dir: string,
  candidates: (exists: (name: string) => boolean) => ReadonlyArray<Candidate>,
  where: { readonly scope: "me" } | { readonly scope: "project"; readonly project_id: string },
): Promise<Rule[]> {
  const names = ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.local.md", ".claude/CLAUDE.md"];
  const sizes = new Map(await Promise.all(names.map(async (name) => [name, await sizeOf(path.join(dir, name))] as const)));
  const exists = (name: string) => sizes.get(name) !== undefined;
  return candidates(exists)
    .filter((c) => !c.optional || exists(c.name))
    .map((c) => ({
      path: path.join(dir, c.name),
      name: c.name,
      ...where,
      engines: [...c.engines],
      exists: exists(c.name),
      idle_tokens_estimate: Math.ceil((sizes.get(c.name) ?? 0) / 4),
    }));
}

/** Every rule file the engines read: home first, then each project's. Reads only. */
export async function listRules(input: {
  readonly homes: SetupHomes;
  readonly codexOwnHome: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly root: string }>;
}): Promise<Rule[]> {
  const out = await rulesIn(input.homes.claudeDir, () => [{ name: "CLAUDE.md", engines: ["claude-agent"] }], { scope: "me" });
  if (input.codexOwnHome) {
    out.push(
      ...(await rulesIn(
        input.homes.codexHome,
        (exists) => [
          { name: "AGENTS.md", engines: exists("AGENTS.override.md") ? [] : ["codex"] },
          { name: "AGENTS.override.md", engines: ["codex"], optional: true },
        ],
        { scope: "me" },
      )),
    );
  }
  for (const project of input.projects) {
    out.push(
      ...(await rulesIn(
        project.root,
        (exists) => {
          const claudeMd = exists("CLAUDE.md") || exists(".claude/CLAUDE.md");
          const codexReadsAgents = exists("AGENTS.md") || exists("AGENTS.override.md");
          return [
            {
              name: "CLAUDE.md",
              engines: exists("AGENTS.md")
                ? ["claude-agent"]
                : ["claude-agent", ...(codexReadsAgents ? [] : (["codex"] as const)), "caveman"],
            },
            {
              name: "AGENTS.md",
              engines: [...(claudeMd ? [] : (["claude-agent"] as const)), ...(exists("AGENTS.override.md") ? [] : (["codex"] as const)), "caveman"],
            },
            { name: ".claude/CLAUDE.md", engines: ["claude-agent"], optional: true },
            { name: "CLAUDE.local.md", engines: ["claude-agent"], optional: true },
            { name: "AGENTS.override.md", engines: ["codex"], optional: true },
          ];
        },
        { scope: "project", project_id: project.id },
      )),
    );
  }
  return out;
}

/**
 * Where a listed rule really lives, refused when it (or the folder it would be
 * created in) leads outside `within` (a project's CLAUDE.md linked to
 * ~/.bashrc), into a `.git` folder, or to a file that is not Markdown (a
 * CLAUDE.md linked to package.json). `within` is the project's root, or for a
 * home rule the person's home and the engine's config folder. A missing folder
 * on the way (~/.claude before Claude ever ran) is checked through its nearest
 * existing parent.
 */
async function realRule(file: string, within: ReadonlyArray<string>): Promise<{ readonly real: string; readonly exists: boolean }> {
  const existing = await fs.promises.realpath(file).catch(() => undefined);
  let real = existing;
  if (real === undefined) {
    const missing: string[] = [path.basename(file)];
    let dir = path.dirname(file);
    for (;;) {
      const found = await fs.promises.realpath(dir).catch(() => undefined);
      if (found !== undefined) {
        real = path.join(found, ...missing);
        break;
      }
      if (path.dirname(dir) === dir) throw new Error(`${file} has no folder to live in`);
      missing.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  const roots = (await Promise.all(within.map((root) => fs.promises.realpath(root).catch(() => undefined)))).filter((r) => r !== undefined);
  const root = roots.find((r) => real.startsWith(`${r}${path.sep}`));
  if (root === undefined) throw new Error(`${file} leads outside its folder`);
  if (path.relative(root, real).split(path.sep).includes(".git") || !/\.md$/i.test(real)) throw new Error(`${file} leads to a file that is not an instruction file`);
  if (existing !== undefined && !(await fs.promises.stat(existing)).isFile()) throw new Error(`${file} is not a file`);
  return { real, exists: existing !== undefined };
}

/** The folders a listed rule must stay inside: its project's root, or the home and the engine folder it sits in. */
const ruleRoots = (rule: Rule, input: { readonly home: string; readonly projects: ReadonlyArray<{ readonly id: string; readonly root: string }> }) =>
  rule.scope === "project" ? input.projects.filter((p) => p.id === rule.project_id).map((p) => p.root) : [input.home, path.dirname(rule.path)];

/** A listed rule's text; "" when it does not exist yet. */
export async function readRule(file: string, within: ReadonlyArray<string>): Promise<string> {
  const { real, exists } = await realRule(file, within);
  if (!exists) return "";
  const handle = await openNoFollow(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${file} is not a file`);
    if (stat.size > MAX_RULE_BYTES) throw new Error(`${file} is over 1 MiB`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replaces a listed rule's text through a sibling temp file and a rename, keeping its mode; a link stays and
 * its file changes. A missing folder inside the allowed one is made.
 * ponytail: a link swapped in between the check and the rename is followed; an fd-relative write closes that if it matters.
 */
export async function saveRule(file: string, text: string, within: ReadonlyArray<string>): Promise<void> {
  const { real } = await realRule(file, within);
  await fs.promises.mkdir(path.dirname(real), { recursive: true });
  const mode = (await fs.promises.stat(real).catch(() => undefined))?.mode;
  const temp = path.join(path.dirname(real), `.${path.basename(real)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, text, { flag: "wx", mode: 0o644 });
    // writeFile's mode is masked by the umask: an existing file keeps its own exactly; a new one gets the umask's.
    if (mode !== undefined) await fs.promises.chmod(temp, mode & 0o7777);
    await fs.promises.rename(temp, real);
  } catch (cause) {
    await fs.promises.rm(temp, { force: true });
    throw cause;
  }
}

type RuleMethod = "rule.list" | "rule.read" | "rule.save";
type Scope = {
  readonly homes: SetupHomes;
  readonly home: string;
  readonly codexOwnHome: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly root: string }>;
};

/**
 * rule.list / rule.read / rule.save. Owner only, as secret.*: a rule file
 * steers every engine on this computer, so a relay principal other than the
 * runtime's owner is forbidden. A file holding a stored secret reads with the
 * value hidden (`redacted`) and is never saved over from here, so the hidden
 * text cannot replace the value; new text holding a secret is refused.
 */
export const makeRuleHandlers = (deps: {
  readonly allowed: (principal: string | undefined) => boolean;
  readonly secrets: ProjectSecrets["Service"];
  readonly scope: Effect.Effect<Scope>;
}): { readonly [M in RuleMethod]: Handler<M> } => {
  const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (error) => new ProtocolError({ reason: "invalid_state", message: (error as Error).message }) });
  const listed = deps.scope.pipe(Effect.flatMap((scope) => Effect.promise(() => listRules(scope)).pipe(Effect.map((rules) => ({ scope, rules })))));
  /** A path rule.list lists, with the folders it must stay inside; not_found for anything else. */
  const listedRule = (file: string) =>
    listed.pipe(
      Effect.flatMap(({ scope, rules }) => {
        const rule = rules.find((r) => r.path === file);
        return rule === undefined ? fail("not_found", `no rule file at ${file}`) : Effect.succeed({ rule, within: ruleRoots(rule, scope) });
      }),
    );
  const handlers: { readonly [M in RuleMethod]: Handler<M> } = {
    "rule.list": (p) =>
      listed.pipe(
        Effect.flatMap(({ scope, rules }) =>
          p.project_id === undefined
            ? Effect.succeed({ rules })
            : scope.projects.some((project) => project.id === p.project_id)
              ? Effect.succeed({ rules: rules.filter((r) => r.scope === "me" || r.project_id === p.project_id) })
              : fail("not_found", `no project ${p.project_id}`),
        ),
      ),
    "rule.read": (p) =>
      Effect.gen(function* () {
        const { rule, within } = yield* listedRule(p.path);
        const text = yield* io(() => readRule(rule.path, within));
        const shown = (yield* deps.secrets.scrubber).scrub(text);
        return { text: shown, redacted: shown !== text };
      }),
    "rule.save": (p) =>
      Effect.gen(function* () {
        if (Buffer.byteLength(p.text, "utf8") > MAX_RULE_BYTES) return yield* fail("invalid_params", "a rule file is at most 1 MiB");
        yield* rejectSecretInput(deps.secrets, p.text);
        const { rule, within } = yield* listedRule(p.path);
        const current = yield* io(() => readRule(rule.path, within));
        if ((yield* deps.secrets.scrubber).scrub(current) !== current) {
          return yield* fail("invalid_state", "This file holds a stored secret; edit it in your editor.");
        }
        yield* io(() => saveRule(rule.path, p.text, within));
        const { rules } = yield* listed;
        return rules.find((r) => r.path === rule.path) ?? rule;
      }),
  };
  const forbidden = new ProtocolError({ reason: "forbidden", message: "rule files belong to this runtime's owner" });
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        deps.allowed(ctx.principal) ? (handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(params, ctx) : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
};
