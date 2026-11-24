// ADEMark (zqkra/ademark, the benchmark of agentic development environments) on Caveman Code: the tests it ranks, run
// on this Mac against the packaged app, compared with its published leaders and held to budgets.json.
//
//   node apps/desktop/scripts/ademark/run.ts                  every test, a fresh seeded profile
//   --tests A1,A5,B1        some of them (A1 A3 A4 A5 A6 A7 A10 A11 B1 B3 B4; A6 comes with A5, B3 and B4 with B1)
//   --app <Caveman Code.app>  another build (default: apps/desktop/release/mac-<arch>, package.mjs --local)
//   --profile <dir>         reuse a seeded profile (a earlier run prints it) instead of seeding one
//   --runs <n>              repetitions of the timed tests (default 6, ADEMark's minimum)
//   --real                  Track B on the real API through Claude Code's own login (spends a little of it)
//   --out <file>            the results as JSON (default: <profile>/results.json)
//   --check                 exit 1 when a value is worse than its budget (budgets.json); timed budgets hold on the
//                           Mac they were measured on (budgets.json `machine`), so --check skips them elsewhere
//
// What it needs: the app packaged here, Bun (ADEMark's replay server), Swift (its sampler, built once) and a Claude
// Code on PATH. It never touches ~/.caveman-code or the person's app: every run is a scratch home and profile.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ademarkCheckout,
  launchApp,
  log,
  mb,
  nativeHelper,
  newProfile,
  packagedApp,
  runEnv,
  startReplay,
  type Profile,
} from "./harness.ts";
import {
  addChats,
  firstWord,
  fightWeight,
  launchToTyping,
  longThreadOpen,
  median,
  seed,
  summarizeWeight,
  threadOpen,
  weighIn,
  writeJson,
} from "./trackA.ts";
import { trackB } from "./trackB.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const ALL = ["A1", "A3", "A4", "A5", "A6", "A7", "A10", "A11", "B1", "B3", "B4"];
const tests = new Set(
  (arg("--tests") ?? ALL.join(",")).split(",").map((t) => t.trim().toUpperCase()),
);
const runs = Number(arg("--runs") ?? 6);

interface Budget {
  name: string;
  unit: string;
  /** ADEMark v1's first place (never the Bare CLI, which is not ranked) on its reference Mac. */
  leader: { app: string; value: number };
  bare: number | null;
  /** The worst value this app may measure here: our edge, which --check holds. */
  budget: number | boolean;
  /** A time: it depends on the Mac, so its budget holds only on `machine`. */
  timed?: boolean;
}
const budgets = JSON.parse(fs.readFileSync(path.join(here, "budgets.json"), "utf8")) as {
  machine: string;
  metrics: Record<string, Budget>;
};

const checkout = ademarkCheckout();
const app = packagedApp(arg("--app"));
const reuse = arg("--profile");
const profile: Profile = reuse
  ? {
      root: reuse,
      home: path.join(reuse, "home"),
      userData: path.join(reuse, "user-data"),
      arena: path.join(reuse, "arena"),
    }
  : newProfile(checkout);
const results: Record<string, number | boolean> = {};
const details: Record<string, unknown> = {};
log(`profile ${profile.root}`);

const needsA = [...tests].some((t) => t.startsWith("A"));
if (needsA) {
  const helper = nativeHelper(checkout);
  const replay = await startReplay(checkout, path.join(profile.root, `replay-${Date.now()}.jsonl`));
  const env = runEnv(profile, replay.url);
  try {
    const seededFile = path.join(profile.root, "seeded.json");
    if (!fs.existsSync(seededFile)) writeJson(seededFile, await seed(app, profile, env));
    const seeded = (JSON.parse(fs.readFileSync(seededFile, "utf8")) as Array<string>)[0]!;
    if (tests.has("A1")) {
      const values = await launchToTyping(app, profile, env, runs);
      results.A1 = median(values);
      details.A1 = values;
    }
    if (tests.has("A5") || tests.has("A6")) {
      const launched = launchApp(app, profile, env);
      try {
        const rest = await weighIn(launched, helper, profile.root);
        results.A5 = Math.round(mb(rest.total_median_b));
        results.A6 = Number(rest.app_cpu_percent.toFixed(3));
        details.A5 = summarizeWeight(rest);
      } finally {
        await launched.quit();
      }
    }
    if (tests.has("A10")) {
      // ADEMark A10: the app group at rest with 15 more seeded chats, against A5's, per chat.
      const before = launchApp(app, profile, env);
      const five = await weighIn(before, helper, profile.root).finally(() => before.quit());
      await addChats(app, profile, env, "replay:seed", 15);
      const after = launchApp(app, profile, env);
      const twenty = await weighIn(after, helper, profile.root).finally(() => after.quit());
      results.A10 = Number(((mb(twenty.app_median_b) - mb(five.app_median_b)) / 15).toFixed(2));
      details.A10 = { rest_5: summarizeWeight(five), rest_20: summarizeWeight(twenty) };
    }
    if (tests.has("A3") || tests.has("A4") || tests.has("A7")) {
      const launched = launchApp(app, profile, env);
      try {
        const page = await launched.page();
        if (tests.has("A3")) {
          const values = await threadOpen(page, seeded, runs);
          results.A3 = median(values);
          details.A3 = values;
        }
        if (tests.has("A4")) {
          const values = await firstWord(page, seeded, runs, replay.requests);
          results.A4 = median(values.map((v) => v.total));
          const split = (key: "request" | "render") => {
            const known = values.flatMap((v) => (v[key] === undefined ? [] : [v[key]!]));
            return known.length > 0 ? Math.round(median(known)) : undefined;
          };
          details.A4 = {
            values: values.map((v) => Math.round(v.total)),
            request_median: split("request"),
            render_median: split("render"),
            runs: values,
          };
        }
        if (tests.has("A7")) {
          const load = await fightWeight(launched, helper, profile.root);
          results.A7 = Math.round(mb(load.total_p95_b));
          details.A7 = {
            ...summarizeWeight(load),
            app_p95_mb: Math.round(mb(load.app_p95_b)),
            total_p95_mb: results.A7,
          };
        }
      } finally {
        await launched.quit();
      }
    }
    if (tests.has("A11")) {
      const longFile = path.join(profile.root, "long.json");
      if (!fs.existsSync(longFile))
        writeJson(longFile, await addChats(app, profile, env, "replay:long-2000", 1, 30 * 60_000));
      const longId = (JSON.parse(fs.readFileSync(longFile, "utf8")) as Array<string>)[0]!;
      const launched = launchApp(app, profile, env);
      try {
        // ADEMark runs A11 five times; --runs sets it like every other timed test.
        const values = await longThreadOpen(
          await launched.page(),
          seeded,
          longId,
          arg("--runs") === undefined ? 5 : runs,
        );
        results.A11 = median(values);
        details.A11 = values;
      } finally {
        await launched.quit();
      }
    }
  } finally {
    replay.stop();
  }
}

if (tests.has("B1") || tests.has("B3") || tests.has("B4")) {
  const b = await trackB(app, profile, (url) => runEnv(profile, url), {
    real: process.argv.includes("--real"),
  });
  results.B1 = b.b1.total_tokens;
  results.B3 = b.b3.total_tokens;
  results.B4 = b.b1.canary_in_request && b.b3.canary_in_request;
  details.B = b;
}

// --- The table: each value, ADEMark's first place and the Bare CLI there, and our budget here.
const sameMac = budgets.machine === machineName();
const failures: Array<string> = [];
const rows = Object.entries(results).map(([id, value]) => {
  const b = budgets.metrics[id];
  if (!b) return `${id.padEnd(4)} ${String(value)}`;
  const held = typeof b.budget === "boolean" ? value === b.budget : (value as number) <= b.budget;
  const checked = !b.timed || sameMac;
  if (!held && checked) failures.push(`${id} ${b.name}: ${value} ${b.unit}, budget ${b.budget}`);
  const shown =
    typeof value === "number"
      ? `${Number(value.toFixed(value < 10 ? 3 : 0))} ${b.unit}`
      : String(value);
  const lead = `${b.leader.value} ${b.unit} (${b.leader.app})`;
  return `${id.padEnd(4)} ${b.name.padEnd(18)} ${shown.padEnd(14)} leader ${lead.padEnd(34)} budget ${String(b.budget).padEnd(8)} ${held ? "ok" : checked ? "OVER" : "over (another Mac: not checked)"}`;
});
console.log(`\nADEMark on ${path.basename(app)} (${machineName()})\n${rows.join("\n")}`);
const out = arg("--out") ?? path.join(profile.root, "results.json");
writeJson(out, {
  app,
  machine: machineName(),
  measured_at: new Date().toISOString(),
  results,
  details,
});
console.log(`\nresults: ${out}`);
if (process.argv.includes("--check") && failures.length > 0) {
  console.error(`\nOver budget:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

function machineName(): string {
  return `${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
}
