// Orchestrating across models on a Cloud computer whose person's credentials stay outside it (cloud-computers
// CONTRACT §2 to §4, SPEC §8): a lead on one engine with builders on others. A real runtime as the computer, its git
// in a tools container, GitHub behind Cloud's git proxy, the stand-in CLI as Claude Agent, Codex and the Caveman
// engine, and the stand-in Cloud's data plane. What it settles:
//
// - Each engine's launch stands on a connection of its own: Claude Agent's requests leave on the Claude plan, Codex's
// on the compact plan, the Caveman engine's on a provider's key, each named to the data plane
//   (`x-caveman-connection`). One running out says nothing of the others.
// - A plan belongs to an engine. One engine's plan running out stops that engine's builders alone, with one note
//   that names it; the lead's other builders go on, finish, and reach the lead.
// - The builders' work ends in one pull request, whichever engine wrote which branch, opened by Cloud's App: with the
//   builders beside their lead, and with one on a cell of its own (another computer under the rule, its branch taken
//   by the git proxy and fetched by the lead's computer).
// - A builder that cannot start says so to its lead: nothing waits for it forever.
import * as path from "node:path";

import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test, vi } from "vitest";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { EgressScrub } from "../secrets/EgressScrub.ts";
import { Builders, RESUME_TEXT } from "../session-protocol/builders.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, userTexts } from "./builders.kit.ts";
import {
  ANTHROPIC_KEY,
  CHATGPT_PLAN,
  CLAUDE_PLAN,
  everySystemKit,
  MONEY,
  OPENAI_KEY,
} from "./everySystem.kit.ts";
import { connectionsFor } from "./modelConnections.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { computer } = everySystemKit(cleanups);
const { startTools, githubWith, checkoutOf } = builderKit(cleanups);

const CODEX_MODEL = "gpt-5.5";
const OPEN_MODEL = "deepseek/deepseek-flash";
/** Each engine's own models, as its provider snapshot lists them on the computer. */
const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.succeed([
    {
      instanceId: "claudeAgent",
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: MODEL, name: MODEL, isDefault: true }],
    },
    {
      instanceId: "codex",
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: CODEX_MODEL, name: CODEX_MODEL, isDefault: true }],
    },
    {
      instanceId: "caveman",
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: OPEN_MODEL, name: OPEN_MODEL, isDefault: true }],
    },
  ]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"]);

/** One project computer under the rule, big enough to hold a lead and its builders, with a lead chat on Claude Agent. */
async function projectComputer(
  connections = [CLAUDE_PLAN, CHATGPT_PLAN, ANTHROPIC_KEY, OPENAI_KEY],
  options: {
    readonly leadModel?: string;
    readonly routesAuto?: Array<"claude-agent" | "codex">;
  } = {},
) {
  const inner = await startTestCloud();
  cleanups.push(inner.close);
  await startTools();
  process.env.CAVEMAN_COMPUTER_CPUS = "16";
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "64";
  cleanups.push(
    () => (
      delete process.env.CAVEMAN_COMPUTER_CPUS,
      delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
    ),
  );
  vi.spyOn(appProxy, "url").mockReturnValue(undefined);
  vi.spyOn(codexProxy, "url").mockReturnValue(undefined);
  inner.state.gitBackend = githubWith(
    makeRepo(tempRoot("every-system-tree-source-"), { "README.md": "widgets\n" }),
  );
  const there = await computer({
    inner,
    checkout: checkoutOf(inner.state.gitBackend, "every-system-tree-"),
    alsoAs: ["codex", "caveman"],
    provide: providers,
    connections,
    ...(options.routesAuto ? { routesAuto: options.routesAuto } : {}),
  });
  const builders = Context.get(
    there.runtime.context as unknown as Context.Context<Builders>,
    Builders,
  );
  const lead = await createReady(there.client, {
    request_id: "lead",
    repo: there.where,
    title: "Ship the widgets",
    engine: "claude-agent",
    options: { model: options.leadModel ?? MODEL },
  });
  const leadEvents: Array<SessionEvent> = [];
  await there.client.attach(lead.session_id, 0, (event) => leadEvents.push(event));
  /** What the lead's agent does with delegate_task (isolation worktree) and a target on another engine. */
  const delegate = (key: string, title: string, engine: string, model: string, task: string) =>
    Effect.runPromise(
      builders.start({
        parentThreadId: `caveman:${lead.id}`,
        task,
        title,
        requestKey: key,
        engine,
        model,
      }),
    );
  const chatOf = async (workspaceId: string) => {
    const workspace = await there.client.call("workspace.get", { workspace_id: workspaceId });
    const events: Array<SessionEvent> = [];
    await there.client.attach(workspace.session_id, 0, (event) => events.push(event));
    return { workspace, events };
  };
  const notes = () =>
    leadEvents.flatMap((event) =>
      event.type === "notification"
        ? [{ title: event.payload.title, body: event.payload.body }]
        : [],
    );
  // Every workspace.changed a client following the computer gets, by workspace: a builder's row follows these.
  const changed = new Map<string, Array<Workspace>>();
  there.client.on(
    "workspace.changed",
    (workspace) =>
      void (changed.get(workspace.id) ?? changed.set(workspace.id, []).get(workspace.id)!).push(
        workspace,
      ),
  );
  /** A builder's state as workspace.get has it, and as the last workspace.changed for it said. */
  const builderOf = async (workspaceId: string) =>
    (await there.client.call("workspace.get", { workspace_id: workspaceId })).builder;
  const lastChanged = (workspaceId: string) => changed.get(workspaceId)?.at(-1)?.builder;
  /** The states a builder's row went through, as workspace.changed said them, each once in a row. */
  const statesOf = (workspaceId: string) =>
    (changed.get(workspaceId) ?? [])
      .flatMap((w) => (w.builder === undefined ? [] : [w.builder.state]))
      .filter((state, i, all) => all[i - 1] !== state);
  return {
    ...there,
    inner,
    builders,
    lead,
    leadEvents,
    delegate,
    chatOf,
    notes,
    builderOf,
    lastChanged,
    statesOf,
  };
}

/** The user-role messages the runtime wrote for an agent: what the agent read, and the one line a person reads. */
const generatedOf = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((event) =>
    event.type === "message.done" &&
    event.payload.role === "user" &&
    event.payload.generated !== undefined
      ? [
          {
            text: event.payload.text,
            shown: event.payload.generated.shown,
            result: event.payload.builders_result,
          },
        ]
      : [],
  );

const done = (chat: { events: Array<SessionEvent> }) =>
  chat.events.filter((event) => event.type === "turn.done");

test.skipIf(process.platform === "win32")(
  "each engine's launch stands on a connection of its own, named to the data plane; one plan running out leaves the other engines' lanes alone",
  async () => {
    const tree = await projectComputer();
    const egress = Context.get(
      tree.runtime.context as unknown as Context.Context<EgressScrub>,
      EgressScrub,
    );
    // The computer's connections, as every launch on it reads them (made at the first one under the rule).
    const connections = (await connectionsFor(tree.info, tree.link))!;
    expect(connections).toBeDefined();
    // What each engine's launch holds on this computer: a stand-in that stands for its own connection, and no credential.
    const claude = await connections.launch("claude-agent", {});
    const codex = await connections.launch(
      "codex",
      { CODEX_HOME: tempRoot("every-system-codex-home-") },
      {
        files: {
          read: async () => undefined,
          write: async () => undefined,
          removeStandIn: async () => undefined,
        } as never,
      },
    );
    const keys = await connections.keys();
    expect("env" in claude && claude.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(
      /^sk-ant-oat01-caveman-stand-in-/,
    );
    expect("env" in codex).toBe(true);
    expect(keys.map((key) => key.provider).sort()).toEqual(["anthropic", "openai"]);
    // A request of each, as its CLI makes it through the computer's own scrub: the lane and the connection it names.
    const claudeToken = "env" in claude ? claude.env.CLAUDE_CODE_OAUTH_TOKEN! : "";
    const ask = (route: string, at: string, headers: Record<string, string>, body: unknown) =>
      fetch(`${egress.route(route)}${at}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const message = {
      model: MODEL,
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    expect(
      (
        await ask(
          "https://api.anthropic.com",
          "/v1/messages",
          { authorization: `Bearer ${claudeToken}` },
          message,
        )
      ).status,
    ).toBe(200);
    const openaiKey = keys.find((key) => key.provider === "openai")!.key;
    expect(
      (
        await ask(
          "https://api.openai.com/v1",
          "/chat/completions",
          { authorization: `Bearer ${openaiKey}` },
          { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hi" }] },
        )
      ).status,
    ).toBe(200);
    let report = await tree.cloud.report();
    expect(report.plane.map((seen) => [seen.lane, seen.named, seen.served, seen.status])).toEqual([
      ["claude", CLAUDE_PLAN.id, CLAUDE_PLAN.id, 200],
      ["key/openai", OPENAI_KEY.id, OPENAI_KEY.id, 200],
    ]);
    expect(
      report.upstream.map((seen) => [seen.credentials, seen.standIn, seen.runtimeToken]),
    ).toEqual([
      [["claudePlan"], false, false],
      [["openaiKey"], false, false],
    ]);
 // Codex's own connection is the compact plan, first in the person's order of those that serve it.
    expect((await connections.serving("codex")).map((connection) => connection.id)).toEqual([
      CHATGPT_PLAN.id,
      OPENAI_KEY.id,
    ]);
    expect((await connections.serving("claude-agent")).map((connection) => connection.id)).toEqual([
      CLAUDE_PLAN.id,
      ANTHROPIC_KEY.id,
    ]);

    // The Claude plan runs out: Claude Agent carries on with the next connection that serves it, and what serves Codex
    // and the Caveman engine's OpenAI models is what it was.
    await tree.cloud.configure({
      usedUpOnUse: { [CLAUDE_PLAN.id]: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(
      (
        await ask(
          "https://api.anthropic.com",
          "/v1/messages",
          { authorization: `Bearer ${claudeToken}` },
          message,
        )
      ).status,
    ).toBe(200);
    report = await tree.cloud.report();
    expect(report.plane.slice(2).map((seen) => [seen.lane, seen.named, seen.status])).toEqual([
      ["claude", CLAUDE_PLAN.id, 429],
      ["claude", ANTHROPIC_KEY.id, 200],
    ]);
    expect((await connections.serving("claude-agent")).map((connection) => connection.id)).toEqual([
      ANTHROPIC_KEY.id,
    ]);
    expect((await connections.serving("codex")).map((connection) => connection.id)).toEqual([
      CHATGPT_PLAN.id,
      OPENAI_KEY.id,
    ]);
    expect(report.closed).toEqual([]);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a Claude Agent lead with Codex and Caveman-engine builders ends in one pull request, whichever engine wrote which branch",
  async () => {
    const tree = await projectComputer();
    const work = (name: string) =>
      `sh: echo "${name}" > ${name}.txt && git add -A && git commit -qm "${name}: its file"\nsay: The ${name} builder wrote ${name}.txt.</note>`;
    const started = [
      await tree.delegate("k-codex", "Codex builder", "codex", CODEX_MODEL, work("codex")),
      await tree.delegate("k-open", "Open model builder", "caveman", OPEN_MODEL, work("open")),
      await tree.delegate("k-claude", "Claude builder", "claude-agent", MODEL, work("claude")),
    ];
    expect(started.map((builder) => [builder?.engine, builder?.where])).toEqual([
      ["codex", "here"],
      ["caveman", "here"],
      ["claude-agent", "here"],
    ]);
    // Each is a chat of its own on the engine and the model asked for, in a worktree on a branch of its own.
    const chats: Array<Workspace> = [];
    for (const builder of started)
      chats.push(await tree.client.call("workspace.get", { workspace_id: builder!.workspaceId }));
    expect(chats.map((chat) => chat.engine)).toEqual(["codex", "caveman", "claude-agent"]);
    expect(new Set(chats.map((chat) => chat.branch)).size).toBe(3);

    // They finish; the runtime merges each branch into the lead's and opens the pull request, once.
    const summary = () =>
      userTexts(tree.leadEvents).find((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    await until(() => summary() !== undefined, 180_000);
    const leadGit = gitIn(tree.repo);
    for (const name of ["codex", "open", "claude"])
      expect(leadGit("show", `${tree.lead.branch}:${name}.txt`)).toBe(name);
    expect(summary()).toContain(`3 of 3 branches are merged into ${tree.lead.branch}`);
    expect(tree.inner.state.automations.pullRequests).toHaveLength(1);
    const pr = tree.inner.state.automations.pullRequests[0]!;
    expect(pr).toMatchObject({
      session_id: tree.lead.session_id,
      repo: "acme/widgets",
      head: tree.lead.branch,
      base: "main",
    });
    expect(pr.sha).toBe(leadGit("rev-parse", tree.lead.branch));
    expect(
      gitIn(path.join(tree.inner.state.gitBackend!, "acme", "widgets.git"))(
        "rev-parse",
        `refs/heads/${tree.lead.branch}`,
      ),
    ).toBe(pr.sha);
    // A note per builder, the same for each engine; the engine is not what the pull request is about.
    for (const [title, name] of [
      ["Codex builder", "codex"],
      ["Open model builder", "open"],
      ["Claude builder", "claude"],
    ])
      (expect(pr.body).toContain(`**${title}**`),
        expect(pr.body).toContain(`The ${name} builder wrote ${name}.txt.`));
    expect(
      userTexts(tree.leadEvents).filter((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      ),
    ).toHaveLength(1);
    // Each builder's row, from the runtime: merged, in workspace.get, workspace.list and the workspace.changed clients follow.
    await until(
      async () =>
        (await Promise.all(started.map((builder) => tree.builderOf(builder!.workspaceId)))).every(
          (state) => state?.state === "merged",
        ),
      10_000,
    );
    for (const builder of started)
      expect(tree.lastChanged(builder!.workspaceId)).toEqual({ state: "merged" });
    const listed = (await tree.client.call("workspace.list", {})).workspaces;
    expect(
      started.map((builder) => listed.find((w) => w.id === builder!.workspaceId)?.builder),
    ).toEqual([{ state: "merged" }, { state: "merged" }, { state: "merged" }]);
    expect(listed.find((w) => w.id === tree.lead.id)?.builder).toBeUndefined();
    // Every message the runtime wrote for the lead's agent says so, with the one line a person reads; the agent's text is as it was.
    const generated = generatedOf(tree.leadEvents);
    expect(generated.map((g) => g.shown).sort()).toEqual([
      `3 of 3 merged · PR #${pr.number}`,
      "Claude builder finished",
      "Codex builder finished",
      "Open model builder finished",
    ]);
    const one = generated.find((g) => g.result !== undefined)!;
    expect(one.text).toBe(summary());
    expect(one.result).toEqual({
      total: 3,
      merged: 3,
      left_out: [],
      pull_requests: [
        { number: pr.number, url: `https://github.com/acme/widgets/pull/${pr.number}` },
      ],
    });
    expect(generated.find((g) => g.shown === "Codex builder finished")!.text).toMatch(
      /^\[Builder "Codex builder" finished its turn/,
    );
    // The rule held: nothing closed was asked for, and nothing left the caveman/ namespace.
    expect((await tree.cloud.report()).closed).toEqual([]);
    expect(tree.inner.state.gitRefused).toEqual([]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a builder whose branch conflicts is sent back with the files named, then left out by name: its row and the lead's one result say so",
  async () => {
    const tree = await projectComputer();
    const write = (name: string) =>
      `sh: echo "${name}" > shared.txt && git add -A && git commit -qm "${name}: shared"\nsay: The ${name} builder wrote shared.txt.</note>`;
    const first = await tree.delegate(
      "k-first",
      "First builder",
      "codex",
      CODEX_MODEL,
      write("first"),
    );
    const second = await tree.delegate(
      "k-second",
      "Second builder",
      "caveman",
      OPEN_MODEL,
      write("second"),
    );
    const secondChat = await tree.chatOf(second!.workspaceId);
    const summary = () =>
      userTexts(tree.leadEvents).find((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    await until(() => summary() !== undefined, 240_000);
    // Sent back twice, each time with one line a person reads; then left out, its row naming the file.
    const sentBack = generatedOf(secondChat.events).filter(
      (g) => g.shown === "Fix conflicts in shared.txt",
    );
    expect(sentBack).toHaveLength(2);
    expect(sentBack[0]!.text).toMatch(
      /^\[Caveman Code\] Your branch .+ does not merge into the lead's branch/,
    );
    expect(await tree.builderOf(first!.workspaceId)).toEqual({ state: "merged" });
    expect(await tree.builderOf(second!.workspaceId)).toEqual({
      state: "left_out",
      why: "conflicts in shared.txt",
    });
    expect(tree.lastChanged(second!.workspaceId)).toEqual({
      state: "left_out",
      why: "conflicts in shared.txt",
    });
    // Back at work while it fixed them: Working, Done, and so on, then Left out.
    expect(tree.statesOf(second!.workspaceId)).toEqual([
      "working",
      "done",
      "working",
      "done",
      "working",
      "done",
      "left_out",
    ]);
    // The lead's one result: the row, and the same as data.
    const pr = tree.inner.state.automations.pullRequests[0]!;
    const one = generatedOf(tree.leadEvents).find((g) => g.result !== undefined)!;
    expect(one.shown).toBe(`1 of 2 merged · 1 left out · PR #${pr.number}`);
    expect(one.result).toEqual({
      total: 2,
      merged: 1,
      left_out: [
        {
          workspace_id: second!.workspaceId,
          title: "Second builder",
          why: "conflicts in shared.txt",
        },
      ],
      pull_requests: [
        { number: pr.number, url: `https://github.com/acme/widgets/pull/${pr.number}` },
      ],
    });
    expect(one.text).toBe(summary());
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a Claude Agent lead with a Codex builder on a cell of its own and a Caveman-engine builder beside it: both computers under the rule, one pull request",
  async () => {
    const tree = await projectComputer();
    // A cell: another computer of the same project at the same Cloud, under the same rule, with the same connections.
    const cell = await computer({
      inner: tree.inner,
      cloud: tree.cloud,
      name: "cell",
      checkout: checkoutOf(tree.inner.state.gitBackend!, "every-system-cell-"),
      alsoAs: ["codex", "caveman"],
      provide: providers,
    });
    tree.inner.state.tree.nextComputers.push(cell.identity.computerId);
    const work = (name: string) =>
      `sh: echo "${name}" > ${name}.txt && git add -A && git commit -qm "${name}: its file"\nsay: The ${name} builder wrote ${name}.txt.</note>`;

    // The Codex builder goes to the cell (delegate_task's where: "cloud"); the open-model one stays beside its lead.
    const away = await Effect.runPromise(
      tree.builders.start({
        parentThreadId: `caveman:${tree.lead.id}`,
        task: work("codex"),
        title: "Codex builder",
        requestKey: "k-cell",
        engine: "codex",
        model: CODEX_MODEL,
        where: "cloud",
      }),
    );
    expect(away).toMatchObject({
      where: "cloud",
      computerId: cell.identity.computerId,
      engine: "codex",
    });
    const beside = await tree.delegate(
      "k-open",
      "Open model builder",
      "caveman",
      OPEN_MODEL,
      work("open"),
    );
    expect([beside?.engine, beside?.where]).toEqual(["caveman", "here"]);
    // Cloud's spawn names the engine and the model, and the cell runs the chat on them.
    expect(
      tree.inner.state.tree.spawns.map((spawn) => [
        spawn.body.engine,
        spawn.body.model,
        spawn.body.title,
      ]),
    ).toEqual([["codex", CODEX_MODEL, "Codex builder"]]);
    let hosted: Workspace | undefined;
    await until(async () => {
      hosted = (await cell.client.call("workspace.list", {})).workspaces.find(
        (workspace) => workspace.title === "Codex builder",
      );
      return hosted !== undefined;
    }, 60_000);
    expect(hosted).toMatchObject({ engine: "codex", base_ref: tree.lead.branch });
    const there: Array<SessionEvent> = [];
    await cell.client.attach(hosted!.session_id, 0, (event) => there.push(event));
    await until(() => there.some((event) => event.type === "turn.started"), 60_000);
    expect(there.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: CODEX_MODEL,
    });
    // Its row, on the computer that runs it: at work, then done. Whether it merged is its lead's to say (the one result).
    const rowThere = async () =>
      (await cell.client.call("workspace.get", { workspace_id: hosted!.id })).builder?.state;
    await until(async () => (await rowThere()) !== undefined, 30_000);
    expect(["working", "done"]).toContain(await rowThere());
    await until(async () => (await rowThere()) === "done", 120_000);

    // Both finish. The cell's branch went through the git proxy and is fetched by the lead's computer; one pull request.
    const summary = () =>
      userTexts(tree.leadEvents).find((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    await until(() => summary() !== undefined, 180_000);
    const leadGit = gitIn(tree.repo);
    for (const name of ["codex", "open"])
      expect(leadGit("show", `${tree.lead.branch}:${name}.txt`)).toBe(name);
    expect(summary()).toContain(`2 of 2 branches are merged into ${tree.lead.branch}`);
    expect(
      userTexts(tree.leadEvents).some(
        (text) =>
          text.includes('Builder "Codex builder" finished its turn') &&
          text.includes("on its own Cloud computer"),
      ),
    ).toBe(true);
    expect(tree.inner.state.automations.pullRequests).toHaveLength(1);
    const pr = tree.inner.state.automations.pullRequests[0]!;
    expect(pr).toMatchObject({
      session_id: tree.lead.session_id,
      repo: "acme/widgets",
      head: tree.lead.branch,
      base: "main",
    });
    for (const [title, name] of [
      ["Codex builder", "codex"],
      ["Open model builder", "open"],
    ])
      (expect(pr.body).toContain(`**${title}**`),
        expect(pr.body).toContain(`The ${name} builder wrote ${name}.txt.`));
    // The rule held on both computers: nothing closed was asked for, and nothing left the caveman/ namespace.
    expect((await tree.cloud.report()).closed).toEqual([]);
    expect(tree.inner.state.gitRefused).toEqual([]);
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "one engine's plan running out stops that engine's builders alone, with one note that names it; the others finish and reach the lead",
  async () => {
    const tree = await projectComputer();
    const RESET_S = 14;
    // A Claude Agent builder at work for a while, a Codex builder thinking, and a Codex builder whose plan refuses it.
    const claude = await tree.chatOf(
      (await tree.delegate(
        "k-claude",
        "Claude builder",
        "claude-agent",
        MODEL,
        "slow 7000: the claude builder is done",
      ))!.workspaceId,
    );
    const thinking = await tree.chatOf(
      (await tree.delegate("k-thinking", "Codex thinking", "codex", CODEX_MODEL, "hold: 120000"))!
        .workspaceId,
    );
    await until(
      () =>
        claude.events.some((event) => event.type === "turn.started") &&
        thinking.events.some((event) => event.type === "turn.started"),
      30_000,
    );
    expect(await tree.builderOf(thinking.workspace.id)).toEqual({ state: "working" });
    const refusedAt = Date.now();
    const refused = await tree.chatOf(
      (await tree.delegate(
        "k-refused",
        "Codex refused",
        "codex",
        CODEX_MODEL,
        `limit: ${RESET_S}`,
      ))!.workspaceId,
    );

    // ---- Codex's builders stop together: the refused one is paused, the other stopped at its next step.
    await until(() => done(thinking).length >= 1 && done(refused).length >= 1, 60_000);
    expect(done(refused)[0]!.payload).toMatchObject({
      status: "failed",
      failure: { class: "usage_limit" },
    });
    expect(done(thinking)[0]!.payload).toMatchObject({ status: "interrupted" });
    // ---- the Claude Agent builder was never stopped: it finishes its turn, and its result reaches the lead well
    // before Codex's window resets.
    await until(() => done(claude).length >= 1, 60_000);
    expect(done(claude)[0]!.payload).toMatchObject({ status: "completed" });
    await until(
      () =>
        userTexts(tree.leadEvents).some((text) =>
          text.startsWith('[Builder "Claude builder" finished its turn'),
        ),
      30_000,
    );
    expect(Date.now()).toBeLessThan(refusedAt + RESET_S * 1000);
    expect(generatedOf(tree.leadEvents).map((g) => g.shown)).toEqual(["Claude builder finished"]);
    // Its row: done, not yet brought together (the paused ones hold that back).
    expect(await tree.builderOf(claude.workspace.id)).toEqual({ state: "done" });
 // The Codex builders' rows: paused until the compact plan resets, in workspace.get and in what clients were told.
    for (const chat of [refused, thinking]) {
      await until(
        async () => (await tree.builderOf(chat.workspace.id))?.state === "paused",
        10_000,
      );
      const paused = (await tree.builderOf(chat.workspace.id))!;
      expect(paused).toMatchObject({ state: "paused", plan: "ChatGPT plan" });
      expect(Math.abs(Date.parse(paused.until!) - (refusedAt + RESET_S * 1000))).toBeLessThan(
        6_000,
      );
      expect(tree.lastChanged(chat.workspace.id)).toEqual(paused);
      // Not "Done": the chat is idle, the builder is not.
      expect(
        (await tree.client.call("workspace.get", { workspace_id: chat.workspace.id })).status,
      ).not.toBe("working");
    }
    expect(userTexts(claude.events)).not.toContain(RESUME_TEXT);

    // ---- one note on the lead, which names the engine and says what goes on. No amount of money.
    const usedUp = () => tree.notes().filter((note) => /is used up/.test(note.title));
    await until(() => usedUp().length >= 1, 10_000);
    expect(usedUp()).toHaveLength(1);
    // A computer whose clock is UTC (CI, every Cloud computer) names the zone: the time is not the person's.
    expect(usedUp()[0]!.title).toMatch(
      /^Your ChatGPT plan is used up until \d{1,2}:\d\d [AP]M(?: UTC)?\.$/,
    );
    expect(usedUp()[0]!.body).toBe(
      "Your agents on Codex pause and carry on then. The others keep working.",
    );
    expect(`${usedUp()[0]!.title} ${usedUp()[0]!.body}`).not.toMatch(MONEY);
    // Paused, each still holding its place: none failed, and no result of theirs went to the lead.
    expect(userTexts(tree.leadEvents).filter((text) => text.includes('[Builder "Codex'))).toEqual(
      [],
    );

    // ---- at the reset the Codex builders, and only they, are told to carry on.
    const resumed = (chat: { events: Array<SessionEvent> }) =>
      chat.events.find(
        (event) =>
          event.type === "message.done" &&
          event.payload.role === "user" &&
          event.payload.text === RESUME_TEXT,
      );
    await until(() => resumed(thinking) !== undefined && resumed(refused) !== undefined, 90_000);
    expect(Date.parse(resumed(refused)!.at)).toBeGreaterThanOrEqual(
      refusedAt + RESET_S * 1000 - 1_500,
    );
    expect(resumed(claude)).toBeUndefined();
    expect(usedUp()).toHaveLength(1);
    // The word to carry on says so: one line a person reads, the agent's text as it was.
    expect(
      generatedOf(refused.events)
        .filter((g) => g.text === RESUME_TEXT)
        .map((g) => g.shown),
    ).toEqual(["Carry on"]);
    // Back at work: no longer paused.
    for (const chat of [refused, thinking])
      await until(
        async () => (await tree.builderOf(chat.workspace.id))?.state !== "paused",
        30_000,
      );
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a builder that did not finish reads the same in its row and in its lead's one result: one wording, kept in one place",
  async () => {
    const tree = await projectComputer();
    const started = await tree.delegate(
      "k-stopped",
      "Stopped builder",
      "codex",
      CODEX_MODEL,
      "hold: 120000",
    );
    const builder = await tree.chatOf(started!.workspaceId);
    await until(() => builder.events.some((event) => event.type === "turn.started"), 60_000);
    // The person stops it in its own chat.
    await tree.client.call("turn.interrupt", {
      request_id: "stop-builder",
      session_id: builder.workspace.session_id,
    });
    await until(
      async () => (await tree.builderOf(started!.workspaceId))?.state === "failed",
      60_000,
    );
    const row = await tree.builderOf(started!.workspaceId);
    expect(row).toEqual({ state: "failed", why: "It was stopped." });
    // Its lead hears, answers, and then gets the one result, which says of it what its row says.
    await until(() => generatedOf(tree.leadEvents).some((g) => g.result !== undefined), 120_000);
    const result = generatedOf(tree.leadEvents).find((g) => g.result !== undefined)!;
    expect(result.result).toEqual({
      total: 1,
      merged: 0,
      left_out: [{ workspace_id: started!.workspaceId, title: "Stopped builder", why: row!.why }],
      pull_requests: [],
      problem: expect.any(String),
    });
    expect(result.shown).toBe("0 of 1 merged · 1 left out · no pull request");
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "a builder whose engine nothing connected can run tells its lead so; nothing waits for it forever",
  async () => {
 // The person connected compact only: Codex runs here, Claude Agent does not.
    const tree = await projectComputer([CHATGPT_PLAN]);
    const started = await tree.delegate(
      "k-claude",
      "Claude builder",
      "claude-agent",
      MODEL,
      "write the parser",
    );
    expect(started?.engine).toBe("claude-agent");
    const builder = await tree.chatOf(started!.workspaceId);
    // Its chat says what to connect, and where, in the product's words.
    await until(
      () => JSON.stringify(builder.events).includes("Claude isn't connected for Cloud."),
      60_000,
    );
    // And its lead hears that it could not do the work: a result, not silence.
    await until(
      () =>
        userTexts(tree.leadEvents).some((text) =>
          text.startsWith('[Builder "Claude builder" failed'),
        ),
      60_000,
    );
    const told = userTexts(tree.leadEvents).find((text) =>
      text.startsWith('[Builder "Claude builder" failed'),
    )!;
    expect(told).toContain("Claude isn't connected for Cloud.");
    expect((await Effect.runPromise(tree.builders.tree(`caveman:${tree.lead.id}`))).running).toBe(
      0,
    );
    // Its row: failed, with the chat's own sentence, never a driver's; the lead's line says it failed.
    expect(await tree.builderOf(started!.workspaceId)).toEqual({
      state: "failed",
      why: "Claude isn't connected for Cloud.",
    });
    expect(tree.lastChanged(started!.workspaceId)).toEqual({
      state: "failed",
      why: "Claude isn't connected for Cloud.",
    });
    expect(generatedOf(tree.leadEvents).find((g) => g.text === told)?.shown).toBe(
      "Claude builder failed",
    );
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a lead on Auto with builders on Auto, in a Cloud that routes it: every agent's requests carry Auto's model to the data plane, which picks, and the builders finish to their lead",
  async () => {
    const tree = await projectComputer([CLAUDE_PLAN, CHATGPT_PLAN], {
      leadModel: "caveman-auto",
      routesAuto: ["claude-agent", "codex"],
    });
    // The lead itself, on Auto: its turn goes out with Auto's model, and the provider answered as the routed one.
    const leadSeen: Array<SessionEvent> = [];
    await tree.client.attach(tree.lead.session_id, 0, (event) => leadSeen.push(event));
    await tree.client.call("turn.submit", {
      request_id: "lead-turn",
      session_id: tree.lead.session_id,
      kind: "followup",
      input: { text: "model: plan the widgets" },
    });
    await until(() => leadSeen.some((event) => event.type === "turn.done"), 60_000);
    expect(leadSeen.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: "caveman-auto",
    });
    // Builders on Auto, a Claude Agent one and a Codex one: each a chat of its own on Auto.
    const started = [
      await tree.delegate(
        "k-auto-claude",
        "Claude builder",
        "claude-agent",
        "caveman-auto",
        "model: write the parser",
      ),
      await tree.delegate(
        "k-auto-codex",
        "Codex builder",
        "codex",
        "caveman-auto",
        "model: write the tests",
      ),
    ];
    const chats = await Promise.all(started.map((builder) => tree.chatOf(builder!.workspaceId)));
    expect(chats.map((chat) => chat.workspace.engine)).toEqual(["claude-agent", "codex"]);
    for (const chat of chats) await until(() => done(chat).length >= 1, 120_000);
    for (const chat of chats)
      expect(chat.events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
        model: "caveman-auto",
      });
    // A first turn carries the computer's setup note before the task; the next one is the model call alone.
    for (const [i, chat] of chats.entries()) {
      await tree.client.call("turn.submit", {
        request_id: `builder-turn-${i}`,
        session_id: chat.workspace.session_id,
        kind: "followup",
        input: { text: `model: builder ${i}` },
      });
      await until(() => done(chat).length >= 2, 120_000);
      expect(
        chat.events
          .filter((event) => event.type === "message.done" && event.payload.role === "assistant")
          .at(-1)?.payload,
      ).toMatchObject({ text: "smoke ok: model said: answer from the provider" });
    }
    // Every one of the three went out on Auto's model and reached the provider on the one Cloud's router chose.
    const report = await tree.cloud.report();
    expect(report.routed.map((r) => [r.lane, r.model, r.fallback])).toEqual([
      ["claude", "claude-sonnet-5-5", false],
      ["claude", "claude-sonnet-5-5", false],
      ["claude", "claude-sonnet-5-5", false],
    ]);
    expect(report.upstream.filter((u) => u.method === "POST").map((u) => u.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
    ]);
    // The lead hears from its builders: a result, never silence.
    await until(
      () =>
        userTexts(tree.leadEvents).some((text) =>
          text.startsWith("[Caveman Code] Your builders have finished."),
        ),
      180_000,
    );
    // Nothing of the policy, and no money, in what the lead's chat shows a person.
    const shown = JSON.stringify(
      tree.leadEvents.filter(
        (event) =>
          ["notification", "ask.user", "error"].includes(event.type) ||
          (event.type === "message.done" && event.payload.role === "assistant"),
      ),
    );
    expect(shown).not.toMatch(MONEY);
    expect(shown).not.toMatch(/claude-sonnet-5-5|router|easy_turn|hard_turn/i);
    expect(report.closed).toEqual([]);
  },
  300_000,
);
