// Computer use on this Mac: whether agents can use its apps, and the two macOS
// permissions that takes (computer.access). Settings > Computer use and the
// Computer tab read it; while a permission is missing and the view is on
// screen it is read again every POLL_MS, so granting one in System Settings
// flips the view without a reload. The guide opens System Settings at the first
// missing permission: in the desktop app, its own panel over it
// (apps/desktop src/computerGuide.ts); elsewhere the runtime's
// (computer.access.guide). "I added it" reads again at once; Screen Recording
// macOS still reports off then waits on Caveman Code reopening.

import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import type { ComputerAccess } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { unserved } from "../components/cloud/trust.tsx";
import { requestId, useRuntimeClient } from "./runtime.tsx";

const POLL_MS = 1500;

/** A runtime from before computer use: nothing to offer here. */
const UNSERVED: ComputerAccess = { supported: false, accessibility: "unknown", screen_recording: "unknown", blocked: [] };

export type PermissionKey = "accessibility" | "screen_recording";

/** The permissions, in the order System Settings asks for them, and what each lets happen. */
export const PERMISSIONS: ReadonlyArray<{ readonly key: PermissionKey; readonly label: string; readonly description: string }> = [
  { key: "accessibility", label: "Accessibility", description: "Lets agents use apps." },
  { key: "screen_recording", label: "Screen Recording", description: "Lets you see app windows here, and agents take screenshots." },
];

export const allowed = (access: ComputerAccess, key: PermissionKey): boolean => access[key] === "granted";
export const missingAny = (access: ComputerAccess): boolean => PERMISSIONS.some((p) => !allowed(access, p.key));

const onVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const windowVisible = () => document.visibilityState === "visible";

const message = (e: unknown) => (e instanceof SessionProtocolError ? e.error.message : e instanceof Error ? e.message : String(e));

export interface ComputerAccessState {
  /** Null until the runtime first answers. */
  readonly access: ComputerAccess | null;
  /** Why the last read failed, until one works. */
  readonly error: string | null;
  readonly retry: () => void;
  /** Open System Settings at the first missing permission, with its guide. */
  readonly guide: () => void;
  readonly guiding: boolean;
  /** System Settings opened for the person at least once: the view can say it waits on them there. */
  readonly guided: boolean;
  readonly guideError: string | null;
  /** The person says they allowed it: read again now. */
  readonly added: () => void;
  /** They said so for Screen Recording and macOS still reports it off: it applies once Caveman Code reopens. */
  readonly awaitsReopen: boolean;
  /** Reopens Caveman Code (the desktop app only); undefined elsewhere. */
  readonly reopen: (() => void) | undefined;
}

/** computer.access, read again while `active`, the window is visible and a permission is still missing. */
export function useComputerAccess(active: boolean): ComputerAccessState {
  const { client, connection } = useRuntimeClient();
  const [access, setAccess] = useState<ComputerAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Counts every answer, so the next read is timed from the last one, whatever it said.
  const [answers, setAnswers] = useState(0);
  const [guiding, setGuiding] = useState(false);
  const [guided, setGuided] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const watching = useSyncExternalStore(onVisibility, windowVisible, () => true) && active;

  // Coming back on screen reads at once: the person may have just granted it in System Settings.
  useEffect(() => {
    // Connection 0: the socket hasn't opened yet; the client queues calls, but a reconnect reads again anyway.
    if (!client || connection === 0 || !watching) return;
    let live = true;
    client.call("computer.access", {}).then(
      (next) => {
        if (!live) return;
        setAccess(next);
        setError(null);
        setAnswers((n) => n + 1);
      },
      (e: unknown) => {
        if (!live) return;
        if (unserved(e)) setAccess(UNSERVED);
        else setError(message(e));
        setAnswers((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [client, connection, tick, watching]);

  const waiting = watching && access?.supported === true && missingAny(access);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, answers]);

  const [saidAdded, setSaidAdded] = useState(false);
  const guide = useCallback(() => {
    // The desktop app's own guide: a panel over System Settings that walks both permissions.
    const shell = window.cavemanDesktop?.computerGuide;
    if (shell) {
      shell.open();
      setGuided(true);
      setTick((n) => n + 1);
      return;
    }
    if (!client) return;
    setGuiding(true);
    setGuideError(null);
    client.call("computer.access.guide", { request_id: requestId() }).then(
      () => {
        setGuiding(false);
        setGuided(true);
        setTick((n) => n + 1);
      },
      (e: unknown) => {
        setGuiding(false);
        // Only this Mac's own window may open its System Settings.
        const reason = e instanceof SessionProtocolError ? e.error.data?.reason : undefined;
        setGuideError(reason === "forbidden" ? "Open Caveman Code on this Mac to change its permissions." : message(e));
      },
    );
  }, [client]);

  const retry = useCallback(() => setTick((n) => n + 1), []);
  const added = useCallback(() => {
    setSaidAdded(true);
    setTick((n) => n + 1);
  }, []);
  const shell = window.cavemanDesktop?.computerGuide;
  const awaitsReopen = saidAdded && access?.supported === true && access.accessibility === "granted" && access.screen_recording !== "granted";
  return { access, error, retry, guide, guiding, guided, guideError, added, awaitsReopen, reopen: shell?.reopen ? () => shell.reopen!() : undefined };
}
