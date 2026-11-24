/**
 * Test seams for other packages' tests (the runtime's Settings -> Engines
 * tests): the engine's scripted model, so a side request runs end to end
 * without a network or a paid call. Never imported by production code.
 *
 * @module provider-caveman/testing
 */
export { fauxModel, scriptedStream } from "@caveman-ai/agent/testing";
/** A model stream to answer from by hand (the runtime's Chief tests route the Chief's calls apart from its chats'). */
export { createAssistantMessageEventStream, type AssistantMessage, type Context as ModelContext } from "@earendil-works/pi-ai";
/** A harness run's checkpoint as the engine writes it (format and digest), for tests that plant a run's files. */
export { writeHarnessCheckpoint } from "./server/harness.ts";
