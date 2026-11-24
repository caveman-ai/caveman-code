/**
 * The plugins a thread's engine session starts with, projected per engine.
 * The runtime provides this from its PluginRegistry. Adapters read it with
 * `Effect.serviceOption` when they build launch options, so a host without it
 * runs sessions with no plugins. The first read for a thread snapshots its
 * plugins: a running session keeps what it started with.
 *
 * Every stdio server here already starts through the runtime's containing
 * launcher, and credentials in `env`/`headers` came from the broker. Pass
 * them to the engine over its config channel (stdin, RPC), never argv. For
 * Claude Agent that is `query.setMcpServers` (the Claude query runner does
 * it): the SDK's `mcpServers` option would become a `--mcp-config` argument.
 *
 * @module engine-core/server/SessionPlugins
 */
import type { ThreadId } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export type PluginMcpServer =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

type Pairs = ReadonlyArray<{ readonly name: string; readonly value: string }>;

/** ACP `session/new` mcpServers. */
export type AcpPluginMcpServer =
  | {
      readonly type: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Pairs;
    }
  | {
      readonly type: "http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: Pairs;
    };

/** Claude Agent SDK options to merge into the query options. */
export interface ClaudeAgentPluginOptions {
  readonly plugins: ReadonlyArray<{
    readonly type: "local";
    readonly path: string;
    readonly skipMcpDiscovery: true;
  }>;
  readonly mcpServers: Readonly<Record<string, PluginMcpServer>>;
  readonly settingSources: ReadonlyArray<"user" | "project" | "local">;
  /** Append to the system prompt. */
  readonly appendSystemPrompt: string;
  /** Permission deny rules (`Read(./secrets/**)`): the project's hidden paths. Absent or empty: none. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** Flag settings merged into the session's (memory: `autoMemoryDirectory` at the session's copy, auto-dream off). Absent: none. */
  readonly sdkSettings?: Readonly<Record<string, unknown>>;
  /** SDK hook callbacks by event, merged with the adapter's own (memory: PreToolUse, PostToolUse). Absent: none. */
  readonly hooks?: Readonly<Record<string, ReadonlyArray<unknown>>>;
}

/**
 * What the Caveman engine's brief calls the thread's memory copy: its file tools
 * map paths under it to the copy, so every chat on a repo sends the same bytes.
 */
export const MEMORY_ROOT = "/memory";

/** A write an engine reported under the thread's memory copy, by absolute path (memory/MemoryService.ts ingests it). */
export interface MemoryCopyWrite {
  readonly tool: "Edit" | "Write" | "fileChange" | "Delete";
  readonly path: string;
  readonly content?: string;
  readonly old_string?: string;
  readonly new_string?: string;
  readonly replace_all?: boolean;
  readonly diff?: string;
}

/**
 * Something the agent just did that memory may have notes about (memory/MemoryPush.ts): files it read
 * or changed (absolute paths), a command that failed, its context compacted, or the person's message.
 */
export type MemoryPushEvent =
  | { readonly kind: "files"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "failure"; readonly command: string; readonly output: string }
  | { readonly kind: "compact" }
  | { readonly kind: "prompt"; readonly text: string };

/** Codex per-thread overrides: `config` merges into `thread/start`'s config. */
export interface CodexPluginOptions {
  readonly config: {
    readonly mcp_servers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  readonly developerInstructions: string;
  /**
   * The plugins' skills. Codex loads only its own skill roots and ignores a `skill` input outside
   * them, so a `$name` mention of one of these carries its SKILL.md into the turn. Absent: none.
   */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  /** The thread's memory copy: a writable root (none for a subagent, which only reads it), and each file change under it handed back as it completes. Absent: no memory. */
  readonly memory?: {
    readonly writableRoot?: string;
    readonly onFileChange: (changes: ReadonlyArray<{ readonly path: string; readonly kind: string; readonly diff: string }>) => void | Promise<void>;
    /** Notes for what Codex just did, as text to steer into its turn (or put back after a compaction); undefined: none. */
    readonly push: (event: MemoryPushEvent) => Promise<string | undefined>;
  };
  /**
   * Trusted plugins' SessionStart hooks run for a compaction (`source: "compact"`, as Claude Code runs them after its
   * own): their text, to put back once Codex compacted the thread's context; undefined: none. Absent: no plugin has
   * SessionStart hooks the runtime runs.
   */
  readonly afterCompaction?: () => Promise<string | undefined>;
}

/** One titled block of instructions; the Caveman engine renders it as `# title`, then the text. */
export interface InstructionSection {
  /** One line naming the source: `AGENTS.md`, `Team rules`, `Caveman Code`. */
  readonly title: string;
  readonly text: string;
}

/**
 * How a session came to start, as Claude Code tells a SessionStart hook (`source`, and what its matcher tests): a new
 * thread, one that exists already loaded again (a new session, a fork), or its context compacted.
 */
export type SessionStartSource = "startup" | "resume" | "compact";

/**
 * The runtime's hook set for an engine that has none of its own (the Caveman
 * engine): trusted plugins' PreToolUse, PostToolUse, SessionStart and Stop
 * command hooks in Claude Code's protocol. Tool names are Claude's (`Bash`,
 * `Read`, `Edit`, `Write`, `Grep`, `mcp__<server>__<tool>`), so one plugin's
 * matchers mean the same in every engine.
 */
export interface RuntimeHooks {
  /** A reason to refuse the call, or undefined to let it run. `signal`: the call was stopped; running hooks end then. */
  readonly preToolUse: (tool: string, input: unknown, signal?: AbortSignal) => Promise<string | undefined>;
  /** Text for the model about the result, or undefined. */
  readonly postToolUse: (tool: string, input: unknown, output: unknown) => Promise<string | undefined>;
  /** Context to add as the session starts, or after its context was compacted; undefined: none. Only hooks whose matcher takes `source` run. */
  readonly sessionStart: (source: SessionStartSource) => Promise<string | undefined>;
  /** A reason to keep working instead of ending the turn, or undefined. `again`: this turn already continued once. */
  readonly stop: (again: boolean) => Promise<string | undefined>;
  /** Before a person's prompt goes to the model: a reason to refuse it, or context to send with it. Absent: none. */
  readonly userPromptSubmit?: (prompt: string) => Promise<{ readonly block?: string; readonly context?: string }>;
  /** After a tool call failed: text for the model about the failure, or undefined. Absent: none. */
  readonly postToolUseFailure?: (tool: string, input: unknown, error: string) => Promise<string | undefined>;
}

/**
 * A trusted plugin's UserPromptSubmit hook refused the prompt. Its reason is what the person sees,
 * as Claude Code shows it (failure.ts lets this one through; other provider text stays hidden).
 */
export class HookBlockedPrompt extends Schema.TaggedError<HookBlockedPrompt>()("HookBlockedPrompt", { reason: Schema.String }) {
  override get message(): string {
    return `A plugin's hook stopped this message: ${this.reason}`;
  }
}

/** What the Caveman engine gets from the thread's spaces and repository. */
export interface CavemanPluginOptions {
  /** Space MCP servers, keyed `<plugin>__<server>`; the engine calls them from its code tool. */
  readonly mcpServers: Readonly<Record<string, PluginMcpServer>>;
  /**
   * Keys of `mcpServers` only the runtime's MCP hub can reach (they sign in
   * with runtime-held tokens): without a runtime MCP credential they are left
   * out. With one, every server goes through the hub (`mcpHubUrl`).
   */
  readonly hubOnly?: ReadonlyArray<string>;
  /** Directories holding Space skills (`<skill>/SKILL.md`), loaded as the engine's agent environment. */
  readonly skillRoots: ReadonlyArray<string>;
  /**
   * Its instructions in cache-stable order: the repository's AGENTS.md (or
   * CLAUDE.md), team rules, the runtime's own (project instructions,
   * attribution, hidden paths), then extra sources such as a memory brief.
   */
  readonly instructionSections: ReadonlyArray<InstructionSection>;
  /**
   * The thread's memory copy: the one directory outside the workspace its file tools may reach; each write there is
   * handed back, and onWrite says why it was not saved when it wasn't. No onWrite: read-only (a subagent). Absent: no memory.
   */
  readonly memory?: { readonly dir: string; readonly onWrite?: (write: MemoryCopyWrite) => string | undefined };
  /** The runtime's hook set; absent when no trusted plugin has hooks. */
  readonly hooks?: RuntimeHooks;
}

export class SessionPlugins extends Context.Service<
  SessionPlugins,
  {
    readonly acp: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<AcpPluginMcpServer>>;
    readonly claudeAgent: (threadId: ThreadId) => Effect.Effect<ClaudeAgentPluginOptions>;
    /** `source`: how the thread loads into Codex (thread/start, or thread/resume and thread/fork), for its SessionStart hooks. */
    readonly codex: (threadId: ThreadId, source: Exclude<SessionStartSource, "compact">) => Effect.Effect<CodexPluginOptions>;
    /** The Caveman engine's projection; `cwd` is where its repository instructions are read. Absent: nothing is added. */
    readonly caveman?: (threadId: ThreadId, cwd: string) => Effect.Effect<CavemanPluginOptions>;
    /**
     * Variables the thread's tool processes get on top of what the engine
     * already passes them: its workspace's CAVEMAN_PORT_* and computer.toml
     * [env]. Only those, never the runtime's own environment. Absent or
     * empty: nothing is added.
     */
    readonly env?: (threadId: ThreadId) => Effect.Effect<Readonly<Record<string, string>>>;
    /**
     * The repository secrets of the thread's project, plaintext, for the engine
     * process itself (never a plugin process), and only for an engine whose
     * model traffic goes through the egress scrub (EgressRoute). `cwd` is the
     * thread's working directory, used when its project is not known. Absent
     * or empty: the repository has none.
     */
    readonly secretEnv?: (
      threadId: ThreadId,
      cwd: string | undefined,
    ) => Effect.Effect<Readonly<Record<string, string>>, unknown>;
    /**
     * Text the runtime adds to the engine's own instructions for the thread
     * (Caveman's commit attribution). `claudeAgent`, `codex` and `caveman`
     * already carry it. Absent or empty: nothing is added.
     */
    readonly instructions?: (threadId: ThreadId) => Effect.Effect<string>;
    /**
     * The thread's hidden paths (Settings > Projects plus the checkout's
     * committed .cavemanignore), gitignore lines relative to the checkout's
     * top level, for engines that enforce them in their own file tools.
     * Absent or empty: nothing is hidden.
     */
    readonly hiddenPaths?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@caveman-app/engine-core/server/SessionPlugins") {}
