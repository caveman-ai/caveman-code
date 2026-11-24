// ), apps/server/src/orchestration-v2/ThreadMessageIntake.test.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type UserInputAttachments,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { dispatchCommand, launchThread, sendToThread } from "./ThreadMessageIntake.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ProjectionStore.layerMemory),
);

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) => {
      captured.push(command);
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Stop after intake",
        }),
      );
    },
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

// The first attempt answered with text only: clients omit attachmentsByQuestionId
// entirely, so the recorded turn item resolves the request without a questionAnswer.
const textOnlyRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      // JSON-quoted, so a Windows path's backslashes come escaped.
      `Attached image "screen.png": ${JSON.stringify(path)}`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("rolls back earlier question claims when a later pending upload is missing", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-q-fail");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const existingId = ChatAttachmentId.make("thread-q-fail-00000000-0000-4000-8000-000000000001");
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${existingId}.png`),
      new Uint8Array([9, 9, 9, 9]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-missing-pending"),
      threadId,
      requestId: RuntimeRequestId.make("request-missing-pending"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: existingId,
            name: "keep.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()!),
            name: "gone.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AttachmentClaimError");
    }
    expect(captured).toHaveLength(0);
    // The pending sources stay behind so the user can retry the response.
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    // The pre-existing thread attachment is retained; only the new copy is rolled back.
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-q-fail-"),
      ),
    ).toEqual([`${existingId}.png`]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("rolls back earlier question claims when attachment path preparation fails", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-missing-claimed"),
      threadId: ThreadId.make("thread-path-fail"),
      requestId: RuntimeRequestId.make("request-missing-claimed"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: ChatAttachmentId.make("thread-path-fail-00000000-0000-4000-8000-000000000099"),
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AttachmentClaimError");
    }
    expect(captured).toHaveLength(0);
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-path-fail-"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    // The response may have been accepted before the error, so the copy that
    // backs the answer's path stays for the provider to read.
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    // A retry of a previously rejected command claims fresh copies, then the
    // orchestrator replays the rejection without touching them.
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    // The first attempt was accepted but its response was lost. The retry's
    // dispatch replays the stored events, which reference the first claim's
    // attachment id — not this attempt's fresh copy.
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    // The accepted copy from the first attempt is untouched; only the
    // retry's unreferenced copy is removed.
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the recorded answer has no attachments", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-empty-answer");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    // The same command id was first answered without attachments; this
    // retry's copies are unreferenced by the recorded answer.
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-empty-answer",
      attachmentsByQuestionId: {},
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-empty"),
      threadId,
      requestId: RuntimeRequestId.make("request-empty-answer"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-empty-answer-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the recorded answer was text-only", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-text-only-answer");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    // The first attempt accepted a text-only response, so its recorded turn
    // item has no questionAnswer at all. The retried command id uploads an
    // attachment whose fresh copy is unreferenced by that answer.
    const storedEvents = textOnlyRespondEvents({
      threadId,
      requestId: "request-text-only",
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-text-only"),
      threadId,
      requestId: RuntimeRequestId.make("request-text-only"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-text-only-answer-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies referenced by a fresh recorded answer", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-fresh-answer");
    const firstId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const secondId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${firstId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${secondId}.png`),
      new Uint8Array([7, 7]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-fresh"),
      threadId,
      requestId: RuntimeRequestId.make("request-fresh"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: firstId,
            name: "one.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: secondId,
            name: "two.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          // A fresh commit records exactly the attachments this attempt claimed.
          dispatch: (command) =>
            Effect.succeed({
              sequence: 1,
              storedEvents: answeredRespondEvents({
                threadId,
                requestId: "request-fresh",
                attachmentsByQuestionId:
                  command.type === "runtime-request.respond"
                    ? (command.attachmentsByQuestionId ?? {})
                    : {},
              }),
            }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-fresh-answer-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when preparation dies with a defect", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const poisoned = {
      get id(): string {
        throw new Error("poisoned");
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-defect"),
      threadId: ThreadId.make("thread-defect"),
      requestId: RuntimeRequestId.make("request-defect"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [poisoned] as never,
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.exit);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(0);
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-defect-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("applies the image budget across all questions before dispatch", () =>
  Effect.gen(function* () {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      type: "image" as const,
      id: ChatAttachmentId.make(`existing-budget-${index}`),
      name: `${index}.png`,
      mimeType: "image/png",
      sizeBytes: 10 * 1024 * 1024,
    }));
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* Effect.exit(
      dispatchCommand({
        type: "runtime-request.respond",
        commandId: CommandId.make("command-image-budget"),
        threadId: ThreadId.make("thread-image-budget"),
        requestId: RuntimeRequestId.make("question-image-budget"),
        answers: {},
        attachmentsByQuestionId: { q1: attachments, q2: attachments },
      }).pipe(Effect.provide(layerFailingDispatch(captured))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(String(result.cause)).toContain("80 MiB");
    expect(captured).toEqual([]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when a project disables the message's provider instance", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* sendToThread({
      projectId: ProjectId.make("project-disabled-send"),
      commandId: CommandId.make("command-disabled-send"),
      threadId: ThreadId.make("thread-disabled-send"),
      messageId: MessageId.make("message-disabled-send"),
      text: "Hello",
      attachments: [
        {
          type: "image",
          id: pendingId,
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
      ],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId: input.projectId,
                instanceId: ProviderInstanceId.make("codex"),
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-disabled-send-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a message or a launch cannot take another thread's stored attachment", () =>
  Effect.gen(function* () {
    const theirs = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-a", "png")!),
      name: "theirs.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const sent = yield* dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("command-foreign-attachment"),
      threadId: ThreadId.make("thread-b"),
      messageId: MessageId.make("message-foreign-attachment"),
      text: "look at this",
      attachments: [theirs],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provide(layerFailingDispatch(dispatched)), Effect.flip);
    expect(sent._tag).toBe("AttachmentClaimError");
    expect(dispatched).toEqual([]);

    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const layerLaunch = Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => launched.push(input)).pipe(Effect.andThen(Effect.die("launched"))),
    });
    for (const threadId of [ThreadId.make("thread-b"), undefined]) {
      const launch = yield* launchThread({
        commandId: CommandId.make("command-foreign-launch"),
        ...(threadId === undefined ? {} : { threadId }),
        projectId: ProjectId.make("project-foreign-launch"),
        title: "Foreign launch",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message-foreign-launch"),
          text: "look at this",
          attachments: [theirs],
        },
        createdBy: "user",
        creationSource: "web",
      }).pipe(Effect.provide(layerLaunch), Effect.flip);
      expect(launch._tag).toBe("AttachmentClaimError");
    }
    expect(launched).toEqual([]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a message sends a migrated chat's attachment only from that chat", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const instanceId = ProviderInstanceId.make("codex");
    const owner = ThreadId.make("thread-legacy-owner");
    const legacy = {
      type: "image" as const,
      id: ChatAttachmentId.make("legacy_screenshot"),
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    yield* store.apply({
      id: EventId.make("create:legacy-owner"),
      type: "thread.created",
      threadId: owner,
      occurredAt: now,
      payload: {
        id: owner,
        projectId: ProjectId.make("project-legacy"),
        title: "Migrated",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* store.apply({
      id: EventId.make("message:legacy-owner"),
      type: "message.updated",
      threadId: owner,
      occurredAt: now,
      payload: {
        id: MessageId.make("message-legacy-owner"),
        threadId: owner,
        runId: null,
        nodeId: null,
        role: "user",
        text: "First question with screenshot",
        attachments: [legacy],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
    const send = (threadId: ThreadId, dispatched: OrchestrationV2ServerCommand[]) =>
      dispatchCommand({
        type: "message.dispatch",
        commandId: CommandId.make(`command-legacy:${threadId}`),
        threadId,
        messageId: MessageId.make(`message-legacy:${threadId}`),
        text: "look again",
        attachments: [legacy],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      }).pipe(Effect.provide(layerFailingDispatch(dispatched)), Effect.flip);

    const intoOther: OrchestrationV2ServerCommand[] = [];
    const refused = yield* send(ThreadId.make("thread-legacy-other"), intoOther);
    expect(refused._tag).toBe("AttachmentClaimError");
    expect(intoOther).toEqual([]);

    const intoOwner: OrchestrationV2ServerCommand[] = [];
    yield* send(owner, intoOwner);
    expect(intoOwner).toHaveLength(1);
    expect(intoOwner[0]?.type === "message.dispatch" ? intoOwner[0].attachments : []).toEqual([
      legacy,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);
