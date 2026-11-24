// A chat on its way to Cloud from a browser window (cloud-wait.ts): what the front door's wait was, as state. The
// window waits for the chat's place, goes there by itself, and asks for the place again while it does not come up.
import type { CloudComputerRow } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import {
  chooseRuntime,
  chosenRuntime,
  holdFollow,
  holdPendingStart,
  pendingFollow,
  pendingStart,
  type CloudRuntime,
  type PendingStart,
  type RuntimesAnswer,
} from "./cloud.ts";
import {
  ASK_AGAIN_MS,
  CLOUD_FAILED_LINE,
  CLOUD_WAKING,
  CloudWait,
  notStarting,
  readyRuntime,
} from "./cloud-wait.ts";
import { waitLine } from "./sync/web-window.ts";

const storage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const online = () => new Date().toISOString();
const box = (id: string, computer: string, lastSeen: string | null = online()): CloudRuntime => ({
  id,
  name: "acme-web",
  computer_id: computer,
  computer_name: "acme-web",
  computer_driver: "boat",
  last_seen_at: lastSeen,
});
const row = (id: string, over: Partial<CloudComputerRow> = {}): CloudComputerRow =>
  ({
    id,
    name: "acme-web",
    driver: "boat",
    size: "4cpu-16gb",
    desired_state: "running",
    observed_state: "starting",
    observed_reason: "booting",
    updated_at: online(),
    ...over,
  }) as CloudComputerRow;
const START: Omit<PendingStart, "from_link"> = {
  computer_id: "c-web",
  workspace_id: "w1",
  repo: "acme/web",
  engine: "caveman",
  task: "Fix the login page",
};

function world(runtimes: CloudRuntime[] = []) {
  const session = storage();
  const local = storage();
  const state = {
    runtimes,
    computers: [] as CloudComputerRow[],
    asked: 0,
    ran: [] as string[],
    now: 1_000_000,
    chosen: [] as string[],
  };
  const wait = new CloudWait({
    session,
    local,
    runtimes: async (): Promise<RuntimesAnswer> => (
      state.asked++,
      { signedIn: true, runtimes: state.runtimes }
    ),
    computers: async () => ({ computers: state.computers }),
    run: async (id) => void state.ran.push(id),
    choose: (r) => (state.chosen.push(r.id), chooseRuntime(local, r)),
    now: () => state.now,
    everyMs: 5,
  });
  return { session, local, state, wait };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

test("a chat started in Cloud waits on one line with its seconds, and the window goes to its place the moment it runs", async () => {
  const w = world();
  holdPendingStart(w.session, START);
  w.wait.start();
  await until(() => w.wait.get().waiting !== null);
  expect(w.wait.get()).toEqual({
    waiting: { computerId: "c-web", since: 1_000_000 },
    linked: null,
    failed: null,
  });
  expect(waitLine(CLOUD_WAKING, w.wait.get().waiting!.since, 1_008_200)).toBe("Waking Cloud… 8s");
  expect(w.state.chosen).toEqual([]);

  // A reload meanwhile: the wait counts on from when it began.
  w.wait.stop();
  w.state.now = 1_020_000;
  const again = new CloudWait({
    session: w.session,
    local: w.local,
    runtimes: async () => ({ signedIn: true, runtimes: w.state.runtimes }),
    choose: (r) => (w.state.chosen.push(r.id), chooseRuntime(w.local, r)),
    now: () => w.state.now,
    everyMs: 5,
  });
  again.start();
  await until(() => again.get().waiting !== null);
  expect(again.get().waiting).toEqual({ computerId: "c-web", since: 1_000_000 });

  // Its computer's runtime answers: the window is put there, and the start runs on it (shell/PendingCloudStart).
  w.state.runtimes = [box("rt-web", "c-web")];
  await until(() => w.state.chosen.length === 1);
  expect(chosenRuntime(w.local)?.id).toBe("rt-web");
  expect(again.get()).toEqual({ waiting: null, linked: null, failed: null });
  expect(pendingStart(w.session)?.task).toBe("Fix the login page");
  again.stop();
});

test("a window that waits for nothing asks Cloud nothing", async () => {
  const w = world([box("rt-web", "c-web")]);
  w.wait.start();
  await new Promise((r) => setTimeout(r, 40));
  expect(w.state.asked).toBe(0);
  expect(w.wait.get()).toEqual({ waiting: null, linked: null, failed: null });
  w.wait.stop();
});

test("a start that came in a link waits for the person's Start before the window goes to its computer; Discard goes back", async () => {
  const w = world([box("rt-web", "c-web")]);
  chooseRuntime(w.local, null);
  w.session.setItem("caveman.cloud.start", JSON.stringify({ ...START, from_link: true }));
  w.wait.start();
  await until(() => w.wait.get().linked !== null);
  // Its computer is up, and nothing connected to it: anyone can send a link.
  expect(w.state.chosen).toEqual([]);
  expect(w.wait.get().linked).toMatchObject({
    start: { task: "Fix the login page", from_link: true },
    runtime: { id: "rt-web" },
  });
  w.wait.confirm();
  expect(w.state.chosen).toEqual(["rt-web"]);
  expect(pendingStart(w.session)?.from_link).toBeUndefined();
  w.wait.stop();

  const other = world([box("rt-web", "c-web")]);
  other.session.setItem("caveman.cloud.start", JSON.stringify({ ...START, from_link: true }));
  other.wait.start();
  await until(() => other.wait.get().linked !== null);
  expect(other.wait.discard()).toMatchObject({ task: "Fix the login page" });
  expect(pendingStart(other.session)).toBeNull();
  expect(other.state.chosen).toEqual([]);
  expect(other.wait.get()).toEqual({ waiting: null, linked: null, failed: null });
  other.wait.stop();
});

test("a place that cannot start: the wait goes on, Cloud's reason is kept for whoever asks, and it is asked for again by itself", async () => {
  const w = world();
  holdPendingStart(w.session, START);
  w.state.computers = [
    row("c-web", {
      observed_state: "failed",
      observed_reason: "create instance: quota exceeded in ams (boat 503)",
    }),
  ];
  w.wait.start();
  await until(() => w.wait.get().failed !== null);
  expect(w.wait.get()).toMatchObject({
    waiting: { computerId: "c-web" },
    failed: "create instance: quota exceeded in ams (boat 503)",
  });
  // What the person reads is ours; the raw reason is behind a click.
  expect(CLOUD_FAILED_LINE).toBe("Cloud couldn't start. Trying again.");
  // Asked for again at once, then at most every ASK_AGAIN_MS, however often Cloud is read meanwhile.
  await new Promise((r) => setTimeout(r, 40));
  expect(w.state.ran).toEqual(["c-web"]);
  w.state.now += ASK_AGAIN_MS;
  await until(() => w.state.ran.length === 2);

  // It comes up after all: the window goes there, and says nothing more of the failure.
  w.state.computers = [row("c-web", { observed_state: "running" })];
  w.state.runtimes = [box("rt-web", "c-web")];
  await until(() => w.state.chosen.length === 1);
  expect(w.wait.get()).toEqual({ waiting: null, linked: null, failed: null });
  w.wait.stop();
});

test("Cancel gives the start up and hands back what it would have sent, so the words are never lost", async () => {
  const w = world();
  holdPendingStart(w.session, START);
  w.wait.start();
  await until(() => w.wait.get().waiting !== null);
  expect(w.wait.discard()).toMatchObject({ task: "Fix the login page", repo: "acme/web" });
  expect(pendingStart(w.session)).toBeNull();
  expect(w.wait.get().waiting).toBeNull();
  // Its computer coming up later moves nothing.
  w.state.runtimes = [box("rt-web", "c-web")];
  w.wait.kick();
  await new Promise((r) => setTimeout(r, 40));
  expect(w.state.chosen).toEqual([]);
  w.wait.stop();
});

test("a chat that moved to Cloud says where it is in its own pane: the window follows it there without a line of its own", async () => {
  const w = world();
  const win = { sessionStorage: w.session, localStorage: w.local } as unknown as Pick<
    Window,
    "sessionStorage" | "localStorage"
  >;
  holdFollow(win, { computer_id: "c-web", workspace_id: "w9" });
  w.wait.start();
  await new Promise((r) => setTimeout(r, 30));
  expect(w.wait.get()).toEqual({ waiting: null, linked: null, failed: null });
  w.state.runtimes = [box("rt-web", "c-web")];
  await until(() => w.state.chosen.length === 1);
  expect(pendingFollow(w.session)).toBeNull();
  w.wait.stop();
});

test("a place answers once its runtime was heard within two heartbeats; a failed computer says why, one on its way does not", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const heard = (ago: number) => new Date(now - ago).toISOString();
  expect(
    readyRuntime(
      [box("rt-old", "c-web", heard(10 * 60_000)), box("rt-new", "c-web", heard(5_000))],
      "c-web",
      now,
    )?.id,
  ).toBe("rt-new");
  expect(readyRuntime([box("rt-old", "c-web", heard(10 * 60_000))], "c-web", now)).toBeUndefined();
  expect(
    readyRuntime(
      [{ ...box("rt-mac", "c-web", heard(1_000)), computer_driver: "local" }],
      "c-web",
      now,
    ),
  ).toBeUndefined();
  expect(notStarting(row("c-web"))).toBeNull();
  expect(notStarting(row("c-web", { observed_state: "failed", observed_reason: "  " }))).toBe(
    "Cloud gave no reason.",
  );
  expect(notStarting(undefined)).toBeNull();
});
