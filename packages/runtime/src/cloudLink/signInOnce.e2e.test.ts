// "Sign in once, everywhere" (cloud-computers SPEC §4, CONTRACT §4), end to end: real runtimes, each in a process of
// its own (signInOnce.e2e.runtime.ts), as a person's two Macs, their Cloud computer under the credential rule, and
// another person's Mac, against the test Cloud (testCloudEngine.ts: one list per person, the data plane, the providers).
// The only `claude` and `codex` are stand-ins for the official CLIs (scripts/fake-plan-clis.mjs) and every secret is
// the test provider's: this process never holds one, and searches for them masked.
//
// A person connects a plan once, on one Mac, by approving on the provider's page. Then, with no further sign-in: their
// Cloud computer runs a turn on it (the data plane attaches the credential), their second Mac lists it and runs a turn
// on it, a new project and a new chat on each run on it, and another person sees nothing.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type EngineAccount, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { CONNECT_NOT_SIGNED_IN, connectKindOff } from "../session-protocol/engineAccounts.ts";
import {
  createReady,
  FAKE_CLAUDE,
  makeRepo,
  MODEL,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { CONNECT_MESSAGE, CONNECTS_DIR } from "./connectHere.ts";
import { OUTSIDE_ORDER, OUTSIDE_REMOVE } from "./credentialRule.ts";
import { enroll } from "./identity.ts";
import {
  CLOUD_LACKS_CONNECTIONS,
  nothingServesNote,
  usedUpNote,
  type ModelConnection,
} from "./modelConnections.ts";
import { startTestCloud } from "./testCloud.ts";
import {
  fileHoldsCanaries,
  startEngineCloud,
  type EngineCloud,
  type EngineCloudReport,
} from "./testCloudEngine.ts";

const RUNTIME = fileURLToPath(new URL("./signInOnce.e2e.runtime.ts", import.meta.url));
const PLAN_CLIS = fileURLToPath(new URL("../../scripts/fake-plan-clis.mjs", import.meta.url));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every regular file under `root`. */
const filesUnder = (root: string): Array<string> =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

interface Runtime {
  readonly name: string;
  readonly client: ReturnType<typeof connect>;
  /** Another window of the same computer: a second client of this runtime. */
  readonly window: () => ReturnType<typeof connect>;
  readonly stateDir: string;
  readonly baseDir: string;
  readonly control: string;
  readonly runtimeId: string | undefined;
  /** Its HOME: a scratch folder, where a CLI that ignored its private folder would write `.claude` or `.codex`. */
  readonly home: string;
  readonly log: string;
  readonly repoUrl?: string;
}

/**
 * The test Cloud, two people, and what starts a runtime as one of their computers. `pageCode`: Claude's page cannot
 * reach the computer, so `claude setup-token` finishes only on the code the page shows, pasted at its prompt.
 */
async function world(options: { readonly pageCode?: boolean } = {}) {
  const inner = await startTestCloud();
  cleanups.push(inner.close);
  const cloud = await startEngineCloud(inner.url, { hosted: [], credentialsOutside: true });
  cleanups.push(cloud.close);
  const root = tempRoot("sign-in-once-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const cliLog = path.join(root, "clis.ndjson");
  fs.writeFileSync(cliLog, "");
  // The only claude and codex there are: the official CLIs' stand-ins. `claude` is the smoke CLI for everything but its sign-in.
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\n${options.pageCode ? "export FAKE_CLAUDE_PAGE_CODE=1\n" : ""}if [ "$1" = "setup-token" ]; then exec '${process.execPath}' '${PLAN_CLIS}' claude '${cloud.url}' '${cliLog}' "$@"; fi\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nexec '${process.execPath}' '${PLAN_CLIS}' codex '${cloud.url}' '${cliLog}' "$@"\n`,
    { mode: 0o755 },
  );
  const hosted: Array<string> = [];
  const children: Array<ChildProcess> = [];
  cleanups.push(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  });

  const start = async (name: string, env: Record<string, string>): Promise<Runtime> => {
    const home = path.join(root, `home-${name}`);
    fs.mkdirSync(home);
    const outFile = path.join(root, `${name}.json`);
    const log = path.join(root, `${name}.log`);
    const fd = fs.openSync(log, "w");
    const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: os.tmpdir(),
        SIO_CLOUD_URL: cloud.url,
        SIO_BIN: bin,
        SIO_OUT: outFile,
        SIO_NAME: name,
        ...env,
      },
      stdio: ["ignore", fd, fd],
    });
    children.push(child);
    await until(() => fs.existsSync(outFile) || child.exitCode !== null, 120_000);
    if (!fs.existsSync(outFile))
      throw new Error(`the ${name} runtime exited: ${fs.readFileSync(log, "utf8").slice(-3000)}`);
    const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
      url: string;
      token: string;
      stateDir: string;
      baseDir: string;
      control: string;
      runtimeId?: string;
    };
    const client = connect(info.url, info.token);
    cleanups.push(() => client.close());
    const window = () => {
      const second = connect(info.url, info.token);
      cleanups.push(() => second.close());
      return second;
    };
    return {
      name,
      client,
      window,
      stateDir: info.stateDir,
      baseDir: info.baseDir,
      control: info.control,
      runtimeId: info.runtimeId,
      home,
      log,
    };
  };
  /** A Mac of `bearer`'s person; with none, a Mac that is not signed in to Caveman. */
  const mac = (name: string, bearer?: string) =>
    start(name, { SIO_ROLE: "mac", ...(bearer ? { SIO_BEARER: bearer } : {}) });
  /** A Cloud computer of `bearer`'s person, under the credential rule: enrolled first, so Cloud knows it is one before it asks. */
  const box = async (name: string, bearer: string): Promise<Runtime> => {
    const linkDir = path.join(root, `${name}-link`);
    const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer, name });
    hosted.push(identity.runtimeId);
    await cloud.configure({ hosted });
    const checkout = makeRepo(path.join(root, `${name}-workspace`), { "README.md": "widgets\n" });
    fs.chmodSync(checkout, 0o755);
    const started = await start(name, {
      SIO_ROLE: "cloud",
      SIO_LINK_DIR: linkDir,
      SIO_WORKSPACE: checkout,
    });
    await until(
      async () => (await started.client.call("cloud.status", {})).state === "connected",
      30_000,
    );
    return { ...started, repoUrl: "https://github.com/acme/widgets" };
  };

  let chats = 0;
  /** A new project and a new chat on `rt`, and one Claude Agent turn in it: what the model said, and what the chat was told. */
  const claudeTurn = async (rt: Runtime, words = "model: say where you ran") => {
    const n = ++chats;
    const repo = rt.repoUrl
      ? { url: rt.repoUrl }
      : { path: makeRepo(path.join(root, `project-${n}`), { "README.md": `project ${n}\n` }) };
    const workspace = await createReady(rt.client, {
      request_id: `w${n}`,
      repo,
      title: `Chat ${n}`,
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const events: Array<SessionEvent> = [];
    await rt.client.attach(workspace.session_id, 0, (event) => events.push(event));
    const turn = async (text = words) => {
      const before = events.filter((event) => event.type === "turn.done").length;
      await rt.client.call("turn.submit", {
        request_id: `t${n}-${events.length}`,
        session_id: workspace.session_id,
        kind: "followup",
        input: { text },
      });
      await until(
        () => events.filter((event) => event.type === "turn.done").length > before,
        90_000,
      );
    };
    await turn();
    return {
      turn,
      said: () =>
        events
          .flatMap((event) =>
            event.type === "message.done" && event.payload.role === "assistant"
              ? [event.payload.text]
              : [],
          )
          .join("\n"),
      notes: () =>
        events.flatMap((event) =>
          event.type === "notification"
            ? [
                {
                  level: event.payload.level,
                  title: event.payload.title,
                  ...(event.payload.body === undefined ? {} : { body: event.payload.body }),
                },
              ]
            : [],
        ),
      asks: () => events.filter((event) => event.type === "ask.user").length,
      shown: () => JSON.stringify(events),
    };
  };
  /** One Codex model request in a new chat on `rt`, launched as its adapter launches Codex. */
  const codexTurn = async (rt: Runtime) => {
    const response = await fetch(`${rt.control}/codex`, {
      method: "POST",
      body: JSON.stringify({ session: `codex-chat-${++chats}`, words: "say where you ran" }),
    });
    return (await response.json()) as {
      out?: string;
      code?: number;
      home?: string;
      stoodIn?: boolean;
      unavailable?: string;
    };
  };
  /**
   * An engine's accounts on `rt`. Claude Agent's are engine.list's. The harness runs no Codex engine, so Codex's are
   * what an account call answers: giving up a sign-in that is not open changes nothing and answers the accounts.
   */
  const accounts = async (
    rt: Runtime,
    engine: "claude-agent" | "codex",
  ): Promise<ReadonlyArray<EngineAccount>> =>
    engine === "codex"
      ? (
          await rt.client.call("engine.account.remove", {
            request_id: `list-${++chats}`,
            engine,
            account_id: "connecting",
          })
        ).accounts
      : ((await rt.client.call("engine.list", {})).engines.find((e) => e.id === engine)?.auth
          .accounts ?? []);
  const everywhere = async (rt: Runtime, engine: "claude-agent" | "codex") =>
    (await rt.client.call("engine.list", {})).engines.find((e) => e.id === engine)?.auth.everywhere;
  /** Connects `engine`'s plan on `rt`: the runtime runs the official CLI, the person approves on the provider's page. */
  const connectPlan = async (rt: Runtime, engine: "claude-agent" | "codex") => {
    const added = await rt.client.call("engine.account.add", {
      request_id: `add-${engine}-${++chats}`,
      engine,
      everywhere: true,
      ...(engine === "codex" ? { chatgpt: true } : {}),
    });
    expect(await cloud.approve()).toBe(1);
    for (;;) {
      const done = await rt.client.call("engine.account.complete", {
        request_id: `done-${++chats}`,
        engine,
        account_id: "connecting",
        callback_url: "",
      });
      if (done.waiting !== true) return { signIn: added.sign_in, accounts: done.accounts };
    }
  };
  const cliRuns = () =>
    fs
      .readFileSync(cliLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            cli: string;
            args: Array<string>;
            home: string;
            env: Array<string>;
            configDir?: string;
            columns?: number;
            tty?: boolean;
            codexHome?: string;
            store?: string;
            status?: number;
            refreshed?: boolean;
            refreshOverridden?: boolean;
          },
      );
  /** The upstream requests the provider got since `from`, on `lane`. */
  const upstream = (report: EngineCloudReport, lane: string, from = 0) =>
    report.upstream.slice(from).filter((seen) => seen.lane === lane && seen.method === "POST");
  /** Every place a runtime writes, searched for every secret a sign-in issued. */
  const leaks = (report: EngineCloudReport, runtimes: ReadonlyArray<Runtime>) => {
    const searched = [
      ...new Set([
        ...runtimes.flatMap((rt) => [
          ...filesUnder(rt.stateDir),
          ...filesUnder(rt.baseDir),
          ...filesUnder(rt.home),
          rt.log,
        ]),
        ...filesUnder(root),
      ]),
    ];
    return {
      searched: searched.length,
      found: searched.flatMap((file) =>
        fileHoldsCanaries(file, report.issued).map(
          (name) => `${name} in ${path.relative(os.tmpdir(), file)}`,
        ),
      ),
    };
  };
  return {
    inner,
    cloud,
    root,
    mac,
    box,
    claudeTurn,
    codexTurn,
    accounts,
    everywhere,
    connectPlan,
    cliRuns,
    upstream,
    leaks,
    me: inner.state.personToken,
    other: inner.state.chats.addPerson("user-2"),
  };
}

const connectionOf = (list: ReadonlyArray<EngineAccount>) =>
  list.filter((account) => account.connection !== undefined);
const SAID = "model said: answer from the provider";

test.skipIf(process.platform === "win32")(
  "a sign-in in progress shows in every window of the Mac, and only the window that started it can end it",
  async () => {
    const w = await world();
    const mac = await w.mac("mac-a", w.me);
    const second = mac.window();
    type Connecting = { readonly request_id: string; readonly since: string } | undefined;
    const connectingOf = async (client: ReturnType<typeof connect>): Promise<Connecting> =>
      (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")?.auth
        .connecting;
    const heard: Array<Connecting | null> = [];
    second.on("engine.changed", ({ engines }) =>
      heard.push(engines.find((e) => e.id === "claude-agent")?.auth.connecting ?? null),
    );
    const signIns = () =>
      w.cliRuns().filter((run) => run.cli === "claude" && run.args[0] === "setup-token").length;
    expect(await connectingOf(second)).toBeUndefined();

    // The first window presses Use everywhere: the official CLI's sign-in opens.
    const added = await mac.client.call("engine.account.add", {
      request_id: "window-a-add",
      engine: "claude-agent",
      everywhere: true,
    });
    expect(added.sign_in?.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    // The second window is told without asking (engine.changed): who started it, and since when.
    await until(() => heard.at(-1)?.request_id === "window-a-add", 15_000);
    const open = await connectingOf(second);
    expect(open?.request_id).toBe("window-a-add");
    expect(Math.abs(Date.now() - Date.parse(open!.since))).toBeLessThan(120_000);
    // Nothing of the sign-in itself rides on the list: no page, no code.
    expect(JSON.stringify(open)).not.toMatch(/claude\.ai|oauth/);

    // The second window pressing the same button is answered the page that is open; no second CLI runs.
    const again = await second.call("engine.account.add", {
      request_id: "window-b-add",
      engine: "claude-agent",
      everywhere: true,
    });
    expect(again.sign_in?.url).toBe(added.sign_in?.url);
    expect(signIns()).toBe(1);
    expect((await connectingOf(mac.client))?.request_id).toBe("window-a-add");

    // Its Cancel, Escape or closing ends nothing: not a bare name, not its own request's.
    await second.call("engine.account.remove", {
      request_id: "window-b-1",
      engine: "claude-agent",
      account_id: "connecting",
    });
    await second.call("engine.account.remove", {
      request_id: "window-b-2",
      engine: "claude-agent",
      account_id: "connecting:window-b-add",
    });
    expect((await connectingOf(second))?.request_id).toBe("window-a-add");
    // Either window may wait for it.
    expect(
      (
        await second.call("engine.account.complete", {
          request_id: "window-b-3",
          engine: "claude-agent",
          account_id: "connecting",
          callback_url: "",
        })
      ).waiting,
    ).toBe(true);

    // The window that started it gives it up, and the other hears it end.
    await mac.client.call("engine.account.remove", {
      request_id: "window-a-1",
      engine: "claude-agent",
      account_id: "connecting:window-a-add",
    });
    await until(() => heard.at(-1) === null, 15_000);
    expect(await connectingOf(second)).toBeUndefined();
    expect(connectionOf(await w.accounts(mac, "claude-agent"))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "a Claude plan connected once on one Mac runs the person's Cloud computer and their second Mac with no sign-in; another person sees nothing",
  async () => {
    const w = await world();
    const [macA, macB, cloudComputer, theirs] = await Promise.all([
      w.mac("mac-a", w.me),
      w.mac("mac-b", w.me),
      w.box("box", w.me),
      w.mac("their-mac", w.other),
    ]);

    // Before anything is connected this Mac runs Claude Agent as it always did, on whatever its own claude has.
    expect(await w.everywhere(macA, "claude-agent")).toBe("available");
    expect(connectionOf(await w.accounts(macA, "claude-agent"))).toEqual([]);
    expect((await w.claudeTurn(macA)).said()).toContain(SAID);
    expect(w.upstream(await w.cloud.report(), "claude").at(-1)).toMatchObject({
      issued: [],
      standIn: false,
    });

    // (1) Connect once, on Mac A: no terminal, nothing pasted. The person approves on Anthropic's page.
    const connected = await w.connectPlan(macA, "claude-agent");
    expect(connected.signIn).toMatchObject({
      command: "",
      message: CONNECT_MESSAGE["claude-agent"],
    });
    expect(connected.signIn?.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    const [plan] = connected.accounts;
    expect(plan).toMatchObject({
      kind: "login",
      active: true,
      where: "everywhere",
      connection: { kind: "claude_plan", status: "ready" },
    });
    expect(plan!.id).toMatch(/^connection:/);
    // A year, as the token lasts: a client asks to reconnect a month before.
    expect(Date.parse(plan!.connection!.expires_at!) - Date.now()).toBeGreaterThan(
      364 * 86_400_000,
    );
    // The runtime ran the official CLI's own sign-in, in a pty wide enough that the token is one line, in a folder of
    // its own that is gone again, with nothing of the person's sign-ins in its environment.
    const [setup] = w.cliRuns().filter((run) => run.cli === "claude");
    expect(setup).toMatchObject({ args: ["setup-token"], tty: true, columns: 1000 });
    expect(path.dirname(setup!.home)).toBe(path.join(macA.stateDir, CONNECTS_DIR));
    expect(setup!.configDir).toBe(setup!.home);
    expect(
      setup!.env.filter(
        (name) =>
          !["HOME", "TERM", "PATH", "CLAUDE_CONFIG_DIR"].includes(name) &&
          !name.startsWith("__CF") &&
          name !== "PWD" &&
          name !== "SHLVL" &&
          name !== "_" &&
          name !== "OLDPWD",
      ),
    ).toEqual([]);
    expect(filesUnder(path.join(macA.stateDir, CONNECTS_DIR))).toEqual([]);
    // What the CLI keeps in its config folder never landed in this Mac's own ~/.claude.
    expect(fs.existsSync(path.join(macA.home, ".claude", ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(macA.home, ".claude.json"))).toBe(false);

    // Mac A runs on it at once: its claude holds a stand-in, and the provider gets the plan's token from the scrub.
    let report = await w.cloud.report();
    const connectionId = report.people["user-1"]![0]!.id;
    expect(plan!.id).toBe(`connection:${connectionId}`);
    let from = report.upstream.length;
    expect((await w.claudeTurn(macA)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({
        issued: ["claude-1"],
        standIn: false,
        runtimeToken: false,
        status: 200,
      }),
    ]);
    // A Mac's requests never go through Cloud's data plane.
    expect(report.plane).toEqual([]);

    // (2) The person's Cloud computer: a turn with no sign-in, the credential attached by the data plane outside it.
    expect(await w.everywhere(cloudComputer, "claude-agent")).toBe("manage");
    // A computer reads Cloud's list again every few seconds; a launch that finds nothing reads it afresh first.
    await until(
      async () => connectionOf(await w.accounts(cloudComputer, "claude-agent")).length === 1,
      20_000,
    );
    expect(connectionOf(await w.accounts(cloudComputer, "claude-agent"))).toEqual([
      expect.objectContaining({
        id: plan!.id,
        where: "everywhere",
        connection: expect.objectContaining({ kind: "claude_plan", status: "ready" }),
      }),
    ]);
    from = report.upstream.length;
    expect((await w.claudeTurn(cloudComputer)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({
        issued: ["claude-1"],
        standIn: false,
        runtimeToken: false,
        status: 200,
      }),
    ]);
    expect(report.plane.at(-1)).toMatchObject({
      lane: "claude",
      path: "/v1/messages",
      named: connectionId,
      served: connectionId,
      status: 200,
    });
    // Nothing is changed from inside it: each refusal says where it is managed.
    await expect(
      cloudComputer.client.call("engine.account.add", {
        request_id: "x1",
        engine: "claude-agent",
        everywhere: true,
      }),
    ).rejects.toMatchObject({ error: { data: { reason: "unsupported" } } });
    await expect(
      cloudComputer.client.call("engine.account.activate", {
        request_id: "x2",
        engine: "claude-agent",
        account_id: plan!.id,
      }),
    ).rejects.toMatchObject({ error: { message: OUTSIDE_ORDER } });
    await expect(
      cloudComputer.client.call("engine.account.remove", {
        request_id: "x3",
        engine: "claude-agent",
        account_id: plan!.id,
      }),
    ).rejects.toMatchObject({ error: { message: OUTSIDE_REMOVE } });

    // (3) The person's second Mac lists it and runs a turn on it: it read the token from Cloud once and sealed it.
    // Its very first chat runs on the plan (a launch reads Cloud's list afresh), and its list shows it.
    from = report.upstream.length;
    expect((await w.claudeTurn(macB)).said()).toContain(SAID);
    expect(connectionOf(await w.accounts(macB, "claude-agent"))).toEqual([
      expect.objectContaining({
        id: plan!.id,
        active: true,
        where: "everywhere",
        connection: expect.objectContaining({ status: "ready" }),
      }),
    ]);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({ issued: ["claude-1"], standIn: false, status: 200 }),
    ]);
    expect(report.access).toEqual([
      { connection: connectionId, runtime: macB.runtimeId, status: 200 },
    ]);

    // (4) A new project and a new chat on each: still no sign-in, and Cloud handed the token out no more.
    from = report.upstream.length;
    for (const rt of [macA, macB, cloudComputer])
      expect((await w.claudeTurn(rt)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from).map((seen) => seen.issued)).toEqual([
      ["claude-1"],
      ["claude-1"],
      ["claude-1"],
    ]);
    expect(report.access).toHaveLength(1);
    expect(w.cliRuns().filter((run) => run.cli === "claude")).toHaveLength(1);

    // (5) Another person sees nothing: not on their Mac, not from their own device, not by naming it.
    expect(await w.everywhere(theirs, "claude-agent")).toBe("available");
    expect(connectionOf(await w.accounts(theirs, "claude-agent"))).toEqual([]);
    from = report.upstream.length;
    expect((await w.claudeTurn(theirs)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([expect.objectContaining({ issued: [] })]);
    const asPerson = (bearer: string, route = "", init: RequestInit = {}) =>
      fetch(`${w.cloud.url}/api/v1/code/model-connections${route}`, {
        ...init,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      });
    expect(await (await asPerson(w.other)).json()).toEqual({ connections: [], kinds: {} });
    expect((await asPerson(w.other, `/${connectionId}`, { method: "DELETE" })).status).toBe(404);
    expect(
      (
        await asPerson(w.other, "/order", {
          method: "PATCH",
          body: JSON.stringify({ ids: [connectionId] }),
        })
      ).status,
    ).toBe(409);
    await expect(
      theirs.client.call("engine.account.remove", {
        request_id: "x4",
        engine: "claude-agent",
        account_id: plan!.id,
      }),
    ).rejects.toBeDefined();
    expect(
      (
        (await (await asPerson(w.me)).json()) as { connections: Array<ModelConnection> }
      ).connections.map((c) => c.id),
    ).toEqual([connectionId]);

    // Offline: Mac A cannot reach Cloud at all, and its Claude plan keeps running its chats.
    await w.cloud.configure({ offline: [macA.runtimeId!] });
    from = report.upstream.length;
    expect((await w.claudeTurn(macA)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({ issued: ["claude-1"], status: 200 }),
    ]);
    await w.cloud.configure({ offline: [] });

    // The token is nowhere a runtime writes: not its state (the journal and the secret store's sealed copy included),
    // not its logs, not a CLI's folder. Cloud's answers carried it once, to the second Mac's access call, and never to
    // the Cloud computer.
    const { searched, found } = w.leaks(report, [macA, macB, cloudComputer, theirs]);
    expect(searched).toBeGreaterThan(40);
    expect(found).toEqual([]);
    expect(report.answersWithIssued).toEqual([
      { route: `POST runtime/model-connections/${connectionId}/access`, name: "claude-1" },
    ]);
    expect(report.answersWithCanary).toEqual([]);
    // The search finds one where there is one: a token written to a file is found by the same masks.
    const { state } = (await (
      await fetch(`${w.cloud.url}/__provider/oauth/start`, {
        method: "POST",
        body: JSON.stringify({ kind: "claude" }),
      })
    ).json()) as { state: string };
    await w.cloud.approve();
    const { token } = (await (
      await fetch(`${w.cloud.url}/__provider/oauth/finish`, {
        method: "POST",
        body: JSON.stringify({ state }),
      })
    ).json()) as { token: string };
    const control = path.join(w.root, "control.txt");
    fs.writeFileSync(control, `a log line with ${token} in it\n`);
    expect(fileHoldsCanaries(control, (await w.cloud.report()).issued)).toEqual(["claude-2"]);
  },
  600_000,
);

test.skipIf(process.platform === "win32")(
  "a ChatGPT plan connected once with the official codex login runs two Macs and a Cloud computer at once, and only Cloud ever refreshes it",
  async () => {
    const w = await world();
    // Short-lived access tokens, so the sign-in has to be refreshed while all three use it.
    await w.cloud.configure({ accessTtlMs: 8_000 });
    const [macA, macB, cloudComputer, theirs] = await Promise.all([
      w.mac("mac-a", w.me),
      w.mac("mac-b", w.me),
      w.box("box", w.me),
      w.mac("their-mac", w.other),
    ]);

    // Nothing connected: Codex is launched on this Mac's own login, as before (here it has none).
    expect(await w.codexTurn(macA)).toMatchObject({ out: "codex: not signed in", stoodIn: false });

    // (1) Connect once, on Mac A: the runtime runs the official `codex login` in a private CODEX_HOME.
    const connected = await w.connectPlan(macA, "codex");
    expect(connected.signIn).toMatchObject({ command: "", message: CONNECT_MESSAGE.codex });
    expect(connected.signIn?.url).toMatch(/^https:\/\/auth\.openai\.com\//);
    const plan = connectionOf(connected.accounts)[0];
    expect(plan).toMatchObject({
      where: "everywhere",
      connection: { kind: "chatgpt_plan", status: "ready" },
    });
    const [login] = w.cliRuns().filter((run) => run.cli === "codex" && run.args.includes("login"));
    // Into a file, in a home of the runtime's own that is gone again; this Mac's own ~/.codex was never opened or made.
    expect(login).toMatchObject({
      args: ["-c", 'cli_auth_credentials_store="file"', "login"],
      store: "file",
    });
    expect(path.dirname(login!.codexHome!)).toBe(path.join(macA.stateDir, CONNECTS_DIR));
    expect(login!.home).toBe(login!.codexHome);
    expect(fs.existsSync(login!.codexHome!)).toBe(false);
    expect(filesUnder(path.join(macA.stateDir, CONNECTS_DIR))).toEqual([]);
    for (const rt of [macA, macB, theirs])
      expect(fs.existsSync(path.join(rt.home, ".codex"))).toBe(false);
    let report = await w.cloud.report();
    const connectionId = report.people["user-1"]![0]!.id;
    expect(plan!.id).toBe(`connection:${connectionId}`);

    // (2) The Cloud computer, (3) the second Mac, and Mac A itself: a Codex request each, with no sign-in. Codex holds a
    // stand-in sign-in in a home of the runtime's own; the real access token is attached outside it.
    for (const rt of [cloudComputer, macB, macA]) {
      const from = report.upstream.length;
      const turn = await w.codexTurn(rt);
      expect(turn).toMatchObject({
        out: "codex said: answer from the provider",
        code: 0,
        stoodIn: true,
        home: path.join(rt.stateDir, "providers", "codex", "codex", "home"),
      });
      report = await w.cloud.report();
      const [seen] = w.upstream(report, "codex", from).filter((s) => s.status === 200);
      expect(seen).toMatchObject({ standIn: false, runtimeToken: false });
      expect(seen!.path).toMatch(/\/responses$/);
      expect(seen!.issued).toHaveLength(1);
      expect(seen!.issued[0]).toMatch(/^chatgpt-1\.access-\d+$/);
    }
    expect(
      report.plane
        .filter((p) => p.lane === "codex" && p.status === 200)
        .every((p) => p.served === connectionId),
    ).toBe(true);
    expect(connectionOf(await w.accounts(macB, "codex"))).toEqual([
      expect.objectContaining({ id: plan!.id, where: "everywhere" }),
    ]);

    // (4) New chats on all three at once, for longer than an access token lasts.
    const until2 = Date.now() + 20_000;
    const rounds: Array<Awaited<ReturnType<typeof w.codexTurn>>> = [];
    while (Date.now() < until2)
      rounds.push(
        ...(await Promise.all([w.codexTurn(macA), w.codexTurn(macB), w.codexTurn(cloudComputer)])),
      );
    expect(rounds.length).toBeGreaterThanOrEqual(6);
    expect(rounds.filter((turn) => turn.out !== "codex said: answer from the provider")).toEqual(
      [],
    );
    report = await w.cloud.report();
    // The sign-in was refreshed, more than once, and every refresh was Cloud's: no computer ever asked the provider.
    expect(report.refreshes.filter((r) => r.by === "cloud" && r.ok).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(report.refreshes.filter((r) => r.by !== "cloud")).toEqual([]);
    expect(report.refreshes.filter((r) => !r.ok)).toEqual([]);
    // Codex's own refresh, had it tried, goes to the runtime's scrub, never to the provider.
    const execs = w
      .cliRuns()
      .filter(
        (run) => run.cli === "codex" && run.args.includes("exec") && run.status !== undefined,
      );
    expect(execs.length).toBeGreaterThan(8);
    expect(execs.every((run) => run.refreshOverridden === true)).toBe(true);
    // A Mac asked Cloud for short-lived access tokens; the Cloud computer never held one.
    expect(new Set(report.access.map((a) => a.runtime))).toEqual(
      new Set([macA.runtimeId, macB.runtimeId]),
    );
    expect(report.access.every((a) => a.connection === connectionId && a.status === 200)).toBe(
      true,
    );

    // (5) Another person sees nothing, and their Codex runs on their own login.
    expect(connectionOf(await w.accounts(theirs, "codex"))).toEqual([]);
    expect(await w.codexTurn(theirs)).toMatchObject({
      out: "codex: not signed in",
      stoodIn: false,
    });

    // Offline: a Mac keeps running Codex on the access token it holds, until that ends.
    await w.cloud.configure({ accessTtlMs: 3_600_000 });
    expect(await w.codexTurn(macA)).toMatchObject({ out: "codex said: answer from the provider" });
    expect(await w.codexTurn(macA)).toMatchObject({ out: "codex said: answer from the provider" });
    await w.cloud.configure({ offline: [macA.runtimeId!] });
    expect(await w.codexTurn(macA)).toMatchObject({
      out: "codex said: answer from the provider",
      stoodIn: true,
    });
    await w.cloud.configure({ offline: [] });

    // No access, refresh or id token is anywhere a runtime writes; Codex's homes hold stand-ins only.
    report = await w.cloud.report();
    expect(Object.keys(report.issued).length).toBeGreaterThanOrEqual(9);
    const { searched, found } = w.leaks(report, [macA, macB, cloudComputer, theirs]);
    expect(searched).toBeGreaterThan(40);
    expect(found).toEqual([]);
    // Cloud's answers carried access tokens only, only through a Mac's access route: never a refresh or id token, never to the Cloud computer.
    expect(report.answersWithIssued.length).toBeGreaterThan(0);
    expect(
      report.answersWithIssued.filter(
        (a) =>
          a.route !== `POST runtime/model-connections/${connectionId}/access` ||
          !/^chatgpt-1\.access-\d+$/.test(a.name),
      ),
    ).toEqual([]);
  },
  600_000,
);

test.skipIf(process.platform === "win32")(
  "a plan that runs out, ends or is switched off says the same on a Mac as on a Cloud computer, and a Mac not signed in works as before",
  async () => {
    const w = await world();
    const [macA, cloudComputer, signedOut] = await Promise.all([
      w.mac("mac-a", w.me),
      w.box("box", w.me),
      w.mac("signed-out-mac"),
    ]);

    // Not signed in to Caveman: nothing about connections is offered or asked, and Claude Agent runs as it always did.
    expect(await w.everywhere(signedOut, "claude-agent")).toBeUndefined();
    expect(connectionOf(await w.accounts(signedOut, "claude-agent"))).toEqual([]);
    await expect(
      signedOut.client.call("engine.account.add", {
        request_id: "s1",
        engine: "claude-agent",
        everywhere: true,
      }),
    ).rejects.toMatchObject({
      error: { message: CONNECT_NOT_SIGNED_IN, data: { reason: "invalid_state" } },
    });
    expect((await w.claudeTurn(signedOut)).said()).toContain(SAID);
    expect(w.cliRuns()).toEqual([]);

    const first = (await w.connectPlan(macA, "claude-agent")).accounts[0]!;
    const firstId = first.id.replace(/^connection:/, "");
    const asMe = (route: string, init: RequestInit) =>
      fetch(`${w.cloud.url}/api/v1/code/model-connections${route}`, {
        ...init,
        headers: { authorization: `Bearer ${w.me}`, "content-type": "application/json" },
      });
    let report = await w.cloud.report();
    let from = report.upstream.length;

    // Anthropic revokes the token: the Mac hears it on its next request, drops its copy and asks to connect again.
    await w.cloud.configure({ provider: { [firstId]: { over: true } } });
    await w.claudeTurn(macA);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from).map((seen) => [seen.status, seen.issued])).toEqual([
      [401, ["claude-1"]],
    ]);
    await until(
      async () =>
        connectionOf(await w.accounts(macA, "claude-agent"))[0]?.connection?.status === "expired",
      30_000,
    );
    expect(connectionOf(await w.accounts(macA, "claude-agent"))[0]).toMatchObject({
      id: first.id,
      active: false,
      connection: { status: "expired" },
    });
    // From then on this Mac's Claude Agent runs on its own login again, never on a dead token.
    from = report.upstream.length;
    expect((await w.claudeTurn(macA)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({ issued: [], status: 200 }),
    ]);
    // The Cloud computer's next request tells Cloud, and every computer's list says expired from then on.
    await w.claudeTurn(cloudComputer);
    await until(
      async () => (await w.cloud.report()).people["user-1"]![0]!.status === "expired",
      30_000,
    );
    await until(
      async () =>
        connectionOf(await w.accounts(cloudComputer, "claude-agent"))[0]?.connection?.status ===
        "expired",
      30_000,
    );

    // Connecting again makes a connection that works at once; the dead one is removed from here, everywhere.
    await w.cloud.configure({ provider: {} });
    const [plan] = (await w.connectPlan(macA, "claude-agent")).accounts.filter(
      (a) => a.connection?.status === "ready",
    );
    const planId = plan!.id.replace(/^connection:/, "");
    await macA.client.call("engine.account.remove", {
      request_id: "r1",
      engine: "claude-agent",
      account_id: first.id,
    });
    expect(
      connectionOf(await w.accounts(macA, "claude-agent")).map((a) => [
        a.id,
        a.active,
        a.connection!.status,
      ]),
    ).toEqual([[plan!.id, true, "ready"]]);
    expect((await w.cloud.report()).people["user-1"]!.map((c) => c.id)).toEqual([planId]);

    // The person's own device adds an Anthropic key, second in their order.
    const key = (await (
      await asMe("", {
        method: "POST",
        body: JSON.stringify({
          kind: "api_key",
          provider: "anthropic",
          key: ("sk-" + "ant-api03-made-up-for-this-test-only"),
        }),
      })
    ).json()) as ModelConnection;
    await until(
      async () => connectionOf(await w.accounts(macA, "claude-agent")).length === 2,
      30_000,
    );
    await until(
      async () => connectionOf(await w.accounts(cloudComputer, "claude-agent")).length === 2,
      30_000,
    );
    expect(
      connectionOf(await w.accounts(macA, "claude-agent")).map((a) => [
        a.id,
        a.active,
        a.where,
        a.connection!.kind,
      ]),
    ).toEqual([
      [plan!.id, true, "everywhere", "claude_plan"],
      [`connection:${key.id}`, false, "everywhere", "api_key"],
    ]);

    // The plan runs out, as Anthropic says it: the chat moves to the next in the person's order, with one note.
    const resets = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 1000) * 1000).toISOString();
    await w.cloud.configure({ provider: { [planId]: { usedUpUntil: resets } } });
    const note = usedUpNote(
      {
        type: "used_up",
        session: "s",
        engine: "claude-agent",
        connection: {
          kind: "claude_plan",
          provider: "anthropic",
          label: "Claude plan",
        } as ModelConnection,
        until: resets,
        next: { kind: "api_key", provider: "anthropic", label: "anthropic" } as ModelConnection,
      },
      Date.now(),
    );
    expect(note).toMatch(
      /^Claude plan used up (?:until|for) .+\. Running on your Anthropic key\.$/,
    );
    report = await w.cloud.report();
    from = report.upstream.length;
    const onMac = await w.claudeTurn(macA);
    expect(onMac.said()).toContain(SAID);
    expect(onMac.notes()).toEqual([{ level: "info", title: note }]);
    report = await w.cloud.report();
    // The same request went out again on the key: the plan's token first (429), then the key.
    expect(w.upstream(report, "claude", from).map((seen) => [seen.status, seen.issued])).toEqual([
      [429, ["claude-2"]],
      [200, []],
    ]);
    // Said once: the next turn in that chat, and the list, just say where it stands.
    await onMac.turn();
    expect(onMac.notes()).toHaveLength(1);
    expect(
      connectionOf(await w.accounts(macA, "claude-agent")).map((a) => [
        a.id,
        a.active,
        a.connection!.status,
        a.connection!.used_up_until,
      ]),
    ).toEqual([
      [plan!.id, false, "used_up", resets],
      [`connection:${key.id}`, true, "ready", undefined],
    ]);
    // The same on the Cloud computer, in the same words.
    const onBox = await w.claudeTurn(cloudComputer);
    expect(onBox.said()).toContain(SAID);
    expect(onBox.notes()).toEqual(onMac.notes());

    // With nothing left, a chat that runs on the person's connections says in one note that its plan is used up and
    // until when, and asks before it spends Caveman credits: on the Mac as on the Cloud computer.
    expect((await asMe(`/${key.id}`, { method: "DELETE" })).status).toBe(204);
    await until(
      async () => connectionOf(await w.accounts(macA, "claude-agent")).length === 1,
      30_000,
    );
    await until(
      async () => connectionOf(await w.accounts(cloudComputer, "claude-agent")).length === 1,
      30_000,
    );
    const usedUp = (carriesOn: boolean) => ({
      level: "warning",
      ...nothingServesNote(
        {
          engine: "claude-agent",
          provider: undefined,
          why: {
            reason: "used_up",
            connection: {
              kind: "claude_plan",
              provider: "anthropic",
              label: "Claude plan",
            } as ModelConnection,
            until: resets,
          },
        },
        Date.now(),
        { carriesOn },
      ),
    });
    // The Mac says when it carries on; Cloud, which may sleep before then, says only until when.
    const [nothing, nothingInCloud] = [usedUp(true), usedUp(false)];
    expect(nothing.title).toMatch(/^Claude plan used up\. Carries on (?:at|in) .+\.$/);
    expect(nothingInCloud.title).toMatch(/^Claude plan used up (?:until|for) .+\.$/);
    await onMac.turn();
    expect(onMac.notes().slice(1)).toEqual([nothing]);
    await until(() => onMac.asks() === 1, 30_000);
    await onBox.turn();
    expect(onBox.notes().slice(1)).toEqual([nothingInCloud]);
    await until(() => onBox.asks() === 1, 30_000);
    // The person adds an Anthropic key again from their own device, and sends nothing: each chat that waited sends its
    // last message again by itself and the model answers, on the Mac as on the Cloud computer.
    const answers = (chat: { readonly said: () => string }) => chat.said().split(SAID).length - 1;
    const [onMacBefore, onBoxBefore] = [answers(onMac), answers(onBox)];
    const again = (await (
      await asMe("", {
        method: "POST",
        body: JSON.stringify({
          kind: "api_key",
          provider: "anthropic",
          key: ("sk-" + "ant-api03-made-up-for-this-test-again"),
        }),
      })
    ).json()) as ModelConnection;
    await until(
      () => answers(onMac) === onMacBefore + 1 && answers(onBox) === onBoxBefore + 1,
      90_000,
    );
    // Nothing more was said or asked for it: the note stands, and the one question closed unanswered.
    expect(onMac.notes().slice(1)).toEqual([nothing]);
    expect(onBox.notes().slice(1)).toEqual([nothingInCloud]);
    expect([onMac.asks(), onBox.asks()]).toEqual([1, 1]);
    // The key goes again, and with it everything that serves Claude Agent.
    expect((await asMe(`/${again.id}`, { method: "DELETE" })).status).toBe(204);
    await until(
      async () => connectionOf(await w.accounts(macA, "claude-agent")).length === 1,
      30_000,
    );
    await until(
      async () => connectionOf(await w.accounts(cloudComputer, "claude-agent")).length === 1,
      30_000,
    );
    // A new chat on the Mac starts on the next in its list, this Mac's own login, and says so in one line: never back
    // to another login in silence.
    report = await w.cloud.report();
    from = report.upstream.length;
    const ownLogin = await w.claudeTurn(macA);
    expect(ownLogin.said()).toContain(SAID);
    const onOwn = usedUpNote(
      {
        type: "used_up",
        session: "s",
        engine: "claude-agent",
        connection: {
          kind: "claude_plan",
          provider: "anthropic",
          label: "Claude plan",
        } as ModelConnection,
        until: resets,
        next: undefined,
        own: true,
      },
      Date.now(),
    );
    expect(onOwn).toMatch(/^Claude plan used up (?:until|for) .+\. Running on this Mac's login\.$/);
    expect(ownLogin.notes()).toEqual([{ level: "info", title: onOwn }]);
    expect(ownLogin.asks()).toBe(0);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({ issued: [], status: 200 }),
    ]);
    // Said once: that chat's next turn runs on the same login and says nothing more.
    await ownLogin.turn();
    expect(ownLogin.notes()).toHaveLength(1);

    // The kind switched off on this Caveman Cloud: listed as off, refused when connected, and this Mac's own login runs.
    await w.cloud.configure({ provider: {}, kinds: { claude_plan: { on: false } } });
    await until(async () => (await w.everywhere(macA, "claude-agent")) === "off", 30_000);
    expect(connectionOf(await w.accounts(macA, "claude-agent"))[0]).toMatchObject({
      active: false,
      connection: { off: true },
    });
    await expect(
      macA.client.call("engine.account.add", {
        request_id: "k1",
        engine: "claude-agent",
        everywhere: true,
      }),
    ).rejects.toMatchObject({
      error: { message: connectKindOff("claude-agent"), data: { reason: "unsupported" } },
    });
    expect(connectKindOff("claude-agent")).toBe(
      "Your admin turned Claude plans off. Claude Agent runs on this Mac's login.",
    );
    expect(connectKindOff("codex")).toBe(
      "Your admin turned ChatGPT plans off. Codex runs on this Mac's login.",
    );
    report = await w.cloud.report();
    from = report.upstream.length;
    expect((await w.claudeTurn(macA)).said()).toContain(SAID);
    report = await w.cloud.report();
    expect(w.upstream(report, "claude", from)).toEqual([
      expect.objectContaining({ issued: [], status: 200 }),
    ]);

    // Through all of it no token reached a file, a log or a transcript, and Cloud never answered with one.
    const { found } = w.leaks(report, [macA, cloudComputer, signedOut]);
    expect(found).toEqual([]);
    expect(report.answersWithIssued).toEqual([]);
  },
  600_000,
);

test.skipIf(process.platform === "win32")(
  "Claude's page cannot reach this Mac and shows a code: pasted, the runtime types it into claude and the plan is connected; anything else is refused",
  async () => {
    const w = await world({ pageCode: true });
    const mac = await w.mac("mac-paste", w.me);
    const added = await mac.client.call("engine.account.add", {
      request_id: "paste-add",
      engine: "claude-agent",
      everywhere: true,
    });
    // The page the app links to: claude's own fallback, which ends on a code, not on this Mac.
    const url = new URL(added.sign_in!.url!);
    expect(url.searchParams.get("code")).toBe("true");
    const state = url.searchParams.get("state")!;
    expect(await w.cloud.approve()).toBe(1);
    const complete = (callback_url: string, n: number) =>
      mac.client.call("engine.account.complete", {
        request_id: `paste-${n}`,
        engine: "claude-agent",
        account_id: "connecting",
        callback_url,
      });
    // Nothing a terminal would read as a command, and no token, is typed into claude.
    for (const [n, typed] of [
      "rm -rf ~",
      ("sk-" + "ant-oat01-not-a-page-code-0000000000000000000000"),
    ].entries())
      await expect(complete(typed, n)).rejects.toMatchObject({
        message:
          "That is not the code the sign-in page shows. Copy the whole code and paste it again.",
      });
    expect(connectionOf(await w.accounts(mac, "claude-agent"))).toEqual([]);
    // A code from an earlier sign-in: claude does not take it, says why, and starts over on a new page.
    const refused = await complete("page-code-0123456789#an-earlier-sign-in", 2);
    expect(refused).toMatchObject({
      waiting: true,
      refused:
        "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
    });
    const again = new URL(refused.url!);
    expect(again.searchParams.get("code")).toBe("true");
    expect(again.searchParams.get("state")).not.toBe(state);
    // The sign-in is still open, on the new page: another window asking is answered that one, and no CLI starts.
    const other = await mac.window().call("engine.account.add", {
      request_id: "paste-other-window",
      engine: "claude-agent",
      everywhere: true,
    });
    expect(other.sign_in?.url).toBe(refused.url);
    // The person signs in again on the new page, and its code is taken: claude prints its token, and the plan is
    // kept in Cloud for every computer.
    expect(await w.cloud.approve()).toBe(1);
    const done = await complete(`page-code-0123456789#${again.searchParams.get("state")}`, 3);
    expect(done.waiting).toBeUndefined();
    expect(connectionOf(done.accounts).map((a) => a.connection?.kind)).toEqual(["claude_plan"]);
    const runs = w.cliRuns().filter((run) => run.cli === "claude" && run.args[0] === "setup-token");
    expect(runs).toHaveLength(1);
    expect(w.leaks(await w.cloud.report(), [mac]).found).toEqual([]);
  },
  240_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud from before connections: Claude and ChatGPT are refused at once in plain words with no sign-in opened, and connect once Cloud has its routes",
  async () => {
    const w = await world();
    // Caveman Cloud up to v0.1.0-rc.41: every model-connections route is "No route matches this path."
    await w.cloud.configure({ knowsConnections: false });
    const mac = await w.mac("mac-older-cloud", w.me);
    const signIns = () =>
      w.cliRuns().filter((run) => run.args.includes("setup-token") || run.args.includes("login"));
    for (const engine of ["claude-agent", "codex"] as const) {
      const refused = await mac.client
        .call("engine.account.add", {
          request_id: `older-${engine}`,
          engine,
          everywhere: true,
          ...(engine === "codex" ? { chatgpt: true } : {}),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toMatchObject({ message: CLOUD_LACKS_CONNECTIONS });
      expect(String((refused as Error).message)).not.toContain("No route");
    }
    // Nobody was sent to a provider's page for a connection Cloud could not keep.
    expect(signIns()).toEqual([]);
    // Cloud updated: the same buttons connect both plans, with no restart here.
    await w.cloud.configure({ knowsConnections: true });
    for (const engine of ["claude-agent", "codex"] as const) {
      const { accounts } = await w.connectPlan(mac, engine);
      expect(connectionOf(accounts).map((a) => a.connection?.kind)).toEqual([
        engine === "codex" ? "chatgpt_plan" : "claude_plan",
      ]);
    }
    expect(signIns()).toHaveLength(2);
  },
  240_000,
);
