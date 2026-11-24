# @caveman-app/codex-app-server

Effect client for the `codex app-server` JSON-RPC protocol: typed requests,
notifications and server requests (`client`), the generated schemas
(`schema`, `rpc`), the wire protocol (`protocol`), replay fixtures (`replay`)
and errors (`errors`).

, `upstream`
@ `ab3a3cd1`); see `THIRD_PARTY_NOTICES.md` at the repo root.

## Protocol version

| | Codex version | Source |
|---|---|---|
| upstream @ ab3a3cd1 (ported) and @ 13aa882c22 (the current reference, same pin) | 0.159.0 | `openai/codex` @ `687a119f` (tag `rust-v0.159.0`), fetched from GitHub |
| This package | **codex-cli 0.165.0** | `codex app-server generate-json-schema` / `generate-ts` from the installed CLI (`rust-v0.165.0` = `openai/codex` @ `360319d8`) |

The app runs whatever `codex` the person has installed, and a server
notification whose params this schema rejects is dropped (with a warning), so
the pin must not trail the Codex people run. 0.161.0 -> 0.165.0 (diff of the
two schema bundles):

- `MessagePhase` gains `partial_answer` (agent messages in `item/*`,
  `turn/completed` and thread history);
- `Account` gains `gcp` (Vertex AI) in `account/read`;
- an `imageGeneration` item carries either `result` (inline bytes) or `fileId`
  (Codex's attachment store), no longer always `result`; optional `inputImages`;
- new values: `CodexErrorInfo` `modelNotFound`, `HookEventName`
  `preModelRequest` | `postModelRequest`, `PlanType` `sci` | `sci_plus`, new
  `RealtimeVoice`s, `ResponseItem` `additional_tools`;
- new client requests `thread/attachmentOwner/list` and `feedback/save`, new
  server notification `thread/readState/changed`;
- optional fields only elsewhere (`Turn.rootTurnId`, `TurnStartParams`
  `parentTurnId`/`rootTurnId`, `SubAgentActivityThreadItem` `model`/
  `reasoningEffort`, `encrypted_content` on response items, and more);
  `ModelProviderCapabilitiesReadResponse` drops `namespaceTools`.

Nothing became required, so what 0.161 sends still decodes.

0.159.0 -> 0.161.0:

- new server notification `thread/prediction/updated`
  (`ThreadPredictionUpdatedNotification`, `ThreadPredictionResult`);
- optional `origin` (`ThreadGoalMutationOrigin`: `user` | `automatic`) on
  `thread/goal/set` and `thread/goal/clear` params;
- optional `loginId` on `McpServerOauthLoginResponse` and
  `McpServerOauthLoginCompletedNotification`;
- `CodexErrorInfo` gains a catch-all branch (unknown error codes decode);
- a description change on `CyberAccessProgram`.

## Regenerate

```sh
pnpm --filter @caveman-app/codex-app-server generate   # CODEX_BIN overrides `codex`
```

The generator refuses any CLI other than the pinned `codex-cli 0.165.0`
(`EXPECTED_CODEX_VERSION` in `scripts/generate.ts`). To move to a new version
on purpose, run it with `CODEX_SCHEMA_VERSION="codex-cli <new>"`, then bump the
constant and the table above in the same commit.

The generator runs the installed CLI with a throwaway `CODEX_HOME`/`HOME`, so
it never reads or writes `~/.codex`. It emits the stable (non-experimental)
schema, the same set `openai/codex` checks in. The source version is written
into the header of each `src/_generated/*.gen.ts` file; update the table above
when it changes. Output is not run through a formatter (T3 used `vp fmt`).

## Checks

```sh
pnpm --filter @caveman-app/codex-app-server typecheck
pnpm --filter @caveman-app/codex-app-server test    # includes a live test against the installed codex (skipped if absent)
pnpm --filter @caveman-app/codex-app-server probe   # initialize, account/read, skills/list against real codex, temp home
```
