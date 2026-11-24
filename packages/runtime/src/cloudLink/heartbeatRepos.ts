// Repos in the heartbeat (RESEARCH-W2 decision 30): a Mac tells Cloud which GitHub repositories it has checked out,
// each as the SHA-256 of its normalized remote URL (normalizeGitRemoteUrl: host and path, lowercased, without scheme,
// user, port or ".git"), and the checkout's HEAD, never a path. Cloud then offers a move or pull to a Mac only when it
// has the chat's repository, whose hash it computes from the chat's GitHub owner/name (Caveman Cloud runtime_repos.go
// GitHubRepoHash; the same vectors are in both tests). Only github.com remotes go: a chat moves only in a repository on
// GitHub, so Cloud matches nothing else, and is told nothing else. A Cloud from before the field refuses it (400): the
// heartbeat then goes without it for an hour (link.ts).
import { createHash } from "node:crypto";

import { normalizeGitRemoteUrl } from "@caveman-app/shared/git";

/** One repository a Mac has checked out, as the heartbeat carries it. */
export interface HeartbeatRepo {
  readonly remote_hash: string;
  /** The checkout's HEAD commit, or "" when it has none yet. */
  readonly head: string;
}

/** The most a heartbeat carries (Cloud's MaxHeartbeatRepos): 200 entries with 64-hex heads stay well inside its 64 KiB body. */
export const MAX_HEARTBEAT_REPOS = 200;

/** The hash of a GitHub remote as Cloud hashes it (github.com/<owner>/<name>); undefined for anything else (another host, a local path). */
export function repoHash(remote: string): string | undefined {
  const key = normalizeGitRemoteUrl(remote);
  if (!/^github\.com\/[^/\s]+\/[^/\s]+$/.test(key)) return undefined;
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The list a Mac's checkouts make, in the order given (its projects first, then what discovery found): one entry per
 * GitHub repository (the first checkout's head), read as it goes (`read`), never a path. Undefined when they hold more
 * GitHub repositories than Cloud keeps: a list cut short would tell Cloud this Mac lacks repositories it has, and Cloud
 * refuses a move to a Mac its list lacks, so none goes then (Cloud keeps the list it had, or filters nothing).
 */
export async function heartbeatRepos(
  dirs: Iterable<string>,
  read: { readonly remote: (dir: string) => Promise<string | null | undefined>; readonly head: (dir: string) => string | undefined },
): Promise<Array<HeartbeatRepo> | undefined> {
  const out = new Map<string, HeartbeatRepo>();
  for (const dir of dirs) {
    const remote = await read.remote(dir);
    const hash = remote ? repoHash(remote) : undefined;
    if (hash === undefined || out.has(hash)) continue;
    if (out.size >= MAX_HEARTBEAT_REPOS) return undefined;
    const head = read.head(dir) ?? "";
    out.set(hash, { remote_hash: hash, head: /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head : "" });
  }
  return [...out.values()];
}
