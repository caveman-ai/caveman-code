// What the first run asks the runtime for, each in one small hook: GitHub as this runtime sees it, the account's
// plan and offer, and what Claude Code, Codex and Cursor have to bring over.

import type { AccountSummary, Result } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useState } from "react";
import type { Client } from "@caveman-app/session-protocol/client";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { openSoon } from "../../panels/browser/BrowserBar.tsx";
import type { ImportSource } from "./model.ts";
import { onBringingFinished } from "../../state/setup-import.ts";

/** null while it loads; `{ login: null }` when no GitHub login is anywhere. Polls while `watch`, for a login made elsewhere. */
export function useGithubStatus(watch = false): Result<"github.status"> | null {
  const { client } = useRuntimeClient();
  const [status, setStatus] = useState<Result<"github.status"> | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const read = () =>
      client.call("github.status", {}).then(
        (r) => live && setStatus(r),
        () => live && setStatus({ login: null, source: null }),
      );
    void read();
    const timer = watch ? setInterval(read, 3000) : undefined;
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [client, watch]);
  return status;
}

/** The Caveman account's plan and offer; null while it loads or when Caveman Cloud can't answer. */
export function useAccount(signedIn: boolean): { account: AccountSummary | null; reload: () => void } {
  const { client } = useRuntimeClient();
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client || !signedIn) return;
    let live = true;
    client.call("account.get", {}).then(
      (r) => live && setAccount(r),
      () => live && setAccount(null),
    );
    return () => {
      live = false;
    };
  }, [client, signedIn, tick]);
  return { account, reload: useCallback(() => setTick((n) => n + 1), []) };
}

/** import.scan: what Claude Code, Codex and Cursor have on this computer; null while it looks. */
// One import.scan per first run, started as soon as it opens (prefetchImportScan): by the time the person reaches
// Your setup, what Claude Code, Codex and Cursor have is already read.
let scanning: { client: Pick<Client, "call">; answer: Promise<ReadonlyArray<ImportSource>> } | null = null;
// A finished import changes what is left to bring over: the next read scans again.
onBringingFinished(() => (scanning = null));

/** Reads what can be brought over, once per client; the setup step reads the same answer. */
export function prefetchImportScan(client: Pick<Client, "call">): Promise<ReadonlyArray<ImportSource>> {
  if (scanning?.client !== client)
    scanning = {
      client,
      answer: client.call("import.scan", {}).then(
        (r) => r.sources,
        () => [],
      ),
    };
  return scanning.answer;
}

export function useImportScan(): ReadonlyArray<ImportSource> | null {
  const { client } = useRuntimeClient();
  const [sources, setSources] = useState<ReadonlyArray<ImportSource> | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void prefetchImportScan(client).then((r) => live && setSources(r));
    return () => {
      live = false;
    };
  }, [client]);
  return sources;
}

/**
 * Turns the plan's usage on for the Caveman engine: Cloud mints a credits key for this runtime (account.credits), then
 * the engines are read again so the engine shows ready. What Settings > Plan's switch does.
 */
export async function turnOnPlanUsage(client: Pick<Client, "call">, refresh: () => Promise<unknown>): Promise<void> {
  await client.call("account.credits", { request_id: requestId(), enabled: true });
  await refresh();
}

/**
 * Connect GitHub through Caveman Cloud (github.connect): its page opens in the browser, and github.status, polled,
 * turns `source: "cloud"` once it is done. Through Cloud, the login follows the person to Cloud computers.
 */
export function useConnectGithub(): { readonly start: () => void; readonly busy: boolean; readonly opened: boolean; readonly error: string | null } {
  const { client } = useRuntimeClient();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(() => {
    if (!client) return;
    setBusy(true);
    setError(null);
    const go = openSoon();
    client.call("github.connect", { request_id: requestId() }).then(
      (r) => {
        go(r.url);
        setOpened(true);
        setBusy(false);
      },
      (e) => {
        go(null);
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  }, [client]);
  return { start, busy, opened, error };
}

/**
 * Git on this computer (git.installed): null while it loads. While git is missing it asks again every few seconds, so
 * the card turns ready by itself once Apple's installer or Git for Windows' finishes; `recheck` asks at once.
 */
export function useGitInstalled(): { readonly installed: Result<"git.installed"> | null; readonly recheck: () => void } {
  const { client } = useRuntimeClient();
  const [installed, setInstalled] = useState<Result<"git.installed"> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      client.call("git.installed", {}).then(
        (r) => {
          if (!live) return;
          setInstalled(r);
          if (!r.ready) timer = setTimeout(read, 5_000);
        },
        () => live && (timer = setTimeout(read, 5_000)),
      );
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, tick]);
  return { installed, recheck: useCallback(() => setTick((n) => n + 1), []) };
}
