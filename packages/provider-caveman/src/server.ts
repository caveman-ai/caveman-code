// ), packages/provider-pi/src/server.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/**
 * The Caveman engine's server entry: the driver the runtime registers, the
 * adapter driver for orchestration-v2, and the key store the Settings screen
 * writes through.
 *
 * @module provider-caveman/server
 */
export { CavemanDriver, type CavemanDriverEnv } from "./server/driver.ts";
export {
  CAVEMAN_AUTO_MODEL,
  CREDITS_DEFAULT_MODEL,
  CAVEMAN_GATEWAY_URL,
  CAVEMAN_PROVIDER,
  CavemanAdapterV2Driver,
  CavemanProviderCapabilitiesV2,
  makeCavemanAdapterV2,
  resolveCavemanModel,
  type CavemanAdapterV2DriverEnv,
} from "./server/adapter.ts";
export {
  cavemanModels,
  cavemanSecrets,
  readCavemanKeys,
  setCavemanKey,
  storedSignIns,
  type CavemanCredential,
  type CavemanKeyProvider,
  type CavemanKeys,
} from "./server/credentials.ts";
export { CREDITS_GATEWAY_OVERRIDE, CREDITS_GATEWAY_URL, CREDITS_LIMIT_CODE, gatewayOf, HOSTED_GATEWAY_URL, parseCreditsModels, setCreditsModels } from "./server/credits.ts";
export { connectedModels, connectedSources, NOTHING_CONNECTED, type ConnectedKind, type ConnectedSource, type HarnessLogin } from "./server/connected.ts";
export { CavemanKeyTester, classifyProviderError, testCavemanCredential, type KeyTest } from "./server/keyTest.ts";
export { startProviderSignIn, type ProviderSignIn } from "./server/signIn.ts";
export {
  CREDITS_INFO,
  CUSTOM_PREFIX,
  FEATURED_PROVIDERS,
  LOCAL_PRESETS,
  MORE_PROVIDERS,
  isAddableProvider,
  listPriceUsd,
  isCustomProvider,
  KEY_SLOT,
  providerInfo,
  providerOrder,
  signInOf,
  slotProvider,
  type CavemanProviderInfo,
} from "./server/providers.ts";
export { cavemanSideText } from "./server/sideText.ts";
export { cavemanHarnessRoot, cavemanJournalRoot, cavemanRunCarries, cavemanSessionStartRoot, forgetCavemanThreads, readCavemanRun, writeCavemanRun } from "./server/journal.ts";
export { loadCavemanEngine } from "./server/engine.ts";
export { cheapCavemanModel } from "./server/rewriter.ts";
export { CavemanExecutionBackend, CavemanToolsLauncher, CavemanToolsStreamRef, type CavemanToolsLaunch, type CavemanToolsRun, type CavemanToolsStream } from "./server/execution.ts";
export { ToolsEnv } from "./server/toolsEnv.ts";
export { CavemanRuntimeToolsRef, type CavemanDirectTool, type CavemanRuntimeTools } from "./server/runtimeTools.ts";
export { makeCavemanRewriter } from "./server/rewriter.ts";
