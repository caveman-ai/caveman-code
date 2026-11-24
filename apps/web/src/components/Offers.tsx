// The later offers, above the shell after the first run: one small card at a time, where a plan unlocks something the
// person just reached (offers-model.ts decides). Unlock opens the plans; a gift opens Settings > Plan. Not now keeps
// that offer away for 7 days, and none comes straight after another. The Chief's own offer is in its no-key note
// (routes/chief-welcome.tsx); while that shows, this card waits.

import { Button } from "@caveman-app/ui/components/button";
import { menuSurface } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAccount } from "../routes/onboarding/data.ts";
import { funnelStep, type FunnelStep } from "../state/desktop.ts";
import { useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { recordLidOutcome } from "../state/sleep-stop.ts";
import { tourPending, TOUR_EVENTS } from "../shell/tour-state.ts";
import { BETWEEN_MS, pickOffer, QUIET_MS, type OfferId } from "./offers-model.ts";
import { paidPlan } from "./unlock-model.ts";
import { UnlockButton, UnlockPlans } from "./UnlockPlans.tsx";

const QUIET_KEY = (id: OfferId | "any") => `caveman.offer.${id}`;
// Merged pull requests already answered (or there before this computer looked): a gift is offered for a new one.
const SEEN_PRS_KEY = "caveman.offer.gift.seen";
const FIRST_RUN_KEY = "caveman.firstRunDone";
/** The Chief's note is offering a plan itself (routes/Chief.tsx): this card waits meanwhile. */
export const INLINE_OFFER_EVENT = "caveman:offer-inline";

const SHOWN: Record<OfferId, FunnelStep> = { lid: "offer_lid_shown", window: "offer_window_shown", gift: "offer_gift_shown" };
const TAKEN: Record<OfferId, FunnelStep> = { lid: "offer_lid_unlock", window: "offer_window_unlock", gift: "offer_gift_open" };

const seenPrs = (): string[] | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_PRS_KEY) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
};

export function Offers() {
  const navigate = useNavigate();
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const connected = useRuntimeSelector((v) => v.status === "connected");
  const { account, reload } = useAccount(true);
  const [lidPaused, setLidPaused] = useState(0);
  const [tick, setTick] = useState(0); // quiet keys, the tour and the Chief's note re-read
  const [inline, setInline] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [giftsToGive, setGiftsToGive] = useState(0);

  // The Mac woke after the lid closed with chats working here that could not move.
  // The chats it stopped keep their "Stopped when your computer slept" marker with Continue (state/sleep-stop.ts).
  useEffect(
    () =>
      window.cavemanDesktop?.onLidOutcome?.((o) => {
        recordLidOutcome(o);
        setLidPaused(o.paused);
      }),
    [],
  );
  // The tour starting or ending, the Chief's note offering a plan.
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const onInline = (e: Event) => setInline((e as CustomEvent<boolean>).detail === true);
    for (const name of TOUR_EVENTS) window.addEventListener(name, again);
    window.addEventListener(INLINE_OFFER_EVENT, onInline);
    return () => {
      for (const name of TOUR_EVENTS) window.removeEventListener(name, again);
      window.removeEventListener(INLINE_OFFER_EVENT, onInline);
    };
  }, []);
  // The plan changes elsewhere (Settings, the browser): read it again when the window comes back, at most every 5 min.
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  // A pull request merged since this computer first looked: the ones there already are the baseline.
  const merged = useMemo(() => workspaces.flatMap((w) => (w.pullRequest?.state === "merged" ? [w.pullRequest.url] : [])), [workspaces]);
  // The baseline is taken once the runtime's list has loaded (connected), empty or not.
  useEffect(() => {
    if (!connected || seenPrs() !== null) return;
    localStorage.setItem(SEEN_PRS_KEY, JSON.stringify(merged));
    setTick((n) => n + 1);
  }, [connected, merged]);
  const seen = seenPrs();
  const fresh = seen === null ? null : (merged.find((url) => !seen.includes(url)) ?? null);
  // Free months still to give, read only when a gift could be offered (sent ones don't count).
  const giftable = fresh !== null && paidPlan(account) !== null && (account?.credits?.gifts?.open ?? 0) > 0;
  useEffect(() => {
    if (!giftable || !client) return;
    let live = true;
    client.call("account.gifts", {}).then(
      (r) => live && setGiftsToGive(r.gifts.filter((g) => g.status === "open").length),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [giftable, client]);

  const offer = useMemo(() => {
    void tick;
    // After the first run, never over the tour, and never straight after another offer.
    if (localStorage.getItem(FIRST_RUN_KEY) !== "1" || tourPending()) return null;
    const until = (id: OfferId | "any") => Number(localStorage.getItem(QUIET_KEY(id)) ?? 0);
    if (until("any") > Date.now()) return null;
    return pickOffer({ account, engines, lidPaused, merged: fresh !== null, giftsToGive, quiet: (id) => until(id) > Date.now() });
  }, [account, engines, lidPaused, fresh, giftsToGive, tick]);
  const shown = offer !== null && !unlocking && !inline;

  useEffect(() => {
    if (shown && offer) funnelStep(SHOWN[offer.id]);
  }, [shown, offer?.id]);

  const quietNow = (id: OfferId) => {
    localStorage.setItem(QUIET_KEY(id), String(Date.now() + QUIET_MS));
    localStorage.setItem(QUIET_KEY("any"), String(Date.now() + BETWEEN_MS));
    if (id === "gift" && fresh) localStorage.setItem(SEEN_PRS_KEY, JSON.stringify([...(seen ?? []), fresh]));
    if (id === "lid") setLidPaused(0);
    setTick((n) => n + 1);
  };
  const take = () => {
    if (!offer) return;
    funnelStep(TAKEN[offer.id]);
    quietNow(offer.id);
    if (offer.action === "gift") navigate("/settings/plan");
    else setUnlocking(true);
  };

  return (
    <>
      {shown && offer ? (
        // Top right, under the title band: clear of the composer at the bottom. Escape is Not now.
        <section
          aria-labelledby="offer-title"
          onKeyDown={(e) => {
            if (e.key === "Escape") quietNow(offer.id);
          }}
          className={cn(
            menuSurface,
            "fixed right-4 top-14 z-40 flex w-[320px] flex-col gap-3 p-4 animate-in fade-in duration-150 ease-snap max-sm:inset-x-3 max-sm:w-auto",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-card">
              <Mascot cut="bust" animate={false} />
            </span>
            <div className="min-w-0">
              <h2 id="offer-title" className="text-[13px] font-semibold leading-5">
                {offer.title}
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{offer.body}</p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => quietNow(offer.id)}>
              Not now
            </Button>
            {offer.action === "unlock" ? (
              <UnlockButton onClick={take} />
            ) : (
              <Button size="sm" onClick={take}>
                Give one
              </Button>
            )}
          </div>
        </section>
      ) : null}
      {/* Always mounted: closed during checkout, it still sees the payment land and turns the plan's usage on. */}
      <UnlockPlans open={unlocking} onOpenChange={setUnlocking} onUnlocked={reload} />
    </>
  );
}
