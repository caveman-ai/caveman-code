// ), apps/server/src/orchestration-v2/ThreadCommandExecutor.ts @ ab3a3cd1.
import type { ThreadId } from "@caveman-app/protocol";
import * as KeyedLock from "@caveman-app/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());
