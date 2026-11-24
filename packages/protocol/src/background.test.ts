// ), packages/contracts/src/background.test.ts @ ab3a3cd1.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ClientActivityClientId } from "./background.ts";

const decodeClientActivityClientId = Schema.decodeUnknownSync(ClientActivityClientId);

describe("ClientActivityClientId", () => {
  it("trims and accepts bounded client identifiers", () => {
    expect(decodeClientActivityClientId("  client-1  ")).toBe("client-1");
    expect(decodeClientActivityClientId("x".repeat(128))).toBe("x".repeat(128));
  });

  it("rejects empty and oversized client identifiers", () => {
    expect(() => decodeClientActivityClientId("   ")).toThrow();
    expect(() => decodeClientActivityClientId("x".repeat(129))).toThrow();
  });
});
