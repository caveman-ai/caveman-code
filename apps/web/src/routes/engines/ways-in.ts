// The ways in, as data: which rows the first run's "nothing found" screen (and New chat's "Set up an agent") lists,
// from the engines, what engine.scan found and what the Caveman engine can sign in to. WaysIn.tsx draws them.

import type { EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import { cliMissing, engineReady, isHarness, type ScanFound } from "../../state/engines.ts";

export type Way =
  /** Claude Agent, Codex or a scanned harness: its own panel (EngineAccounts) opens in place. */
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly engine: string;
      readonly label: string;
      readonly desc: string;
      readonly action: "Sign in";
    }
  /** A Caveman engine sign-in (provider-caveman signIn.ts): one click opens the provider's page. `installCodex`: Codex is missing, so its install line sits under the sign-in. */
  | {
      readonly kind: "sign_in";
      readonly key: string;
      readonly provider: string;
      readonly label: string;
      readonly desc: string;
      readonly installCodex?: true;
    }
  /** Any provider's key, a gateway, a coding plan, Ollama or LM Studio: the Caveman engine's source picker opens in place. */
  | {
      readonly kind: "key";
      readonly key: string;
      readonly engine: string;
      readonly label: string;
      readonly desc: string;
      readonly action: "Add key";
    };

/** The subscriptions the Caveman engine signs in to on this computer, after compact, in the order they are offered. */
const SIGN_INS = ["github-copilot", "xai", "openrouter"] as const;

export function waysIn(
  engines: ReadonlyArray<EngineDescriptor>,
  found: ReadonlyMap<string, ScanFound> | null,
  providers: ReadonlyArray<EngineProvider> | null,
): ReadonlyArray<Way> {
  const byId = (id: string) => engines.find((e) => e.id === id);
  const caveman = byId("caveman");
  /** A sign-in the Caveman engine offers (engine.providers), or none where it does not. */
  const signInOf = (id: string) =>
    caveman ? providers?.find((p) => p.id === id && p.sign_in === true) : undefined;
  const ways: Way[] = [];

  const claude = byId("claude-agent");
  if (claude) {
    ways.push({
      kind: "agent",
      key: "claude-agent",
      engine: "claude-agent",
      label: "Claude Pro or Max",
      desc: cliMissing(claude, found?.get("claude-agent"))
        ? "Install claude, then sign in"
        : "Sign in through the claude app",
      action: "Sign in",
    });
  }

 // compact runs two ways: Codex on its own login (the codex command), or the Caveman engine's own sign-in. With no
  // codex on this computer the Caveman engine's leads, and the codex install line sits under it. Until the Caveman
  // engine says what it signs in to (`providers` null), that row waits: shown as Codex first, it would change kind and
  // key when the answer came, closing an open panel.
  const codex = byId("codex");
  const chatgpt = signInOf("openai");
  const codexMissing = codex !== undefined && cliMissing(codex, found?.get("codex"));
  if (codexMissing && caveman && providers === null) {
    // Still asking the Caveman engine.
  } else if (codexMissing && chatgpt) {
    ways.push({
      kind: "sign_in",
      key: "openai",
      provider: "openai",
      label: "ChatGPT Plus or Pro",
      desc: "Runs the Caveman engine on your plan",
      installCodex: true,
    });
  } else if (codex) {
    ways.push({
      kind: "agent",
      key: "codex",
      engine: "codex",
      label: "ChatGPT Plus or Pro",
      desc: "Runs Codex on your ChatGPT sign-in",
      action: "Sign in",
    });
  } else if (chatgpt) {
    ways.push({
      kind: "sign_in",
      key: "openai",
      provider: "openai",
      label: "ChatGPT Plus or Pro",
      desc: "Runs the Caveman engine on your plan",
    });
  }

  for (const id of SIGN_INS) {
    const p = signInOf(id);
    if (!p) continue;
    ways.push({
      kind: "sign_in",
      key: id,
      provider: id,
      label: p.sign_in_plan ?? p.label,
 // external tools's sign-in hands back a key (no plan): it is a way to skip pasting one.
      desc: p.sign_in_plan
        ? `Runs the Caveman engine on your ${p.sign_in_plan} plan`
        : "Sign in instead of pasting a key",
    });
  }

  // Every harness engine.scan found on this computer and not yet signed in: Cursor and the rest.
  for (const e of engines) {
    const f = found?.get(e.id);
    if (!isHarness(e.id) || f === undefined || f === "not_found" || engineReady(e)) continue;
    ways.push({
      kind: "agent",
      key: e.id,
      engine: e.id,
      label: e.label,
      desc: "Found on this computer",
      action: "Sign in",
    });
  }

  if (caveman)
    ways.push({
      kind: "key",
      key: "caveman",
      engine: "caveman",
      label: "An API key",
      desc: "Anthropic, OpenAI, OpenRouter and more",
      action: "Add key",
    });
  return ways;
}
