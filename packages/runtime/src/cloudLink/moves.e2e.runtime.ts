// Test-only: one runtime process for moves.e2e.test.ts, the real runtime with
// the real Caveman engine on a scripted model (no network, no paid call), as
// This Mac (MOVES_ROLE=mac: enrolled with MOVES_BEARER) or as a Cloud
// computer's runtime (MOVES_ROLE=cloud: CAVEMAN_CLOUD_LINK_DIR and
// CAVEMAN_WORKSPACE_ROOT set, as the computers service sets them). Writes
// {url, token, stateDir} to MOVES_OUT once it serves, and runs until killed.
//
// The model answers each turn with every user message it was given, so a test
// sees whether the conversation it continues is the whole one; a Mac named
// MOVES_NAME ("Moves Mac" by default) says its name in place of its role
// ("heard: … (on Mac B)"). On This Mac a
// message containing "hang" never gets its answer: the turn runs until it is
// stopped. A message containing "slow" is answered after 8 s, on either. The
// runtime's note carrying on a stopped turn is answered at once, and a tool it
// lists as completed is not run again.
//
// A message containing "approve" makes the agent run a shell command first, which a chat that asks for approvals
// waits on the person for.
//
// "crash <tag>": 1.5 s in, the agent runs a shell command that adds a line to MOVES_EFFECTS and then kills this runtime
// (once per tag: a second run of it only adds its line), as a computer that dies right after a push. An agent told the
// command "may or may not have finished" does not run it again; one told nothing does. "burst <n>": n shell commands
// one after another. "peek": one file read.
//
// MOVES_AGENTS_KEY_FILE: a PEM file holding the Mac's agents key (the desktop app hands it over on fd 3, as
// macs.e2e.kit.ts startDesktopMac does with the whole runtime; here a test file stands in).
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, CavemanAdapterV2Driver, makeCavemanAdapterV2 } from "@caveman-app/provider-caveman/server";
import { createAssistantMessageEventStream, fauxModel, type AssistantMessage, type ModelContext } from "@caveman-app/provider-caveman/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeConfig, startRuntime } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { linkDirOf } from "./index.ts";

const role = process.env.MOVES_ROLE;
const out = process.env.MOVES_OUT!;

/**
 * The text of each user message in the conversation the model was given. The runtime's note carrying on a stopped
 * turn quotes what the person asked: when the conversation already holds that message (the engine kept it as the turn
 * was cut, as the Caveman harness does), the quote is the same message, heard once.
 */
const asked = (context: ModelContext) => {
  const heard: Array<string> = [];
  for (const m of context.messages) {
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    const words = /\b(?:ask|hang|slow|approve|crash|burst|peek)\b[^\n]*/i.exec(text)?.[0]?.trim();
    if (!words || (text.startsWith("[Caveman Code]") && heard.at(-1) === words)) continue;
    heard.push(words);
  }
  return heard;
};

const streamFn = ((model: { api: string; provider: string; id: string }, context: ModelContext, options?: { signal?: AbortSignal }) => {
  const heard = asked(context);
  // The runtime's own note carrying on a stopped turn ("[Caveman Code] ..."): a model told which tools already ran
  // does not run them again, and the turn it carries on is answered, never left hanging.
  const lastUser = context.messages.findLast((m) => m.role === "user");
  const lastText = lastUser === undefined ? "" : typeof lastUser.content === "string" ? lastUser.content : lastUser.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  const note = lastText.startsWith("[Caveman Code]");
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: `heard: ${heard.join(" | ")} (on ${process.env.MOVES_NAME ?? role})` }],
    api: model.api as never,
    provider: model.provider,
    model: model.id,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  // A model call made for a turn that was stopped ends at once with nothing said, as a real one does (the provider's
  // request is refused on its aborted signal): the turn's last word is never an answer that came after its stop.
  if (options?.signal?.aborted) {
    const cut: AssistantMessage = { ...message, content: [], stopReason: "aborted" };
    setTimeout(() => {
      stream.push({ type: "error", reason: "aborted", error: cut });
      stream.end(cut);
    }, 0);
    return stream;
  }
  /** One tool call as the model's whole answer, `after` ms in. */
  const call = (name: string, args: Record<string, unknown>, after = 200) => {
    const toolCall = { type: "toolCall" as const, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args as never };
    const asks: AssistantMessage = { ...message, content: [toolCall], stopReason: "toolUse" };
    setTimeout(() => {
      stream.push({ type: "start", partial: { ...asks, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: asks });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: asks });
      stream.push({ type: "done", reason: "toolUse", message: asks });
      stream.end(asks);
    }, after);
    return stream;
  };
  const last = heard.at(-1) ?? "";
  // The tool results since the person's last message (or the runtime's note): how far this turn got.
  const ranHere = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult").length;
  const effects = process.env.MOVES_EFFECTS ?? "/dev/null";
  const crash = /\bcrash (\w+)/i.exec(last);
  // Told the command may already have run, an agent checks and does not run it again.
  if (crash && ranHere === 0 && !(note && /may or may not have finished/.test(lastText)))
    return call("bash", { command: `echo ${role} >> '${effects}'; [ -e '${effects}.crashed-${crash[1]}' ] || { touch '${effects}.crashed-${crash[1]}'; kill -9 ${process.pid}; }` }, 1_500);
  const burst = /\bburst (\d+)/i.exec(last);
  if (burst && ranHere < Number(burst[1])) return call("bash", { command: `echo ${ranHere} >> '${effects}.burst'` }, 20);
  if (/\bpeek\b/i.test(last) && ranHere === 0) return call("read", { path: "README.md" }, 20);
  // "approve": one command first, which asks under Ask access; with MOVES_EFFECTS set, each run of it adds a line to
  // that file (outside the repository), so a test counts how often it ran. Once it ran, the turn answers as any other.
  if (/approve/i.test(heard.at(-1) ?? "") && context.messages.at(-1)?.role !== "toolResult" && !(note && /\(completed\)/.test(lastText))) {
    const command = process.env.MOVES_EFFECTS ? `echo ${role} >> '${process.env.MOVES_EFFECTS}'` : "echo approved";
    const toolCall = { type: "toolCall" as const, id: `call-${Date.now()}`, name: "bash", arguments: { command } as never };
    const asks: AssistantMessage = { ...message, content: [toolCall], stopReason: "toolUse" };
    setTimeout(() => {
      stream.push({ type: "start", partial: { ...asks, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: asks });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: asks });
      stream.push({ type: "done", reason: "toolUse", message: asks });
      stream.end(asks);
    }, 200);
    return stream;
  }
  const hang = role === "mac" && /hang/i.test(heard.at(-1) ?? "") && !note;
  // "slow": answered after 8 s, or after N s for "slow N".
  const slow = /slow/i.test(heard.at(-1) ?? "") ? Number(/slow (\d+)/i.exec(heard.at(-1) ?? "")?.[1] ?? 8) * 1000 : 0;
  setTimeout(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (hang) {
      // Like a real model call, it ends when the turn is stopped.
      const stop = () => {
        const aborted: AssistantMessage = { ...message, content: [], stopReason: "aborted" };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      if (options?.signal?.aborted) stop();
      else options?.signal?.addEventListener("abort", stop, { once: true });
      return;
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  }, slow || 200);
  return stream;
}) as never;

const agentsKey = process.env.MOVES_AGENTS_KEY_FILE ? fs.readFileSync(process.env.MOVES_AGENTS_KEY_FILE, "utf8") : undefined;
const config = { ...(await makeConfig()), ...(agentsKey === undefined ? {} : { agentsKey }) };
if (role === "mac") await enroll({ dir: linkDirOf(config.stateDir), cloudUrl: process.env.MOVES_CLOUD_URL!, bearer: process.env.MOVES_BEARER!, name: process.env.MOVES_NAME ?? "Moves Mac" });
const host = Layer.succeedContext(await Effect.runPromise(Effect.scoped(Layer.build(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))))));
const scripted: typeof CavemanAdapterV2Driver = {
  ...CavemanAdapterV2Driver,
  create: (input) =>
    makeCavemanAdapterV2({ instanceId: input.instanceId, settings: { ...input.config, enabled: input.enabled }, engine: { streamFn, model: fauxModel({ priced: true }) } }).pipe(Effect.orDie),
};
const registry = ProviderAdapterRegistry.layerFromDrivers({
  drivers: [scripted],
  configMap: { [ProviderInstanceId.make("caveman")]: { driver: CAVEMAN_PROVIDER, config: { optimization: "off" } } },
}).pipe(Layer.provide(Layer.mergeAll(host, IdAllocator.layer, NodeServices.layer)), Layer.orDie);
const runtime = await startRuntime(config, "fake-claude", undefined, { provide: host, registry });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ url: runtime.url, token: runtime.token(), stateDir: config.stateDir }));
setInterval(() => {}, 1 << 30);
