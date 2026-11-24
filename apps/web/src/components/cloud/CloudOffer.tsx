// "Use your Claude subscription here too?": asked once, the first time someone starts a chat in Cloud. One quiet line with a Yes and a No, beside the start and never in front of it: the chat starts whatever is
// answered, or nothing is. Yes starts the browser approval Settings > Models & keys' Use everywhere makes; No is
// remembered and the same choice stays in Settings. Shown only where this computer holds a plan login that one approval
// would carry to Cloud (cloudToo), so a window with none, or a plan already connected, never sees it.
// docs/ "The Cloud offer" (the "Use them in Cloud too" row left Your setup).
import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { cloudToo } from "../../routes/onboarding/model.ts";
import { startConnect, useNow } from "../../routes/settings/Connections.tsx";
import {
  answerCloudOffer,
  cloudOfferTitle,
  mayOfferCloud,
  noteCloudOfferShown,
  useCloudOfferSaved,
} from "../../state/cloud-offer.ts";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { Dot } from "../environment/parts.tsx";

/** What the line says once it is answered, until the page it is on goes. */
const ANSWERED = {
  yes: "Approve it in your browser. Chats in Cloud then use it too.",
  no: "Turn it on any time in Settings > Models & keys.",
} as const;

/** `countShown`: false where the offer sits in a popover that opens and closes (Review's Ask): showing it uses nothing up, only an answer does. */
export function CloudOffer({
  className,
  countShown = true,
}: {
  className?: string;
  countShown?: boolean;
}) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const saved = useCloudOfferSaved();
  const now = useNow();
  const offered = cloudToo(engines, now);
  // What this line asked, kept while it is on screen: the answer hides the offer for good, but the line says what it did.
  const [said, setSaid] = useState<"yes" | "no" | null>(null);
  // On screen from the first moment it may be, until it is answered or nothing is left to approve. Counted once, then:
  // a start that never read it still counts toward MAX_SHOWN, and the count must not take the line off its own screen.
  const [live, setLive] = useState(false);
  const counted = useRef(false);
  useEffect(() => {
    if (!countShown || counted.current || !mayOfferCloud(saved, cloudToo(engines, now))) return;
    counted.current = true;
    noteCloudOfferShown();
    setLive(true);
  }, [saved, engines, now, countShown]);
  const up = countShown
    ? live && saved.answer === null && offered.length > 0
    : mayOfferCloud(saved, offered);
  if (said !== null) {
    return (
      <p
        role="status"
        className={
          className ?? "mt-2 flex items-center gap-x-2 text-[13px] leading-5 text-muted-foreground"
        }
      >
        {ANSWERED[said]}
      </p>
    );
  }
  if (!up) return null;
  const answer = (yes: boolean) => {
    answerCloudOffer(yes ? "yes" : "no");
    setSaid(yes ? "yes" : "no");
    // Not waited for: the approval is the person's, in the browser, and Settings shows it waiting.
    if (yes && client) for (const o of offered) startConnect(o.engine, client, refresh);
  };
  return (
    <div
      role="group"
      aria-label={cloudOfferTitle(offered)}
      className={
        className ??
        "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] leading-5 text-foreground"
      }
    >
      <Dot tone="idle" />
      <span className="min-w-0">{cloudOfferTitle(offered)}</span>
      <span className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!client}
          onClick={() => answer(true)}
        >
          Yes
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => answer(false)}>
          No
        </Button>
      </span>
    </div>
  );
}
