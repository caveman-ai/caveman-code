// engine.scan from the first run and New chat: what is installed on this computer and signed in through its own CLI.
// It turns on every harness it finds ready (the runtime reverts what it finds no use for) and says what it found for
// each engine, so the ways in can offer Cursor and the others, and an install command where a CLI is missing.

import type { Client } from "@caveman-app/session-protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanFound } from "./engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "./runtime.tsx";

export type EngineScan = {
  /** By engine id; null until a scan has answered (or when it cannot: a runtime from before it). */
  readonly found: ReadonlyMap<string, ScanFound> | null;
  /** Looks again (Check again after an install); resolves with what it found. */
  readonly rescan: () => Promise<ReadonlyMap<string, ScanFound> | null>;
};

/** One engine.scan, as a map by engine id. */
export async function scanEngines(client: Client): Promise<ReadonlyMap<string, ScanFound>> {
  const res = await client.call("engine.scan", { request_id: requestId() });
  return new Map(res.engines.map((e) => [e.engine, e.found]));
}

/**
 * Scans once when the page mounts, in the background: nothing waits for it, rows appear as it answers. `enabled`
 * false (a Cloud computer keeps nothing of its person's, so there is nothing to find) scans nothing.
 */
export function useEngineScan(enabled = true): EngineScan {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [found, setFound] = useState<ReadonlyMap<string, ScanFound> | null>(null);
  const started = useRef(false);
  const rescan = useCallback(async () => {
    if (!client) return null;
    try {
      const next = await scanEngines(client);
      setFound(next);
      await refresh();
      return next;
    } catch {
      return null;
    }
  }, [client, refresh]);
  useEffect(() => {
    if (!enabled || !client || started.current) return;
    started.current = true;
    void rescan();
  }, [enabled, client, rescan]);
  return { found, rescan };
}
