import type { EngineDescriptor, Workspace } from "@caveman-app/session-protocol";
import { expect, test, vi } from "vitest";

// The drag engine's store (Composer's drop target) reads `window` on load; this test never drags.
vi.mock("../panes/drag.ts", () => ({}));
import { cloudNeed, needsEngineSignIn, signsInThere } from "../components/cloud/EngineSignIn.tsx";

const engine = (id: string, state: EngineDescriptor["auth"]["state"]) => ({ id, label: id, auth: { state, accounts: [] } }) as unknown as EngineDescriptor;
const on = (kind: Workspace["computer"]["kind"], engineId: string) => ({ engine: engineId, computer: { id: "c", kind, label: "c", status: "online" } }) as unknown as Workspace;

test("a Cloud chat shows the sign-in card only while its Claude Agent or Codex isn't signed in there", () => {
  for (const id of ["claude-agent", "codex"]) {
    expect(needsEngineSignIn(on("caveman_cloud", id), engine(id, "signed_out"))).toBe(true);
    expect(needsEngineSignIn(on("caveman_cloud", id), engine(id, "unavailable"))).toBe(true);
    // Signed in, on a key, or still being checked: no card.
    for (const state of ["signed_in", "api_key", "checking"] as const) expect(needsEngineSignIn(on("caveman_cloud", id), engine(id, state))).toBe(false);
    // This Mac's chats sign in in Settings, not in the chat.
    expect(needsEngineSignIn(on("this_mac", id), engine(id, "signed_out"))).toBe(false);
  }
  expect(needsEngineSignIn(on("caveman_cloud", "caveman"), engine("caveman", "signed_out"))).toBe(false);
  expect(needsEngineSignIn(on("caveman_cloud", "claude-agent"), undefined)).toBe(false);
});

test("where nothing is signed in on a Cloud computer the line offers no sign-in there: it says what is missing in our own words", () => {
  const there = engine("claude-agent", "signed_out");
  expect(signsInThere(there)).toBe(true);
  // What the agent's own CLI says there asks for a key the person does not need: it is never shown.
  const outside = { ...there, auth: { ...there.auth, message: "Add an Anthropic API key to use Claude Agent.", no_sign_in_here: true } } as EngineDescriptor;
  expect(needsEngineSignIn(on("caveman_cloud", "claude-agent"), outside)).toBe(true);
  expect(signsInThere(outside)).toBe(false);
  expect(cloudNeed(outside, Date.now())).toEqual({ kind: "connect", line: "Claude isn't connected for Cloud." });
  expect(cloudNeed({ id: "codex", auth: { state: "signed_out", accounts: [], no_sign_in_here: true } }, Date.now()).line).toBe("ChatGPT isn't connected for Cloud.");
});
