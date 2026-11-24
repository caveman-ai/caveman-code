import { statSync } from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { listPriceUsd } from "@caveman-app/provider-caveman/server";

export interface RequestSavings {
  readonly session: string;
  readonly model: string;
  readonly day: string;
  readonly saved_tokens: number;
  readonly saved_usd: number | null;
  readonly saved_usd_partial: boolean;
  readonly basis: "inferred";
}

type Delta = { at: number; tokens: number; usd: number | null };
type Group = { total: RequestSavings; deltas: Array<Delta> };
const add = (total: RequestSavings, delta: Delta): RequestSavings => ({
  ...total,
  saved_tokens: total.saved_tokens + delta.tokens,
  saved_usd: total.saved_usd === null && delta.usd === null ? null : (total.saved_usd ?? 0) + (delta.usd ?? 0),
  saved_usd_partial: total.saved_usd_partial || (delta.tokens !== 0 && delta.usd === null),
});
const empty = ({ session, model, day }: Pick<RequestSavings, "session" | "model" | "day">): RequestSavings => ({
  session, model, day, saved_tokens: 0, saved_usd: null, saved_usd_partial: false, basis: "inferred",
});

/** Runtime-local totals; a restart seeds once again, in bounded batches, without modifying the proxy. */
export const makeRequestSavingsReader = () => {
  let activeFile = "";
  let identity = "";
  let after = 0;
  const groups = new Map<string, Group>();
  return (file: string, from?: string, to?: string): ReadonlyArray<RequestSavings> => {
    if (activeFile !== file) {
      activeFile = file;
      identity = "";
      after = 0;
      groups.clear();
    }
    let db: NodeSqlite.DatabaseSync | undefined;
    try {
      const stat = statSync(file);
      const nextIdentity = `${file}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      db = new NodeSqlite.DatabaseSync(file, { readOnly: true, timeout: 0 });
      const last = Number(db.prepare("SELECT max(id) AS id FROM requests").get()?.id ?? 0);
      if (identity !== nextIdentity || last < after) {
        identity = nextIdentity;
        after = 0;
        groups.clear();
      }
      // Limit scanned rows, not just matches: uncorrelated history must also advance the cursor.
      const rows = db.prepare(`SELECT id, session_id, model, provider, ts, input_tokens, cached_input_tokens,
        cache_creation_input_tokens, cache_creation_1h_tokens, request_tokens_before, request_tokens_after,
        request_estimated_input_delta_usd, request_measurement_status FROM requests
        WHERE id > ? ORDER BY id LIMIT 5000`).all(after);
      for (const row of rows) {
        after = Number(row.id);
        if (!row.session_id || row.request_measurement_status !== "measured" ||
          row.request_tokens_before === null || row.request_tokens_after === null) continue;
        const model = String(row.model ?? "unknown").replace(/\[1m\]$/, "");
        const provider = String(row.provider ?? (model.startsWith("claude-") ? "anthropic" : "openai"));
        const saved = Number(row.request_tokens_before) - Number(row.request_tokens_after);
        const input = Number(row.input_tokens ?? 0);
        const cacheRead = Number(row.cached_input_tokens ?? 0);
        const cacheWrite = Number(row.cache_creation_input_tokens ?? 0);
        // The proxy records total input, including cache reads and writes.
        const cost = listPriceUsd(model.includes("/") ? model : `${provider}/${model}`, {
          input: Math.max(0, input - cacheRead - cacheWrite), output: 0, cacheRead, cacheWrite,
          cacheWrite1h: Number(row.cache_creation_1h_tokens ?? 0),
        }, input);
        const usd = row.request_estimated_input_delta_usd !== null
          ? Number(row.request_estimated_input_delta_usd)
          : saved === 0 ? 0 : input > 0 && cost !== undefined ? saved * cost / input : null;
        const session = String(row.session_id);
        const timestamp = String(row.ts);
        const at = Date.parse(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
        if (!Number.isFinite(at)) continue;
        const day = new Date(at).toISOString().slice(0, 10);
        const key = JSON.stringify([session, model, day]);
        const group = groups.get(key) ?? { total: empty({ session, model, day }), deltas: [] };
        const delta = { at, tokens: saved, usd };
        group.total = add(group.total, delta);
        // Keep only numeric deltas for exact intraday bounds; full days use running totals.
        group.deltas.push(delta);
        groups.set(key, group);
      }
    } catch {
      // Missing/older/temporarily busy proxy: no new evidence, retry next call.
    } finally {
      db?.close();
    }
    const start = from === undefined ? -Infinity : Date.parse(from);
    const end = to === undefined ? Infinity : Date.parse(to);
    return [...groups.values()].flatMap(({ total, deltas }) => {
      const day = Date.parse(`${total.day}T00:00:00.000Z`);
      if (day > end || day + 86_400_000 <= start) return [];
      if (start <= day && end >= day + 86_399_999) return [total];
      const included = deltas.filter((delta) => delta.at >= start && delta.at <= end);
      return included.length === 0 ? [] : [included.reduce(add, empty(total))];
    });
  };
};

export const readRequestSavings = makeRequestSavingsReader();
