// What a chat started in Cloud would be missing, said under New chat's box before Send: the agent does not run there,
// or it has no plan or key that works there. Read from this computer's own list of the agent's plans and keys.
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { CLOUD_ENGINES, cloudStartNeed } from "./cloud-need.ts";
import { connectLabel } from "./settings/connections-model.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
type Auth = Partial<EngineDescriptor["auth"]>;
const agent = (id: string, label: string, auth: Auth = {}) =>
  ({
    id,
    label,
    auth: { state: "signed_in", accounts: [], ...auth },
  }) as unknown as EngineDescriptor;
const own = {
  id: "claudeAgent:default",
  label: "ada@acme.dev",
  kind: "login",
  active: true,
  where: "this_mac",
};
const plan = (connection: Record<string, unknown>) => ({
  id: "connection:c1",
  label: "Claude plan",
  kind: "login",
  active: true,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", ...connection },
});
const key = {
  id: "connection:k1",
  label: "Anthropic key",
  kind: "api_key",
  active: false,
  where: "everywhere",
  connection: { kind: "anthropic_key", status: "ready" },
};
const accounts = (...list: unknown[]) => list as unknown as EngineDescriptor["auth"]["accounts"];

test("Cloud runs the Caveman engine, Claude Agent and Codex, never an ACP agent", () => {
  expect([...CLOUD_ENGINES]).toEqual(["caveman", "claude-agent", "codex"]);
  expect(cloudStartNeed(agent("cursor", "Cursor"), NOW)).toEqual({
    kind: "unsupported",
    line: "Cursor doesn't run in Cloud. Pick Claude Agent, Codex or Caveman.",
  });
  expect(cloudStartNeed(agent("acp:gemini", "Gemini"), NOW)?.kind).toBe("unsupported");
});

test("a plan connected only on this Mac is not connected for Cloud: one line, and its button", () => {
  const need = cloudStartNeed(
    agent("claude-agent", "Claude Agent", { everywhere: "available", accounts: accounts(own) }),
    NOW,
  );
  expect(need).toEqual({ kind: "connect", line: "Claude isn't connected for Cloud." });
  expect(connectLabel("claude-agent")).toBe("Connect Claude");
  expect(cloudStartNeed(agent("codex", "Codex", { everywhere: "available" }), NOW)).toEqual({
    kind: "connect",
    line: "ChatGPT isn't connected for Cloud.",
  });
  expect(connectLabel("codex")).toBe("Connect ChatGPT");
});

test("a plan or a key that works everywhere needs nothing, and neither does a plan used up until its reset", () => {
  const withPlan = agent("claude-agent", "Claude Agent", {
    everywhere: "available",
    accounts: accounts(plan({}), own),
  });
  expect(cloudStartNeed(withPlan, NOW)).toBeNull();
  expect(
    cloudStartNeed(
      agent("claude-agent", "Claude Agent", {
        everywhere: "available",
        accounts: accounts(key, own),
      }),
      NOW,
    ),
  ).toBeNull();
  // Used up: the chat carries on by itself at the reset, so there is nothing to connect.
  expect(
    cloudStartNeed(
      agent("claude-agent", "Claude Agent", {
        everywhere: "available",
        accounts: accounts(plan({ status: "used_up", used_up_until: "2026-11-10T23:08:00Z" })),
      }),
      NOW,
    ),
  ).toBeNull();
  // Ending within the month still works today.
  expect(
    cloudStartNeed(
      agent("claude-agent", "Claude Agent", {
        everywhere: "available",
        accounts: accounts(plan({ expires_at: "2026-11-20T00:00:00Z" })),
      }),
      NOW,
    ),
  ).toBeNull();
});

test("a sign-in that ended asks to reconnect; plans the admin turned off, with no key, say so", () => {
  const ended = agent("claude-agent", "Claude Agent", {
    everywhere: "available",
    accounts: accounts(plan({ status: "expired" }), own),
  });
  // Reconnect replaces the plan that ended.
  expect(cloudStartNeed(ended, NOW)).toMatchObject({
    kind: "reconnect",
    line: "Your Claude sign-in expired.",
    account: { connection: { status: "expired" } },
  });
  const off = agent("claude-agent", "Claude Agent", { everywhere: "off", accounts: accounts(own) });
  expect(cloudStartNeed(off, NOW)).toEqual({
    kind: "admin_off",
    line: "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
  });
  // With a key that works everywhere, the admin's switch needs nothing of the person.
  expect(
    cloudStartNeed(
      agent("claude-agent", "Claude Agent", {
        everywhere: "off",
        accounts: accounts(plan({ off: true }), key),
      }),
      NOW,
    ),
  ).toBeNull();
});

test("nothing is asked where the client cannot know: the Caveman engine, and a Cloud from before plans connected once", () => {
  expect(cloudStartNeed(agent("caveman", "Caveman", { state: "api_key" }), NOW)).toBeNull();
  // auth.everywhere absent: not signed in to Caveman, or a Cloud that signs each chat in where it runs.
  expect(
    cloudStartNeed(agent("claude-agent", "Claude Agent", { accounts: accounts(own) }), NOW),
  ).toBeNull();
  expect(cloudStartNeed(undefined, NOW)).toBeNull();
});

test("no line says engine, connection, login or Claude Code", () => {
  const lines = [
    cloudStartNeed(agent("cursor", "Cursor"), NOW),
    cloudStartNeed(agent("claude-agent", "Claude Agent", { everywhere: "available" }), NOW),
    cloudStartNeed(agent("claude-agent", "Claude Agent", { everywhere: "off" }), NOW),
    cloudStartNeed(
      agent("codex", "Codex", {
        everywhere: "available",
        accounts: accounts({
          ...plan({ status: "expired" }),
          connection: { kind: "chatgpt_plan", status: "expired" },
        }),
      }),
      NOW,
    ),
  ];
  for (const need of lines)
    expect(need?.line).not.toMatch(/engine|connection|login|Claude Code|Cloud computer/i);
});
