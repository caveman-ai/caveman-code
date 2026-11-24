// Schedules smoke against a real `node packages/runtime/src/bin.ts` in a scratch home. A chat's agent calls the
// orchestrator MCP tools with the chat's own MCP credential (read from what the runtime hands the engine): it
// registers a project with `t3_project_create` (schedule_task refuses Caveman Code's own session projects) and
// schedules work there. A one-time task fires at its time, launching a chat on the engine, and then has no next run; repeats (the last day of the month, weekday cron in another
// zone, every other Monday, an interval with a run count) report next runs that read right on their own wall clock; a
// time in the past and a cron croner cannot read are refused. A Me automation file with `once` fires once too. The
// engine is Claude Agent pointed at scripts/smoke-claude.mjs, so no model is called and no login is read.
//
//   node packages/runtime/scripts/schedules-smoke.ts [--port <runtime>] [--keep]
//
// --keep leaves the runtime up with a Me automation file that has a schedule (for the web app: VITE_RUNTIME_URL,
// VITE_RUNTIME_TOKEN) until SIGTERM or a `stop` file in the scratch dir.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const fakeClaude = path.join(here, "smoke-claude.mjs");
const keep = process.argv.includes("--keep");
const portArg = process.argv.indexOf("--port");
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
const port = portArg < 0 ? await freePort() : Number(process.argv[portArg + 1]);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-schedules-smoke-"));
const home = path.join(scratch, "home");
const stateDir = path.join(scratch, "runtime", "userdata");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(stateDir, "secrets"), { recursive: true, mode: 0o700 });
fs.chmodSync(fakeClaude, 0o755);
fs.writeFileSync(
  path.join(stateDir, "settings.json"),
  JSON.stringify({
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } },
    },
  }),
);

const failures: string[] = [];
const log = (line: string) =>
  console.log(`[schedules-smoke ${new Date().toISOString().slice(11, 19)}] ${line}`);
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
/** The wall clock in `zone` at an instant: weekday (0 Sunday), day, hour, minute. */
const wall = (iso: string, zone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
};

const trace = path.join(scratch, "claude-trace.ndjson");
const repo = path.join(scratch, "shop");
fs.mkdirSync(path.join(repo, ".caveman", "local", "automations"), { recursive: true });
fs.writeFileSync(path.join(repo, ".caveman", ".gitignore"), "local/\nstate/\n");
fs.writeFileSync(path.join(repo, "README.md"), "shop\n");
// A Me file with a repeat the form edits: every other Monday at 10:00 from a start, for six runs.
fs.writeFileSync(
  path.join(repo, ".caveman", "local", "automations", "release-notes.yaml"),
  `# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json
version: 1
description: Every other Monday, draft release notes from what merged

on:
  schedule: { at: "10:00", timezone: Europe/Amsterdam, weekdays: [mon], every: 2w, start: "2026-11-09", count: 6 }

steps:
  notes:
    prompt: Draft release notes from the pull requests merged since the last notes.
    model: fast
`,
);
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "smoke",
      GIT_AUTHOR_EMAIL: "smoke@example.invalid",
      GIT_COMMITTER_NAME: "smoke",
      GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    },
  });
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-qm", "init");

let runtime: ChildProcess | undefined;
let output = "";
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CAVEMAN_CODE_HOME: path.join(scratch, "runtime"),
    CAVEMAN_CODE_NO_BROWSER: "1",
    SHELL: "/bin/zsh",
    SMOKE_CLAUDE_TRACE: trace,
  };
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "CAVEMAN_PROXY_BIN",
    "CAVEMAN_MCP_BIN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ])
    delete env[name];
  runtime = spawn(process.execPath, [bin, "--port", String(port)], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  fs.writeFileSync(path.join(scratch, "runtime.pid"), String(runtime.pid));
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  log(`runtime pid ${runtime.pid} on 127.0.0.1:${port}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 180_000);
  const token = fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  // A chat, whose first turn starts the engine: the runtime hands it the t3-code MCP server and its credential.
  const created = await client.call("workspace.create", {
    request_id: "w1",
    repo: { path: repo },
    title: "Shop",
    engine: "claude-agent",
    options: { model: "claude-sonnet-4-6" },
  });
  await client.attach(created.session_id, 0, () => {});
  await client.call("turn.submit", {
    request_id: "t1",
    session_id: created.session_id,
    kind: "followup",
    input: { text: "slow 120000: hello" },
  });
  // The turn stays open while its agent calls the tools: they act for a running turn only.
  type Server = {
    readonly type?: string;
    readonly url?: string;
    readonly headers?: Record<string, string>;
  };
  let mcp: Server | undefined;
  await until(
    "the engine to get its MCP servers",
    () => {
      if (!fs.existsSync(trace)) return false;
      for (const line of fs.readFileSync(trace, "utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as {
          what: string;
          frame: { request?: { subtype?: string; servers?: Record<string, Server> } } | string[];
        };
        if (
          frame.what === "in" &&
          !Array.isArray(frame.frame) &&
          frame.frame.request?.subtype === "mcp_set_servers"
        )
          mcp = frame.frame.request.servers?.["t3-code"];
      }
      return mcp?.url !== undefined;
    },
    120_000,
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcp!.url!), {
    requestInit: { headers: mcp!.headers ?? {} },
  });
  const agent = new Client({ name: "schedules-smoke", version: "1" });
  // exactOptionalPropertyTypes: the SDK's transport types sessionId as optional without undefined.
  await agent.connect(transport as never);
  const tools = await agent.listTools();
  const tool = tools.tools.find((t) => t.name === "schedule_task");
  check(
    tool !== undefined && /once/.test(tool.description ?? "") && tool.title === "Schedule a task",
    "schedule_task is advertised for one-time and repeating work",
  );
  type Saved = {
    readonly scheduledTaskId: string;
    readonly nextRunAt: string | null;
    readonly schedule: { readonly type: string };
  };
  // A second repo, registered through the MCP project tool so the agent's tasks may start work in it.
  const ops = path.join(scratch, "ops");
  fs.mkdirSync(ops);
  fs.writeFileSync(path.join(ops, "README.md"), "ops\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ops });
  execFileSync(
    "git",
    ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "add", "."],
    { cwd: ops },
  );
  execFileSync(
    "git",
    ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init"],
    { cwd: ops },
  );
  const registered = (await agent.callTool({
    name: "t3_project_create",
    arguments: {
      title: "Ops",
      workspaceRoot: ops,
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
    },
  })) as {
    isError?: boolean;
    structuredContent?: { id?: string };
    content?: Array<{ text?: string }>;
  };
  if (registered.isError)
    throw new Error(`t3_project_create: ${registered.content?.map((c) => c.text).join(" ")}`);
  const opsId =
    registered.structuredContent?.id ??
    (JSON.parse(registered.content?.[0]?.text ?? "{}") as { id?: string }).id;
  log(`registered ${ops} as project ${opsId}`);
  const schedule = async (title: string, schedule: unknown): Promise<Saved | string> => {
    const result = (await agent.callTool({
      name: "schedule_task",
      arguments: { projectId: opsId, prompt: `${title}: say done.`, title, schedule },
    })) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> };
    if (result.isError) return result.content?.map((c) => c.text ?? "").join(" ") ?? "error";
    return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}")) as Saved;
  };
  const saved = (r: Saved | string, what: string): Saved => {
    if (typeof r === "string") throw new Error(`${what} was refused: ${r}`);
    return r;
  };
  type Listed = Saved & { readonly lastRunStatus: string; readonly enabled: boolean };
  const listTasks = async (): Promise<ReadonlyArray<Listed>> => {
    const result = (await agent.callTool({
      name: "list_scheduled_tasks",
      arguments: { projectId: opsId },
    })) as {
      structuredContent?: { tasks: Array<Saved & { lastRunStatus: string; enabled: boolean }> };
      content?: Array<{ text?: string }>;
    };
    return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}")).tasks;
  };

  // One time, a little over a minute from now, in New York's offset the way an agent writes the user's local time.
  const at = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
  const nyOffset = (() => {
    const w = wall(at.toISOString(), "America/New_York");
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const minutes = Math.round((asUtc - at.getTime()) / 60_000);
    const sign = minutes < 0 ? "-" : "+";
    return `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  })();
  const w = wall(at.toISOString(), "America/New_York");
  const runAt = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}T${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:00${nyOffset}`;
  const once = saved(await schedule("Cut the release branch", { type: "once", runAt }), "once");
  log(
    `schedule_task once at ${runAt}: ${once.scheduledTaskId}, stored ${JSON.stringify(once.schedule)}, next run ${once.nextRunAt}`,
  );
  check(
    once.nextRunAt === at.toISOString(),
    "a one-time task's next run is its instant, stored in UTC",
  );

  const past = await schedule("Too late", {
    type: "once",
    runAt: new Date(Date.now() - 60_000).toISOString(),
  });
  check(
    typeof past === "string" && /run time has passed/.test(past),
    `a one-time task in the past is refused (${String(past).slice(0, 70)})`,
  );

  // Repeats, each read on its own wall clock.
  const monthEnd = saved(
    await schedule("Month-end review", {
      type: "monthly",
      timeOfDay: "18:00",
      days: [-1],
      timeZone: "Europe/Amsterdam",
    }),
    "monthly",
  );
  const me = wall(monthEnd.nextRunAt!, "Europe/Amsterdam");
  const lastDay = new Date(Date.UTC(me.year, me.month, 0)).getUTCDate();
  log(
    `monthly last day next run ${monthEnd.nextRunAt} (Amsterdam ${me.year}-${me.month}-${me.day} ${me.hour}:${String(me.minute).padStart(2, "0")})`,
  );
  check(
    me.day === lastDay && me.hour === 18 && me.minute === 0,
    "the last day of the month at 18:00 in Amsterdam",
  );

  const cron = saved(
    await schedule("Weekday standup notes", {
      type: "cron",
      expression: "30 8 * * 1-5",
      timeZone: "America/New_York",
      until: "2027-06-30T23:59:59.999-04:00",
    }),
    "cron",
  );
  const ny = wall(cron.nextRunAt!, "America/New_York");
  log(
    `cron next run ${cron.nextRunAt} (New York weekday ${ny.weekday} ${ny.hour}:${String(ny.minute).padStart(2, "0")})`,
  );
  check(
    ny.weekday >= 1 && ny.weekday <= 5 && ny.hour === 8 && ny.minute === 30,
    "weekday cron at 08:30 in New York",
  );

  const fortnightly = saved(
    await schedule("Release notes", {
      type: "fixed_time",
      timeOfDay: "10:00",
      weekdays: [1],
      everyWeeks: 2,
      timeZone: "Europe/Amsterdam",
      startAt: "2026-11-09T00:00:00+01:00",
    }),
    "every other Monday",
  );
  const f1 = wall(fortnightly.nextRunAt!, "Europe/Amsterdam");
  log(`every other Monday next run ${fortnightly.nextRunAt}`);
  check(
    f1.weekday === 1 && f1.hour === 10 && fortnightly.nextRunAt! >= "2026-11-09",
    "every other Monday at 10:00, from its start",
  );

  const interval = saved(
    await schedule("Queue check", { type: "interval", everyMs: 90 * 60_000, maxRuns: 3 }),
    "interval",
  );
  const gap = Date.parse(interval.nextRunAt!) - Date.now();
  check(
    gap > 85 * 60_000 && gap <= 91 * 60_000,
    `an interval's next run is 90 minutes on (${Math.round(gap / 60_000)} min)`,
  );

  const badCron = await schedule("Bad cron", {
    type: "cron",
    expression: "0 25 * * *",
    timeZone: "UTC",
  });
  check(
    typeof badCron === "string" && /not valid/.test(badCron),
    `a cron croner cannot read is refused (${String(badCron).slice(0, 70)})`,
  );

  // A Me file that runs once, two minutes on, turned on as the app does when it saves one.
  const fileAt = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000);
  const fw = wall(fileAt.toISOString(), "UTC");
  const fileOnce = `${fw.year}-${String(fw.month).padStart(2, "0")}-${String(fw.day).padStart(2, "0")} ${String(fw.hour).padStart(2, "0")}:${String(fw.minute).padStart(2, "0")}`;
  const onceFile = `version: 1\ndescription: Tag the release once\n\non:\n  schedule: { once: "${fileOnce}", timezone: UTC }\n\nsteps:\n  tag:\n    prompt: Say which commit you would tag.\n    model: fast\n    computer: none\n`;
  const project_id = (await client.call("workspace.get", { workspace_id: created.id })).project_id!;
  const fileSaved = await client.call("automation.create", {
    request_id: "f1",
    project_id,
    scope: "me",
    from: { name: "tag-release", text: onceFile },
  });
  log(
    `automation.create: ${fileSaved.automation.id} enabled ${fileSaved.automation.enabled}, next run ${fileSaved.automation.next_run_at} for ${fileOnce} UTC`,
  );
  check(
    fileSaved.automation.next_run_at === fileAt.toISOString(),
    "a once file's next run is its date and time in its zone",
  );

  // The one-time task fires at its time, once.
  await until(
    "the one-time task to run",
    async () => {
      const t = (await listTasks()).find((x) => x.scheduledTaskId === once.scheduledTaskId);
      return t !== undefined && t.lastRunStatus !== "never" && t.lastRunStatus !== "running";
    },
    240_000,
  );
  const ran = (await listTasks()).find((x) => x.scheduledTaskId === once.scheduledTaskId)!;
  const firedAt = Date.now();
  log(
    `once ran: status ${ran.lastRunStatus}, next run ${ran.nextRunAt}, enabled ${ran.enabled}, seen at ${new Date(firedAt).toISOString()}`,
  );
  check(ran.lastRunStatus === "succeeded", "the one-time run launched its chat");
  check(
    firedAt >= at.getTime() && firedAt - at.getTime() < 30_000,
    `it ran at its time, not before (${new Date(firedAt).toISOString()} for ${at.toISOString()})`,
  );
  check(
    ran.nextRunAt === null && ran.enabled && ran.schedule.type === "once",
    "after it runs it stays listed, on, with no next run",
  );
  // The launched chat is a real engine run: the stand-in CLI answered the task's prompt.
  // One user frame per run carries the task's prompt to the engine.
  const answered = () =>
    fs
      .readFileSync(trace, "utf8")
      .split("\n")
      .filter((l) => l.includes('"what":"in"') && l.includes("Cut the release branch: say done."))
      .length;
  await until(
    "the engine to answer the task's prompt",
    () =>
      answered() > 0 &&
      fs.readFileSync(trace, "utf8").includes("smoke ok: Cut the release branch: say done."),
    60_000,
  );
  check(true, "the engine answered the task's prompt in a new chat");

  // The file's once fires too, and the list says its schedule in words.
  const fileId = (await client.call("automation.list", { project_id })).automations.find((a) =>
    a.id.endsWith(":tag-release"),
  )?.id;
  if (fileId !== undefined) {
    await until(
      "the file's once to fire",
      async () =>
        (await client.call("automation.deliveries", { id: fileId })).deliveries.length > 0,
      240_000,
    );
    const deliveries = (await client.call("automation.deliveries", { id: fileId })).deliveries;
    log(`file once deliveries: ${JSON.stringify(deliveries).slice(0, 200)}`);
    check(
      deliveries.length === 1 && /^Started /.test(deliveries[0]!.outcome),
      "the file's once started one run",
    );
  } else check(false, "the once file is listed");
  await new Promise((r) => setTimeout(r, 15_000));
  check(
    answered() === 1 &&
      (await listTasks()).find((x) => x.scheduledTaskId === once.scheduledTaskId)!.nextRunAt ===
        null,
    "the one-time task does not run again",
  );
  const file = (await client.call("automation.list", { project_id })).automations.find((a) =>
    a.id.endsWith(":release-notes"),
  );
  const words = file?.trigger.type === "file" ? file.trigger.words.join(" · ") : "(none)";
  log(`release-notes file trigger: ${words}`);
  check(
    /Every 2 weeks on Mon at 10:00 \(Europe\/Amsterdam\), from 2026-11-09, 6 runs/.test(words),
    "a file's every-other-Monday schedule reads back in words",
  );
  await agent.close();

  if (keep) {
    log(
      `KEEP VITE_RUNTIME_URL=ws://127.0.0.1:${port}/session/v1 VITE_RUNTIME_TOKEN=${token}; touch ${path.join(scratch, "stop")} to end`,
    );
    client.close();
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
      const timer = setInterval(
        () => fs.existsSync(path.join(scratch, "stop")) && (clearInterval(timer), resolve()),
        500,
      );
    });
  } else client.close();
} catch (error) {
  failures.push(String(error));
  log(String(error));
  log(`runtime output tail:\n${output.split("\n").slice(-40).join("\n")}`);
} finally {
  if (runtime && runtime.exitCode === null) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
  }
  fs.writeFileSync(path.join(scratch, "runtime.log"), output);
  log(
    failures.length === 0
      ? "all checks passed"
      : `${failures.length} failed: ${failures.join("; ")}`,
  );
  // An open socket from a failed step must not hold the process.
  process.exit(failures.length === 0 ? 0 : 1);
}
