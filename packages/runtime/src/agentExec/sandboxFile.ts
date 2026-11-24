// `agent exec --sandbox-file`: where a coding agent's commands and files run when they do not run here. Tier linux on
// Cloud's harness pool (Caveman Cloud docs/ §3.1-3.2): the harness stays
// on the pool and drives the session's one bare Caveman sandbox through the public sandbox API with the session's own
// key, the endpoint's (CAVEMAN_MODEL_API_KEY_FILE). The pool writes this file from its claim; it holds no secret, and
// its shape is Caveman Cloud's public/shared/contracts/examples/sandbox-file.json and sandbox-file-repository.json
// (fixtures/):
//
//   {"session_id": "...", "api_url": "https://...", "relay_url": "https://...", "computer_id": "...",
//    "repository": {"owner": "...", "name": "...", "base_branch": "...", "git_url": "http://..."}}
//
// session_id names the create's Idempotency-Key (`session-<id>`); api_url is the Caveman Cloud API's origin, relay_url
// the origin of its /relay (the streams); computer_id, when the session has its computer already (an earlier claim's),
// is attached instead of making one; repository, when the session names one, is cloned into the computer from its
// git_url (the computer's host's git lane: no credential in the computer), base_branch (optional: the default branch)
// checked out, and the GitHub URL sent to git_url by the clone's own config. Nothing else: control-api decides a
// session computer's size, network, lifetime and idle, and its working directory is the image's /workspace. The computer is made at the first tool call that
// needs one (the harness's SandboxEnv), never at start, and the build's own files (--cwd) are written into it then.
// A build's secrets come apart from it, in the 0600 file CAVEMAN_SANDBOX_SECRETS_FILE names (readSandboxSecrets).
import * as fs from "node:fs";
import * as path from "node:path";

import { isReservedEnvName } from "@caveman-app/session-protocol";

export interface SandboxFile {
  readonly sessionId: string;
  readonly apiURL: string;
  readonly relayURL: string;
  readonly computerId?: string;
  readonly repository?: {
    readonly owner: string;
    readonly name: string;
    readonly baseBranch?: string;
    readonly gitURL: string;
  };
}

const KEYS = ["session_id", "api_url", "relay_url", "computer_id", "repository"];
/** An owner's or a repository's name, as the host's git lane takes it. */
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A branch git would take, never an option. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin the sandbox client takes: HTTPS, or HTTP on this machine; no path, credentials, query or fragment. */
function origin(name: string, raw: unknown): string | { readonly error: string } {
  const bad = {
    error: `--sandbox-file: ${name} is an origin: https://host[:port], or http on this machine, with no path, credentials, query or fragment`,
  };
  if (typeof raw !== "string") return bad;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad;
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== ""
  )
    return bad;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    return bad;
  return url.origin;
}

/** A clone's URL: http or https, no credentials (the computer holds none), no query or fragment; undefined if not. */
function cloneURL(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  return url.href;
}

/** The file at `file`, checked whole; a string says what is wrong with it. */
export function readSandboxFile(file: string): SandboxFile | string {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return `--sandbox-file ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "--sandbox-file is a JSON object";
  const data = value as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0)
    return `--sandbox-file has ${unknown.join(", ")}; it takes ${KEYS.join(", ")}`;
  // The Idempotency-Key is `session-<id>`: 1 to 200 letters, digits and . _ : - in all.
  if (typeof data.session_id !== "string" || !/^[A-Za-z0-9._:-]{1,192}$/.test(data.session_id)) {
    return "--sandbox-file: session_id is 1 to 192 letters, digits and . _ : -";
  }
  const api = origin("api_url", data.api_url);
  if (typeof api !== "string") return api.error;
  const relay = origin("relay_url", data.relay_url);
  if (typeof relay !== "string") return relay.error;
  if (
    data.computer_id !== undefined &&
    (typeof data.computer_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(data.computer_id))
  ) {
    return "--sandbox-file: computer_id is a computer's id";
  }
  let repository: SandboxFile["repository"];
  if (data.repository !== undefined) {
    const repo = data.repository as Record<string, unknown> | null;
    const bad =
      "--sandbox-file: repository is {owner, name, base_branch?, git_url}: letters, digits and . _ - (a branch / too), git_url an http(s) URL without credentials";
    if (repo === null || typeof repo !== "object" || Array.isArray(repo)) return bad;
    if (Object.keys(repo).some((key) => !["owner", "name", "base_branch", "git_url"].includes(key)))
      return bad;
    const gitURL = typeof repo.git_url === "string" ? cloneURL(repo.git_url) : undefined;
    if (gitURL === undefined) return bad;
    if (
      typeof repo.owner !== "string" ||
      !SEGMENT.test(repo.owner) ||
      typeof repo.name !== "string" ||
      !SEGMENT.test(repo.name)
    )
      return bad;
    if (
      repo.base_branch !== undefined &&
      (typeof repo.base_branch !== "string" || !BRANCH.test(repo.base_branch))
    )
      return bad;
    repository = {
      owner: repo.owner,
      name: repo.name,
      ...(repo.base_branch === undefined ? {} : { baseBranch: repo.base_branch as string }),
      gitURL,
    };
  }
  return {
    sessionId: data.session_id,
    apiURL: api,
    relayURL: relay,
    ...(data.computer_id === undefined ? {} : { computerId: data.computer_id }),
    ...(repository === undefined ? {} : { repository }),
  };
}

/** Where the pool names a linux session's build secrets (Caveman Cloud harness pool). */
export const SECRETS_ENV = "CAVEMAN_SANDBOX_SECRETS_FILE";

export interface SandboxSecret {
  readonly name: string;
  readonly value: string;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRETS_MAX = 64;
/** A shorter value could not be told apart from other text in what is redacted (the pool withholds it). */
const SECRET_VALUE_MIN = 8;
const SECRET_VALUE_MAX = 64 * 1024;

/**
 * The build's secrets SECRETS_ENV names, its shape Caveman Cloud's public/shared/contracts/examples/secrets-file.json
 * (fixtures/): {"secrets": [{"name": "...", "value": "..."}]}, at most 64, each name an environment variable NAME the
 * computer does not set itself (the runtime's reserved list, Cloud's too), once, each value 8 bytes to 64 KiB of text
 * without NUL. The organization's own values for the commands the session's computer runs: they go in each command's
 * environment (the harness's SandboxEnv env), never into a file there, and are redacted from everything agent exec
 * says. With `remove` (agent exec, at start), the file is deleted right after it is read, before anything else, so its
 * time on disk is the shortest (the pool removes it too, after the child); one that cannot be deleted is refused. A
 * string says what is wrong, never with a value.
 */
export function readSandboxSecrets(
  file: string,
  options: { readonly remove?: boolean } = {},
): ReadonlyArray<SandboxSecret> | string {
  const where = `${SECRETS_ENV} ${file}`;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return `${where}: ${(error as NodeJS.ErrnoException).code ?? "cannot be read"}`;
  }
  if (options.remove === true) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Gone already is what deleting it is for.
      if (code !== "ENOENT")
        return `${where} could not be deleted once read (${code ?? "unknown error"}); agent exec keeps a build's secrets in memory alone`;
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not the parser's words: they quote the text, values and all.
    return `${where} is not JSON`;
  }
  const shape = `${where} is {"secrets": [{"name", "value"}]}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return shape;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== "secrets") || !Array.isArray(data.secrets))
    return shape;
  if (data.secrets.length > SECRETS_MAX)
    return `${where} has ${data.secrets.length} secrets; a build names at most ${SECRETS_MAX}`;
  const secrets: Array<SandboxSecret> = [];
  for (const [index, entry] of (data.secrets as Array<unknown>).entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return shape;
    const { name, value: secret, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof name !== "string" || typeof secret !== "string")
      return shape;
    if (!SECRET_NAME.test(name) || isReservedEnvName(name, "process")) {
      return `${where}: secret ${index + 1}'s name is not an environment variable NAME a command may be given (A-Z, 0-9 and _, not one the computer sets itself, such as PATH)`;
    }
    if (secrets.some((seen) => seen.name === name)) return `${where} names ${name} twice`;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes < SECRET_VALUE_MIN || bytes > SECRET_VALUE_MAX || secret.includes("\0")) {
      return `${where}: ${name}'s value is not ${SECRET_VALUE_MIN} bytes to 64 KiB of text without NUL`;
    }
    secrets.push({ name, value: secret });
  }
  return secrets;
}

/**
 * The build's own files: every regular file under `root` (the pool's --cwd holds just the claim's agent files), its
 * path relative to it, but `skip` (agent exec's own inputs and outputs when they lie there). Read when the sandbox
 * is made, not before.
 */
export async function buildFiles(
  root: string,
  skip: ReadonlySet<string>,
): Promise<Array<{ readonly path: string; readonly data: Uint8Array }>> {
  const files: Array<{ readonly path: string; readonly data: Uint8Array }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && !skip.has(full))
        files.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          data: await fs.promises.readFile(full),
        });
    }
  };
  await walk(root);
  return files;
}
