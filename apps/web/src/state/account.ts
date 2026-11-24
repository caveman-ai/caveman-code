// Where a window reads the person's Caveman account (account.get's answer): its runtime, or, in a browser window with
// no computer behind it, Caveman Cloud itself on this origin (state/cloud.ts hostedAccount).
import type { AccountSummary } from "@caveman-app/session-protocol";
import { useMemo } from "react";
import { hostedAccount } from "./cloud.ts";
import { useRuntimeClient, useWebWindow } from "./runtime.tsx";

/** Reads the account; null while there is nothing to ask (the app before its runtime is up). */
export function useAccountRead(): (() => Promise<AccountSummary>) | null {
  const { client } = useRuntimeClient();
  const web = useWebWindow() !== null;
  return useMemo(
    () => (client ? () => client.call("account.get", {}) : web ? hostedAccount.get : null),
    [client, web],
  );
}
