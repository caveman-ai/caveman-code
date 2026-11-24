import { ChiefAvatar } from "@caveman-app/session-protocol";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";

import { CHIEF_CAST } from "./Chief.ts";

test("every character a new Chief can get is one the protocol accepts", () => {
  for (const character of CHIEF_CAST) {
    expect(Schema.decodeUnknownSync(ChiefAvatar)({ character, tone: "medium" }).character).toBe(character);
  }
});
