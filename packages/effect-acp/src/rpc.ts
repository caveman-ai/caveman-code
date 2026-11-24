// Ported from T3 Code (MIT), packages/effect-acp/src/rpc.ts @ ab3a3cd1.
import * as AcpCompat from "./compat.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { defaultOnError, skipInvalidItems } from "./_internal/deserialize.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";

export const V1_AGENT_METHODS = {
  authenticate: "authenticate",
  logout: "logout",
  session_load: "session/load",
  session_set_model: "session/set_model",
  session_set_mode: "session/set_mode",
} as const;

export const V1_CLIENT_METHODS = {
  session_elicitation: "session/elicitation",
  unstable_session_elicitation: "_session/elicitation",
  session_elicitation_complete: "session/elicitation/complete",
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
  terminal_create: "terminal/create",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit",
  terminal_kill: "terminal/kill",
} as const;

const InitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: AcpSchema.InitializeResponse,
  error: AcpSchema.Error,
});

const LoginRpc = Rpc.make(AGENT_METHODS.auth_login, {
  payload: AcpSchema.LoginAuthRequest,
  success: AcpSchema.LoginAuthResponse,
  error: AcpSchema.Error,
});

const LogoutRpc = Rpc.make(AGENT_METHODS.auth_logout, {
  payload: AcpSchema.LogoutAuthRequest,
  success: AcpSchema.LogoutAuthResponse,
  error: AcpSchema.Error,
});

const NewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: AcpSchema.NewSessionResponse,
  error: AcpSchema.Error,
});

const ListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: AcpSchema.ListSessionsRequest,
  success: AcpSchema.ListSessionsResponse,
  error: AcpSchema.Error,
});

const ForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: AcpSchema.ForkSessionRequest,
  success: AcpSchema.ForkSessionResponse,
  error: AcpSchema.Error,
});

const ResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: AcpSchema.ResumeSessionRequest,
  success: AcpSchema.ResumeSessionResponse,
  error: AcpSchema.Error,
});

const CloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: AcpSchema.CloseSessionRequest,
  success: AcpSchema.CloseSessionResponse,
  error: AcpSchema.Error,
});

const DeleteSessionRpc = Rpc.make(AGENT_METHODS.session_delete, {
  payload: AcpSchema.DeleteSessionRequest,
  success: AcpSchema.DeleteSessionResponse,
  error: AcpSchema.Error,
});

const ListProvidersRpc = Rpc.make(AGENT_METHODS.providers_list, {
  payload: AcpSchema.ListProvidersRequest,
  success: AcpSchema.ListProvidersResponse,
  error: AcpSchema.Error,
});

const SetProviderRpc = Rpc.make(AGENT_METHODS.providers_set, {
  payload: AcpSchema.SetProviderRequest,
  success: AcpSchema.SetProviderResponse,
  error: AcpSchema.Error,
});

const DisableProviderRpc = Rpc.make(AGENT_METHODS.providers_disable, {
  payload: AcpSchema.DisableProviderRequest,
  success: AcpSchema.DisableProviderResponse,
  error: AcpSchema.Error,
});

const PromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
  error: AcpSchema.Error,
});

const SetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
  error: AcpSchema.Error,
});

const RequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const ElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  payload: AcpSchema.CreateElicitationRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  LoginRpc,
  LogoutRpc,
  NewSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  DeleteSessionRpc,
  ListProvidersRpc,
  SetProviderRpc,
  DisableProviderRpc,
  PromptRpc,
  SetSessionConfigOptionRpc,
);

// v1 schemas before 1.21.0 had env_var auth methods (this is 1.20.0's
// AuthMethodEnvVar and AuthEnvVar), and agents on those SDKs still send them.
// The pinned v1 AuthMethod reads one as an agent method without its variables,
// so the client would send its ID to authenticate instead of asking for a key.
const LegacyAuthEnvVar = Schema.Struct({
  name: Schema.String,
  label: Schema.optionalKey(defaultOnError(Schema.NullOr(Schema.String))),
  secret: Schema.optionalKey(defaultOnError(Schema.Boolean)),
  optional: Schema.optionalKey(defaultOnError(Schema.Boolean)),
  _meta: AcpSchemaV1.AuthMethodAgent.fields._meta,
});

const LegacyAuthMethodEnvVar = Schema.Struct({
  type: Schema.Literal("env_var"),
  ...AcpSchemaV1.AuthMethodAgent.fields,
  vars: defaultOnError(skipInvalidItems(LegacyAuthEnvVar), () => []),
  link: Schema.optionalKey(defaultOnError(Schema.NullOr(Schema.String))),
});

// Registry agents transition independently. The compatibility groups accept
// both protocol generations on the wire while the public client normalizes
// them into one provider-neutral surface after initialize negotiates v1 or v2.
//
// A peer's replies reach the caller undecoded and callRpc decodes them. Effect's
// RpcClient decodes a reply under Effect.orDie, so a malformed one would be a
// defect rather than an AcpError, and its JSON codec first matches the reply
// strictly against the success schema's encoded side, where ACP's
// default-on-error and skip-invalid-items rules do not run and a union keeps
// only the keys of the member it matched. Decoding in callRpc also lets the
// client pick the schema of the generation initialize negotiated, where a union
// of both would let one generation's lenient member take the other's reply.

/** The v2 or v1 initialize reply; the client negotiates v2 when it carries `info`. */
export const CompatInitializeResponse = Schema.Union([
  AcpSchema.InitializeResponse,
  // A v2 reply that breaks the v2 schema must fail here; as v1 it would lose
  // `info` and its capabilities, and the agent would be driven with v1 methods.
  Schema.Struct({
    ...AcpSchemaV1.InitializeResponse.fields,
    info: Schema.optionalKey(Schema.Never),
    authMethods: Schema.optionalKey(
      defaultOnError(
        skipInvalidItems(Schema.Union([LegacyAuthMethodEnvVar, AcpSchemaV1.AuthMethod])),
      ),
    ),
  }),
]);

const withSessionModels = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({
    ...fields,
    models: Schema.optionalKey(Schema.NullOr(AcpCompat.SessionModelState)),
  });

export const V1NewSessionResponse = withSessionModels(AcpSchemaV1.NewSessionResponse.fields);
export const V1LoadSessionResponse = withSessionModels(AcpSchemaV1.LoadSessionResponse.fields);
export const V1ForkSessionResponse = withSessionModels(AcpSchemaV1.ForkSessionResponse.fields);
export const V1ResumeSessionResponse = withSessionModels(AcpSchemaV1.ResumeSessionResponse.fields);

export const CompatListSessionsResponse = Schema.Union([
  AcpSchemaV1.ListSessionsResponse,
  AcpSchema.ListSessionsResponse,
]);

export const CompatCloseSessionResponse = Schema.Union([
  AcpSchema.CloseSessionResponse,
  AcpSchemaV1.CloseSessionResponse,
]);

export const CompatPromptResponse = Schema.Union([
  AcpSchemaV1.PromptResponse,
  AcpSchema.PromptResponse,
]);

const CompatInitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  // The negotiation request intentionally carries both v1 and v2 capability
  // field names. A union encoder would select one branch and discard the
  // other generation's fields before they reach the agent.
  payload: Schema.Unknown,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatAuthenticateV1Rpc = Rpc.make(V1_AGENT_METHODS.authenticate, {
  payload: AcpSchemaV1.AuthenticateRequest,
  success: Schema.Unknown,
  error: AcpSchemaV1.Error,
});

const CompatLogoutV1Rpc = Rpc.make(V1_AGENT_METHODS.logout, {
  payload: AcpSchemaV1.LogoutRequest,
  success: Schema.Unknown,
  error: AcpSchemaV1.Error,
});

const CompatNewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: Schema.Union([AcpSchema.NewSessionRequest, AcpSchemaV1.NewSessionRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatLoadSessionV1Rpc = Rpc.make(V1_AGENT_METHODS.session_load, {
  payload: AcpSchemaV1.LoadSessionRequest,
  success: Schema.Unknown,
  error: AcpSchemaV1.Error,
});

const CompatListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: Schema.Union([AcpSchema.ListSessionsRequest, AcpSchemaV1.ListSessionsRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: Schema.Union([AcpSchema.ForkSessionRequest, AcpSchemaV1.ForkSessionRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: Schema.Union([AcpSchema.ResumeSessionRequest, AcpSchemaV1.ResumeSessionRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatCloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: Schema.Union([AcpSchema.CloseSessionRequest, AcpSchemaV1.CloseSessionRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatDeleteSessionRpc = Rpc.make(AGENT_METHODS.session_delete, {
  payload: AcpSchema.DeleteSessionRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatListProvidersRpc = Rpc.make(AGENT_METHODS.providers_list, {
  payload: AcpSchema.ListProvidersRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatSetProviderRpc = Rpc.make(AGENT_METHODS.providers_set, {
  payload: AcpSchema.SetProviderRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatDisableProviderRpc = Rpc.make(AGENT_METHODS.providers_disable, {
  payload: AcpSchema.DisableProviderRequest,
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatPromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: Schema.Union([AcpSchema.PromptRequest, AcpSchemaV1.PromptRequest]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatSetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: Schema.Union([
    AcpSchema.SetSessionConfigOptionRequest,
    AcpSchemaV1.SetSessionConfigOptionRequest,
  ]),
  success: Schema.Unknown,
  error: AcpSchema.Error,
});

const CompatSetSessionModelRpc = Rpc.make(V1_AGENT_METHODS.session_set_model, {
  payload: AcpCompat.SetSessionModelRequest,
  success: Schema.Unknown,
  error: AcpSchemaV1.Error,
});

const CompatSetSessionModeRpc = Rpc.make(V1_AGENT_METHODS.session_set_mode, {
  payload: AcpSchemaV1.SetSessionModeRequest,
  success: Schema.Unknown,
  error: AcpSchemaV1.Error,
});

export const CompatAgentRpcs = RpcGroup.make(
  CompatInitializeRpc,
  CompatSetSessionModelRpc,
  CompatSetSessionModeRpc,
  LoginRpc.setSuccess(Schema.Unknown),
  CompatAuthenticateV1Rpc,
  LogoutRpc.setSuccess(Schema.Unknown),
  CompatLogoutV1Rpc,
  CompatNewSessionRpc,
  CompatLoadSessionV1Rpc,
  CompatListSessionsRpc,
  CompatForkSessionRpc,
  CompatResumeSessionRpc,
  CompatCloseSessionRpc,
  CompatDeleteSessionRpc,
  CompatListProvidersRpc,
  CompatSetProviderRpc,
  CompatDisableProviderRpc,
  CompatPromptRpc,
  CompatSetSessionConfigOptionRpc,
);

const CompatRequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: Schema.Union([AcpSchema.RequestPermissionRequest, AcpSchemaV1.RequestPermissionRequest]),
  success: Schema.Union([
    AcpSchema.RequestPermissionResponse,
    AcpSchemaV1.RequestPermissionResponse,
  ]),
  error: AcpSchema.Error,
});

const CompatElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  // Decode in the handler so malformed requests receive ACP's invalid-params error.
  payload: Schema.Unknown,
  success: Schema.Union([
    AcpSchema.CreateElicitationResponse,
    AcpSchemaV1.CreateElicitationResponse,
  ]),
  error: AcpSchema.Error,
});

// Native ACP agents still use the older nested elicitation response.
const legacyElicitationRpc = <const Method extends string>(method: Method) =>
  Rpc.make(method, {
    payload: AcpSchema.CreateElicitationRequest,
    success: Schema.Struct({
      action: AcpSchema.CreateElicitationResponse,
      _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
    }),
    error: AcpSchema.Error,
  });

const ConnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_connect, {
  payload: AcpSchema.ConnectMcpRequest,
  success: AcpSchema.ConnectMcpResponse,
  error: AcpSchema.Error,
});

const MessageMcpRpc = Rpc.make(CLIENT_METHODS.mcp_message, {
  payload: AcpSchema.MessageMcpRequest,
  success: AcpSchema.MessageMcpResponse,
  error: AcpSchema.Error,
});

const DisconnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_disconnect, {
  payload: AcpSchema.DisconnectMcpRequest,
  success: AcpSchema.DisconnectMcpResponse,
  error: AcpSchema.Error,
});

// The agent calls the client through this group, and callRpc decodes the
// replies for the reasons given above the compatibility groups.
export const ClientRpcs = RpcGroup.make(
  RequestPermissionRpc,
  ElicitationRpc,
  ConnectMcpRpc.setSuccess(Schema.Unknown),
  MessageMcpRpc.setSuccess(Schema.Unknown),
  DisconnectMcpRpc.setSuccess(Schema.Unknown),
);

const ReadTextFileV1Rpc = Rpc.make(V1_CLIENT_METHODS.fs_read_text_file, {
  payload: AcpSchemaV1.ReadTextFileRequest,
  success: AcpSchemaV1.ReadTextFileResponse,
  error: AcpSchemaV1.Error,
});

const WriteTextFileV1Rpc = Rpc.make(V1_CLIENT_METHODS.fs_write_text_file, {
  payload: AcpSchemaV1.WriteTextFileRequest,
  success: AcpSchemaV1.WriteTextFileResponse,
  error: AcpSchemaV1.Error,
});

const CreateTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_create, {
  payload: AcpSchemaV1.CreateTerminalRequest,
  success: AcpSchemaV1.CreateTerminalResponse,
  error: AcpSchemaV1.Error,
});

const TerminalOutputV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_output, {
  payload: AcpSchemaV1.TerminalOutputRequest,
  success: AcpSchemaV1.TerminalOutputResponse,
  error: AcpSchemaV1.Error,
});

const ReleaseTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_release, {
  payload: AcpSchemaV1.ReleaseTerminalRequest,
  success: AcpSchemaV1.ReleaseTerminalResponse,
  error: AcpSchemaV1.Error,
});

const WaitForTerminalExitV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_wait_for_exit, {
  payload: AcpSchemaV1.WaitForTerminalExitRequest,
  success: AcpSchemaV1.WaitForTerminalExitResponse,
  error: AcpSchemaV1.Error,
});

const KillTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_kill, {
  payload: AcpSchemaV1.KillTerminalRequest,
  success: AcpSchemaV1.KillTerminalResponse,
  error: AcpSchemaV1.Error,
});

export const CompatClientRpcs = RpcGroup.make(
  CompatRequestPermissionRpc,
  CompatElicitationRpc,
  legacyElicitationRpc(V1_CLIENT_METHODS.session_elicitation),
  legacyElicitationRpc(V1_CLIENT_METHODS.unstable_session_elicitation),
  ConnectMcpRpc,
  MessageMcpRpc,
  DisconnectMcpRpc,
  ReadTextFileV1Rpc,
  WriteTextFileV1Rpc,
  CreateTerminalV1Rpc,
  TerminalOutputV1Rpc,
  ReleaseTerminalV1Rpc,
  WaitForTerminalExitV1Rpc,
  KillTerminalV1Rpc,
);
