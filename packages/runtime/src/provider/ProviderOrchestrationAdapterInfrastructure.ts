// ), apps/server/src/provider/ProviderOrchestrationAdapterInfrastructure.ts @ ab3a3cd1.
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "@caveman-app/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@caveman-app/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@caveman-app/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@caveman-app/engine-core/server/ProviderContinuationRequests";
import * as EngineEgress from "../secrets/EngineEgress.ts";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2;

/**
 * Infrastructure shared by the V2 adapters materialized inside provider
 * instances. `providerContinuationRequestsLayer` must be the same layer
 * reference the orchestration runtime provides to its continuation worker so
 * Effect layer memoization yields one shared queue.
 */
export const layer = Layer.mergeAll(
  // Claude Agent and Codex model traffic goes through the project-secrets egress
  // scrub; its EgressRoute stays in the output for the in-process Caveman engine.
  EngineEgress.layerEngines,
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
