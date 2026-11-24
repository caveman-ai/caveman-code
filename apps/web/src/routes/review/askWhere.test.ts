import type { ChatSummary, RuntimeState } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { askComputers, prChatParams, prPendingStart, startOnComputer, waitOnline } from "./askWhere.ts";
import type { RuntimeState as ListedRuntime } from "../../state/sync/wire.ts";

const runtime = (runtime_id: string, name: string, over: Partial<RuntimeState> = {}): RuntimeState =>
  ({ runtime_id, computer_id: `c-${runtime_id}`, kind: "cloud", name, online: true, last_seen_at: "2026-10-21T20:00:00Z", ...over }) as RuntimeState;
const chat = (session_id: string, runtime_id: string, repo: string | undefined): ChatSummary => ({ session_id, runtime_id, ...(repo === undefined ? {} : { repo }) }) as unknown as ChatSummary;
const listOf = (runtimes: RuntimeState[], chats: ChatSummary[]) => ({ runtimes: new Map(runtimes.map((r) => [r.runtime_id, r])), chats: new Map(chats.map((c) => [c.session_id, c])) });

test("Ask offers the person's online Cloud computers that hold the pull request's repository, by name", () => {
  const list = listOf(
    [
      runtime("r-b", "widgets-2"),
      runtime("r-a", "widgets-1"),
      runtime("r-asleep", "widgets-3", { online: false }),
      runtime("r-other", "api-box"),
      runtime("r-mac", "Ada's Mac", { kind: "laptop" }),
      runtime("r-unknown", "fresh"),
      runtime("r-home", "the one this window is on"),
    ],
    [
      chat("s1", "r-a", "acme/widgets"),
      chat("s2", "r-b", "https://github.com/Acme/Widgets.git"),
      chat("s3", "r-asleep", "acme/widgets"),
      chat("s4", "r-other", "acme/api"),
      chat("s5", "r-mac", "acme/widgets"),
      chat("s6", "r-unknown", undefined),
      chat("s7", "r-home", "acme/widgets"),
    ],
  );
  // Another repository, a Mac, a computer of unknown repository and the window's own runtime are left out; an asleep
  // one comes after the awake ones, marked so Ask wakes it.
  expect(askComputers(list, "acme/widgets", ["r-home", null])).toEqual([
    { runtimeId: "r-a", computerId: "c-r-a", name: "widgets-1", asleep: false },
    { runtimeId: "r-b", computerId: "c-r-b", name: "widgets-2", asleep: false },
    { runtimeId: "r-asleep", computerId: "c-r-asleep", name: "widgets-3", asleep: true },
  ]);
  // A deleted computer is not offered.
  const deleted = listOf([runtime("r-gone", "gone", { online: false, computer_state: "deleted" })], [chat("s9", "r-gone", "acme/widgets")]);
  expect(askComputers(deleted, "acme/widgets", [])).toEqual([]);
  expect(askComputers(null, "acme/widgets", [])).toEqual([]);
});

test("Ask waits for a computer it woke to come online in Cloud's list, hearing the list, and gives up plainly", async () => {
  let snapshot = listOf([runtime("r-z", "widgets-3", { online: false })], []);
  const listeners = new Set<() => void>();
  const list = { get: () => snapshot, subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) };
  const waiting = waitOnline(list, { runtimeId: "r-z", name: "widgets-3" }, 5_000);
  // Other updates do not end the wait.
  snapshot = listOf([runtime("r-z", "widgets-3", { online: false, computer_state: "starting" })], []);
  for (const fn of listeners) fn();
  snapshot = listOf([runtime("r-z", "widgets-3", { online: true })], []);
  for (const fn of listeners) fn();
  await waiting;
  expect(listeners.size).toBe(0);
  // Already online: at once.
  await waitOnline(list, { runtimeId: "r-z", name: "widgets-3" }, 5_000);
  // Never comes up: the person reads that Cloud did not wake, never a computer's name.
  snapshot = listOf([runtime("r-z", "widgets-3", { online: false })], []);
  await expect(waitOnline(list, { runtimeId: "r-z", name: "widgets-3" }, 30)).rejects.toThrow("Cloud didn't wake within 0 minutes.");
  expect(listeners.size).toBe(0);
});

test("the chat on a Cloud computer names the repository by URL and the pull request, on an engine the computer runs", () => {
  const params = prChatParams({ pr: { repo: "acme/widgets", number: 7 }, engine: "claude-agent", title: "Ask: why", task: "Pull request #7 …", requestId: "r1" });
  expect(params).toEqual({ request_id: "r1", repo: { url: "https://github.com/acme/widgets" }, engine: "claude-agent", title: "Ask: why", task: { text: "Pull request #7 …" }, pull_request: { number: 7 } });
  // An engine no Cloud computer runs: the Caveman engine there.
  expect(prChatParams({ pr: { repo: "acme/widgets", number: 7 }, engine: "cursor", title: "t", task: "x", requestId: "r2" }).engine).toBe("caveman");
});

test("on a new Cloud computer, what the Cloud page starts carries the pull request", () => {
  expect(prPendingStart("c-new", { pr: { repo: "acme/widgets", number: 7 }, engine: "codex", title: "Fix: the test", task: "Fix it" })).toEqual({
    computer_id: "c-new",
    repo: "acme/widgets",
    engine: "codex",
    task: "Fix it",
    title: "Fix: the test",
    pull_request: 7,
  });
});

test("an asleep Cloud computer picked in Ask is woken, and the chat made there once its runtime is up; an awake one at once", async () => {
  let snapshot = listOf([runtime("r-z", "widgets-3", { online: false, computer_state: "suspended" })], []);
  const listeners = new Set<() => void>();
  const list = { get: () => snapshot, subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) };
  const steps: string[] = [];
  const resume = async (computerId: string) => {
    steps.push(`resume ${computerId}`);
    // Cloud wakes it; its runtime comes online a moment later.
    setTimeout(() => {
      snapshot = listOf([runtime("r-z", "widgets-3", { online: true, computer_state: "running" })], []);
      for (const fn of listeners) fn();
    }, 20);
  };
  const create = async (runtimeId: string) => (steps.push(`create on ${runtimeId}, online ${snapshot.runtimes.get(runtimeId)?.online}`), "w-1");
  const computer = { runtimeId: "r-z", computerId: "c-z", name: "widgets-3", asleep: true };
  expect(await startOnComputer({ computer, list, resume, create, waitMs: 5_000 })).toBe("w-1");
  expect(steps).toEqual(["resume c-z", "create on r-z, online true"]);
  // Picked asleep but awake by now: no wake.
  steps.length = 0;
  expect(await startOnComputer({ computer, list, resume, create })).toBe("w-1");
  expect(steps).toEqual(["create on r-z, online true"]);
  // A device that cannot reach Cloud's computer routes says so instead of waiting.
  snapshot = listOf([runtime("r-z", "widgets-3", { online: false })], []);
  await expect(startOnComputer({ computer, list, resume: undefined, create })).rejects.toThrow("Cloud can't be reached from this device.");
});

test("a computer Ask woke that came back under a new runtime id gets the chat on that runtime, not a wait that never ends", async () => {
  // Cloud mints a new runtime id at every wake: the computer is the same, and is looked up by its id.
  const listeners = new Set<() => void>();
  let runtimes = new Map<string, ListedRuntime>([["r-old", { runtime_id: "r-old", computer_id: "c-9", kind: "cloud", name: "widgets-9", online: false, last_seen_at: "2026-11-09T00:00:00Z" }]]);
  const list = { get: () => ({ runtimes }), subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)) };
  const computer = { runtimeId: "r-old", computerId: "c-9", name: "widgets-9", asleep: true };
  const resumed: string[] = [];
  const made: string[] = [];
  const starting = startOnComputer({ computer, list, resume: async (id) => void resumed.push(id), create: async (runtimeId) => (made.push(runtimeId), "w-9"), waitMs: 5_000 });
  await Promise.resolve();
  runtimes = new Map<string, ListedRuntime>([...runtimes, ["r-new", { runtime_id: "r-new", computer_id: "c-9", kind: "cloud", name: "widgets-9", online: true, last_seen_at: "2026-11-09T00:05:00Z", seq: 7 }]]);
  for (const listener of listeners) listener();
  expect(await starting).toBe("w-9");
  expect(resumed).toEqual(["c-9"]);
  expect(made).toEqual(["r-new"]);
  // Awake already under the new id when Ask is pressed: no wake, the chat goes there at once.
  expect(await startOnComputer({ computer, list, resume: async () => void resumed.push("again"), create: async (runtimeId) => runtimeId })).toBe("r-new");
  expect(resumed).toEqual(["c-9"]);
  expect(await waitOnline(list, { runtimeId: "r-old", computerId: "c-9", name: "widgets-9" }, 50)).toBe("r-new");
  // Another computer's runtime never answers for this one.
  await expect(waitOnline(list, { runtimeId: "r-old", computerId: "c-other", name: "widgets-9" }, 30)).rejects.toThrow("didn't wake");
});
