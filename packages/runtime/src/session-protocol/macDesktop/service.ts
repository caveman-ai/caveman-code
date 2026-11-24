// Computer use on a Mac (docs/): agents see and use the person's apps through
// Vercel's agent-desktop, in the background, the way Codex does. Accessibility first: an app's tree as an outline with
// a ref for everything the agent can act on, a screenshot only when it asks. Nothing moves the person's pointer or
// takes focus, and each chat has its own cursor on the screen, labelled with the chat, drawn over the apps it uses.
//
// The person decides, per app, the first time a chat touches it (an approval card: Always allow, Allow in this chat,
// Deny); Always is kept in Settings > Computer use. Terminals, password managers, Caveman Code itself and macOS
// security prompts are never available (apps.ts). One chat at a time acts in an app. A person who takes over a chat's
// screen (computer.control) pauses its agent there and gets the app brought forward. A chat's screen in the Computer
// tab is the app window its agent used last: computer.* (computer.ts) streams it through `screens` below.
//
// What this binds is the `desktop` tool. A chat that runs shell commands as the person (Full access) can reach the
// same accessibility APIs through its shell, as any program Caveman Code starts can once macOS allows it.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ComputerAccess, ComputerApp, SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import { toolsSocket } from "../../cloudLink/tools.ts";
import { DesktopError, type Shot } from "../desktop.ts";
import type { DraftEvent } from "../projector.ts";
import { makeRuntimeAsks, type AskResponse } from "../runtimeAsks.ts";
import type { ScreenChange, ScreenPointer, Screens } from "../screens.ts";
import * as Store from "../store.ts";
import type { WorkspaceRecord } from "../store.ts";
import { BLOCKED_LABELS, blockedReason, DOCK, NOTIFICATIONS, resolveApp, sameApp, type AppIdentity } from "./apps.ts";
import { findAgentDesktop, makeRunner, shrinkPng, toJpeg, type AgentDesktopBinary, type Envelope, type Runner } from "./cli.ts";
import { appArgument, batchResults, boundsIn, COMMANDS, errorText, impliedApp, refsIn, resultText, type Bounds } from "./commands.ts";
import { AGENT_COLOUR, CURSOR, CURSOR_HOTSPOT, POINTER, POINTER_HOTSPOT } from "./cursors.ts";

/** The runtime's own asks for computer use (an app's approval, macOS permission): ask.respond routes them here. */
export const COMPUTER_ASK_PREFIX = "computer:";
export const isComputerAsk = (askId: string) => askId.startsWith(COMPUTER_ASK_PREFIX);
/**
 * An app's approval answered with this option is kept in Settings (computer_use_apps) for every later chat on this
 * Mac: the runtime's owner's alone to give (ownerGate.ts).
 */
export const ALWAYS_ALLOW = "always";

/** One call of the `desktop` tool. */
export interface DesktopCall {
  readonly app?: string | undefined;
  readonly command?: string | undefined;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly steps?: ReadonlyArray<{ readonly command: string; readonly args?: Readonly<Record<string, unknown>> | undefined }> | undefined;
}

export interface DesktopAnswer {
  readonly text: string;
  /** The app the call touched, as macOS names it. */
  readonly app?: string;
  readonly screenshot?: Shot;
}

/** Why ask.respond refused an answer to one of these asks (handlers.ts maps it to a ProtocolError). */
export class ComputerAskError extends Schema.TaggedError<ComputerAskError>()("ComputerAskError", {
  reason: Schema.Literals(["not_found", "invalid_state", "invalid_params"]),
  message: Schema.String,
}) {}

export class MacDesktop extends Context.Service<
  MacDesktop,
  {
    /** computer.*: each chat's screen, the app window its agent used last. */
    readonly screens: Screens;
    /** One `desktop` call as `threadId`'s agent: asks the person first when it touches an app they haven't allowed. */
    readonly use: (threadId: string, call: DesktopCall) => Effect.Effect<DesktopAnswer, DesktopError>;
    /** ask.respond for a computer-use ask. */
    readonly respond: (record: WorkspaceRecord, askId: string, response: AskResponse) => Effect.Effect<void, ComputerAskError>;
  }
>()("caveman/session-protocol/MacDesktop") {}

const MAX_STEPS = 16;
/** Another chat acting in an app holds it this long after its last action. */
const LEASE_MS = 120_000;
/** How long a person has to allow the permission in System Settings once they opened it from the card. */
const GRANT_WAIT_MS = 180_000;
/** Frames: JPEG at most this wide. An agent's screenshot: PNG at most this on its long side. */
const FRAME_WIDTH = 1600;
const SHOT_EDGE = 1366;
const ENGINE_LABELS: Readonly<Record<string, string>> = { "claude-agent": "Claude Agent", codex: "Codex", caveman: "Caveman" };

type Permission = ComputerAccess["accessibility"];
interface Permissions {
  readonly accessibility: Permission;
  readonly screen_recording: Permission;
}

const fail = (reason: DesktopError["reason"], message: string) => Effect.fail(new DesktopError({ reason, message }));
const now = () => new Date().toISOString();
const appKey = (app: AppIdentity) => (app.bundleId ?? app.name).toLowerCase();
const toWire = (app: AppIdentity): ComputerApp => ({ name: app.name, ...(app.bundleId ? { bundle_id: app.bundleId } : {}) });
const agentId = (workspaceId: string) => `c${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

/** Each chat's cursor label: its title's first words, else its engine. */
const cursorLabel = (record: WorkspaceRecord) => {
  const title = record.workspace.title?.trim();
  return title && !/^new chat$/i.test(title) ? title.split(/\s+/).slice(0, 4).join(" ") : (ENGINE_LABELS[record.workspace.engine] ?? "Agent");
};

interface Snapshot {
  readonly workspaceId: string;
  readonly app: AppIdentity;
  readonly windowId?: string;
  /** The window's bounds in screen points, for the pointer's place in a frame. */
  readonly window?: Bounds;
}

/** Keeps a map from growing without end: the oldest entries go first. */
const capped = <K, V>(map: Map<K, V>, max: number) => {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
};

const make = (binary: AgentDesktopBinary) =>
  Effect.gen(function* () {
    const store = yield* Store.SessionStore;
    const config = yield* ServerConfig.ServerConfig;
    const runner: Runner = makeRunner(binary, path.join(config.stateDir, "agent-desktop"));
    const shots = fs.mkdtempSync(path.join(runner.home, "shots-"));
    const asks = makeRuntimeAsks(store);
    const changes = yield* PubSub.unbounded<ScreenChange>();
    const run = (args: ReadonlyArray<string>, timeoutMs?: number) => Effect.promise(() => runner.run(args, timeoutMs === undefined ? {} : { timeoutMs }));

    // ------------------------------------------------------------- permissions
    let cached: { readonly at: number; readonly value: Permissions } | undefined;
    const permissions = (maxAgeMs: number) =>
      Effect.gen(function* () {
        if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
        const envelope = yield* run(["permissions"], 10_000);
        const data = (envelope.data ?? {}) as Record<string, { state?: string } | undefined>;
        const state = (key: string): Permission => (data[key]?.state === "granted" ? "granted" : data[key]?.state === "denied" ? "denied" : "unknown");
        const value = { accessibility: state("accessibility"), screen_recording: state("screen_recording") };
        cached = { at: Date.now(), value };
        return value;
      });
    let version: string | undefined;
    const access: Effect.Effect<ComputerAccess> = Effect.gen(function* () {
      const granted = yield* permissions(2_000);
      if (version === undefined) {
        const envelope = yield* run(["version"], 10_000);
        version = (envelope.data as { version?: string } | undefined)?.version;
      }
      return { supported: true, ...granted, blocked: [...BLOCKED_LABELS], ...(version ? { version } : {}) };
    });
    /**
     * Shows the person where to allow Caveman Code. Under the desktop app (CAVEMAN_DESKTOP_GUIDE), its own guide panel
     * over System Settings (apps/desktop/src/computerGuide.ts), asked for through computer.guide; elsewhere
     * agent-desktop's.
     */
    const guide = (permission?: keyof Permissions) =>
      Effect.suspend(() => {
        cached = undefined;
        if (process.env.CAVEMAN_DESKTOP_GUIDE === "1") return PubSub.publish(changes, { type: "guide", ...(permission ? { permission } : {}) }).pipe(Effect.asVoid);
        return run(["permissions", "--guide"], 15_000).pipe(
          Effect.flatMap((envelope) => (envelope.ok ? Effect.void : fail("failed", envelope.error ? errorText(envelope.error) : "System Settings did not open"))),
        );
      });

    // ------------------------------------------------------------- settings
    interface Saved {
      computer_use?: boolean;
      computer_use_apps?: Array<ComputerApp>;
      [key: string]: unknown;
    }
    const saved = store.kvGet("settings").pipe(Effect.map((raw): Saved => (raw === undefined ? {} : (JSON.parse(raw) as Saved))));
    const settingsLock = yield* Semaphore.make(1);
    const allowAlways = (app: AppIdentity) =>
      settingsLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* saved;
          const apps = current.computer_use_apps ?? [];
          if (apps.some((entry) => sameApp(app, { name: entry.name, bundleId: entry.bundle_id }))) return;
          yield* store.kvSet("settings", JSON.stringify({ ...current, computer_use_apps: [...apps, toWire(app)] }));
        }),
      );

    // ------------------------------------------------------------- asks
    /**
     * Posts an approval in the chat and waits for the person's option, or undefined when nobody answered. With
     * `settles`, the runtime may answer it itself: when that finishes first, the ask closes with its option.
     */
    const ask = (record: WorkspaceRecord, payload: Extract<SessionEvent, { type: "ask.user" }>["payload"], settles?: { readonly when: Effect.Effect<void>; readonly option: string }) =>
      Effect.gen(function* () {
        const runId = yield* asks.runningTurn(record.internal.threadId);
        const askId = `${COMPUTER_ASK_PREFIX}${randomUUID()}`;
        // Subscribed before the ask is journaled, so its answer cannot slip past.
        const sub = yield* PubSub.subscribe(store.events);
        const draft = yield* asks.withState(record, (state) => {
          state.asks[askId] = "open";
          const event = { at: now(), type: "ask.user", item_id: askId, ...(runId ? { turn_id: runId } : {}), payload } as DraftEvent;
          return { value: event, drafts: [event] };
        });
        const posted = draft as { item_id?: string; turn_id?: string };
        const answered = Effect.gen(function* () {
          while (true) {
            const event = yield* PubSub.take(sub);
            if (event.type === "ask.resolved" && event.item_id === askId) return event;
          }
        });
        // The runtime's own answer goes through the journal like the person's, so the card shows it.
        const settled = settles === undefined ? Effect.never : settles.when.pipe(Effect.andThen(asks.close(record, posted, "answered", { kind: "approval", option_id: settles.option })), Effect.andThen(Effect.never));
        const resolved = yield* Effect.raceFirst(answered, settled).pipe(Effect.onInterrupt(() => asks.close(record, posted, "cancelled").pipe(Effect.asVoid)));
        const response = resolved.payload.response;
        return resolved.payload.outcome === "answered" && response?.kind === "approval" ? response.option_id : undefined;
      }).pipe(Effect.scoped);

    const respond = (record: WorkspaceRecord, askId: string, response: AskResponse) =>
      Effect.gen(function* () {
        const posted = yield* asks.askEvent(record.session.id, askId);
        if (posted === undefined || posted.payload.kind !== "approval") return yield* new ComputerAskError({ reason: "not_found", message: `no ask ${askId}` });
        if (response.kind !== "approval") return yield* new ComputerAskError({ reason: "invalid_params", message: "this ask takes an approval: one of its options" });
        if (!posted.payload.options.some((option) => option.id === response.option_id)) {
          return yield* new ComputerAskError({ reason: "invalid_params", message: `option_id must be one of ${posted.payload.options.map((option) => option.id).join(", ")}` });
        }
        if (!(yield* asks.close(record, posted, "answered", { kind: "approval", option_id: response.option_id }))) {
          const outcome = yield* asks.resolvedOutcome(record.session.id, askId);
          return yield* new ComputerAskError({ reason: "invalid_state", message: outcome === "cancelled" ? "this ask was cancelled (the turn stopped)" : "this ask was already answered" });
        }
      });

    // ------------------------------------------------------------- the person's decisions
    const allowed = new Map<string, Set<string>>();
    const denied = new Map<string, Set<string>>();
    const gates = new Map<string, Semaphore.Semaphore>();
    const gateOf = (workspaceId: string) => {
      let gate = gates.get(workspaceId);
      if (gate === undefined) gates.set(workspaceId, (gate = Semaphore.makeUnsafe(1)));
      return gate;
    };
    const engineOf = (record: WorkspaceRecord) => ENGINE_LABELS[record.workspace.engine] ?? "The agent";

    /**
     * Screen Recording the person turned on that this Caveman Code can't use yet: macOS applies it once the app that
     * holds it reopens, and until then reports it off. Kept so a chat isn't asked again on every screenshot.
     */
    let screenRecordingAwaitsReopen = false;
    const AWAITS_REOPEN =
      "The person turned on Screen Recording for Caveman Code, and macOS applies it once Caveman Code reopens. Until then work from snapshots, which read every app without it, and take no screenshots.";

    /** macOS lets Caveman Code do `kind`, or the person is asked to allow it in System Settings, and the call waits. */
    const ensurePermission = (record: WorkspaceRecord, kind: keyof Permissions) =>
      Effect.gen(function* () {
        if ((yield* permissions(60_000))[kind] === "granted") return;
        if ((yield* permissions(0))[kind] === "granted") {
          if (kind === "screen_recording") screenRecordingAwaitsReopen = false;
          return;
        }
        if (kind === "screen_recording" && screenRecordingAwaitsReopen) return yield* fail("unsupported", AWAITS_REOPEN);
        const what = kind === "accessibility" ? "Accessibility" : "Screen Recording";
        const option = yield* ask(record, {
          kind: "approval",
          title: kind === "accessibility" ? `Let ${engineOf(record)} use apps on this Mac?` : `Let ${engineOf(record)} see app windows on this Mac?`,
          detail:
            kind === "accessibility"
              ? `macOS asks you to allow Caveman Code under Privacy & Security > ${what} first. Agents then work in your apps in the background: they never move your pointer, and each app asks you once.`
              : `Screenshots and the Computer tab's view of an app need Caveman Code allowed under Privacy & Security > ${what}. Reading and using apps works without it.`,
          options: [
            { id: "open", label: "Open System Settings", decision: "allow" },
            { id: "later", label: "Not now", decision: "deny" },
          ],
        });
        if (option !== "open") return yield* fail("failed", `The person did not allow ${what} for Caveman Code${option === undefined ? " (nobody answered)" : ""}. Don't use the desktop tool again unless they ask.`);
        yield* guide(kind).pipe(Effect.ignore);
        // While they switch it on: a card they can answer, which the runtime answers itself the moment macOS agrees.
        const granted = Effect.gen(function* () {
          while ((yield* permissions(0))[kind] !== "granted") yield* Effect.sleep(1_500);
        });
        const waited = yield* ask(
          record,
          {
            kind: "approval",
            title: `Waiting for ${what}`,
            detail: `Switch on Caveman Code under Privacy & Security > ${what}. This goes on by itself once macOS says so; if it doesn't notice, tell it here.`,
            options: [
              { id: "added", label: "I added it", decision: "allow" },
              { id: "cancel", label: "Cancel", decision: "deny" },
            ],
          },
          { when: granted, option: "added" },
        ).pipe(Effect.timeoutOption(GRANT_WAIT_MS));
        if ((yield* permissions(0))[kind] === "granted") return;
        if (waited._tag === "Some" && waited.value === "added") {
          if (kind === "screen_recording") {
            screenRecordingAwaitsReopen = true;
            return yield* fail("unsupported", AWAITS_REOPEN);
          }
          return yield* fail("failed", "Accessibility still reads as off for Caveman Code. Ask the person to check that Caveman Code is switched on under Privacy & Security > Accessibility, then try again.");
        }
        return yield* fail("failed", `${what} is still off for Caveman Code: the person did not allow it in System Settings. Don't use the desktop tool again unless they ask.`);
      });

    /** The person allows `app` for this chat (Always, or this chat), or the call fails with why not. */
    const ensureAllowed = (record: WorkspaceRecord, app: AppIdentity) =>
      gateOf(record.workspace.id).withPermits(1)(
        Effect.gen(function* () {
          const why = blockedReason(app);
          if (why !== undefined) return yield* fail("invalid_params", `${app.name} is never available to agents: ${why}.`);
          const key = appKey(app);
          const workspaceId = record.workspace.id;
          if (allowed.get(workspaceId)?.has(key)) return;
          if (denied.get(workspaceId)?.has(key)) return yield* fail("failed", `The person did not allow ${app.name} in this chat. Don't use it unless they ask.`);
          const always = (yield* saved).computer_use_apps ?? [];
          if (always.some((entry) => sameApp(app, { name: entry.name, bundleId: entry.bundle_id }))) {
            allowed.set(workspaceId, (allowed.get(workspaceId) ?? new Set()).add(key));
            return;
          }
          const agent = engineOf(record);
          const reach =
            app.name === "Clipboard"
              ? "read and change what you copied"
              : app === NOTIFICATIONS
                ? "read your notifications"
                : `see what's in ${app.name}'s windows and click and type there`;
          const option = yield* ask(record, {
            kind: "approval",
            title: `Allow ${agent} to use ${app.name}?`,
            detail: `${agent} will ${reach}, in the background: it never moves your pointer, and Take over in the Computer tab pauses it.`,
            options: [
              { id: ALWAYS_ALLOW, label: "Always allow", decision: "allow" },
              { id: "chat", label: "Allow in this chat", decision: "allow" },
              { id: "deny", label: "Deny", decision: "deny" },
            ],
          });
          if (option === ALWAYS_ALLOW) yield* allowAlways(app);
          if (option === ALWAYS_ALLOW || option === "chat") {
            allowed.set(workspaceId, (allowed.get(workspaceId) ?? new Set()).add(key));
            return;
          }
          if (option === "deny") denied.set(workspaceId, (denied.get(workspaceId) ?? new Set()).add(key));
          return yield* fail("failed", option === "deny" ? `The person did not allow ${app.name}. Don't use it in this chat unless they ask.` : `Nobody answered whether you may use ${app.name}. Stop and wait for the next message.`);
        }),
      );

    // ------------------------------------------------------------- what the runtime saw
    const snapshots = new Map<string, Snapshot>();
    const refBounds = new Map<string, Bounds>();
    const windows = new Map<string, AppIdentity>();
    /** Each chat's screen: the app it used last, and its window. */
    const current = new Map<string, { readonly app: AppIdentity; readonly windowId?: string }>();
    const frameSize = new Map<string, { readonly width: number; readonly height: number }>();
    const leases = new Map<string, { readonly workspaceId: string; readonly title: string; readonly at: number }>();
    const holders = new Map<string, string>();

    // ------------------------------------------------------------- the cursor overlay
    let session: Promise<string | undefined> | undefined;
    const sessionId = () =>
      (session ??= runner.run(["session", "start", "--cursor", "--multi-agent", "--no-trace", "--name", "Caveman Code"], { timeoutMs: 15_000 }).then((envelope) =>
        envelope.ok ? (envelope.data as { session_id?: string } | undefined)?.session_id : undefined,
      ));
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const id = await session;
        if (id) await runner.run(["session", "end", id], { timeoutMs: 5_000 });
        await fs.promises.rm(shots, { recursive: true, force: true });
      }),
    );
    // The agents' cursor as files for agent-desktop: the dart in Caveman's green (scripts/agentDesktopCursors.ts).
    const cursorDir = path.join(runner.home, "cursors");
    fs.mkdirSync(cursorDir, { recursive: true });
    const image = { cursor: path.join(cursorDir, "agent-cursor.png"), pointer: path.join(cursorDir, "agent-pointer.png") };
    fs.writeFileSync(image.cursor, Buffer.from(CURSOR, "base64"));
    fs.writeFileSync(image.pointer, Buffer.from(POINTER, "base64"));
    const styled = new Set<string>();
    /** The global flags that give a chat its own cursor, styled once per chat. */
    const cursorFlags = (record: WorkspaceRecord) =>
      Effect.promise(async () => {
        const id = await sessionId();
        if (id === undefined) return [] as Array<string>;
        const agent = agentId(record.workspace.id);
        const flags = ["--session", id, "--agent-id", agent];
        if (!styled.has(agent)) {
          styled.add(agent);
          await runner.run(
            [
              ...flags,
              "cursor-overlay",
              "enable",
              "--label",
              cursorLabel(record),
              "--max-words",
              "4",
              "--accent",
              AGENT_COLOUR,
              "--image",
              image.cursor,
              "--hotspot",
              CURSOR_HOTSPOT,
              "--pointer-image",
              image.pointer,
              "--pointer-hotspot",
              POINTER_HOTSPOT,
            ],
            { timeoutMs: 10_000 },
          );
        }
        return flags;
      });

    // ------------------------------------------------------------- one call
    const planned = (workspaceId: string, call: DesktopCall) =>
      Effect.gen(function* () {
        const steps = call.steps ?? (call.command === undefined ? [] : [{ command: call.command, args: call.args }]);
        if (steps.length === 0) return yield* fail("invalid_params", "name a command (with its args), or steps: [{command, args}, …]");
        if (steps.length > MAX_STEPS) return yield* fail("invalid_params", `at most ${MAX_STEPS} steps in one call`);
        if (call.steps !== undefined && call.command !== undefined) return yield* fail("invalid_params", "give command or steps, not both");
        let app: AppIdentity | undefined = call.app?.trim() ? yield* Effect.promise(() => resolveApp(call.app!)) : undefined;
        let windowId: string | undefined;
        let needsApp = false;
        for (const step of steps) {
          const spec = COMMANDS[step.command];
          if (spec === undefined) return yield* fail("invalid_params", `${step.command} is not a desktop command. Commands: ${Object.keys(COMMANDS).join(", ")}.`);
          const args = step.args ?? {};
          for (const [argument, why] of Object.entries(spec.refuse ?? {})) {
            if (args[argument] !== undefined && args[argument] !== false) return yield* fail("invalid_params", `${step.command} without ${argument}: ${why}.`);
          }
          if ("session" in args || "agent_id" in args) return yield* fail("invalid_params", "the runtime keeps each chat's session and cursor: leave out session and agent_id");
          const implied = impliedApp(step.command, args);
          if (step.command === "screenshot" && steps.length > 1) return yield* fail("invalid_params", "a screenshot is a call of its own, not a step");
          if (implied !== undefined) {
            if (app !== undefined && !sameApp(app, implied)) return yield* fail("invalid_params", `${step.command} touches ${implied.name}, not ${app.name}: one app per call`);
            app = implied;
            continue;
          }
          for (const { ref, snapshot } of refsIn(args)) {
            const taken = snapshots.get(snapshot);
            if (taken === undefined || taken.workspaceId !== workspaceId) return yield* fail("invalid_params", `${ref} is not from a snapshot this chat took: snapshot the app again and use its refs`);
            if (app !== undefined && !sameApp(app, taken.app)) return yield* fail("invalid_params", `${ref} is in ${taken.app.name}, not ${app.name}: one app per call`);
            app = taken.app;
            windowId ??= taken.windowId;
          }
          const window = typeof args.window_id === "string" ? args.window_id : undefined;
          if (window !== undefined) {
            const owner = windows.get(window);
            if (owner === undefined) return yield* fail("invalid_params", `window ${window} is not one this chat listed: list-windows for the app first`);
            if (app !== undefined && !sameApp(app, owner)) return yield* fail("invalid_params", `window ${window} is ${owner.name}'s, not ${app.name}'s`);
            app = owner;
            windowId = window;
          }
          if (step.command === "snapshot" && args.surface === "dock") app = DOCK;
          if (spec.target === "app" || (spec.target === "ref" && refsIn(args).length === 0)) needsApp = true;
          // A wait on text, a window, a menu or an event reads an app: without one, whatever the person has in front.
          if (step.command === "wait" && args.element === undefined && ["text", "window", "menu", "menu_closed", "event"].some((key) => args[key] !== undefined && args[key] !== false)) needsApp = true;
        }
        if (needsApp && app === undefined) return yield* fail("invalid_params", "name the app this acts on: app, as macOS shows it (\"Safari\", \"System Settings\")");
        // Each entry as agent-desktop takes it: the app where the command takes one; snapshots the outline way.
        const entries = steps.map((step) => {
          const spec = COMMANDS[step.command]!;
          const args: Record<string, unknown> = { ...step.args };
          if (app !== undefined && (spec.target === "app" || (spec.target === "app-or-none" && call.app?.trim()))) Object.assign(args, appArgument(step.command, app, args));
          // A whole window: what can be acted on. A drill into one part (root): all of it, its text too, which is how an
          // agent reads a document, a field or a result.
          if (step.command === "snapshot") {
            args.interactive_only ??= args.root === undefined;
            args.compact ??= true;
            args.include_bounds = true;
          }
          return { command: step.command, args };
        });
        const looks = steps.every((step) => COMMANDS[step.command]!.looks);
        const wantsBounds = steps.map((step) => step.args?.include_bounds === true);
        return { app, windowId, entries, looks, wantsBounds };
      });

    /** What the runtime keeps from a result: snapshots and their refs' places, windows and their apps. */
    const learn = (workspaceId: string, app: AppIdentity | undefined, entry: { command: string; args: Record<string, unknown> }, data: unknown) => {
      const record = (data ?? {}) as Record<string, unknown>;
      if ((entry.command === "snapshot" || entry.command === "find") && typeof record.snapshot_id === "string" && app !== undefined) {
        const window = record.window as { id?: string } | undefined;
        const tree = record.tree as Parameters<typeof boundsIn>[0] | undefined;
        const found = tree ? boundsIn(tree) : undefined;
        const previous = snapshots.get(record.snapshot_id);
        const windowBounds = entry.args.root === undefined && found?.root !== undefined ? found.root : previous?.window;
        const windowId = window?.id ?? previous?.windowId;
        snapshots.set(record.snapshot_id, { workspaceId, app, ...(windowId ? { windowId } : {}), ...(windowBounds ? { window: windowBounds } : {}) });
        for (const [ref, bounds] of found?.refs ?? []) refBounds.set(ref, bounds);
        if (windowId) windows.set(windowId, app);
        capped(snapshots, 400);
        capped(refBounds, 20_000);
      }
      const listed = Array.isArray(data) ? data : Array.isArray(record.windows) ? record.windows : undefined;
      if (entry.command === "list-windows" && listed) {
        for (const window of listed as ReadonlyArray<{ id?: string; app_name?: string }>) {
          if (window.id) windows.set(window.id, app !== undefined && (!window.app_name || sameApp(app, { name: window.app_name })) ? app : { name: window.app_name ?? "an app" });
        }
      }
      const launched = record.window as { id?: string } | undefined;
      if (entry.command === "launch" && launched?.id && app !== undefined) windows.set(launched.id, app);
      capped(windows, 2_000);
    };

    /** Where the agent's pointer went in its window, for the live view: a ref's centre, as a fraction of the window. */
    const pointerOf = (entry: { command: string; args: Record<string, unknown> }): ScreenPointer | undefined => {
      const ref = typeof entry.args.ref_id === "string" ? entry.args.ref_id : undefined;
      const snapshot = ref === undefined ? undefined : snapshots.get(/^@([^:]+):/.exec(ref)?.[1] ?? "");
      const bounds = ref === undefined ? undefined : refBounds.get(ref);
      const window = snapshot?.window;
      if (!bounds || !window || window.width <= 0 || window.height <= 0) return undefined;
      const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
      const phase = entry.command === "type" || entry.command === "set-value" || entry.command === "clear" ? "type" : entry.command.startsWith("scroll") || entry.command === "focus" ? "move" : "click";
      return { fx: clamp((bounds.x + bounds.width / 2 - window.x) / window.width), fy: clamp((bounds.y + bounds.height / 2 - window.y) / window.height), phase };
    };

    /** An app window as a PNG file in `shots`, which the caller removes. */
    const windowPng = (app: AppIdentity, windowId: string | undefined) =>
      Effect.gen(function* () {
        const file = path.join(shots, `${randomUUID()}.png`);
        const envelope = yield* run(["screenshot", "--app", app.name, ...(windowId ? ["--window-id", windowId] : []), file], 20_000);
        if (!envelope.ok) {
          yield* Effect.promise(() => fs.promises.rm(file, { force: true }));
          if (envelope.error?.code === "PERM_DENIED") cached = undefined;
          return yield* fail(envelope.error?.code === "PERM_DENIED" ? "unsupported" : "failed", envelope.error ? errorText(envelope.error) : `no screenshot of ${app.name}`);
        }
        return file;
      });

    const use = (threadId: string, call: DesktopCall) =>
      Effect.gen(function* () {
        if ((yield* saved).computer_use === false) return yield* fail("unsupported", "The person turned computer use off (Settings > Computer use). Don't use the desktop tool unless they turn it on.");
        const record = yield* store.getByThread(threadId);
        if (record === undefined) return yield* fail("unsupported", "Computer use needs a chat whose person can allow each app; this thread has none.");
        const workspaceId = record.workspace.id;
        const plan = yield* planned(workspaceId, call);
        const { app } = plan;
        if (app !== undefined) {
          if (holders.has(workspaceId)) return yield* fail("user_in_control", `The person took over (Computer tab). Wait for them to hand it back, then snapshot ${app.name} again.`);
          if (!plan.looks) {
            const lease = leases.get(appKey(app));
            if (lease !== undefined && lease.workspaceId !== workspaceId && Date.now() - lease.at < LEASE_MS) {
              return yield* fail("user_in_control", `${app.name} is in use by another chat ("${lease.title}"). Use another app, or try again in a couple of minutes.`);
            }
          }
          yield* ensurePermission(record, "accessibility");
          yield* ensureAllowed(record, app);
        } else {
          yield* ensurePermission(record, "accessibility");
        }
        const screenshot = plan.entries.length === 1 && plan.entries[0]!.command === "screenshot";
        if (screenshot) yield* ensurePermission(record, "screen_recording");

        if (screenshot) {
          const args = plan.entries[0]!.args;
          const file = yield* windowPng(app!, typeof args.window_id === "string" ? args.window_id : plan.windowId);
          const png = yield* Effect.promise(() => shrinkPng(file, SHOT_EDGE)).pipe(Effect.ensuring(Effect.promise(() => fs.promises.rm(file, { force: true }))));
          if (png === undefined) return yield* fail("failed", `the screenshot of ${app!.name} was not a PNG`);
          return { text: `screenshot of ${app!.name} (${png.width}x${png.height}). It shows the window; act on refs from a snapshot.`, app: app!.name, screenshot: { mimeType: "image/png" as const, ...png } };
        }

        const flags = yield* cursorFlags(record);
        const envelope: Envelope = yield* run([...flags, "batch", JSON.stringify(plan.entries), "--stop-on-error", "--timeout-ms", "120000"], 130_000);
        const results = batchResults(envelope);
        if (results.some((result) => result.error?.code === "PERM_DENIED")) cached = undefined;
        results.forEach((result, index) => {
          const entry = plan.entries[index];
          if (result.ok && entry) learn(workspaceId, app, entry, result.data);
        });
        const text = results
          .map((result, index) => {
            const body = resultText(plan.entries[index]?.command ?? result.command, result, plan.wantsBounds[index] === true);
            return plan.entries.length === 1 ? body : `[${index + 1}] ${result.command}${result.execution && result.execution !== "completed" ? ` (${result.execution})` : ""}\n${body}`;
          })
          .join("\n\n");
        const skipped = plan.entries.length - results.length;

        // The chat's screen follows the app it used; acting there holds the app for this chat a while.
        if (app !== undefined && !app.pseudo && app !== DOCK && app !== NOTIFICATIONS && results.some((result) => result.ok)) {
          const used = plan.entries.flatMap((entry) => (typeof entry.args.ref_id === "string" ? [snapshots.get(/^@([^:]+):/.exec(entry.args.ref_id)?.[1] ?? "")?.windowId] : []));
          const windowId = used.find(Boolean) ?? plan.windowId ?? [...snapshots.values()].reverse().find((taken) => taken.workspaceId === workspaceId && sameApp(taken.app, app))?.windowId;
          const before = current.get(workspaceId);
          current.set(workspaceId, { app, ...(windowId ? { windowId } : {}) });
          if (!before || !sameApp(before.app, app)) frameSize.delete(workspaceId);
          if (!plan.looks) leases.set(appKey(app), { workspaceId, title: record.workspace.title ?? "a chat", at: Date.now() });
          const acted = [...plan.entries].reverse().find((entry) => !COMMANDS[entry.command]!.looks);
          const pointer = acted === undefined ? undefined : pointerOf(acted);
          yield* PubSub.publish(changes, { type: "acted", threadId, ...(pointer ? { pointer } : {}) });
        }
        return { text: skipped > 0 ? `${text}\n\n(${skipped} later step${skipped === 1 ? "" : "s"} not run: an earlier one failed)` : text, ...(app ? { app: app.name } : {}) };
      });

    // ------------------------------------------------------------- the Computer tab
    /** Brings a chat's app forward for the person: its window when known, else the app. */
    const bringForward = (screen: { readonly app: AppIdentity; readonly windowId?: string }) =>
      run(screen.windowId ? ["focus-window", "--window-id", screen.windowId] : ["launch", screen.app.bundleId ?? screen.app.name, "--activate", "--timeout", "5000"], 10_000);
    const screens: Screens = {
      available: Effect.void,
      screenOf: (workspaceId) => {
        const screen = current.get(workspaceId);
        return screen === undefined ? undefined : `${appKey(screen.app)}\0${screen.windowId ?? ""}`;
      },
      capture: (workspaceId) =>
        Effect.gen(function* () {
          const screen = current.get(workspaceId);
          if (screen === undefined) return yield* fail("failed", "this chat has used no app yet");
          const file = yield* windowPng(screen.app, screen.windowId);
          const jpeg = yield* Effect.promise(() => toJpeg(file, FRAME_WIDTH)).pipe(Effect.ensuring(Effect.promise(() => fs.promises.rm(file, { force: true }))));
          if (jpeg === undefined) return yield* fail("failed", `the frame of ${screen.app.name} did not convert`);
          frameSize.set(workspaceId, { width: jpeg.width, height: jpeg.height });
          return { mimeType: "image/jpeg" as const, data: jpeg.data, width: jpeg.width, height: jpeg.height };
        }),
      state: (workspaceId) => {
        const screen = current.get(workspaceId);
        const size = frameSize.get(workspaceId) ?? { width: 0, height: 0 };
        return { controller: holders.has(workspaceId) ? "user" : screen ? "agent" : "none", ...size, ...(screen ? { app: toWire(screen.app) } : {}) };
      },
      holder: (workspaceId) => holders.get(workspaceId),
      heldBy: (connectionId) => [...holders].filter(([, holder]) => holder === connectionId).map(([workspaceId]) => workspaceId),
      // The person uses their own mouse: taking over pauses the chat's agent here and brings its app forward.
      take: (workspaceId, connectionId) =>
        Effect.gen(function* () {
          holders.set(workspaceId, connectionId);
          const screen = current.get(workspaceId);
          if (screen) yield* bringForward(screen);
          yield* PubSub.publish(changes, { type: "state", workspaceId });
        }),
      release: (workspaceId) =>
        Effect.suspend(() => (holders.delete(workspaceId) ? PubSub.publish(changes, { type: "state", workspaceId }).pipe(Effect.asVoid) : Effect.void)),
      input: () => fail("unsupported", "On this Mac you use your own mouse and keyboard: Take over pauses the agent and brings its app forward."),
      gapMs: () => 1_000,
      changes,
      access,
      guide: guide(),
    };

    return MacDesktop.of({ screens, use, respond });
  });

/** Computer use on agent-desktop `binary` (tests run a stand-in). */
export const layerWith = (binary: AgentDesktopBinary) => Layer.effect(MacDesktop, make(binary)).pipe(Layer.provide(Store.layer));

/**
 * Computer use on this Mac: present on macOS with agent-desktop found, never on a Cloud computer (its desktop is
 * desktop.ts). Elsewhere the layer provides nothing, and the `desktop` tool is not offered.
 */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const binary = offered() ? findAgentDesktop() : undefined;
    return binary === undefined ? Layer.empty : layerWith(binary);
  }),
);

/**
 * Whether this runtime offers computer use here (the `desktop` tool): on macOS with agent-desktop found, never on a
 * Cloud computer. Engines that declare the tool themselves (the Caveman engine) ask this, as `layer` does.
 */
export const offered = () => process.platform === "darwin" && toolsSocket() === undefined && findAgentDesktop() !== undefined;
