// Exhaustive check of the WS RPC scope middleware (RpcAuthorization.layer) against a reference table: every RPC in
// WsRpcGroup runs iff its required scopes are held, over every subset of the scopes that RPC needs (with nothing else
// held, and with everything else held), every ServerSettingsPatch key alone and in pairs with and without a provider
// instance mutation, and every ProjectMutation, asset and pull request thread shape the payload decides on. Payloads
// are Schema-derived decoded values: what RpcServer hands the middleware after decoding the wire request.
// Skill: .claude/skills/mcp-and-rpc-authorization/SKILL.md
import {
  AssetResource,
  AuthEnvironmentMaintainScope,
  AuthEnvironmentScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  GitPreparePullRequestThreadInput,
  ProjectMutation,
  ProviderInstanceMutation,
  RpcScopeAuthorization,
  ServerSettingsPatch,
  WS_METHODS,
  WsRpcGroup,
} from "@caveman-app/protocol";
import { canonicalKey } from "@caveman-app/model-check";
import { expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";

import * as RpcAuthorization from "./RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";

type Scope = typeof AuthEnvironmentScope.Type;
const ALL_SCOPES: ReadonlyArray<Scope> = AuthEnvironmentScope.literals;

// ---- The real middleware, built from the real layer for one held scope set.

type Decision =
  | { readonly kind: "ran" }
  | { readonly kind: "refused"; readonly missing: string }
  | { readonly kind: "defect"; readonly error: string };

const middlewareCache = new Map<string, RpcScopeAuthorization["Service"]>();
const middlewareFor = (held: ReadonlyArray<Scope>) => {
  const key = [...held].sort().join(",");
  let middleware = middlewareCache.get(key);
  if (middleware === undefined) {
    middleware = Effect.runSync(
      Effect.scoped(
        Layer.build(RpcAuthorization.layer(held)).pipe(
          Effect.map((context) => Context.get(context, RpcScopeAuthorization)),
        ),
      ),
    );
    middlewareCache.set(key, middleware);
  }
  return middleware;
};

const handlerRan = Effect.succeed("handler ran");

const decide = (held: ReadonlyArray<Scope>, method: string, payload: unknown): Decision => {
  const rpc = WsRpcGroup.requests.get(method) as Rpc.AnyWithProps | undefined;
  if (rpc === undefined) throw new Error(`no RPC ${method} in WsRpcGroup`);
  let guarded: Effect.Effect<unknown, unknown>;
  try {
    guarded = middlewareFor(held)(
      handlerRan as never,
      {
        rpc,
        payload,
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId(0),
        headers: Headers.empty,
      } as never,
    ) as Effect.Effect<unknown, unknown>;
  } catch (error) {
    return { kind: "defect", error: String(error).split("\n").slice(0, 2).join(" ") };
  }
  const exit = Effect.runSyncExit(guarded);
  if (Exit.isSuccess(exit)) return { kind: "ran" };
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  const error =
    failure?._tag === "Fail"
      ? (failure.error as { _tag?: string; requiredPermission?: string })
      : undefined;
  return error?._tag === "EnvironmentAuthorizationError" && error.requiredPermission !== undefined
    ? { kind: "refused", missing: error.requiredPermission }
    : { kind: "defect", error: String(exit.cause).slice(0, 200) };
};

// ---- The reference: the scopes each RPC needs, from the promises in RpcAuthorization.ts, settings.ts and
// clientRpcPermissions.ts.

/**
 * Every ServerSettingsPatch key, by the configuration domain it changes. `providerInstances` carries each engine's
 * driver, binary environment and config, so it is the providers domain; everything else is settings. A key added to
 * ServerSettingsPatch fails the check until it is classified here.
 */
const PROVIDER_KEYS: ReadonlyArray<string> = ["providerInstances", "secretProviders"];
const SETTINGS_KEYS: ReadonlyArray<string> = [
  "setModelFavorites",
  "setModelsHidden",
  "setProviderModelOrder",
  "favorites",
  "providerModelPreferences",
  "migrateModelPreferences",
  "worktreeCleanup",
  "subagents",
  "storageCleanup",
  "worktreesDirectory",
  "responseStreamingMode",
  "enableProviderUpdateChecks",
  "promptSuggestionsEnabled",
  "continueThreadsAfterServerUpdate",
  "enableAgentBrowserAccess",
  "projectAgentBrowserAccessOverrides",
  "defaultAutoPull",
  "defaultProjectScripts",
  "projectScriptOverrides",
  "projectAutoPullOverrides",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "projectSettingsOverrides",
  "enableAgentDeviceAccess",
  "sidebarAutoSettleAfterDays",
  "compactIdleThreads",
  "sidebarAutoSettleKeepPullRequests",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "environmentIcon",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "addProjectBaseDirectory",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWritingStyle",
  "sourceControlWriterModelSelection",
  "reviewGuidesEnabled",
  "reviewGuidePrewarm",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "reviewGuideShortLines",
  "reviewGuideChatTldr",
  "reviewGuideStepUp",
  "reviewGuideSinglePassKb",
  "reviewGuidePrewarmDaily",
  "reviewGuidePrewarmPlanPercent",
  "reviewGuidePrewarmIdleMinutes",
  "pullRequestMergeMethod",
  "observability",
  "sourceControlHosts",
  "cursorKeychainUsageEnabled",
  "usagePriceOverrides",
  "usageModelAliases",
  "plugins",
  "reviewGuidePost",
  "promptSuggestionsEnabled",
];

const settingsUpdateNeeds = (
  patch: Record<string, unknown>,
  mutation: unknown,
): ReadonlyArray<Scope> => {
  const present = Object.keys(patch).filter((key) => patch[key] !== undefined);
  const changesProviders =
    present.some((key) => PROVIDER_KEYS.includes(key)) || mutation !== undefined;
  // An empty patch with no provider mutation is still a settings write.
  const changesSettings =
    present.some((key) => !PROVIDER_KEYS.includes(key)) ||
    (present.length === 0 && mutation === undefined);
  return [
    ...(changesSettings ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
};

const needs = (method: string, payload: unknown): ReadonlyArray<Scope> => {
  const input = payload as Record<string, unknown>;
  switch (method) {
    case WS_METHODS.serverUpdateSettings:
      return settingsUpdateNeeds(
        input.patch as Record<string, unknown>,
        input.providerInstanceMutation,
      );
    case WS_METHODS.projectsMutate:
      // Project scripts run on the host, so carrying any needs the same grant as saving them through settings.
      return input.type !== "project.delete" && input.scripts !== undefined
        ? [AuthOrchestrationOperateScope, AuthSettingsWriteScope]
        : [AuthOrchestrationOperateScope];
    case WS_METHODS.assetsCreateUrl: {
      const tag = (input.resource as { _tag: string })._tag;
      return [
        tag === "workspace-file" || tag === "media-file" || tag === "draft-workspace-file"
          ? AuthFilesystemReadScope
          : AuthOrchestrationReadScope,
      ];
    }
    case WS_METHODS.serverRetryResourceTelemetry:
      return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
    case WS_METHODS.gitPreparePullRequestThread:
      return input.mode === "worktree" && input.threadId !== undefined
        ? [AuthSourceControlWriteScope, AuthOrchestrationOperateScope]
        : [AuthSourceControlWriteScope];
    default:
      return [RPC_REQUIRED_SCOPES[method as keyof typeof RPC_REQUIRED_SCOPES]];
  }
};

/** Every subset of what the RPC needs, alone and with every other scope held too. */
function* heldSets(required: ReadonlyArray<Scope>): Generator<ReadonlyArray<Scope>> {
  const others = ALL_SCOPES.filter((scope) => !required.includes(scope));
  for (let mask = 0; mask < 1 << required.length; mask++) {
    const subset = required.filter((_, index) => (mask & (1 << index)) !== 0);
    yield subset;
    yield [...subset, ...others];
  }
}

const verdict = (
  held: ReadonlyArray<Scope>,
  method: string,
  payload: unknown,
): string | undefined => {
  const required = needs(method, payload);
  const decision = decide(held, method, payload);
  const missing = required.filter((scope) => !held.includes(scope));
  if (decision.kind === "defect") return `defect (${decision.error})`;
  if (missing.length === 0)
    return decision.kind === "ran"
      ? undefined
      : `refused for ${decision.missing} though every needed scope (${required.join(", ")}) is held`;
  if (decision.kind === "ran") return `ran without ${missing.join(", ")}`;
  return missing.includes(decision.missing as Scope)
    ? undefined
    : `refused naming ${decision.missing}, but what is missing is ${missing.join(", ")}`;
};

// ---- Payload domains: decoded values derived from each RPC's own Schema, with fixed seeds.

const sample = <S extends Schema.Top>(
  schema: S,
  count: number,
  seed: number,
): ReadonlyArray<S["Type"]> =>
  Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema), { count, seed, size: 8 }));

const patchFields = ServerSettingsPatch.fields as Record<string, Schema.Top>;
const valueFor = (key: string): unknown => {
  const candidates = sample(
    Schema.Struct({ [key]: patchFields[key]! }),
    40,
    key.length * 7919,
  ) as ReadonlyArray<Record<string, unknown>>;
  const found = candidates.find((candidate) => candidate[key] !== undefined);
  if (found === undefined) throw new Error(`no sample for ServerSettingsPatch.${key}`);
  return found[key];
};

const settingsPayloads = (): ReadonlyArray<{
  readonly patch: Record<string, unknown>;
  readonly providerInstanceMutation?: unknown;
}> => {
  const keys = Object.keys(patchFields);
  const values = new Map(keys.map((key) => [key, valueFor(key)]));
  const patches: Array<Record<string, unknown>> = [{}];
  for (const [index, key] of keys.entries()) {
    patches.push({ [key]: values.get(key) });
    for (const other of keys.slice(index + 1))
      patches.push({ [key]: values.get(key), [other]: values.get(other) });
  }
  const mutations = sample(ProviderInstanceMutation, 3, 17);
  return patches.flatMap((patch, index) => [
    { patch },
    { patch, providerInstanceMutation: mutations[index % mutations.length] },
  ]);
};

const scriptsShapes = (mutation: ProjectMutation): ReadonlyArray<ProjectMutation> => {
  if (mutation.type === "project.delete") return [mutation];
  const { scripts: _scripts, ...rest } = mutation;
  return [{ ...rest } as ProjectMutation, { ...rest, scripts: [] } as ProjectMutation, mutation];
};

const otherPayloads = (): ReadonlyArray<{ readonly method: string; readonly payload: unknown }> => [
  ...sample(ProjectMutation, 120, 23)
    .flatMap(scriptsShapes)
    .map((payload) => ({ method: WS_METHODS.projectsMutate, payload })),
  ...sample(AssetResource, 60, 29).map((resource) => ({
    method: WS_METHODS.assetsCreateUrl,
    payload: { resource },
  })),
  ...sample(GitPreparePullRequestThreadInput, 40, 31).map((payload) => ({
    method: WS_METHODS.gitPreparePullRequestThread,
    payload,
  })),
  { method: WS_METHODS.serverRetryResourceTelemetry, payload: {} },
];

const PAYLOAD_DEPENDENT = new Set<string>([
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.projectsMutate,
  WS_METHODS.assetsCreateUrl,
  WS_METHODS.gitPreparePullRequestThread,
  WS_METHODS.serverRetryResourceTelemetry,
]);

/** One decoded payload per RPC, or undefined where its Schema cannot be sampled (those RPCs never read it). */
const anyPayload = (rpc: Rpc.AnyWithProps): unknown => {
  try {
    return sample(rpc.payloadSchema, 1, 41)[0];
  } catch {
    return undefined;
  }
};

const report = (label: string, decisions: number, failures: ReadonlyArray<string>) => {
  console.log(
    `${label}: ${decisions} decisions explored, ${failures.length} violations, exhaustive over the stated domain`,
  );
};

it("classifies every ServerSettingsPatch key as settings or providers", () => {
  expect(
    new Set(Object.keys(patchFields)),
    "a new ServerSettingsPatch key must be classified in this check",
  ).toEqual(new Set([...SETTINGS_KEYS, ...PROVIDER_KEYS]));
});

it("requires settings permission for enabling and disabling prompt suggestions", () => {
  for (const promptSuggestionsEnabled of [false, true]) {
    const payload = { patch: { promptSuggestionsEnabled } };
    for (const held of [[], [AuthProvidersManageScope]]) {
      expect(decide(held, WS_METHODS.serverUpdateSettings, payload)).toEqual({
        kind: "refused",
        missing: AuthSettingsWriteScope,
      });
    }
    expect(decide([AuthSettingsWriteScope], WS_METHODS.serverUpdateSettings, payload)).toEqual({
      kind: "ran",
    });
    const mixed = { patch: { promptSuggestionsEnabled, providerInstances: {} } };
    expect(decide([AuthSettingsWriteScope], WS_METHODS.serverUpdateSettings, mixed)).toEqual({
      kind: "refused",
      missing: AuthProvidersManageScope,
    });
    expect(decide([AuthProvidersManageScope], WS_METHODS.serverUpdateSettings, mixed)).toEqual({
      kind: "refused",
      missing: AuthSettingsWriteScope,
    });
    expect(
      decide(
        [AuthSettingsWriteScope, AuthProvidersManageScope],
        WS_METHODS.serverUpdateSettings,
        mixed,
      ),
    ).toEqual({ kind: "ran" });
  }
});

it("runs every payload-independent RPC iff its declared scope is held", () => {
  const failures: Array<string> = [];
  let decisions = 0;
  for (const [method, rpc] of WsRpcGroup.requests) {
    if (PAYLOAD_DEPENDENT.has(method)) continue;
    const payload = anyPayload(rpc as unknown as Rpc.AnyWithProps);
    for (const held of heldSets(needs(method, payload))) {
      decisions++;
      const bad = verdict(held, method, payload);
      if (bad !== undefined) failures.push(`${method} holding [${held.join(", ")}]: ${bad}`);
    }
  }
  report("payload-independent RPCs", decisions, failures);
  const shortest = failures.toSorted((a, b) => a.length - b.length).slice(0, 10);
  expect(shortest, shortest.join("\n")).toEqual([]);
  expect(Object.keys(RPC_REQUIRED_SCOPES).length).toBe(WsRpcGroup.requests.size);
});

it("authorizes every settings patch of up to two keys, with and without a provider mutation, by the domains it changes", () => {
  const failures: Array<string> = [];
  let decisions = 0;
  let defects = 0;
  for (const payload of settingsPayloads()) {
    for (const held of heldSets(needs(WS_METHODS.serverUpdateSettings, payload))) {
      decisions++;
      const decision = decide(held, WS_METHODS.serverUpdateSettings, payload);
      // Defects are the next test's property; this one judges every decision the middleware reaches.
      if (decision.kind === "defect") {
        defects++;
        continue;
      }
      const bad = verdict(held, WS_METHODS.serverUpdateSettings, payload);
      if (bad !== undefined)
        failures.push(
          `${canonicalKey({ keys: Object.keys(payload.patch), mutation: payload.providerInstanceMutation !== undefined })} holding [${held.join(", ")}]: ${bad}`,
        );
    }
  }
  report(`settings patches (${defects} undecided, see the defect test)`, decisions, failures);
  const shortest = failures.toSorted((a, b) => a.length - b.length).slice(0, 10);
  expect(shortest, shortest.join("\n")).toEqual([]);
});

it("authorizes project mutations, asset URLs, pull request threads and telemetry retries by what their payload asks for", () => {
  const failures: Array<string> = [];
  let decisions = 0;
  for (const { method, payload } of otherPayloads()) {
    for (const held of heldSets(needs(method, payload))) {
      decisions++;
      const bad = verdict(held, method, payload);
      if (bad !== undefined)
        failures.push(
          `${method} ${canonicalKey(payload).slice(0, 160)} holding [${held.join(", ")}]: ${bad}`,
        );
    }
  }
  report("payload-dependent RPCs", decisions, failures);
  const shortest = failures.toSorted((a, b) => a.length - b.length).slice(0, 10);
  expect(shortest, shortest.join("\n")).toEqual([]);
});

it("reaches a decision, never a defect, for every decoded payload the RPC schema accepts", () => {
  const defects = new Map<string, string>();
  let decisions = 0;
  const everything = ALL_SCOPES;
  const payloads = [
    ...settingsPayloads().map((payload) => ({
      method: WS_METHODS.serverUpdateSettings as string,
      payload,
    })),
    ...otherPayloads(),
  ];
  for (const { method, payload } of payloads) {
    decisions++;
    const decision = decide(everything, method, payload);
    if (decision.kind !== "defect") continue;
    const shape =
      method === WS_METHODS.serverUpdateSettings
        ? `patch keys ${canonicalKey(Object.keys((payload as { patch: object }).patch))}`
        : canonicalKey(payload).slice(0, 120);
    const label = `${method} ${shape}`;
    if (!defects.has(label)) defects.set(label, decision.error);
  }
  const shortest = [...defects.entries()].sort(([a], [b]) => a.length - b.length).slice(0, 6);
  console.log(
    `decoded payloads, every scope held: ${decisions} decisions explored, ${defects.size} payload shapes died in the middleware`,
  );
  expect(
    shortest.map(([label, error]) => `${label}: ${error}`),
    "the middleware died on a payload RpcServer had already decoded",
  ).toEqual([]);
});

/** Every payload above, for sampling against arbitrary held sets drawn from all scopes. */
const payloadPool = (): ReadonlyArray<{ readonly method: string; readonly payload: unknown }> => [
  ...[...WsRpcGroup.requests]
    .filter(([method]) => !PAYLOAD_DEPENDENT.has(method))
    .map(([method, rpc]) => ({ method, payload: anyPayload(rpc as unknown as Rpc.AnyWithProps) })),
  ...settingsPayloads()
    .filter((_, index) => index % 5 === 0)
    .map((payload) => ({ method: WS_METHODS.serverUpdateSettings as string, payload })),
  ...otherPayloads(),
];
const POOL = payloadPool();

it.prop(
  "runs any RPC iff it holds what that RPC needs, for held sets drawn from every scope",
  [
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: POOL.length - 1 }))),
    Arbitrary.schema(Schema.Array(AuthEnvironmentScope)),
  ],
  ([index, held]) => {
    const { method, payload } = POOL[index]!;
    // A defect is the decoded-payload test's finding; this property judges decisions.
    if (decide(held, method, payload).kind === "defect") return;
    const bad = verdict(held, method, payload);
    expect(
      bad,
      `${method} ${canonicalKey(payload).slice(0, 160)} holding [${held.join(", ")}]`,
    ).toBeUndefined();
  },
  { arbitrary: { runs: 3000, seed: 20261106 } },
);
