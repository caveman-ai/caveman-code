/**
 * The Caveman engine for `caveman-runtime agent exec`: one agent, headless, on one model endpoint, without the app's
 * adapter, orchestration or key store, so the command starts fast. The engine is the app's: the Caveman harness, a
 * coding agent on the loadout its model was measured on and a general agent on the general loadout with only its own
 * tools (execSession.ts).
 *
 * @module provider-caveman/exec
 */
export { approvalKindFor, approvalPrompt } from "./server/approvals.ts";
export { defaultEffort, effortLevel } from "./server/engineConfig.ts";
export { openConnectorGate, parseConnectorsUrl, type ConnectorGate } from "./server/connectorGate.ts";
export { ENDPOINT_FAMILIES, ENDPOINT_PROVIDER, endpointFamily, execModel, familyAutoModel, familySlugs, parseBaseUrl, type EndpointFamily, type ExecModel } from "./server/execModels.ts";
export {
  EXEC_CLIENT_SERVER,
  openExecSession,
  reservedServerName,
  type ExecApprovalCall,
  type ExecCustomTool,
  type ExecDraft,
  type ExecSession,
  type ExecSessionOptions,
  type ExecShape,
  type ToolKind,
  type TurnOutcome,
} from "./server/execSession.ts";
