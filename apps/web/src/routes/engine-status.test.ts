import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { engineStatusLabel } from "../state/engines.ts";

const engine = (state: EngineDescriptor["auth"]["state"]) =>
  ({ id: "claude-agent", label: "Claude Agent", auth: { state, accounts: [] } }) as unknown as EngineDescriptor;

test("an engine whose first probe is running says Checking…, not its fallback", () => {
  expect(engineStatusLabel(engine("checking"), "Not found")).toBe("Checking…");
  expect(engineStatusLabel(engine("signed_in"), "Not found")).toBe("Ready");
  expect(engineStatusLabel(engine("api_key"), "Not found")).toBe("Ready");
  expect(engineStatusLabel(engine("unavailable"), "Not found")).toBe("Not found");
});
