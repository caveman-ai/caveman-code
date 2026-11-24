// `pnpm generate` on a clean install formats with what this package installs
// and writes what is committed. The release files it downloads are fed here
// from the committed meta and a slice of each pinned schema.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";

import * as Meta from "../src/_generated/meta.gen.ts";
import { generateSchemas } from "./generate.ts";

const metaProperty = (docs: string) => ({
  description: `The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](${docs}/extensibility)`,
  type: ["object", "null"],
  "x-deserialize-default-on-error": true,
  additionalProperties: true,
});

const sessionId = (docs: string) => ({
  description: `A unique identifier for a conversation session between a client and agent.\n\nSessions maintain their own context, conversation history, and state,\nallowing multiple independent interactions with the same agent.\n\nSee protocol docs: [Session ID](${docs}/session-setup#session-id)`,
  type: "string",
});

const cancelNotification = (docs: string, cancellation: string) => ({
  description: `Notification to cancel ongoing operations for a session.\n\nSee protocol docs: [Cancellation](${docs}/${cancellation})`,
  type: "object",
  properties: {
    sessionId: {
      description: "The ID of the session to cancel operations for.",
      allOf: [{ $ref: "#/$defs/SessionId" }],
    },
    _meta: metaProperty(docs),
  },
  required: ["sessionId"],
  "x-side": "agent",
  "x-method": "session/cancel",
});

// Definitions as the pinned ACP releases publish them. SessionId comes out
// exactly as committed because a message references it, as in the release.
const v2Docs = "https://agentclientprotocol.com/protocol/v2/draft";
const v2Definitions = {
  SessionId: sessionId(v2Docs),
  CancelSessionNotification: cancelNotification(v2Docs, "prompt-lifecycle#cancellation"),
};
const v1Docs = "https://agentclientprotocol.com/protocol";
const v1Definitions = {
  SessionId: sessionId(v1Docs),
  CancelNotification: cancelNotification(v1Docs, "prompt-turn#cancellation"),
};

const committedEntry = (source: string, name: string) => {
  const start = source.indexOf(`export type ${name} =`);
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf("\n\n", start));
};

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))(
  "ACP schema generator",
  (it) => {
    it.effect("regenerates the committed files' shape with only this package's dependencies", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const committedDir = path.join(import.meta.dirname, "..", "src", "_generated");
        const generatedDir = yield* fs.makeTempDirectoryScoped();
        const write = (file: string, value: unknown) =>
          fs.writeFileString(path.join(generatedDir, file), JSON.stringify(value));
        yield* write("upstream-meta.json", {
          version: Meta.PROTOCOL_VERSION,
          agentMethods: Meta.AGENT_METHODS,
          clientMethods: Meta.CLIENT_METHODS,
        });
        yield* write("upstream-schema.json", { $defs: v2Definitions });
        yield* write("upstream-schema-v1.json", { $defs: v1Definitions });

        yield* generateSchemas({ skipDownload: true, generatedDir });

        const read = (dir: string, file: string) => fs.readFileString(path.join(dir, file));
        expect(yield* read(generatedDir, "meta.gen.ts")).toBe(
          yield* read(committedDir, "meta.gen.ts"),
        );
        for (const file of ["schema.gen.ts", "schema-v1.gen.ts"]) {
          const generated = yield* read(generatedDir, file);
          const committed = yield* read(committedDir, file);
          expect(generated.startsWith(committed.slice(0, committed.indexOf("\nexport ")))).toBe(
            true,
          );
          expect(generated).toContain(committedEntry(committed, "SessionId"));
        }
      }),
    );
  },
);
