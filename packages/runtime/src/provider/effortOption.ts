/**
 * The effort a model runs at, under each engine's own option name: Claude's, the Caveman engine's
 * and native `effort`, Codex's, Grok's and Muse's `reasoningEffort`, native `reasoning`, Pi's
 * `thinking` and OpenCode's `variant` (its Reasoning list). The Session Protocol shows one effort
 * list per model, so every reader (engine.list, a turn's options, turn.started, a delegated
 * agent's pick) finds it the same way. Earlier names win when a model offers more than one.
 */
export const EFFORT_OPTION_IDS = ["effort", "reasoningEffort", "reasoning", "thinking", "variant"] as const;

interface SelectLike {
  readonly id: string;
  readonly type: string;
  readonly role?: string | undefined;
}

/**
 * A model's effort list among its option descriptors: a select under one of the names above, else
 * the select an engine marks `role: "reasoning"` under its agent's own id (an ACP `thought_level`,
 * such as Antigravity's thinking levels).
 */
export function effortDescriptorOf<D extends SelectLike>(descriptors: ReadonlyArray<D> | undefined): (D & { readonly type: "select" }) | undefined {
  for (const id of EFFORT_OPTION_IDS) {
    const found = descriptors?.find((d) => d.type === "select" && d.id === id);
    if (found) return found as D & { readonly type: "select" };
  }
  const reasoning = descriptors?.find((d) => d.type === "select" && d.role === "reasoning");
  return reasoning as (D & { readonly type: "select" }) | undefined;
}

/** The effort a model selection's options name, if any. */
export function effortValueOf(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const id of EFFORT_OPTION_IDS) {
    const found = (options as ReadonlyArray<{ readonly id?: unknown; readonly value?: unknown }>).find((o) => typeof o === "object" && o !== null && o.id === id);
    if (typeof found?.value === "string" && found.value.length > 0) return found.value;
  }
  return undefined;
}
