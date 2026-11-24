// `caveman-runtime apply`: a repository's Cloud automations (`host: cloud`) and the agent files they name, sent
// to Caveman Cloud, which makes a revision of each and says how it moves authority (CONTRACT §5). The same
// files go whether the person runs the CLI with a `code:run` key or the app sends them as the signed-in person;
// what Cloud answers is printed the same way. Files with errors never leave this computer.
import * as path from "node:path";

import { agentsUsed, checkSources, git, readWorkingTree, type ProjectSources } from "./files.ts";
import { hostOf, renderDiagnostics, type Diagnostic, type ParsedAgent } from "@caveman-app/automations";
import type { CloudAuthorityDiff, CloudAutomationApplied } from "@caveman-app/session-protocol/protocol";

/** The body of `POST /api/v1/code/automations/apply`. */
export interface ApplyBody {
  readonly repo: string;
  readonly commit_sha: string;
  /** Repo-relative path to text: each `host: cloud` automation and every `.caveman/agents/*.md` it names. */
  readonly files: Readonly<Record<string, string>>;
}

export interface ApplyPlan {
  readonly body: ApplyBody;
  /** Files that stay here, each with why. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export class ApplyError extends Error {
  readonly reason: "invalid" | "nothing" | "no_repo";
  constructor(reason: ApplyError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** `owner/name` from a GitHub remote URL (https, ssh, or a proxy path ending in owner/name). */
export function repoSlug(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(trimmed)?.[1];
  const rest = scp ?? (() => {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  })();
  const parts = (rest ?? "").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, name] = parts.slice(-2) as [string, string];
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name) ? `${owner}/${name}` : undefined;
}

/** What `apply` would send from these sources: the Cloud automations and their agents, or why nothing goes. */
export function applyPlanFrom(input: {
  readonly sources: ProjectSources;
  readonly registry: ReadonlyArray<ParsedAgent>;
  readonly repo: string;
  readonly commitSha: string;
}): ApplyPlan {
  const check = checkSources({ sources: input.sources, registry: input.registry, target: "cloud" });
  const skipped: Array<{ path: string; reason: string }> = [];
  const files: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  const byPath = new Map(input.sources.files.map((f) => [f.path, f.text]));
  for (const automation of check.automations) {
    if (automation.scope === "me") {
      skipped.push({ path: automation.path, reason: "a Me automation; it lives only on this computer" });
      continue;
    }
    if (hostOf(automation.file) !== "cloud") {
      skipped.push({ path: automation.path, reason: "runs on This Mac (add host: cloud to run it on Cloud)" });
      continue;
    }
    const used = new Set(agentsUsed(automation.file));
    const agentPaths = check.agents.filter((a) => used.has(a.name) && a.path?.startsWith(".caveman/agents/") === true).map((a) => a.path!);
    const paths = new Set([automation.path, ...agentPaths]);
    for (const d of check.diagnostics) if (d.severity === "error" && paths.has(d.path)) errors.push(d);
    files[automation.path] = automation.text;
    for (const agentPath of agentPaths) {
      const text = byPath.get(agentPath);
      if (text !== undefined) files[agentPath] = text;
      // A returns schema travels with its agent, so Cloud's runtime validates against the same one.
      const agent = check.agents.find((a) => a.path === agentPath);
      if (agent?.returns !== undefined) {
        const schema = path.posix.join(path.posix.dirname(agentPath), agent.returns);
        const schemaText = byPath.get(schema);
        if (schemaText !== undefined) files[schema] = schemaText;
      }
    }
  }
  if (errors.length > 0) {
    throw new ApplyError("invalid", `Nothing was sent: fix these first.\n${renderDiagnostics(errors)}`);
  }
  if (!Object.keys(files).some((p) => p.startsWith(".caveman/automations/"))) {
    throw new ApplyError("nothing", "No automation here runs on Cloud. Add host: cloud to one in .caveman/automations/, then apply again.");
  }
  return { body: { repo: input.repo, commit_sha: input.commitSha, files }, skipped };
}

/** The plan for a checkout: its `.caveman/` working tree, its origin's `owner/name`, its HEAD. */
export async function applyPlanOf(root: string, registry: ReadonlyArray<ParsedAgent>): Promise<ApplyPlan> {
  const [sources, remote, head] = await Promise.all([
    readWorkingTree(root),
    git(root, ["remote", "get-url", "origin"]).catch(() => ""),
    git(root, ["rev-parse", "HEAD"]).catch(() => ""),
  ]);
  const repo = repoSlug(remote);
  if (repo === undefined) throw new ApplyError("no_repo", "This repository has no GitHub origin, so Caveman cannot tell which repository the automations belong to. Add one with git remote add origin.");
  if (head.trim() === "") throw new ApplyError("no_repo", "This repository has no commits yet; commit the .caveman/ files, then apply.");
  return applyPlanFrom({ sources, registry, repo, commitSha: head.trim() });
}

const text = (value: unknown): string | null => (value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value));
const STATES = new Set(["active", "pending_approval", "superseded", "unchanged", "removed"]);

/**
 * An authority diff, read tolerantly: A2-3's `{widens, changes}`, or a bare list of changes (A3's first draft), each
 * value as text.
 */
export function authorityDiffFrom(raw: unknown): CloudAuthorityDiff {
  const diff = (Array.isArray(raw) ? { changes: raw } : (raw ?? {})) as { widens?: unknown; changes?: unknown };
  const changes = (Array.isArray(diff.changes) ? diff.changes : []).flatMap((c): CloudAuthorityDiff["changes"][number][] => {
    if (c === null || typeof c !== "object") return [];
    const change = c as Record<string, unknown>;
    const before = text(change.before);
    const after = text(change.after);
    const kind = change.change === "added" || change.change === "removed" || change.change === "changed" ? change.change : before === null ? "added" : after === null ? "removed" : "changed";
    return [{ key: String(change.key ?? ""), change: kind, before, after, widens: change.widens === true }];
  });
  return { widens: diff.widens === true || changes.some((c) => c.widens), changes };
}

/** Cloud's answer, read tolerantly (A2-3 in CONTRACT-CHANGES): unknown fields are ignored and missing ones default. */
export function appliedFrom(raw: unknown): ReadonlyArray<CloudAutomationApplied> {
  const list = (raw as { automations?: unknown } | undefined)?.automations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): CloudAutomationApplied[] => {
    if (item === null || typeof item !== "object") return [];
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || a.id === "") return [];
    const state = typeof a.state === "string" && STATES.has(a.state) ? (a.state as CloudAutomationApplied["state"]) : "active";
    const hook = (a.hook !== null && typeof a.hook === "object" ? a.hook : {}) as Record<string, unknown>;
    const { id: hookId, path: hookPath, secret } = hook;
    return [
      {
        id: a.id,
        name: typeof a.name === "string" ? a.name : a.id,
        revision_id: typeof a.revision_id === "string" && a.revision_id !== "" ? a.revision_id : null,
        state,
        ...(typeof a.reason === "string" && a.reason !== "" ? { reason: a.reason } : {}),
        authority_diff: authorityDiffFrom(a.authority_diff),
        // The one time Cloud says a new webhook's secret: it goes to whoever applied, and nothing here keeps it.
        ...(typeof hookId === "string" && hookId !== "" && typeof hookPath === "string" && typeof secret === "string" && secret !== ""
          ? { hook: { id: hookId, path: hookPath, secret } }
          : {}),
      },
    ];
  });
}

const STATE_WORDS: Readonly<Record<CloudAutomationApplied["state"], string>> = {
  active: "active: it fires from now on",
  pending_approval: "waiting for the owner's approval, because it widens what it may do",
  superseded: "superseded by a newer revision",
  unchanged: "unchanged: Cloud already has these files",
  removed: "removed: this apply no longer carries its file, so Cloud stopped it",
};
const stateWords = (a: CloudAutomationApplied) =>
  a.state === "pending_approval" && a.reason === "not_owner" ? "waiting for its owner's approval, because you are not its owner" : STATE_WORDS[a.state];

const SIGNING = "Sign each body with it: X-Caveman-Signature: sha256=<hex HMAC-SHA256 of the body>. Caveman shows it this once; keep it where the sender reads it.";

/** A new webhook's one-time secrets, for a terminal that printed an apply's text (which never holds them). */
export function renderHookSecrets(automations: ReadonlyArray<CloudAutomationApplied>): string | undefined {
  const hooks = automations.flatMap((a) => (a.hook === undefined ? [] : [`  ${a.name}  ${a.hook.secret}`]));
  return hooks.length === 0 ? undefined : ["Webhook secrets:", ...hooks, `  ${SIGNING}`].join("\n");
}

/**
 * What `caveman-runtime apply` prints: each automation, its state, a new webhook's URL, then each change of authority.
 * `origin`: Caveman Cloud's, for the webhook's URL. `secrets`: the webhook's one-time secret too (a terminal's own
 * print, never a text the runtime hands on or keeps).
 */
export function renderApplied(input: {
  readonly repo: string;
  readonly automations: ReadonlyArray<CloudAutomationApplied>;
  readonly skipped: ApplyPlan["skipped"];
  readonly origin?: string | undefined;
  readonly secrets?: boolean;
}): string {
  const lines: string[] = [];
  for (const a of input.automations) {
    lines.push(`${a.name}  ${stateWords(a)}${a.revision_id === null ? "" : ` (revision ${a.revision_id})`}`);
    if (a.hook !== undefined) {
      const url = /^https?:\/\//.test(a.hook.path) || input.origin === undefined ? a.hook.path : `${input.origin.replace(/\/$/, "")}${a.hook.path.startsWith("/") ? "" : "/"}${a.hook.path}`;
      lines.push(`  webhook  POST ${url}`, ...(input.secrets === true ? [`  secret   ${a.hook.secret}`, `  ${SIGNING}`] : ["  secret   given once with this answer, apart from this text"]));
    }
    if (a.authority_diff.changes.length === 0) {
      lines.push("  no change to what it may do");
      continue;
    }
    const width = Math.max(...a.authority_diff.changes.map((c) => c.key.length));
    for (const c of a.authority_diff.changes) {
      const what =
        c.change === "added" ? `added ${c.after ?? ""}` : c.change === "removed" ? `removed ${c.before ?? ""}` : `${c.after ?? "nothing"}, was ${c.before ?? "nothing"}`;
      lines.push(`  ${c.key.padEnd(width)}  ${what.trim()}${c.widens ? "  (widens)" : ""}`);
    }
  }
  if (input.automations.some((a) => a.state === "pending_approval" && a.reason !== "not_owner")) {
    lines.push("", "The owner approves a widening revision on the Automations page in Caveman Platform; until then the active one keeps running.");
  }
  if (input.skipped.length > 0) {
    lines.push("", "Stayed here:");
    for (const s of input.skipped) lines.push(`  ${s.path}  ${s.reason}`);
  }
  return `${input.repo}\n${lines.join("\n")}`;
}
