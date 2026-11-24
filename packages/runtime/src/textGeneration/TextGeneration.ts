// ), apps/server/src/textGeneration/TextGeneration.ts @ ab3a3cd1.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@caveman-app/protocol";
import type { ProviderTextGeneration } from "@caveman-app/engine-core/server/textGeneration";
import { TextGenerationError } from "@caveman-app/protocol";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@caveman-app/engine-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BugReportGenerationInput,
  BugReportGenerationResult,
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@caveman-app/engine-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  ProviderTextGeneration & {
    /**
     * Whether an instance's text generation can read a checkout for a review guide
     * (ProviderTextGeneration.readsCheckout). Absent, as on one provider standing in for the service: it can.
     */
    readonly canReadCheckout?: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
  }
>()("t3/textGeneration/TextGeneration") {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateBugReport"
  | "findChats";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateReviewGuide: (input) =>
      resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      ),
    // A provider that runs no one-shot prompts has none: the report keeps its template description.
    generateBugReport: (input) =>
      resolveInstance(registry, "generateBugReport", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateBugReport
            ? textGeneration.generateBugReport(input)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateBugReport",
                  detail: `Provider instance '${input.modelSelection.instanceId}' cannot describe a problem report.`,
                }),
              ),
        ),
      ),
    findChats: (input) =>
      resolveInstance(registry, "findChats", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.findChats(input)),
      ),
    // An instance that is gone cannot write either; its run fails and the next writer is tried.
    canReadCheckout: (instanceId) =>
      resolveInstance(registry, "generateReviewGuide", instanceId).pipe(
        Effect.map((textGeneration) => textGeneration.readsCheckout !== false),
        Effect.orElseSucceed(() => true),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
