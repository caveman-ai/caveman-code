import { spawn } from "node:child_process";

import { expect, test } from "vitest";

import {
  anonFromMemoryStat,
  bytesFromMemoryMax,
  chatBudget,
  chatCapacity,
  chatsMemoryBytes,
  COMPUTER_FULL,
  computerCpus,
  computerMemoryBytes,
  cpusFromCpuMax,
  FootprintMeter,
  reserveBytes,
  SEED_FOOTPRINT,
  treeResidentBytes,
} from "./capacity.ts";

const GiB = 1024 ** 3;
const cloud = (
  cpus: number,
  gib: number,
  extra: { services?: ReadonlyArray<string>; footprint?: { p95: number; max: number } } = {},
) => chatCapacity({ kind: "cloud", cpus, memoryBytes: gib * GiB, ...extra });

test("a lean chat is budgeted its p95 in a turn plus half the way to the most one reached: 1.75 GiB from the seed", () => {
  expect(SEED_FOOTPRINT).toEqual({ p95: 1.1 * GiB, max: 2.4 * GiB });
  expect(chatBudget(SEED_FOOTPRINT)).toBeCloseTo(1.75 * GiB, 0);
  // Never under half a GiB, however little was measured.
  expect(chatBudget({ p95: 0.05 * GiB, max: 0.1 * GiB })).toBe(0.5 * GiB);
});

test("the reserve: 2 GiB or an eighth on a Cloud computer; half and at least 8 GiB on This Mac", () => {
  expect([4, 8, 16, 32, 64].map((gib) => reserveBytes(gib * GiB, "cloud") / GiB)).toEqual([
    2, 2, 2, 4, 8,
  ]);
  expect([8, 16, 36, 128].map((gib) => reserveBytes(gib * GiB, "mac") / GiB)).toEqual([
    8, 8, 18, 64,
  ]);
});

test("each size holds what its memory allows: 8 lean chats on a large, 16 on an xlarge", () => {
  // boat's sizes (vCPU x GiB): small, default, large, xlarge.
  expect([cloud(2, 4), cloud(4, 8), cloud(8, 16), cloud(16, 32)]).toEqual([1, 3, 8, 16]);
  // computer.toml's sizes on our own pools.
  expect([cloud(2, 8), cloud(4, 16), cloud(8, 32), cloud(16, 64)]).toEqual([3, 8, 16, 32]);
  // Memory with few cores to run it: two chats a vCPU at most.
  expect(cloud(2, 64)).toBe(4);
  // Always one: a computer too small for the budget still runs its first chat.
  expect(cloud(1, 1)).toBe(1);
  // No vCPU count known: memory alone decides.
  expect(chatCapacity({ kind: "cloud", memoryBytes: 16 * GiB })).toBe(8);
});

test("declared services take memory the chats then do not have", () => {
  expect(cloud(8, 16, { services: ["postgres", "redis"] })).toBe(7);
  expect(cloud(8, 16, { services: ["postgres"] })).toBe(7);
  // One the table does not know takes a GiB.
  expect(cloud(8, 16, { services: ["postgres", "redis", "kafka", "elasticsearch"] })).toBe(6);
  expect(cloud(16, 32, { services: ["postgres", "redis"] })).toBe(15);
});

test("a heavier or lighter footprint moves the count", () => {
  // Chats that each run a Docker stack: 4 GiB at p95, 6 GiB at most.
  expect(cloud(8, 16, { footprint: { p95: 4 * GiB, max: 6 * GiB } })).toBe(2);
  expect(cloud(16, 32, { footprint: { p95: 4 * GiB, max: 6 * GiB } })).toBe(5);
  // Lighter than a lean agent: more, up to two a vCPU.
  expect(cloud(8, 16, { footprint: { p95: 0.6 * GiB, max: 1 * GiB } })).toBe(16);
});

test("This Mac keeps half its memory for its person", () => {
  const mac = (cpus: number, gib: number) =>
    chatCapacity({ kind: "mac", cpus, memoryBytes: gib * GiB });
  expect([mac(8, 8), mac(8, 16), mac(10, 36), mac(18, 128)]).toEqual([1, 4, 10, 36]);
});

test("the footprint is the seed until enough was measured, then what this computer's chats use", () => {
  const meter = new FootprintMeter();
  // Nothing measured: a large holds 8.
  expect(
    chatCapacity({ kind: "cloud", cpus: 8, memoryBytes: 16 * GiB, footprint: meter.current() }),
  ).toBe(8);
  // A sample with no turn running says nothing.
  meter.observe(12 * GiB, 0);
  // Too few samples to stand on.
  for (let i = 0; i < 29; i++) meter.observe(3 * 3.2 * GiB, 3);
  expect(meter.measured).toBe(false);
  expect(meter.current()).toEqual(SEED_FOOTPRINT);
  // Three chats in a turn hold 9.6 GiB between them, again and again: 3.2 GiB a chat.
  meter.observe(3 * 3.2 * GiB, 3);
  expect(meter.measured).toBe(true);
  expect(meter.current().p95).toBeCloseTo(3.2 * GiB, 0);
  expect(
    chatCapacity({ kind: "cloud", cpus: 8, memoryBytes: 16 * GiB, footprint: meter.current() }),
  ).toBe(4);
  // One spike of 6 GiB for one chat: the most a chat reached moves the budget, the p95 does not.
  meter.observe(6 * GiB, 1);
  expect(meter.current().max).toBe(6 * GiB);
  expect(meter.current().p95).toBeCloseTo(3.2 * GiB, 0);
  expect(
    chatCapacity({ kind: "cloud", cpus: 8, memoryBytes: 16 * GiB, footprint: meter.current() }),
  ).toBe(3);
  // Old samples leave the window: lean chats for four hours bring the computer back to more.
  for (let i = 0; i < 720; i++) meter.observe(2 * 0.9 * GiB, 2);
  expect(meter.current()).toEqual({ p95: 0.9 * GiB, max: 0.9 * GiB });
  expect(
    chatCapacity({ kind: "cloud", cpus: 8, memoryBytes: 16 * GiB, footprint: meter.current() }),
  ).toBe(15);
});

test("ps gives the memory of everything below a process, on Linux and macOS alike", () => {
  // pid ppid rss(KiB): 10 is the runtime; 11 and 12 its engines, 13 a tool of 11; 20 is someone else's.
  const ps =
    "    1     0   100\n   10     1  5000\n   11    10  2048\n   12    10  1024\n   13    11   512\n   20     1  9999\n garbage\n";
  expect(treeResidentBytes(ps, 10)).toBe((2048 + 1024 + 512) * 1024);
  expect(treeResidentBytes(ps, 20)).toBe(0);
  // From the kernel's root: the whole table (a tools container, where every process is a chat's).
  expect(treeResidentBytes(ps, 0)).toBe((100 + 5000 + 2048 + 1024 + 512 + 9999) * 1024);
});

test.skipIf(process.platform === "win32")(
  "the runtime reads what its own children hold",
  async () => {
    const before = (await chatsMemoryBytes(undefined))!;
    // A child that holds 200 MiB of touched memory until told to go.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const held = Buffer.alloc(200 * 1024 * 1024, 1); process.stdout.write('held'); process.stdin.resume(); process.stdin.on('data', () => process.exit(held.length > 0 ? 0 : 1));",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      const during = (await chatsMemoryBytes(undefined))!;
      expect(during - before).toBeGreaterThan(150 * 1024 * 1024);
    } finally {
      child.stdin.write("go");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  },
  60_000,
);

test("a cgroup's files say what a tools container holds and how large it is", () => {
  expect(anonFromMemoryStat("anon 1073741824\nfile 5368709120\nkernel 1000\n")).toBe(1073741824);
  expect(anonFromMemoryStat("file 5\n")).toBeUndefined();
  expect(bytesFromMemoryMax("17179869184\n")).toBe(16 * GiB);
  expect(bytesFromMemoryMax("max\n")).toBeUndefined();
});

test("the computer's size comes from what the computers service says, else the tools container's cgroup, else the machine", async () => {
  expect(cpusFromCpuMax("400000 100000\n")).toBe(4);
  expect(cpusFromCpuMax("150000 100000")).toBe(2);
  expect(cpusFromCpuMax("50000 100000")).toBe(1);
  expect(cpusFromCpuMax("max 100000")).toBeUndefined();
  expect(cpusFromCpuMax("")).toBeUndefined();
  expect(await computerCpus({ CAVEMAN_COMPUTER_CPUS: "8" }, undefined)).toBe(8);
  expect(await computerCpus({ CAVEMAN_COMPUTER_CPUS: "nonsense" }, undefined)).toBeUndefined();
  expect(await computerCpus({}, undefined)).toBeUndefined();
  expect(await computerCpus({}, undefined, "mac")).toBeGreaterThan(0);
  expect(await computerMemoryBytes({ CAVEMAN_COMPUTER_MEMORY_GIB: "16" }, undefined)).toBe(
    16 * GiB,
  );
  expect(
    await computerMemoryBytes({ CAVEMAN_COMPUTER_MEMORY_GIB: "nonsense" }, undefined),
  ).toBeGreaterThan(GiB);
});

test("a full computer says so without a count of worktrees, a machine, or a choice the person does not have", () => {
  expect(COMPUTER_FULL).toBe("Cloud is busy. Trying again.");
  expect(COMPUTER_FULL).not.toMatch(/\d/);
  expect(COMPUTER_FULL).not.toMatch(/worktree/i);
  // Where a chat runs in Cloud is Cloud's: nothing to archive, no other computer to pick.
  expect(COMPUTER_FULL).not.toMatch(/computer|archive|another/i);
});
