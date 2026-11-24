/**
 * Where the Caveman engine's tools run. Unset, on this computer (the SDK's local backend). On a
 * Cloud computer the runtime sets a backend that runs every shell command and file read or
 * write in the tools container, so the engine's tools never run beside the runtime's Cloud key.
 *
 * @module provider-caveman/server/execution
 */
import type { ExecutionBackend } from "@caveman-ai/agent/execution-backend";
import * as Context from "effect/Context";

export class CavemanExecutionBackend extends Context.Reference<ExecutionBackend | undefined>("caveman/provider-caveman/ExecutionBackend", {
  defaultValue: () => undefined,
}) {}

/** How a command the engine starts itself (a Space's stdio MCP server) becomes one that runs in the tools container. */
export type CavemanToolsLaunch = (command: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) => {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Added to the launched process's environment: how the command's env reaches tools without riding in argv. */
  readonly env: Readonly<Record<string, string>>;
};

/** A command running in the tools container: its end, and a way to end it (its whole process group). */
export interface CavemanToolsRun {
  /** The command's exit code (128 + a signal's number when a signal ended it), and whether stop() ended it. */
  readonly done: Promise<{ readonly code: number; readonly stopped: boolean }>;
  readonly stop: () => void;
}

/**
 * Starts `argv` in the tools container, in `cwd`, with `env` on top of tools' own environment, in a process group of
 * its own; stdout and stderr arrive as they are written. What the Caveman harness runs on (toolsEnv.ts): unlike the
 * backend's buffered exec, a command can keep running while the model reads what it printed so far.
 */
export type CavemanToolsStream = (
  request: { readonly argv: ReadonlyArray<string>; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly stdin?: Uint8Array },
  io: { readonly stdout: (chunk: Buffer) => void; readonly stderr: (chunk: Buffer) => void },
) => CavemanToolsRun;

/** Set beside CavemanExecutionBackend on a Cloud computer: the harness's commands and files go through it. */
export class CavemanToolsStreamRef extends Context.Reference<CavemanToolsStream | undefined>("caveman/provider-caveman/ToolsStream", {
  defaultValue: () => undefined,
}) {}

/**
 * Set beside CavemanExecutionBackend on a Cloud computer. With a backend and no launch, the
 * engine starts no stdio MCP server at all: it would run beside the runtime's Cloud key.
 */
export class CavemanToolsLauncher extends Context.Reference<CavemanToolsLaunch | undefined>("caveman/provider-caveman/ToolsLauncher", {
  defaultValue: () => undefined,
}) {}
