// What a chat started in Cloud would be missing, said under New chat's box before Send, not in the chat after it:
// the agent picked does not run there, or it has no plan or key that works there. Read from this computer's own list
// of the agent's plans and keys (EngineDescriptor.auth), each with where it works and the state it is in. The words
// are the ones the chat's own line uses for the same thing (components/cloud/EngineSignIn.tsx).
import type { EngineAccount, EngineDescriptor } from "@caveman-app/session-protocol";
import { cloudNeed } from "../components/cloud/EngineSignIn.tsx";
import { connectionsOf, connectionState } from "./settings/connections-model.ts";

/** The agents that run in Cloud, by the names the app gives them: its image carries claude and codex beside the Caveman engine; ACP agents have no CLI there. */
export const CLOUD_AGENTS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "caveman", label: "Caveman" },
  { id: "claude-agent", label: "Claude Agent" },
  { id: "codex", label: "Codex" },
];
export const CLOUD_ENGINES: ReadonlySet<string> = new Set(CLOUD_AGENTS.map((a) => a.id));

export interface CloudStartNeed {
  /**
   * unsupported: the agent does not run in Cloud. connect: no plan or key of it works there yet. reconnect: its plan's
   * sign-in ended. admin_off: the admin turned its plans off and no key is there instead.
   */
  readonly kind: "unsupported" | "connect" | "reconnect" | "admin_off";
  readonly line: string;
  /** The plan Reconnect replaces. */
  readonly account?: EngineAccount;
}

/**
 * What picking Cloud for this agent still needs, or null when a chat there runs. Only Claude Agent and Codex are
 * asked about, and only where plans connect once for every computer (auth.everywhere): the Caveman engine runs in
 * Cloud on the Caveman plan, and before plans connected once a chat signs in where it runs. The words are the chat's
 * own line's (cloudNeed), said here before Send.
 */
export function cloudStartNeed(
  engine: Pick<EngineDescriptor, "id" | "label" | "auth"> | undefined,
  now: number,
): CloudStartNeed | null {
  if (engine === undefined) return null;
  if (!CLOUD_ENGINES.has(engine.id))
    return {
      kind: "unsupported",
      line: `${engine.label} doesn't run in Cloud. Pick Claude Agent, Codex or Caveman.`,
    };
  if (
    (engine.id !== "claude-agent" && engine.id !== "codex") ||
    engine.auth.everywhere === undefined
  )
    return null;
  const states = connectionsOf(engine.auth.accounts).flatMap((account) =>
    account.connection ? [connectionState(account.connection, now)] : [],
  );
  // Something of it works there now, or will again by itself (a plan used up until its reset).
  if (states.some((s) => s.is === "ready" || s.is === "expiring" || s.is === "used_up"))
    return null;
  // Plans turned off before one was connected read as a plan that is off.
  const need = cloudNeed(
    engine.auth.everywhere === "off"
      ? { ...engine, auth: { ...engine.auth, accounts: [...engine.auth.accounts, OFF] } }
      : engine,
    now,
  );
  return need.kind === "used_up"
    ? null
    : { kind: need.kind, line: need.line, ...(need.account ? { account: need.account } : {}) };
}

/** A plan whose kind the admin turned off: what `auth.everywhere: "off"` means while none is connected. */
const OFF: EngineAccount = {
  id: "connection:off",
  label: "",
  kind: "login",
  active: false,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", off: true },
};
