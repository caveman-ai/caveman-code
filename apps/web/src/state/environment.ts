// A project's Cloud setup in the person's words (docs/ §3-§4):
// the run-on chip, the setup card's steps and fold line, the failure table and the missing values. Plain
// functions over environment.get's answer, so every state reads the same in the chip, the card and the
// Computer tab; useEnvironment keeps one fresh while it is on screen. Never a cost.
// docs/ adds the setup chat's proposal (a diff to publish), agents'
// proposals, CI on the built commit, and the organization's whole list (useEnvironmentList).
import type { Environment, EnvironmentBuild, EnvironmentCi, EnvironmentSummary, Result } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRuntimeClient } from "./runtime.tsx";

export type EnvironmentAnswer = Result<"environment.get">;

const STEP_LABEL: Record<string, string> = {
  clone: "Clone",
  services: "Services",
  setup: "Setup",
  check: "Checks",
  snapshot: "Save",
  restore_check: "Final check",
};
export const stepLabel = (name: string) => STEP_LABEL[name] ?? name;

export const buildDone = (b: Pick<EnvironmentBuild, "status">) => b.status === "succeeded" || b.status === "failed";

/** The steps a person sees: Services only when the setup asks for one, so "step 3" and "3/5" count the rows shown. */
export const shownSteps = (build: Pick<EnvironmentBuild, "steps">, config: string | null) => build.steps.filter((s) => s.name !== "services" || servicesOf(config).length > 0);

/** "3/5": the step the build is on, of the ones shown. */
export function stepProgress(build: Pick<EnvironmentBuild, "steps">, config: string | null): string {
  const steps = shownSteps(build, config);
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return `${Math.min(done + 1, steps.length)}/${steps.length}`;
}

export type Tone = "ok" | "busy" | "warn" | "idle";

/** Cloud is off for the organization: the run-on row's reason, and what a start page says. */
export const CLOUD_OFF = "Cloud is off. Ask your admin.";
/** A project Cloud cannot fetch: only a repository on GitHub runs there. */
export const CLOUD_NEEDS_GITHUB = "Cloud needs this project on GitHub.";
/** This computer is not signed in to Caveman. */
export const CLOUD_NEEDS_SIGN_IN = "Sign in to use Cloud (Settings > Account).";

/** Asked from inside Cloud, where a project's setup is not changed. */
export const CLOUD_SETUP_ON_MAC = "Change Cloud setup on your Mac (Settings > Environments).";

/**
 * Why Cloud cannot be picked, from the runtime's reason (environment.get `reason`, which carries no code, so its
 * words are read): signed out of Caveman, asked from inside Cloud, else off for the organization. The runtime's own
 * sentence is never shown: it names servers and what they prepare.
 */
export function cloudUnavailable(reason: string | undefined): string {
  if (/sign in/i.test(reason ?? "")) return CLOUD_NEEDS_SIGN_IN;
  if (/on your Mac/i.test(reason ?? "")) return CLOUD_SETUP_ON_MAC;
  return CLOUD_OFF;
}

/**
 * Cloud as New chat's run-on control says it. `chip`: the pill's words, one of three states and no more ("Cloud",
 * "Cloud · setting up 3/5", "Cloud · setup failed"). `disabled`: why its row cannot be picked, said beside it.
 * `failed`: setup failed, so the pill offers See why. A failed setup is amber, never red: chats still start.
 */
export function runOnLabel(answer: EnvironmentAnswer | null): { chip: string; tone: Tone; disabled?: string; failed?: true } {
  if (answer === null) return { chip: "Cloud", tone: "idle" };
  if (!answer.available) return { chip: "Cloud", tone: "idle", disabled: cloudUnavailable(answer.reason) };
  const env = answer.environment;
  if (env === null) return { chip: "Cloud", tone: "idle", disabled: CLOUD_NEEDS_GITHUB };
  const latest = env.build;
  switch (env.state) {
    case "setting_up":
      return { chip: latest ? `Cloud · setting up ${stepProgress(latest, env.config)}` : "Cloud · setting up", tone: "busy" };
    case "failed":
      return { chip: "Cloud · setup failed", tone: "warn", failed: true };
    // Not set up yet (Caveman sets it up with the first chat), set up, or set up with an update running or failed
    // beside it: the chat starts either way, so there is nothing to say.
    case "not_set_up":
      return { chip: "Cloud", tone: "idle" };
    case "ready_with_gaps":
    case "ready":
      return { chip: "Cloud", tone: "ok" };
  }
}

/** A repo's row in Settings, Environments: its state, and for one that is set up when that was. */
export function environmentLine(answer: EnvironmentAnswer | null, now = Date.now()): { tone: Tone; text: string } {
  const label = runOnLabel(answer);
  const env = answer?.environment;
  if (!env) return { tone: "idle", text: label.disabled ?? "Checking Cloud…" };
  // The setup chat's fix waiting for the person comes first (agents' proposals show as their own cards).
  if (answer?.setup_chat?.state === "review") return { tone: "warn", text: "Fix ready for review" };
  switch (env.state) {
    case "not_set_up":
      return { tone: "idle", text: "Not set up. Its first chat in Cloud sets it up." };
    case "setting_up":
      return { tone: "busy", text: env.build ? `Setting up ${stepProgress(env.build, env.config)}` : "Setting up" };
    case "failed":
      return { tone: "warn", text: env.build?.failure ? `Setup failed: ${env.build.failure.message}` : "Setup failed" };
    default: {
      const running = env.build !== null && !buildDone(env.build);
      const failedUpdate = !running && env.build?.status === "failed";
      const when = env.snapshot ? `${env.snapshot.commit.slice(0, 7)}, ${ago(env.snapshot.built_at, now)}` : null;
      const note = running ? "updating now" : failedUpdate ? "the last update failed" : env.state === "ready_with_gaps" ? "a check failed" : null;
      return { tone: env.state === "ready_with_gaps" || failedUpdate ? "warn" : "ok", text: ["Set up", when, note].filter(Boolean).join(" · ") };
    }
  }
}

/** "4m 12s", "38s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "2 h ago": when a snapshot was built. */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** The setup folded, like "Worked for": `Set up in 4m 12s · 2 checks passed`. */
export function foldLine(build: EnvironmentBuild, snapshot: Environment["snapshot"]): string {
  const took = build.started_at && build.finished_at ? `Set up in ${duration(Date.parse(build.finished_at) - Date.parse(build.started_at))}` : "Set up";
  const checks = snapshot?.checks ?? [];
  const passed = checks.filter((c) => c.ok).length;
  const said = checks.length === 0 ? "" : passed === checks.length ? ` · ${checks.length} ${checks.length === 1 ? "check" : "checks"} passed` : ` · ${passed} of ${checks.length} checks passed`;
  return `${took}${said}`;
}

/** `Saved as acme/web's Cloud setup for everyone in Acme.` */
export const savedLine = (repo: string, org: string | undefined) => `Saved as ${repo}'s Cloud setup for everyone in ${org ?? "your organization"}.`;

export type FailureAction = "fix" | "log" | "add_value" | "add_build_secret" | "use_size";

/** What broke, in one sentence, and at most two buttons. */
export function failureCopy(build: EnvironmentBuild, env: Pick<Environment, "snapshot" | "max_size" | "repo" | "config">, now = Date.now()): { text: string; actions: FailureAction[]; value?: string; size?: string } {
  const failure = build.failure;
  if (!failure) return { text: "The build stopped without saying why.", actions: ["log"] };
  const step = shownSteps(build, env.config).findIndex((s) => s.name === failure.step);
  const where = step >= 0 ? `step ${step + 1}` : stepLabel(failure.step).toLowerCase();
  const message = failure.message.replace(/\.$/, "");
  const keeps = env.snapshot ? ` Chats keep using the setup from ${ago(env.snapshot.built_at, now)}.` : " Chats start without setup until it works.";
  if (/ERR_PNPM_OUTDATED_LOCKFILE|lockfile.{0,40}(out of date|doesn't match|not up to date|needs to be updated)|frozen-lockfile/i.test(`${failure.message}\n${build.log_tail}`) && failure.kind === "command") {
    const lock = /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|uv\.lock|Cargo\.lock|poetry\.lock)/.exec(`${failure.message}\n${build.log_tail}`)?.[1] ?? "The lockfile";
    return { text: `${lock} doesn't match its manifest on ${build.steps.length > 0 ? "the default branch" : "main"}. That's in the repository, not the setup.`, actions: ["log"] };
  }
  switch (failure.kind) {
    case "registry_auth": {
      // A private registry's token is the organization's, read at build time only: a shared build secret, not a
      // person's own value (those never reach a build).
      const value = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|AUTH))\b/.exec(failure.message)?.[1] ?? (/npm|yarn|pnpm/i.test(failure.message) ? "NPM_TOKEN" : undefined);
      return value
        ? { text: `${message}. Setup needs ${value} as a build secret: shared for this repository, read only while it builds.`, actions: ["add_build_secret"], value }
        : { text: `${message}. Setup needs a registry token as a build secret.`, actions: ["add_build_secret", "log"] };
    }
    case "timeout":
      return { text: `Setup ran past its time limit at ${stepLabel(failure.step).toLowerCase()}.${keeps}`, actions: ["fix", "log"] };
    case "too_big":
      return { text: `${message}.`, actions: env.max_size ? ["use_size"] : [], size: env.max_size };
    case "clone":
      return { text: `Couldn't clone ${env.repo}: ${message}.`, actions: ["log"] };
    case "secret_on_disk":
      // A build secret ended up in a file, so the setup wasn't saved: everyone's chats would have read it.
      // Cloud's message names the files, never the value.
      return {
        text: `Setup left a build secret in a file, so it wasn't saved and no chat got it: ${message}. Have setup read it from the environment (npm reads \${NPM_TOKEN} in .npmrc) or delete the file before it ends.${keeps}`,
        actions: ["fix", "log"],
      };
    case "start":
      // Scheduling, an image pull, a Spot node that never came: Caveman Cloud's side, not the setup's.
      return { text: `Cloud couldn't start the setup: ${message}. The setup itself didn't run, so Rebuild tries it again.${keeps}`, actions: ["log"] };
    case "restore":
      return { text: `The new setup failed its checks from a fresh start: ${message}. It wasn't kept.${keeps}`, actions: ["fix", "log"] };
    case "service":
    case "check":
    case "command":
      return { text: `Setup failed at ${where}: ${message}.${keeps}`, actions: ["fix", "log"] };
  }
}

/**
 * Whether a failing setup is the repo's own (environment.ci): "CI on abc1234 is failing too: lint, test", or
 * "Passes in CI on abc1234", so the Cloud setup is what to fix. Nothing when GitHub can't say.
 */
export function ciLine(ci: EnvironmentCi | null | undefined): { tone: Tone; text: string } | null {
  if (!ci || ci.state === "unknown") return null;
  const at = /^[0-9a-f]{12,40}$/i.test(ci.commit) ? ci.commit.slice(0, 7) : ci.commit;
  switch (ci.state) {
    case "failing":
      return { tone: "warn", text: `CI on ${at} is failing too${ci.failing.length > 0 ? `: ${ci.failing.slice(0, 4).join(", ")}${ci.failing.length > 4 ? ` +${ci.failing.length - 4}` : ""}` : ""}. That's the repository, not the Cloud setup.` };
    case "passing":
      return { tone: "ok", text: `Passes in CI on ${at}, so the Cloud setup is what differs.` };
    case "pending":
      return { tone: "busy", text: `CI on ${at} is still running.` };
  }
}

/** One line of a diff: kept, removed or added. */
export type DiffLine = { readonly kind: "same" | "del" | "add"; readonly text: string };

/**
 * A line diff of two computer.toml texts (a setup chat's proposal against the current setup), folded to the
 * changed lines with `context` lines around them; null between hunks marks a fold.
 */
export function lineDiff(before: string, after: string, context = 3): Array<DiffLine | null> {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (before === "") a.length = 0;
  // Longest common subsequence: the files are a few dozen lines.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) all.push({ kind: "del", text: a[i++]! });
    else all.push({ kind: "add", text: b[j++]! });
  }
  const near = all.map((_, k) => all.slice(Math.max(0, k - context), k + context + 1).some((l) => l.kind !== "same"));
  const out: Array<DiffLine | null> = [];
  all.forEach((line, k) => {
    if (near[k]) out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}

/** An organization's environment in Settings' list (environment.list): its state, who set it up and when. */
export function summaryLine(e: EnvironmentSummary, now = Date.now()): { tone: Tone; text: string } {
  const by = e.updated_by ? ` by ${e.updated_by}` : "";
  const when = e.updated_at ? ` · ${ago(e.updated_at, now)}` : "";
  switch (e.state) {
    case "not_set_up":
      return { tone: "idle", text: "Not set up" };
    case "setting_up":
      return { tone: "busy", text: "Setting up" };
    case "failed":
      return { tone: "warn", text: `Setup failed${by ? ` · set up${by}` : ""}${when}` };
    default:
      return {
        tone: e.state === "ready_with_gaps" ? "warn" : "ok",
        text: ["Set up", e.snapshot_built_at ? ago(e.snapshot_built_at, now) : null, e.updated_by ? `by ${e.updated_by}` : null, e.state === "ready_with_gaps" ? "a check failed" : null].filter(Boolean).join(" · "),
      };
  }
}

/** The names this repo's computers read that the person hasn't set. */
export const missingValues = (env: Pick<Environment, "secret_names"> | null, set: ReadonlyArray<string>) => (env ? env.secret_names.filter((n) => !set.includes(n)) : []);

/**
 * A Cloud start waits until the person's stored names are known, then while missing values this Mac's .env files
 * hold (or may: `onMac` null while looking) are unanswered. A missing value this Mac doesn't have never waits.
 */
export const startWaitsForValues = (set: ReadonlyArray<string> | null, missing: ReadonlyArray<string>, onMac: ReadonlyMap<string, string> | null) =>
  set === null || (missing.length > 0 && (onMac === null || onMac.size > 0));

/** `[services]` from a computer.toml's text, as name = version. */
export function servicesOf(config: string | null): Array<{ name: string; version: string }> {
  const table = /^\s*\[services\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(config ?? "")?.[1] ?? "";
  return [...table.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']([^"']*)["']/gm)].map((m) => ({ name: m[1]!, version: m[2]! }));
}

/** An array key's strings from a table, e.g. `[setup].run`. */
export function listOf(config: string | null, table: string, key: string): string[] {
  const body = new RegExp(`^\\s*\\[${table}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, "m").exec(config ?? "")?.[1] ?? "";
  const value = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(body)?.[1] ?? "";
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]!));
}

/** The text with `[computer] size` set, adding the table when it has none. */
export function withSize(config: string, size: string): string {
  if (/^\s*\[computer\]\s*$/m.test(config)) {
    return /^\s*\[computer\]\s*$[\s\S]*?^\s*size\s*=/m.test(config)
      ? config.replace(/(^\s*\[computer\]\s*$[\s\S]*?^\s*size\s*=\s*)["'][^"']*["']/m, `$1"${size}"`)
      : config.replace(/^(\s*\[computer\]\s*)$/m, `$1\nsize = "${size}"`);
  }
  return `${config.replace(/\s*$/, "")}\n\n[computer]\nsize = "${size}"\n`;
}

export const sizeOf = (config: string | null) => /^\s*\[computer\]\s*$[\s\S]*?^\s*size\s*=\s*["']([^"']+)["']/m.exec(config ?? "")?.[1];

/**
 * environment.get for projects, kept fresh while mounted: environment.updated while a build runs (the
 * runtime polls Cloud as long as someone asked in the last minute, so this asks again every 45 s). Answers
 * are kept by project, so a project added to the list shows nothing until its own answer comes.
 */
export function useEnvironments(projectIds: ReadonlyArray<string>) {
  const { client } = useRuntimeClient();
  const key = projectIds.join("\n");
  const [answers, setAnswers] = useState<ReadonlyMap<string, EnvironmentAnswer>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const load = useCallback(
    async (only?: string) => {
      if (!client) return;
      const ids = only !== undefined ? [only] : key ? key.split("\n") : [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const answer = await client.call("environment.get", { project_id: id });
            setAnswers((m) => new Map(m).set(id, answer));
            setErrors((m) => (m.has(id) ? new Map([...m].filter(([k]) => k !== id)) : m));
          } catch (e) {
            setErrors((m) => new Map(m).set(id, e instanceof Error ? e.message : String(e)));
          }
        }),
      );
    },
    [client, key],
  );
  useEffect(() => {
    if (!client || !key) return;
    void load();
    const ids = new Set(key.split("\n"));
    const off = client.on("environment.updated", (u) => {
      if (!ids.has(u.project_id)) return;
      setAnswers((m) => {
        const prev = m.get(u.project_id);
        return prev ? new Map(m).set(u.project_id, { ...prev, environment: u.environment }) : m;
      });
    });
    // An agent proposed a change: its card shows without waiting for the next read.
    const offProposed = client.on("environment.proposed", (u) => {
      if (!ids.has(u.project_id)) return;
      setAnswers((m) => {
        const prev = m.get(u.project_id);
        return prev ? new Map(m).set(u.project_id, { ...prev, proposals: [u.proposal, ...(prev.proposals ?? []).filter((x) => x.id !== u.proposal.id && x.summary !== u.proposal.summary)] }) : m;
      });
    });
    // The setup chat changed (a newer proposal, published, stopped): the review card shows the one that waits now.
    const offChat = client.on("environment.setup_chat", (u) => {
      if (!ids.has(u.project_id)) return;
      setAnswers((m) => {
        const prev = m.get(u.project_id);
        return prev ? new Map(m).set(u.project_id, { ...prev, setup_chat: u.setup_chat }) : m;
      });
    });
    const timer = setInterval(() => void load(), 45_000);
    return () => {
      off();
      offProposed();
      offChat();
      clearInterval(timer);
    };
  }, [client, key, load]);
  return { answers, errors, reload: load };
}

/** useEnvironments for one project: its answer, or null until it comes (and for no project). */
export function useEnvironment(projectId: string | null) {
  const ids = useMemo(() => (projectId ? [projectId] : []), [projectId]);
  const { answers, errors, reload } = useEnvironments(ids);
  const reloadOne = useCallback(() => (projectId ? reload(projectId) : Promise.resolve()), [reload, projectId]);
  return { answer: projectId ? (answers.get(projectId) ?? null) : null, error: projectId ? (errors.get(projectId) ?? null) : null, reload: reloadOne };
}

/** A link from what a server or an agent wrote, only when it is https (never javascript: or a local file). */
export const httpsUrl = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** environment.list: every environment of the organization the person may read, with the projects here marked. */
export function useEnvironmentList() {
  const { client } = useRuntimeClient();
  const [list, setList] = useState<Result<"environment.list"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      setList(await client.call("environment.list", {}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);
  return { list, error, reload: load };
}
