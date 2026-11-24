// The token edge, held on every pull request (ADEMark B1 and B3, TESTS.md §3): what a new Claude Agent chat sends the
// model for "hi" and for ADEMark's read-only real prompt, against what bare Claude Code sends for "hi". No app build,
// no login, no model: the runtime from source, the Claude Code the Agent SDK pins (the same CLI everywhere), and
// fakeModel.ts keeping every request. Bytes are exact; tokens are estimated (trackB.ts BYTES_PER_TOKEN).
//
//   node apps/desktop/scripts/ademark/tokens-check.ts           print, and exit 1 over a budget in budgets.json `tokens`
//   --update                                                     write the measured bytes as the new budgets
//
// A change that adds to every request (instructions, tools, injected text) moves these numbers: cut it, or raise the
// budget in the same pull request and say why.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ademarkCheckout, log, newProfile, runEnv, sdkClaude } from "./harness.ts";
import { startFakeModel } from "./fakeModel.ts";
import { B1_PROMPT, BYTES_PER_TOKEN, trackB } from "./trackB.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const budgetsFile = path.join(here, "budgets.json");

interface TokenBudgets {
  /** The pinned CLI the bytes were measured with: a new one moves every number, so budgets are re-measured with it. */
  claude: string;
  /** Bare `claude -p hi` in the arena: the floor no app can go under without cutting Claude Code itself. */
  bare_hi_bytes: number;
  /** The chat's first request for "hi" (ADEMark B2's request). */
  hi_bytes: number;
  /** Every request of the "hi" chat, side calls included (ADEMark B1). */
  hi_total_bytes: number;
  /** Every request of the real-prompt chat (ADEMark B3). */
  real_prompt_total_bytes: number;
}

const claude = sdkClaude();
const version = await new Promise<string>((resolve) => {
  const child = spawn(claude, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.once("exit", () => resolve(out.trim().split(" ")[0] ?? "?"));
});

const checkout = ademarkCheckout();
const profile = newProfile(checkout);

// Bare Claude Code: `claude -p hi` in the arena, on a home with nothing in it.
const bare = await startFakeModel({ tokensPerSecond: 1e9 });
await new Promise<void>((resolve, reject) => {
  const child = spawn(claude, ["-p", B1_PROMPT, "--model", "claude-opus-5-5"], {
    cwd: profile.arena,
    env: runEnv(profile, bare.url),
    stdio: "ignore",
  });
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`bare claude -p exited ${code}`)),
  );
});
const bareHi =
  bare.requests.find((r) => JSON.stringify(r.body.messages).includes(`"text":"${B1_PROMPT}"`)) ??
  bare.requests[0];
await bare.close();

const b = await trackB("source", profile, (url) => runEnv(profile, url), {
  claude,
  sideCallMs: 5_000,
});
const sum = (each: ReadonlyArray<{ bytes: number }>) => each.reduce((n, r) => n + r.bytes, 0);
const measured: TokenBudgets = {
  claude: version,
  bare_hi_bytes: bareHi?.bytes ?? 0,
  hi_bytes: b.b1.first_request_bytes,
  hi_total_bytes: sum(b.b1.each),
  real_prompt_total_bytes: sum(b.b3.each),
};

const all = JSON.parse(fs.readFileSync(budgetsFile, "utf8")) as { tokens?: TokenBudgets } & Record<
  string,
  unknown
>;
const budget = all.tokens;
const tok = (bytes: number) =>
  `~${Math.round(bytes / BYTES_PER_TOKEN).toLocaleString("en")} tokens`;
console.log(`Claude Code ${version} (the Agent SDK's), ${b.user_agent}`);
console.log(
  `  bare "hi"              ${measured.bare_hi_bytes} bytes  ${tok(measured.bare_hi_bytes)}`,
);
console.log(
  `  our "hi", first        ${measured.hi_bytes} bytes  ${tok(measured.hi_bytes)}  (${measured.hi_bytes >= measured.bare_hi_bytes ? "+" : ""}${Math.round(((measured.hi_bytes - measured.bare_hi_bytes) / measured.bare_hi_bytes) * 100)}% against bare)`,
);
console.log(
  `  our "hi", every call   ${measured.hi_total_bytes} bytes  ${tok(measured.hi_total_bytes)}  ${b.b1.requests} requests, ${b.b1.side_requests} side`,
);
console.log(
  `  our real prompt        ${measured.real_prompt_total_bytes} bytes  ${tok(measured.real_prompt_total_bytes)}  ${b.b3.requests} requests`,
);
console.log(
  `  first request: system ~${b.b2.system}, tools ~${b.b2.tools}, MCP tools ~${b.b2.mcp_tools}, injected ~${b.b2.injected} tokens; tools ${b.b2.tool_names.join(", ")}`,
);
console.log(
  `  repo rules (AGENTS.md canary) in the request: ${b.b1.canary_in_request && b.b3.canary_in_request}`,
);

if (process.argv.includes("--update")) {
  fs.writeFileSync(budgetsFile, `${JSON.stringify({ ...all, tokens: measured }, null, 2)}\n`);
  log(`budgets.json tokens updated`);
  process.exit(0);
}
const failures: Array<string> = [];
if (!(b.b1.canary_in_request && b.b3.canary_in_request))
  failures.push("the arena's AGENTS.md no longer reaches the model (ADEMark B4)");
if (budget === undefined) failures.push("budgets.json has no `tokens`: run with --update");
else if (budget.claude !== version)
  // A new pinned CLI moves every byte: the pull request that bumps it re-measures, so a bump never skips the check.
  failures.push(
    `the budgets were measured with Claude Code ${budget.claude} and this is ${version}: run with --update in the pull request that bumps it`,
  );
else
  for (const key of ["hi_bytes", "hi_total_bytes", "real_prompt_total_bytes"] as const) {
    // A path or an id is a few bytes longer on another machine; anything past 1 % is a real change.
    if (measured[key] > budget[key] * 1.01)
      failures.push(
        `${key}: ${measured[key]} bytes, budget ${budget[key]} (${tok(measured[key] - budget[key])} more)`,
      );
  }
if (failures.length > 0) {
  console.error(
    `\nToken budget broken:\n  ${failures.join("\n  ")}\nCut what was added, or raise budgets.json \`tokens\` (--update) and say why in the pull request.`,
  );
  process.exit(1);
}
console.log("\nwithin budget");
