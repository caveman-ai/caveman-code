// How many chats a computer holds (SPEC §8.1, finding P1): its memory, less a reserve for the OS and the runtime
// and what the project's declared services take, divided by what a chat here is measured to use. One function
// (chatCapacity) decides it for placement, for a lead's builders and for the heartbeat's `capacity`.
import { execFile } from "node:child_process";
import * as os from "node:os";

import { toolsRun } from "../cloudLink/tools.ts";

const GiB = 1024 ** 3;

/** What a chat uses: its 95th percentile in a turn, and the most one chat reached. */
export interface Footprint {
  readonly p95: number;
  readonly max: number;
}

/** Measured on a lean agent's computer: 1.1 GiB at p95 in a turn, 2.4 GiB the most one chat reached. */
export const SEED_FOOTPRINT: Footprint = { p95: 1.1 * GiB, max: 2.4 * GiB };
/** No chat is budgeted under this: an engine and a shell alone take about that (0.6 GiB idle, measured). */
const BUDGET_FLOOR = 0.5 * GiB;
/** What a declared service takes from the chats' share; one the table does not know takes the larger. */
const SERVICE_BYTES: Record<string, number> = { postgres: 1 * GiB, redis: 0.5 * GiB };
const OTHER_SERVICE_BYTES = 1 * GiB;
/** Chats mostly wait on the model (0.03 cores idle, measured), so memory decides; this only stops a computer with much memory and few cores. */
const CHATS_PER_CPU = 2;

/**
 * What one chat is budgeted: its p95 in a turn plus half the way to the most a chat reached, so the turns that
 * overlap fit and one spike does too. The seed gives 1.75 GiB.
 */
export const chatBudget = (footprint: Footprint) => {
  const MiB = 1024 ** 2;
  // In whole MiB: a budget a hair over 1.75 GiB from rounding must not cost a large its eighth chat.
  return Math.max(
    BUDGET_FLOOR,
    Math.round((footprint.p95 + Math.max(0, footprint.max - footprint.p95) / 2) / MiB) * MiB,
  );
};

/** Kept back for the OS and the runtime: a Cloud computer's is 2 GiB or an eighth; This Mac's is its person's, half and at least 8 GiB. */
export const reserveBytes = (memoryBytes: number, kind: "cloud" | "mac") =>
  kind === "mac" ? Math.max(8 * GiB, memoryBytes / 2) : Math.max(2 * GiB, memoryBytes / 8);

export interface CapacityInput {
  readonly memoryBytes: number;
  /** vCPUs, when known. */
  readonly cpus?: number | undefined;
  readonly kind: "cloud" | "mac";
  /** Measured here (FootprintMeter), else SEED_FOOTPRINT. */
  readonly footprint?: Footprint | undefined;
  /** The project's `[services]` names (computer.toml): each takes memory the chats then do not have. */
  readonly services?: ReadonlyArray<string> | undefined;
}

/**
 * The chats a computer holds at once, its first included; at least one. With the seed: 3 on a 4x8, 8 on a large
 * (8x16), 16 on an xlarge (16x32), fewer with services (7 on a large with Postgres and Redis).
 */
export function chatCapacity(input: CapacityInput): number {
  const services = (input.services ?? []).reduce(
    (sum, name) => sum + (SERVICE_BYTES[name] ?? OTHER_SERVICE_BYTES),
    0,
  );
  const usable = input.memoryBytes - reserveBytes(input.memoryBytes, input.kind) - services;
  const byMemory = Math.floor(usable / chatBudget(input.footprint ?? SEED_FOOTPRINT));
  const byCpu =
    input.cpus === undefined ? Number.POSITIVE_INFINITY : Math.floor(input.cpus) * CHATS_PER_CPU;
  return Math.max(1, Math.min(byMemory, byCpu));
}

/** Samples kept: four hours at one every 20 s. */
const WINDOW = 720;
/** Until this many samples the seed stands: a quiet first minute says little about a turn. */
const MIN_SAMPLES = 30;

/**
 * What this computer's chats actually use, from samples of memory per chat in a turn. Until MIN_SAMPLES it answers
 * the seed; after, the window's own p95 and max, so a project whose chats run heavier (or lighter) than a lean
 * agent's moves the computer's capacity.
 */
export class FootprintMeter {
  private readonly samples: Array<number> = [];
  private readonly seed: Footprint;
  constructor(seed: Footprint = SEED_FOOTPRINT) {
    this.seed = seed;
  }
  /** One sample: the bytes the chats' processes hold now, and how many chats have a turn running (none: no sample). */
  observe(bytes: number, chatsInTurn: number) {
    if (chatsInTurn <= 0 || !Number.isFinite(bytes) || bytes <= 0) return;
    this.samples.push(bytes / chatsInTurn);
    if (this.samples.length > WINDOW) this.samples.shift();
  }
  get measured() {
    return this.samples.length >= MIN_SAMPLES;
  }
  current(): Footprint {
    if (!this.measured) return this.seed;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
      max: sorted[sorted.length - 1]!,
    };
  }
}

// ------------------------------------------------------------------ reading the computer

/** `ps -A -o pid=,ppid=,rss=` (procps and BSD both print KiB): the resident bytes of every process below `root`, `root` left out. */
export function treeResidentBytes(ps: string, root: number): number {
  const children = new Map<number, Array<number>>();
  const rss = new Map<number, number>();
  for (const line of ps.split("\n")) {
    const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
    if (
      pid === undefined ||
      ppid === undefined ||
      kib === undefined ||
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      !Number.isFinite(kib)
    )
      continue;
    rss.set(pid, kib * 1024);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const seen = new Set<number>([root]);
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** A cgroup v2 `memory.stat`: the bytes its processes hold that cannot be dropped (`anon`), undefined when unreadable. */
export function anonFromMemoryStat(text: string): number | undefined {
  const anon = Number(/^anon (\d+)$/m.exec(text)?.[1]);
  return Number.isFinite(anon) ? anon : undefined;
}

/** A cgroup v2 `memory.max`: bytes, undefined when unbounded ("max") or unreadable. */
export function bytesFromMemoryMax(text: string): number | undefined {
  const bytes = Number(text.trim());
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

const run = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string | undefined>((resolve) =>
    execFile(command, [...args], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    ),
  );
const inTools = (socket: string, argv: ReadonlyArray<string>) =>
  toolsRun(socket, "/", argv, {}).then(
    (r) => (r.code === 0 ? r.stdout : undefined),
    () => undefined,
  );

/**
 * The memory the chats' processes hold now. On a Cloud computer they run in the tools container, so that is its
 * cgroup's anonymous memory (its `ps` when the cgroup cannot be read); on This Mac, everything below the runtime
 * (engines, their tools, terminals): `ps` reads both Linux and macOS the same way. Undefined when neither answers.
 */
export async function chatsMemoryBytes(socket: string | undefined): Promise<number | undefined> {
  if (socket !== undefined) {
    const stat = await inTools(socket, ["cat", "/sys/fs/cgroup/memory.stat"]);
    const anon = stat === undefined ? undefined : anonFromMemoryStat(stat);
    if (anon !== undefined) return anon;
    const ps = await inTools(socket, ["ps", "-A", "-o", "pid=,ppid=,rss="]);
    // Every process there is a chat's: the whole table, from the kernel's root.
    return ps === undefined ? undefined : treeResidentBytes(ps, 0);
  }
  if (process.platform === "win32") return undefined;
  const ps = await run("ps", ["-A", "-o", "pid=,ppid=,rss="]);
  return ps === undefined ? undefined : treeResidentBytes(ps, process.pid);
}

/**
 * The computer's memory: what the computers service says (CAVEMAN_COMPUTER_MEMORY_GIB, beside CAVEMAN_COMPUTER_CPUS),
 * else the tools container's own limit (its cgroup; the runtime container's is not the computer's size), else the
 * machine's.
 */
export async function computerMemoryBytes(
  env: NodeJS.ProcessEnv,
  socket: string | undefined,
): Promise<number> {
  const said = Number(env.CAVEMAN_COMPUTER_MEMORY_GIB);
  if (Number.isFinite(said) && said > 0) return said * GiB;
  const limit =
    socket === undefined ? undefined : await inTools(socket, ["cat", "/sys/fs/cgroup/memory.max"]);
  return (limit === undefined ? undefined : bytesFromMemoryMax(limit)) ?? os.totalmem();
}

/** A cgroup v2 `cpu.max` ("<quota> <period>", or "max <period>"): whole vCPUs, undefined when unbounded or unreadable. */
export function cpusFromCpuMax(text: string): number | undefined {
  const [quota, period] = text.trim().split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  if (quota === "max" || !Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0)
    return undefined;
  return Math.max(1, Math.round(q / p));
}

/**
 * The computer's vCPUs: what the computers service says (CAVEMAN_COMPUTER_CPUS), else the tools container's own CPU
 * limit (its cgroup, read through the tools channel; the runtime container's is not the computer's size), else none
 * on a Cloud computer and the machine's cores on This Mac.
 */
export async function computerCpus(
  env: NodeJS.ProcessEnv,
  socket: string | undefined,
  kind: "cloud" | "mac" = "cloud",
): Promise<number | undefined> {
  const said = Number(env.CAVEMAN_COMPUTER_CPUS);
  if (Number.isFinite(said) && said > 0) return Math.floor(said);
  if (socket === undefined) return kind === "mac" ? os.availableParallelism() : undefined;
  const text = await inTools(socket, ["cat", "/sys/fs/cgroup/cpu.max"]);
  return text === undefined ? undefined : cpusFromCpuMax(text);
}

/**
 * What a full computer answers. It names no machine, no number of worktrees (how many chats it holds moves with what
 * they use) and no choice the person does not have: where a chat runs in Cloud is Cloud's to decide. A builder is
 * placed again by its lead's runtime, twice. Open: a person's own chat is not placed again yet (SPEC §8.1), so its
 * client shows this beside Try again until that lands.
 */
export const COMPUTER_FULL = "Cloud is busy. Trying again.";

/** What the heartbeat says of this computer (`capacity`): the chats it holds at once and how many it has now. */
export interface ComputerCapacity {
  readonly chats: number;
  readonly used: number;
}
