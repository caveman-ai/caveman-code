// The real terminal manager on a PTY a test prints to, for tests that read terminals as a client does.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as PtyAdapter from "@caveman-app/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class FakePtyProcess implements PtyAdapter.PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(): () => void {
    return () => {};
  }
  /** What the program in the terminal prints. */
  print(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

export class FakePtyAdapter {
  readonly processes: Array<FakePtyProcess> = [];
  /** Holds the next spawn, and with it the thread's lock, from `spawning` until `release`. */
  hold:
    | { readonly spawning: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const hold = this.hold;
    this.hold = undefined;
    const spawned = Effect.sync(() => {
      const process = new FakePtyProcess(9000 + this.processes.length);
      this.processes.push(process);
      return process;
    });
    return hold === undefined
      ? spawned
      : Deferred.succeed(hold.spawning, undefined).pipe(
          Effect.andThen(Deferred.await(hold.release)),
          Effect.andThen(spawned),
        );
  }
}

/** A real TerminalManager whose terminals run on `pty`; scoped. */
export const terminalsOnFakePty = (
  options: { readonly historyLineLimit?: number; readonly historyByteLimit?: number } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fake-pty-terminals-" });
    const pty = new FakePtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(dir, "logs"),
      historyLineLimit: options.historyLineLimit ?? 100,
      ...(options.historyByteLimit === undefined
        ? {}
        : { historyByteLimit: options.historyByteLimit }),
      ptyAdapter: pty,
      processKillGraceMs: 1,
    });
    return { pty, manager, services: Context.make(TerminalManager.TerminalManager, manager) };
  }).pipe(
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );
