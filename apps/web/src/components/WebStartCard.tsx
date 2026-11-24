// How to start, in a browser window with nothing in it yet (state/sync/web-window.ts startCard): a signed-in account
// with no chat and no Mac of its own on line. The free way first (Caveman Code on the person's computer, on their own
// subscriptions and keys), then Cloud with a plan, then one quiet line about sync. No pop-up: it is a card on the page,
// and it goes by itself once a chat or a Mac shows up. Mounted by New chat for a web window (routes/NewChat.tsx).
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState } from "react";
import { hostedAccount } from "../state/cloud.ts";
import { useWebWindow, type WebWindowValue } from "../state/runtime.tsx";
import { DOWNLOAD_URL, startCard, type StartCard } from "../state/sync/web-window.ts";
import { emptyLine } from "./EmptyState.tsx";
import { offersUnlock } from "./unlock-model.ts";
import { UnlockPlans } from "./UnlockPlans.tsx";

/** The card as drawn: its rows, with `onUnlock` opening the plans. Pure of any window, so a page can show it as it is. */
export function StartCardView({
  card,
  onUnlock,
  className,
}: {
  card: StartCard;
  onUnlock: () => void;
  className?: string | undefined;
}) {
  return (
    <section aria-label={card.title} className={cn("flex flex-col gap-3 text-left", className)}>
      <h2 className="text-[13px] font-medium text-foreground">{card.title}</h2>
      <ul className="flex flex-col gap-3">
        {card.rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-5 text-foreground">{row.title}</p>
              <p className={cn(emptyLine, "max-w-none text-left")}>{row.line}</p>
            </div>
            {row.action?.kind === "download" ? (
              <Button asChild variant="secondary" size="sm" className="shrink-0">
                <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  {row.action.label}
                </a>
              </Button>
            ) : row.action?.kind === "unlock" ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={onUnlock}
              >
                {row.action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {card.sync ? (
        <p className="text-[12px] leading-[17px] text-[hsl(var(--subtle-foreground))]">
          {card.sync}
        </p>
      ) : null}
    </section>
  );
}

/** Whether Cloud says this account holds no plan: null until it answers (or when it cannot be read). */
export function useFree(read: boolean): boolean | null {
  const [free, setFree] = useState<boolean | null>(null);
  useEffect(() => {
    if (!read) return;
    let live = true;
    void hostedAccount.get().then(
      (account) => live && setFree(offersUnlock(account)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);
  return free;
}

export function WebStartCard({
  web,
  className,
}: {
  web?: WebWindowValue | null;
  className?: string | undefined;
}) {
  const own = useWebWindow();
  const here = web === undefined ? own : web;
  const [unlocking, setUnlocking] = useState(false);
  // Cloud is asked only once the card could show: a window with chats, or a Mac on line, reads nothing here.
  const could = here ? startCard(here.window, here.mac, { free: null }) !== null : false;
  const free = useFree(could);
  const card = here ? startCard(here.window, here.mac, { free }) : null;
  if (!card) return null;
  return (
    <>
      <StartCardView card={card} onUnlock={() => setUnlocking(true)} className={className} />
      <UnlockPlans open={unlocking} onOpenChange={setUnlocking} source={hostedAccount} />
    </>
  );
}
