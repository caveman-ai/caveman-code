// One sign-in to a plugin's server, as the install dialog's setup and a plugin's Connect list make it:
// plugin.connect opens the service's page in the browser, then plugin.read is asked every 1.5 s, and at
// once when the person comes back to the app, until the server is connected.
import { useEffect, useState } from "react";
import { openExternal, openSoon } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import type { PluginDetail } from "./api.ts";
import { message, SIGN_IN_UNFINISHED, useHere } from "./shared.tsx";

type HeldBy = PluginDetail["server_details"][number]["held_by"];
export type SignInPhase = "idle" | "opening" | "waiting" | "connected" | "failed";

export interface SignIn {
  readonly phase: SignInPhase;
  /** Why it failed ("failed"). */
  readonly problem: string | null;
  /** Who holds the sign-in once connected, when plugin.read says. */
  readonly heldBy: HeldBy;
  /** Called from the person's click: the service's page opens in a tab that click opened (a browser blocks a later one). */
  readonly connect: () => Promise<void>;
  /** Opens the service's page again while waiting, when the runtime gave one. */
  readonly reopen: (() => void) | undefined;
}

export function useSignIn({ pluginId, server, shared, onConnected }: { pluginId: string; server: string; shared?: boolean | undefined; onConnected?: () => void }): SignIn {
  const { client } = useRuntimeClient();
  const here = useHere();
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [heldBy, setHeldBy] = useState<HeldBy>(undefined);

  /** True once plugin.read says the server is connected. */
  const check = async () => {
    const r = await client!.call("plugin.read", { id: pluginId, ...here });
    const s = r.plugin.server_details.find((d) => d.name === server);
    if (!s?.connected) return false;
    setHeldBy(s.held_by);
    setPhase("connected");
    return true;
  };

  useEffect(() => {
    if (phase !== "waiting") return;
    const look = () => void check().catch(() => undefined);
    const timer = setInterval(look, 1500);
    window.addEventListener("focus", look);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", look);
    };
    // `check` closes over this server only; the phase is what starts and stops the asking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase === "connected") onConnected?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tell the caller once per phase, not each time onConnected is rebuilt.
  }, [phase]);

  const connect = async () => {
    const go = openSoon();
    setPhase("opening");
    setProblem(null);
    try {
      const r = await client!.call("plugin.connect", { request_id: requestId(), id: pluginId, server, ...here, ...(shared ? { shared: true } : {}) });
      if (r.status === "connected") {
        go(null);
        // A GitHub login connects at once; plugin.read says who holds it.
        if (!(await check().catch(() => false))) setPhase("connected");
        return;
      }
      if (r.status === "error") {
        go(null);
        setProblem(r.problem ?? SIGN_IN_UNFINISHED);
        setPhase("failed");
        return;
      }
      setUrl(r.authorization_url ?? null);
      go(r.authorization_url);
      setPhase("waiting");
    } catch (e) {
      go(null);
      setProblem(message(e));
      setPhase("failed");
    }
  };

  return { phase, problem, heldBy, connect, reopen: phase === "waiting" && url ? () => openExternal(url) : undefined };
}
