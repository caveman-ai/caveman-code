// Test helpers: a throwaway git repository with automation files, and the fakes the automation services
// run against (a project store that knows one checkout, a runner that records what it was asked).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProjectId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { AutomationRunner, type AdmitRequest, type AdmitResult } from "./services.ts";

export interface TestRepo {
  readonly root: string;
  readonly write: (rel: string, text: string) => void;
  readonly git: (...args: string[]) => string;
  readonly commit: (message?: string) => void;
  readonly remove: () => void;
}

/** `git init -b main`, with the given files committed when `commit` is true. */
export function testRepo(files: Readonly<Record<string, string>> = {}, options: { readonly commit?: boolean } = {}): TestRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-automations-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@caveman.so");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const commit = (message = "files") => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };
  write("README.md", "# test\n");
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  if (options.commit !== false) commit("start");
  return { root, write, git, commit, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * A `git` first on PATH that runs the real one, except that the next `times` calls naming `subcommand` fail with exit
 * 128, as a git spawned under load does (EAGAIN, EMFILE), or, `killed`, die by a signal before they answer at all, as
 * a git that could not be started says nothing either. PATH is the whole worker's, so no other test of the file may
 * run while it is in place; `restore` puts PATH back.
 */
export function gitFailing() {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-git-shim-")));
  const marker = path.join(dir, "fail-next");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh
if [ -f "${marker}" ]; then
  read -r sub left how < "${marker}"
  for a in "$@"; do
    if [ "$a" = "$sub" ]; then
      if [ "$left" -gt 1 ]; then echo "$sub $((left - 1)) $how" > "${marker}"; else rm -f "${marker}"; fi
      if [ "$how" = "killed" ]; then kill -KILL $$; fi
      echo "fatal: Resource temporarily unavailable" >&2
      exit 128
    fi
  done
fi
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved ?? ""}`;
  return {
    failNext: (subcommand: string, times = 1, how: "exit" | "killed" = "exit") => fs.writeFileSync(marker, `${subcommand} ${times} ${how}\n`),
    /** Every failure asked for was spent. */
    failed: () => !fs.existsSync(marker),
    /** git works again, whatever failures were left. */
    heal: () => fs.rmSync(marker, { force: true }),
    restore: () => {
      process.env.PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The runtime as launched from a German terminal, with a translated git first on PATH (Homebrew's, linked to libintl):
 * it says "Kein Git-Repository" where git says "not a git repository", unless the locale is C. Like gitFailing, it is
 * the whole worker's until `restore`.
 */
export function gitTranslated() {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-git-de-")));
  fs.writeFileSync(
    path.join(dir, "git"),
    [
      "#!/bin/sh",
      `case "\${LC_ALL:-\${LC_MESSAGES:-$LANG}}" in ""|C|C.*|POSIX) exec "${real}" "$@" ;; esac`,
      `err=$(mktemp); "${real}" "$@" 2>"$err"; code=$?`,
      "sed 's/^fatal: not a git repository (or any of the parent directories)/Schwerwiegend: Kein Git-Repository (oder irgendeines der Elternverzeichnisse)/' \"$err\" >&2",
      'rm -f "$err"; exit $code',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL };
  Object.assign(process.env, { PATH: `${dir}${path.delimiter}${saved.PATH ?? ""}`, LC_ALL: "de_DE.UTF-8" });
  return {
    restore: () => {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A folder in no git repository, holding these files. */
export function plainFolder(files: Readonly<Record<string, string>> = {}): { readonly root: string; readonly remove: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-folder-")));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A project store that knows these checkouts, by Session Protocol project id. */
export const projectStoreFor = (projects: Readonly<Record<string, string>>) =>
  Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (id) => {
      const root = projects[id];
      return Effect.succeed(root === undefined ? Option.none() : Option.some({ projectId: id, workspaceRoot: root, deletedAt: null } as never));
    },
    list: () => Effect.succeed(Object.entries(projects).map(([id, root]) => ({ projectId: ProjectId.make(id), workspaceRoot: root, deletedAt: null }) as never)),
  });

/** A runner that admits everything (or answers `answer`) and remembers each request. */
export function fakeRunner(answer?: (request: AdmitRequest) => AdmitResult) {
  const admitted: AdmitRequest[] = [];
  const layer = Layer.succeed(AutomationRunner, {
    admit: (request) =>
      Effect.sync(() => {
        admitted.push(request);
        return answer?.(request) ?? { runId: `r_${admitted.length}` };
      }),
    cancel: () => Effect.void,
    applyOutputs: () => Effect.succeed([]),
    runs: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined),
    useLauncher: () => Effect.void,
    approve: (input) => Effect.succeed({ refused: "not_found", message: `No run ${input.runId}.` } as const),
    useHost: () => Effect.void,
    useChief: () => Effect.void,
  });
  return { admitted, layer };
}

/** The smallest automation that loads clean. */
export const DIGEST = `on: { schedule: { every: 6h } }
steps:
  digest:
    prompt: Summarise yesterday's merged pull requests.
    model: fast
    computer: none
`;
