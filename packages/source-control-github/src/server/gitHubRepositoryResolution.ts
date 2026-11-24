// ), packages/source-control-github/src/server/gitHubRepositoryResolution.ts @ ab3a3cd1.
import { normalizeGitRemoteUrl } from "@caveman-app/shared/git";
import {
  detectSourceControlProviderFromRemoteUrl,
  isSshRemoteUrl,
} from "@caveman-app/shared/sourceControl";
import { isGitHubHost } from "./GitHubCredentials.ts";

/** A repository on a GitHub host: the API it is read through, and its owner and name. */
export interface GitHubRepositoryLocator {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** The fetch remotes in `git remote -v` output, by name. */
export function parseFetchRemotes(
  remotes: string,
): ReadonlyArray<{ readonly name: string; readonly url: string }> {
  // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
  return remotes
    .split("\n")
    .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]+\])?$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, url: match[2]! }));
}

/**
 * The repository `gh pr list` reads in a checkout, picked the way gh picks one without a
 * prompt: the remote `gh repo set-default` marked, else the first of upstream, github, origin
 * (in any case), else the only remote. `remotes` is `git remote -v` output and `resolved` is the output of
 * `git config --get-regexp '^remote\..*\.gh-resolved$'`.
 *
 * Null whenever gh might weigh the remotes differently: a remote on another host, more than one
 * mark, or several remotes with none of those names. An SSH alias counts as the host it stands
 * for. Callers then fall back to the provider's remote, then to the best-ranked remote on the
 * host.
 */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const remote of parseFetchRemotes(input.remotes)) {
    const [normalizedHost, owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/");
    const remoteHost =
      normalizedHost && isSshRemoteUrl(remote.url)
        ? (apiHostForSshAlias(normalizedHost) ?? normalizedHost)
        : normalizedHost;
    if (remoteHost !== host || !owner || !name || rest.length > 0) return null;
    repositories.set(remote.name, { owner, name });
  }
  const marks = input.resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && repositories.has(match[1]!));
  if (marks.length > 1) return null;
  const [mark] = marks;
  if (mark) {
    if (mark[2] === "base") return repositories.get(mark[1]!) ?? null;
    const [owner, name, ...rest] = mark[2]!.toLowerCase().split("/");
    return owner && name && rest.length === 0 ? { owner, name } : null;
  }
  // gh sorts remotes by these names, case-insensitively, and takes the first. A tie for the
  // top place has no defined winner.
  const score = (remoteName: string) =>
    ["origin", "github", "upstream"].indexOf(remoteName.toLowerCase()) + 1;
  const ranked = [...repositories.entries()].toSorted(
    ([left], [right]) => score(right) - score(left),
  );
  const [top, next] = ranked;
  return top !== undefined && (next === undefined || score(top[0]) > score(next[0]))
    ? top[1]
    : null;
}

/**
 * The repository `gh` would act on in a checkout, from its remotes: the remote `gh` would pick,
 * else the best-ranked remote on the host. `host` is the API host it settled on, which a caller
 * names when no repository was found there. GH_REPO is the caller's to check first.
 */
export function resolveGitHubRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  /** The checkout's GitHub API host, when the caller already knows it. */
  readonly hostHint: string | undefined;
  readonly defaultHost: string;
}): { readonly host: string; readonly locator: GitHubRepositoryLocator | null } {
  const fetchRemotes = parseFetchRemotes(input.remotes).map((remote) => ({
    ...remote,
    host: gitHubApiHostForRemote(remote.url),
  }));
  const host =
    (input.hostHint === undefined ? undefined : apiHostForHint(input.hostHint, fetchRemotes)) ??
    fetchRemotes.find((remote) => remote.name === "origin" && remote.host !== null)?.host ??
    fetchRemotes.find((remote) => remote.host !== null)?.host ??
    input.defaultHost;
  const selected = selectGitHubBaseRepository({
    remotes: input.remotes,
    resolved: input.resolved,
    host,
  });
  if (selected !== null) return { host, locator: { host, ...selected } };
  // gh's own order without its prompt: upstream, github, origin, then the first remote, among
  // the ones on this host (an SSH alias counts as its API host).
  const rank = (name: string) => ["upstream", "github", "origin"].indexOf(name.toLowerCase());
  const candidates = fetchRemotes
    .filter(
      (remote) =>
        remote.host === host ||
        (remote.host === null && normalizeGitRemoteUrl(remote.url).split("/")[0] === host),
    )
    .toSorted((left, right) => {
      const l = rank(left.name);
      const r = rank(right.name);
      return (l === -1 ? 99 : l) - (r === -1 ? 99 : r);
    });
  for (const remote of candidates) {
    const [owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/").slice(1);
    if (owner && name && rest.length === 0) return { host, locator: { host, owner, name } };
  }
  return { host, locator: null };
}

/** `owner/name` or `host/owner/name`, as `gh --repo` and GH_REPO take them. */
export function parseGitHubRepositorySelector(
  selector: string,
  defaultHost: string,
): GitHubRepositoryLocator | null {
  // Like gh, a clone URL's `.git` comes off the path, before any trailing slash, query or fragment.
  const withoutGitSuffix = (path: string) => path.replace(/\.git\/*$/i, "");
  const trimmed = selector.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const [owner, name, ...rest] = withoutGitSuffix(url.pathname).split("/").filter(Boolean);
      return owner && name && rest.length === 0
        ? { host: url.host.toLowerCase(), owner, name }
        : null;
    } catch {
      return null;
    }
  }
  const parts = withoutGitSuffix(trimmed).split("/").filter(Boolean);
  if (parts.length === 2) return { host: defaultHost, owner: parts[0]!, name: parts[1]! };
  const host = parts[0]?.toLowerCase();
  if (parts.length === 3 && host !== undefined && isGitHubHost(host))
    return { host, owner: parts[1]!, name: parts[2]! };
  return null;
}

/**
 * A pull request reference the way `gh pr view` takes one: a number (`#7` too), a pull request
 * URL, or a branch name.
 */
export function parsePullRequestReference(
  reference: string,
):
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "url"; readonly locator: GitHubRepositoryLocator; readonly number: number }
  | { readonly kind: "branch"; readonly headSelector: string } {
  const trimmed = reference.trim();
  const numbered = /^#?([1-9]\d*)$/.exec(trimmed);
  if (numbered) return { kind: "number", number: Number(numbered[1]) };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
      if (match) {
        return {
          kind: "url",
          locator: { host: url.host.toLowerCase(), owner: match[1]!, name: match[2]! },
          number: Number(match[3]),
        };
      }
    } catch {
      // Not a URL after all; read it as a branch.
    }
  }
  return { kind: "branch", headSelector: trimmed };
}

// An additional dot is a real DNS host, never a github.com SSH alias.
const GITHUB_DOT_COM_SSH_ALIAS = /^github\.com-[a-z0-9_-]+$/u;

/**
 * The API host an SSH alias from ~/.ssh/config stands for: a dotless alias holding "github"
 * (`git@github-work:`) and a `github.com-<name>` alias (multi-account setups) read through
 * `github.com`; another dotless alias is no API host (null). Undefined for a real host.
 */
function apiHostForSshAlias(host: string): string | null | undefined {
  if (!host.includes(".")) return host.includes("github") ? "github.com" : null;
  return GITHUB_DOT_COM_SSH_ALIAS.test(host) ? "github.com" : undefined;
}

/**
 * The GitHub host a remote URL is served from, or null for a remote that is not GitHub. An SSH
 * alias (`git@github-work:owner/repo`, `git@github.com-work:owner/repo`) names no API host of its
 * own; it is read through `github.com`, which is what such an alias almost always stands for
 * (issue #6198). So is `ssh.github.com`, GitHub's SSH endpoint on port 443 for networks that
 * block port 22.
 */
export function gitHubApiHostForRemote(remoteUrl: string): string | null {
  const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
  if (provider === null) return null;
  const host = new URL(provider.baseUrl).host.toLowerCase();
  // An alias from ~/.ssh/config is never a real API host.
  if (isSshRemoteUrl(remoteUrl)) {
    const aliased = apiHostForSshAlias(host);
    if (aliased !== undefined) return aliased;
  }
  if (host === "ssh.github.com") return "github.com";
  return provider.kind === "github" ? host : null;
}

/**
 * The repository a git remote names on the GitHub host `host`, or null for a remote elsewhere.
 * An SSH alias from ~/.ssh/config names no host that can be checked against `host`, so it is
 * taken to name a repository there.
 */
export function gitHubRepositoryOfRemote(
  remoteUrl: string,
  host: string,
): GitHubRepositoryLocator | null {
  const [remoteHost = "", owner, name, ...rest] = normalizeGitRemoteUrl(remoteUrl).split("/");
  if (!owner || !name || rest.length > 0) return null;
  const alias = isSshRemoteUrl(remoteUrl) && apiHostForSshAlias(remoteHost) !== undefined;
  const apiHost = host.toLowerCase();
  if (!alias && (gitHubApiHostForRemote(remoteUrl) ?? remoteHost) !== apiHost) return null;
  return { host: apiHost, owner, name };
}

/** Whether a git remote is `nameWithOwner` on the GitHub host `host`, by the name it gives. */
export function remoteHoldsGitHubRepository(
  remoteUrl: string,
  host: string,
  nameWithOwner: string,
): boolean {
  const held = gitHubRepositoryOfRemote(remoteUrl, host);
  return held !== null && `${held.owner}/${held.name}` === nameWithOwner.toLowerCase();
}

/** A caller's host hint, read the way a remote's host is: an SSH alias is not an API host. */
function apiHostForHint(host: string, remotes: ReadonlyArray<{ readonly url: string }>): string {
  const normalized = host.toLowerCase();
  if (GITHUB_DOT_COM_SSH_ALIAS.test(normalized)) {
    const matching = remotes.filter(
      (remote) => normalizeGitRemoteUrl(remote.url).split("/")[0] === normalized,
    );
    // A hint carries no transport; an HTTPS remote or missing evidence must not select
    // the github.com endpoint and credentials for a dotted host.
    if (matching.length === 0 || matching.some((remote) => !isSshRemoteUrl(remote.url)))
      return normalized;
  }
  return apiHostForSshAlias(normalized) ?? normalized;
}
