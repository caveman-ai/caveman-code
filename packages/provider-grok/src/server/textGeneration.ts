// ), packages/provider-grok/src/server/textGeneration.ts @ 13aa882c22.
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "@caveman-app/effect-acp/errors";

import { TextGenerationError } from "@caveman-app/protocol";
import type { GrokSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@caveman-app/shared/model";

import * as TextGenerationOperations from "@caveman-app/engine-core/server/textGenerationOperations";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  GROK_DEFAULT_MODEL_SLUG,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "./acpSupport.ts";
import { grokModelReasoningEfforts } from "./status.ts";

const GROK_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const random = yield* SecureRandom.SecureRandom;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;

  const runGrokJson: TextGenerationOperations.Runner = (request) => {
    const { operation, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      // The prompt carries everything, and Grok can still run what it does not
      // ask about (reads, searches, permissions.allow rules). In an empty
      // directory those see nothing of the repository, and the repository's
      // own Grok config never loads.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "caveman-grok-text-" });
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment,
        cwd,
        clientInfo: { name: "caveman-code-git-text", version: "0.0.0" },
        // The prompt carries repository content and nothing answers Grok's
        // permission requests, so launch it asking: left off the argv, the
        // user's Grok config can make it always-approve and run tools here.
        runtimeMode: "approval-required",
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
        const started = yield* runtime.start();
        const setup = started.sessionSetupResult;
        const currentModelId = currentGrokModelIdFromSessionSetup(setup);
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        const selectModel = (reasoningEffort: string | undefined) =>
          applyGrokAcpModelSelection({
            runtime,
            currentModelId,
            currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(setup),
            requestedModelId: resolvedModel,
            requestedReasoningEffort: reasoningEffort,
            mapError: (cause) => cause,
          });
        // As when a session opens: model and effort share one set_model, so a
        // stored effort the target model does not take runs at Grok's own
        // instead of failing the whole operation.
        const targetModelId =
          resolvedModel === GROK_DEFAULT_MODEL_SLUG ? currentModelId : resolvedModel;
        const targetModel = setup.models?.availableModels.find(
          (model) => model.modelId.trim() === targetModelId,
        );
        const reasoningEffort =
          requestedReasoningEffort !== undefined &&
          targetModel !== undefined &&
          !grokModelReasoningEfforts(targetModel).includes(requestedReasoningEffort)
            ? undefined
            : requestedReasoningEffort;
        yield* selectModel(reasoningEffort).pipe(
          Effect.catchTags({
            AcpRequestError: (error) =>
              reasoningEffort === undefined ? Effect.fail(error) : selectModel(undefined),
          }),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to set Grok ACP base model for text generation.",
                cause,
              }),
          ),
        );
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(GROK_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Grok Agent", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Grok ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner(
    "GrokTextGeneration",
    TextGenerationOperations.withoutInvestigation("Grok", runGrokJson),
  );
});
