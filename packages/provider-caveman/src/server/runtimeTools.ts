/**
 * The runtime's tools the Caveman engine sees declared beside its surface instead of only from programs and exec
 * cells: the few that wait on another agent or a person, which a program's time limit would cut off, and the two that answer with a screenshot, which a
 * program can only print as text. The runtime owns their MCP servers and sets this.
 *
 * @module provider-caveman/server/runtimeTools
 */
import * as Context from "effect/Context";

/** One tool of a runtime server, declared to the engine (the server is the adapter's to name). */
export interface CavemanDirectTool {
  /** The server's own tool name. */
  readonly tool: string;
  readonly description: string;
  /** JSON Schema of the arguments, as the server lists them. */
  readonly input: Record<string, unknown>;
  /** How long one call waits for the server's answer. */
  readonly timeoutMs?: number;
}

export interface CavemanRuntimeTools {
  /** On the runtime's own server (caveman-code), declared whenever the thread has its credential. */
  readonly waiting: ReadonlyArray<CavemanDirectTool>;
  /** Grill mode: its own server, declared tools, and the skill the turn that enters it loads. Unset: no grill mode. */
  readonly grill?: {
    readonly server: string;
    /** Its endpoint beside the runtime's `/mcp`, on the same credential. */
    readonly endpoint: (runtimeEndpoint: string) => string;
    readonly tools: ReadonlyArray<CavemanDirectTool>;
    readonly skillPath: string;
    /** The text without the runtime's skill mention, or undefined when the turn loads no skill. */
    readonly takeSkillMention: (text: string) => string | undefined;
  };
  /** On the runtime's own server too: tools whose answer is an image. Unset: none. */
  readonly images?: {
    /** preview_snapshot, when the thread has browser tools. */
    readonly browser: ReadonlyArray<CavemanDirectTool>;
    /** computer, on a Cloud computer only: the list is fixed before the server answers. */
    readonly desktop: ReadonlyArray<CavemanDirectTool>;
    /** desktop, for a thread on this computer (no execution backend) where the runtime offers computer use on this Mac. */
    readonly local?: ReadonlyArray<CavemanDirectTool>;
  };
  /** A repo's setup chat: its own server and declared tools (environment_build), on that chat's thread only. */
  readonly setup?: {
    readonly server: string;
    readonly endpoint: (runtimeEndpoint: string) => string;
    readonly tools: ReadonlyArray<CavemanDirectTool>;
    readonly has: (threadId: string) => boolean;
  };
  /**
   * An agent file's custom tools (platform CONTRACT §3.5): the `client` server and the tools declared for that
   * thread only; none for a thread whose agent declares none. Each call waits for whoever drives the session.
   */
  readonly client?: {
    readonly server: string;
    readonly endpoint: (runtimeEndpoint: string) => string;
    readonly tools: (threadId: string) => ReadonlyArray<CavemanDirectTool>;
  };
  /** web_search and web_fetch (docs/): their own server and declared tools, for a credential with the `web` capability. */
  readonly web?: {
    readonly server: string;
    readonly endpoint: (runtimeEndpoint: string) => string;
    readonly tools: ReadonlyArray<CavemanDirectTool>;
  };
}

export class CavemanRuntimeToolsRef extends Context.Reference<CavemanRuntimeTools>("caveman/provider-caveman/RuntimeTools", {
  defaultValue: () => ({ waiting: [] }),
}) {}
