import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  ThreadId,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import { providerMessageText } from "./ThreadMessageText.ts";

const parentThreadId = ThreadId.make("thread:parent");
const childThreadId = ThreadId.make("thread:child");
const messageId = MessageId.make("message:1");

const projections = (
  thread: Partial<OrchestrationV2AppThread>,
  sender: Partial<OrchestrationV2AppThread> = {},
  others: Readonly<Record<string, Partial<OrchestrationV2AppThread>>> = {},
) => ({
  getThread: () =>
    Effect.succeed({
      id: childThreadId,
      lineage: { rootThreadId: childThreadId, relationshipToParent: null, parentThreadId: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      ...thread,
    } as OrchestrationV2AppThread),
  getThreadShell: (id: ThreadId) =>
    Effect.succeed(
      id === parentThreadId
        ? ({
            title: "Lead",
            lineage: { rootThreadId: parentThreadId },
            runtimeMode: "full-access",
            interactionMode: "default",
            ...sender,
          } as never)
        : ((others[id] ?? null) as never),
    ),
});

const appOwnedChild = {
  lineage: { rootThreadId: parentThreadId, relationshipToParent: "subagent", parentThreadId },
  forkedFrom: { type: "node", nodeId: NodeId.make("node:task") },
} as Partial<OrchestrationV2AppThread>;

const textFor = (
  thread: Partial<OrchestrationV2AppThread>,
  message: Partial<OrchestrationV2ConversationMessage>,
  options: {
    readonly sender?: Partial<OrchestrationV2AppThread>;
    /** Other threads' shells, by id. */
    readonly others?: Readonly<Record<string, Partial<OrchestrationV2AppThread>>>;
    readonly firstRun?: boolean;
    readonly supportsMcpTools?: boolean;
  } = {},
) =>
  providerMessageText(projections(thread, options.sender, options.others), {
    threadId: childThreadId,
    run: { ordinal: options.firstRun === true ? 1 : 2, userMessageId: messageId },
    message: {
      id: messageId,
      createdBy: "agent",
      creationSource: "mcp",
      ...message,
    } as OrchestrationV2ConversationMessage,
    text: "Check the build.",
    supportsMcpTools: options.supportsMcpTools ?? true,
  });

it.effect("passes a user's message through", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* textFor({}, { createdBy: "user", creationSource: "web" }),
      "Check the build.",
    );
  }),
);

it.effect("wraps another thread's message with its title, falling back to its id", () =>
  Effect.gen(function* () {
    assert.match(
      yield* textFor({}, { senderThreadId: parentThreadId }),
      /^<thread_message from="Lead" from_thread_id="thread:parent" message_id="message:1">\n/,
    );
    const unknown = ThreadId.make("thread:gone");
    assert.include(yield* textFor({}, { senderThreadId: unknown }), 'from="thread:gone"');
  }),
);

it.effect("offers thread_send only to a receiver that may send to the sender", () =>
  Effect.gen(function* () {
    const sent = { senderThreadId: parentThreadId, expectsReply: true as const };
    assert.include(yield* textFor({}, sent), "Reply with thread_send(");
    for (const text of [
      yield* textFor({ runtimeMode: "approval-required" }, sent),
      yield* textFor({}, sent, { supportsMcpTools: false }),
    ]) {
      assert.isTrue(
        text.endsWith(
          "\nFrom a teammate agent working for the same user. Your final message this turn is sent back.",
        ),
      );
    }
    // An automation step messages only what its run pays for and stops: a chat that asks it hears back from its
    // final message, and only its own delegate is offered thread_send, never a fork sharing its root.
    const automationStep = ThreadId.make("automation:r_1.build.1");
    const step = {
      id: automationStep,
      creationSource: "server",
      lineage: { rootThreadId: automationStep, parentThreadId: null, relationshipToParent: null },
    } satisfies Partial<OrchestrationV2AppThread>;
    const others = { [automationStep]: step };
    assert.notInclude(yield* textFor(step, sent), "thread_send(");
    assert.include(
      yield* textFor(step, sent, {
        sender: {
          creationSource: "mcp",
          lineage: {
            rootThreadId: automationStep,
            parentThreadId: automationStep,
            relationshipToParent: "subagent",
          },
        },
        others,
      }),
      "Reply with thread_send(",
    );
    assert.notInclude(
      yield* textFor(step, sent, {
        sender: {
          creationSource: "web",
          lineage: {
            rootThreadId: automationStep,
            parentThreadId: automationStep,
            relationshipToParent: "fork",
          },
        },
        others,
      }),
      "thread_send(",
    );
  }),
);

it.effect("leaves a parent's delegated work bare but wraps its replies", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* textFor(appOwnedChild, { senderThreadId: parentThreadId }),
      "Check the build.",
    );
    assert.include(
      yield* textFor(appOwnedChild, {
        senderThreadId: parentThreadId,
        inReplyTo: MessageId.make("message:question"),
      }),
      'in_reply_to="message:question"',
    );
  }),
);

it.effect("leaves the prompt an agent launched a thread with bare", () =>
  Effect.gen(function* () {
    const launched = { createdBy: "agent", creationSource: "mcp" } as const;
    const sent = { senderThreadId: parentThreadId };
    assert.equal(yield* textFor(launched, sent, { firstRun: true }), "Check the build.");
    // A later message, or a first message into a thread a person created, is wrapped.
    assert.include(yield* textFor(launched, sent), "<thread_message");
    assert.include(yield* textFor({}, sent, { firstRun: true }), "<thread_message");
  }),
);
