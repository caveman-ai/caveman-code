// S12: where the Mac's side of a lid move goes, call by call. A Claude Agent chat (the stand-in claude) is mid-turn on
// This Mac, in this process; the lid closes (`cloud.suspend`, the one word the desktop's onLidClose says); and the
// stand-in Cloud, a round trip away (FAR_MS), says when each of the Mac's calls reached it and how long it held it:
// the move check, the last copy's segment and its journal, the handoff. What lies between two calls is this Mac's own
// work (the turn stopped and parked, the work in progress snapshotted). Printed, and written to CAVEMAN_LID_RESULTS
// when set; the budget is judged up to a load of MAX_LOAD per core, past which the timings measure the machine.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import { connect } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

/** A round trip to Cloud (CAVEMAN_LID_FAR_MS, 25): each request to the stand-in waits that long before it is looked at. */
const FAR_MS = Number(process.env.CAVEMAN_LID_FAR_MS ?? 25);
/** From the lid closing to Cloud holding the move (its handoff answered) and the lid's call back: S12's 3 s is the Mac's whole budget. */
const LID_BUDGET_MS = 3_000;
const MAX_LOAD = 3.5;
const loadPerCore = () => os.loadavg()[0]! / os.cpus().length;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(process.platform === "win32")(
  `the lid hands a working chat to a Cloud ${FAR_MS} ms away within its budget, and says where the time went`,
  { timeout: 240_000 },
  async (context) => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    const runtime = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(runtime.close);
    const mac = connect(runtime.url, runtime.token);
    cleanups.push(() => mac.close());
    await mac.call("cloud.enroll", {
      request_id: "e1",
      cloud_url: cloud.url,
      token: cloud.state.personToken,
      name: "Test Mac",
    });
    await mac.call("settings.set", {
      request_id: "s1",
      settings: { sync_chats: true, move_to_cloud: true },
    });
    cloud.state.environments.computers = true;
    cloud.state.chats.engineLogins.set("user-1", {
      "claude-agent": { vault_key: true, signed_in_on: [] },
    });
    const box = cloud.enrollRuntime({ kind: "cloud" });
    const repo = makeRepo(tempRoot("lid-timing-"), { "README.md": "lid\n" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/lid-timing.git"], {
      cwd: repo,
    });
    const w = await createReady(mac, {
      request_id: "w1",
      repo: { path: repo },
      title: "Working at the lid",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const chats = cloud.state.chats;
    // A first turn that changes a file, copied: the lid's last copy then carries what a real chat's does, its work in progress.
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: `write: notes.txt ${"wip from the Mac\n".repeat(40)}` },
    });
    await until(
      () => chats.copyOf(w.session_id).filter((e) => e.type === "turn.done").length === 1,
      60_000,
    );
    await mac.call("turn.submit", {
      request_id: "t2",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: still working at the lid" },
    });
    await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
    // The copy of the running turn's start has landed: the lid's own copy is the last one, not two.
    await until(
      () =>
        chats
          .copyOf(w.session_id)
          .some(
            (e) =>
              e.type === "turn.started" &&
              chats.copyOf(w.session_id).filter((x) => x.type === "turn.started").length === 2,
          ),
      30_000,
    );

    cloud.state.latencyMs = FAR_MS;
    const loadBefore = loadPerCore();
    const from = cloud.state.seen.length;
    const lidAt = Date.now();
    const out = await mac.call("cloud.suspend", { request_id: "lid-1", budget_ms: 10_000 });
    const lidMs = Date.now() - lidAt;
    cloud.state.latencyMs = 0;
    expect(out.handed_off).toEqual([w.session_id]);
    expect(chats.sessions.get(w.session_id)).toMatchObject({ computer_id: box.computerId });

    // The Mac's calls about this chat while the lid closed, by what each is: when it reached Cloud (ms after the lid) and how long Cloud held it.
    const about = (path: string) => {
      const route = path.split("?")[0]!;
      if (!route.includes(w.session_id)) return undefined;
      if (route.endsWith("/move-check")) return "check";
      if (route.endsWith("/handoff")) return "handoff";
      if (/\/journal\/segments\/\d+$/.test(route)) return "segment";
      if (route.endsWith("/journal")) return "journal";
      return undefined;
    };
    const calls = cloud.state.seen.slice(from).flatMap((r) => {
      const what = about(r.path);
      return what === undefined || r.at === undefined
        ? []
        : [
            {
              what: `${r.method === "GET" ? "read " : ""}${what}`,
              at: r.at - lidAt,
              ms: r.ms ?? -1,
            },
          ];
    });
    const handoff = calls.find((call) => call.what === "handoff");
    expect(handoff).toBeDefined();
    // Cloud holds the move once it answered the handoff.
    const heldMs = handoff!.at + handoff!.ms;
    const check = calls.find((call) => call.what === "check");
    const copyFrom = calls.find(
      (call) => call.what !== "check" && (check === undefined || call.at > check.at),
    );
    // What is the Mac's own between Cloud's answers: before the check, from its answer to the copy's first call (the
    // turn stopped and parked, its files snapshotted), and from the handoff's answer to the lid's.
    const own = {
      before_check: check?.at ?? -1,
      check_to_copy:
        check !== undefined && copyFrom !== undefined ? copyFrom.at - (check.at + check.ms) : -1,
      after_handoff: lidMs - heldMs,
    };
    const load = Math.max(loadBefore, loadPerCore());
    const result = {
      far_ms: FAR_MS,
      lid_ms: lidMs,
      held_ms: heldMs,
      round_trips: calls.length,
      own,
      calls,
      load_per_core: Number(load.toFixed(2)),
      cpus: os.cpus().length,
    };
    console.log(`lid timing: ${JSON.stringify(result)}`);
    if (process.env.CAVEMAN_LID_RESULTS)
      fs.appendFileSync(process.env.CAVEMAN_LID_RESULTS, `${JSON.stringify(result)}\n`);
    if (load > MAX_LOAD)
      return context.skip(
        `the machine is overloaded (load per core ${load.toFixed(2)} > ${MAX_LOAD}): timings printed, budgets not judged`,
      );
    expect(lidMs).toBeLessThan(LID_BUDGET_MS);
  },
);
