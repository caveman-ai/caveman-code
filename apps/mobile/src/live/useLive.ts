// A view's hold on one of the agent's screens (the desktop's useLive, apps/web/src/panels/live/LiveView.tsx): it
// streams the screen while `active`, at 10 frames a second to watch and 30 while you drive it, and hands a screen you
// hold back to the agent when it stops watching, so closing the view never keeps the agent waiting.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Controller, LiveFrame, LiveSource, ScreenState } from "./protocol";

const WATCH_FPS = 10;
const DRIVE_FPS = 30;
const none = () => () => {};

export interface Live {
  status: "starting" | "live" | "unavailable" | "error";
  state: ScreenState | null;
  frame: LiveFrame | null;
  controller: Controller;
  /** This view holds the screen: its touches go to the page. */
  holding: boolean;
  /** Take the screen or hand it back; resolves whether it is now as asked. */
  control: (want: "user" | "agent") => Promise<boolean>;
}

export function useLive(source: LiveSource | null, active: boolean): Live {
  const onState = useCallback((cb: () => void) => (source ? source.onState(cb) : none()), [source]);
  const onFrame = useCallback((cb: () => void) => (source ? source.onFrame(cb) : none()), [source]);
  const state = useSyncExternalStore(onState, () => source?.state ?? null);
  const frame = useSyncExternalStore(onFrame, () => source?.frame ?? null);
  const [status, setStatus] = useState<Live["status"]>("starting");
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  // This view's hold on the frames, which other views of the same screen share.
  const holder = useRef({}).current;
  const fps = holding ? DRIVE_FPS : WATCH_FPS;

  useEffect(() => {
    if (!source || !active) return;
    let current = true;
    source.start(holder, fps).then(
      (r) => current && setStatus(r),
      () => current && setStatus("error"),
    );
    return () => {
      current = false;
    };
  }, [source, active, fps, holder]);

  useEffect(() => {
    if (!source || !active) return;
    return () => {
      source.stop(holder);
      if (!holdingRef.current) return;
      setHolding(false);
      void source.control("agent").catch(() => undefined);
    };
  }, [source, active, holder]);

  // A state that says the person isn't driving: this view no longer holds the screen (it was handed back, or another
  // connection has it). Heard as states arrive, so a render between Take over and its answer never drops the hold.
  useEffect(() => (source ? source.onState((s) => s.controller !== "user" && setHolding(false)) : undefined), [source]);
  const controller = state?.controller ?? "none";

  const control = useCallback(
    (want: "user" | "agent") => {
      if (!source) return Promise.resolve(false);
      setHolding(want === "user");
      return source.control(want).then(
        (now) => {
          const ok = want === "user" ? now === "user" : now !== "user";
          if (want === "user") setHolding(ok);
          return ok;
        },
        () => {
          setHolding(false);
          return false;
        },
      );
    },
    [source],
  );

  return { status, state, frame, controller, holding, control };
}
