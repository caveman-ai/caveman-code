/** Cloud-only Auto: one pick per ask, across the sources connected now. */
import type { RoutingCredentialSource } from "@caveman-app/engine-core/server/ProviderHost";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConnectedSource } from "./connected.ts";
import { slotProvider } from "./providers.ts";

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Cloud's pick for an ask: a connected model, and the effort to run it at when Cloud chose one. */
export interface AutoDecision {
  /** Full `provider/model` identity, one of the connected pool's. */
  readonly model: string;
  readonly reason: string;
  readonly signals: ReadonlyArray<string>;
  readonly reasoning?: ModelThinkingLevel;
}

/** What Cloud hears about an ask beside its text: the model it runs on now, how full its context is, images, tool errors, the last call. */
export interface AutoDecideInput {
  readonly currentModel: string;
  readonly ctxTokens: number;
  readonly hasImages: boolean;
  readonly toolErrorStreak: number;
  readonly previousUsage?: { readonly model: string; readonly inputTokens?: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number };
}

const modelId = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** The asked model first, bounded to Cloud's pool cap. Even one model may get a new effort. */
export const autoPool = (start: string, connected: ReadonlyArray<string>): ReadonlyArray<string> =>
  !connected.includes(start) ? [] : [start, ...connected.filter((id) => id !== start)].slice(0, 64);

export interface AutoAsk {
  text: string;
  seq: number;
}

export class CloudAutoRouter {
  #state: string | undefined;
  #previousAsk: string | undefined;
  #decided: { seq: number; decision: AutoDecision | undefined } | undefined;
  #outcome: { key: string; url: string; token: string } | undefined;
  readonly #pool;
  readonly credential: RoutingCredentialSource;
  readonly ask: () => AutoAsk;
  readonly effort: () => string;
  readonly fetchImpl: typeof fetch;

  constructor(
    credential: RoutingCredentialSource,
    pool: ReadonlyArray<string>,
    sources: ReadonlyArray<ConnectedSource>,
    ask: () => AutoAsk,
    effort: () => string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.credential = credential;
    this.ask = ask;
    this.effort = effort;
    this.fetchImpl = fetchImpl;
    this.#pool = pool.map((id) => {
      const source = sources.find((s) => s.models.includes(id));
      const host = slotProvider(source?.id ?? id.slice(0, id.indexOf("/"))).replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
      const billing = source?.kind === "credits" ? "credits" : source?.kind === "plan" ? "subscription" : source?.kind === "key" ? "api_key" : undefined;
      return { id, model: modelId(id), host, via: "local", harness: "caveman", ...(billing ? { billing } : {}) };
    });
  }

  /** Cloud's pick for the current ask, asked once per ask (`ask().seq`); undefined keeps the model it runs on. `reasoning` false: the effort is locked. */
  async decide(input: AutoDecideInput, reasoning = true): Promise<AutoDecision | undefined> {
    const ask = this.ask();
    if (this.#decided?.seq === ask.seq) return this.#decided.decision;
    this.#decided = { seq: ask.seq, decision: undefined };
    if (!ask.text.trim() || this.#pool.length === 0) return undefined;
    const credential = await this.credential.get();
    if (!credential) return undefined;
    const asked = this.#pool.find((p) => p.id === input.currentModel) ?? this.#pool[0]!;
    const body = {
      models: [...new Set([asked.model, ...this.#pool.map((p) => p.model)])],
      signals: { agent: "caveman-code-engine", context_tokens: input.ctxTokens, tools_declared: 1, tool_errors: input.toolErrorStreak, images: input.hasImages },
      ask: { text: tailBytes(ask.text, 32 * 1024), turn: ask.seq, ...(this.#previousAsk === undefined ? {} : { prev_text: tailBytes(this.#previousAsk, 16 * 1024) }) },
      request: { endpoint: "responses", effort: this.effort() === "off" ? "none" : this.effort() },
      // The previous ask's last call, so Cloud's session sees what its pick cost (route-ask-v2 `last`).
      ...(input.previousUsage === undefined ? {} : { last: {
        model: modelId(input.previousUsage.model),
        input_tokens: input.previousUsage.inputTokens ?? 0,
        cache_read_tokens: input.previousUsage.cacheReadTokens,
        cache_write_tokens: input.previousUsage.cacheWriteTokens,
      } }),
      pool: this.#pool,
      ...(this.#state === undefined ? {} : { state: this.#state }),
    };
    this.#previousAsk = ask.text;
    try {
      let auth = credential;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.fetchImpl(`${auth.url}/v1/route`, {
          method: "POST",
          headers: { authorization: `Bearer ${auth.key}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });
        if ([401, 402, 403].includes(response.status)) {
          await response.body?.cancel();
          await this.credential.rejected(auth.key, response.status, attempt === 0);
          if (attempt === 0) {
            const fresh = response.status === 402 ? undefined : await this.credential.get();
            if (fresh && fresh.key !== auth.key) { auth = fresh; continue; }
          }
          return undefined;
        }
        if (!response.ok) { await response.body?.cancel(); return undefined; }
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const answer = value as Record<string, unknown>;
        if (["allowance", "billing_limit"].includes(String(answer.reason))) return undefined;
        const picked = this.#pool.find((p) => p.id === answer.pool_id && (answer.model === p.model || answer.model === p.id));
        if (!picked) return undefined;
        const effort = answer.effort === "none" ? "off" : answer.effort;
        const decision: AutoDecision = {
          model: picked.id,
          reason: "Caveman Cloud",
          signals: ["caveman_cloud_router"],
          ...(reasoning && typeof effort === "string" && EFFORTS.has(effort) ? { reasoning: effort as ModelThinkingLevel } : {}),
        };
        if (typeof answer.state === "string") this.#state = answer.state;
        if (typeof answer.outcome_token === "string") this.#outcome = { ...auth, token: answer.outcome_token };
        this.#decided = { seq: ask.seq, decision };
        return decision;
      }
    } catch { /* Cloud unavailable: keep the engine default. */ }
    return undefined;
  }

  async finish(kind: "completed" | "failed" | "interrupted"): Promise<void> {
    const outcome = this.#outcome;
    this.#outcome = undefined;
    if (!outcome) return;
    try {
      const response = await this.fetchImpl(`${outcome.url}/v1/route/outcomes`, {
        method: "POST",
        headers: { authorization: `Bearer ${outcome.key}`, "content-type": "application/json" },
        body: JSON.stringify({ outcome_token: outcome.token, outcome_kind: kind }),
        signal: AbortSignal.timeout(3_000),
      });
      await response.body?.cancel();
    } catch { /* Outcomes never block a turn. */ }
  }
}

function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= max ? text : bytes.subarray(bytes.byteLength - max).toString("utf8").replace(/^�+/, "");
}
