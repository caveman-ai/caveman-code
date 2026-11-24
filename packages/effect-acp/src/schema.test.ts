// Ported from upstream (MIT), packages/effect-acp/src/schema.test.ts @ ab3a3cd1.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as V1 from "./_generated/schema-v1.gen.ts";
import * as V2 from "./schema.ts";

describe("pinned ACP wire schemas", () => {
  it("validates known content variants without accepting malformed ones as future content", () => {
    const accepts = Schema.is(V2.ContentBlock);
    expect(accepts({ type: "text", text: "hello" })).toBe(true);
    expect(accepts({ type: "text" })).toBe(false);
    expect(accepts({ type: "image", data: "aGVsbG8=" })).toBe(false);
    expect(accepts({ type: "future_content", payload: { value: 1 } })).toBe(true);
  });

  it("requires both the elicitation scope and the selected mode's fields", () => {
    const accepts = Schema.is(V2.CreateElicitationRequest);
    const form = {
      sessionId: "session-1",
      mode: "form",
      message: "Choose a branch",
      requestedSchema: { type: "object", properties: {} },
    };
    expect(accepts(form)).toBe(true);
    expect(accepts({ ...form, requestedSchema: undefined })).toBe(false);
    expect(accepts({ ...form, sessionId: undefined })).toBe(false);
    expect(accepts({ sessionId: "session-1", mode: "url", message: "Sign in" })).toBe(false);
  });

  it("accepts titled multi-select items, whose options sit under a property named anyOf", () => {
    const items = {
      anyOf: [
        { const: "ts", title: "TypeScript" },
        { const: "rs", title: "Rust" },
      ],
    };
    expect(Schema.is(V2.MultiSelectItems)(items)).toBe(true);
    expect(Schema.is(V1.MultiSelectItems)(items)).toBe(true);
    expect(Schema.is(V2.MultiSelectItems)({ anyOf: [] })).toBe(false);
  });

  it("drops a malformed field or list item where the schema marks it, and still types strictly", () => {
    const location = { path: "/tmp/a.ts", line: -1 };
    expect(Schema.decodeUnknownSync(V2.ToolCallLocation)(location)).toEqual({ path: "/tmp/a.ts" });
    expect(Schema.decodeUnknownSync(V1.ToolCallLocation)(location)).toEqual({ path: "/tmp/a.ts" });
    expect(Schema.is(V2.ToolCallLocation)(location)).toBe(false);

    const session = { sessionId: "session-1", cwd: "/tmp" };
    const decodeSessions = Schema.decodeUnknownSync(V2.ListSessionsResponse);
    expect(decodeSessions({ sessions: [session, { sessionId: 1 }] })).toEqual({
      sessions: [session],
    });
    expect(decodeSessions({ sessions: "not a list" })).toEqual({ sessions: [] });
    expect(() => decodeSessions({})).toThrow();
    expect(Schema.is(V2.ListSessionsResponse)({ sessions: [session, { sessionId: 1 }] })).toBe(
      false,
    );
  });

  it("keeps v1 command inputs compatible with native agents", () => {
    const command = { name: "plan", description: "Make a plan", input: { hint: "Task" } };
    expect(Schema.is(V1.AvailableCommand)(command)).toBe(true);
    expect(
      Schema.is(V2.AvailableCommand)({ ...command, input: { type: "text", hint: "Task" } }),
    ).toBe(true);
  });
});
