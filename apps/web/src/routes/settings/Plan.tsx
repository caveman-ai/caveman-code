import type { AccountSummary, CodeGift } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Progress } from "@caveman-app/ui/components/progress";
import { Switch } from "@caveman-app/ui/components/switch";
import { Tag } from "@caveman-app/ui/components/tag";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import type { CastCharacter, MascotPose } from "@caveman-app/ui/mascot/poses";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useRemoteControl } from "../../components/RemoteControl.tsx";
import { planColumns, recommended } from "../../components/unlock-model.ts";
import { openExternal, openSoon } from "../../panels/browser/BrowserBar.tsx";
import { useAccountRead } from "../../state/account.ts";
import { BILLING_PATH, hostedAccount, isHostedCloud } from "../../state/cloud.ts";
import { requestId, useRuntimeClient, useWebWindow } from "../../state/runtime.tsx";
import { SignIn } from "./Account.tsx";
import {
  billingFingerprint,
  canManageBilling,
  ceilingLine,
  computersLine,
  defaultRefill,
  disputeMail,
  draftChanged,
  draftProblem,
  draftRequest,
  giftLine,
  giftsBlurb,
  higherLimitMail,
  moveAction,
  paygDraft,
  paygStatus,
  planCard,
  planLabel,
  planLadder,
  planMove,
  planPrice,
  plansSmallPrint,
  planWindows,
  refillLine,
  resetsLabel,
  subscriptionLine,
  topUps,
  usd,
  wholeDollars,
  windowLabel,
  yearlySaving,
  type AutoTopup,
  type AutoTopupCatalog,
  type OfferPlan,
  type PaygDraft,
} from "./account-model.ts";
import { Segmented, SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";
import "./plan.css";

export type Checkout = { kind: "plan"; plan: string; interval: "month" | "year"; seats?: number } | { kind: "topup"; amount_usd: number };
/** Pay as you go's settings as account.auto_topup takes them: what is left out, Cloud keeps or works out from the limit. */
export type PaygSettings = { enabled: boolean; month_limit_usd?: number; amount_usd?: number; below_usd?: number };
/** What Pay as you go's controls do; each throws Cloud's refusal, which the row shows beside itself. */
export interface PaygActions {
  /** On, off or new settings; with `needsCard`, Stripe's page to save one opens in the browser, inside the click. */
  readonly save: (settings: PaygSettings, needsCard: boolean) => Promise<void>;
  /** Stripe's page to save another card. */
  readonly changeCard: () => Promise<void>;
  /** The open invoice's page, where the cardholder confirms a payment their bank held. */
  readonly confirm: (url: string) => void;
}
type Credits = NonNullable<AccountSummary["credits"]>;
type Offer = NonNullable<AccountSummary["offer"]>;

/**
 * Settings > Plan: the organization's Caveman Code plan, how much of each limit is used (a bar and a reset, never
 * dollars: docs/ section 9), the free months it earned to give friends, every plan Cloud sells side by side
 * as the website's pricing page draws them, and credits. Every
 * price and allowance is the offer Cloud serves (account.offer), never the app's own. Buying opens Stripe Checkout
 * in the browser, Manage billing Stripe's
 * billing portal (card, invoices, cancelling); the same page runs in the desktop app and the browser. `?plan=max`
 * raises that plan's card (the sidebar meter and a used-up window link here).
 *
 * A browser window with no computer behind it reads the plan from Cloud itself and buys one through Cloud's own
 * checkout; credits, invoices and Pay as you go are then one button away, on Cloud's billing page.
 */
export function PlanSettings() {
  const { client, connection } = useRuntimeClient();
  const read = useAccountRead();
  const cloudOnly = useWebWindow() !== null && client === null;
  const remote = useRemoteControl();
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!read) return;
    read().then(setAccount, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [read]);
  useEffect(load, [load, connection, remote.status?.account?.email, remote.status?.runtime_id]);

  // Back from Stripe in the browser: Stripe tells Cloud a moment later, so read again on focus and every few seconds
  // for two minutes, until the plan, balance or gifts change.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const seen = useRef(billingFingerprint(account?.credits));
  seen.current = billingFingerprint(account?.credits);
  useEffect(() => {
    if (awaiting === null) return;
    if (seen.current !== awaiting) {
      setAwaiting(null);
      return;
    }
    const poll = window.setInterval(load, 4000);
    const stop = window.setTimeout(() => setAwaiting(null), 120_000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
      window.removeEventListener("focus", load);
    };
  }, [awaiting, account, load]);
  // A plan or credits bought here run this computer's Caveman engine at once, as the Unlock sheet's do: once the purchase
  // lands, Cloud mints the credits key and the engines are read again. Turning credits off later stays the person's.
  const creditsAfter = useRef<string | null>(null);
  useEffect(() => {
    const before = creditsAfter.current;
    if (before === null || !client || !account || billingFingerprint(account.credits) === before) return;
    creditsAfter.current = null;
    if (account.credits_on === true) return;
    client.call("account.credits", { request_id: requestId(), enabled: true }).then(load, () => undefined);
  }, [account, client, load]);
  // `before`: what the page showed before Stripe, when the call itself already changed it (Pay as you go turned on).
  const leaveForStripe = (url: string, before = seen.current) => {
    setAwaiting(before);
    openExternal(url);
  };

  // Pay as you go. A page that needs a card opens in the click (openSoon), as a browser blocks one opened after a call.
  const payg: PaygActions = {
    save: async (settings, needsCard) => {
      const go = needsCard ? openSoon() : undefined;
      try {
        const done = await client!.call("account.auto_topup", { request_id: requestId(), ...settings });
        const next = account?.credits ? { ...account.credits, auto_topup: done.auto_topup } : null;
        setAccount((a) => (a?.credits ? { ...a, credits: { ...a.credits, auto_topup: done.auto_topup } } : a));
        if (done.url) {
          setAwaiting(billingFingerprint(next));
          return go ? go(done.url) : openExternal(done.url);
        }
        go?.(null);
        load();
      } catch (e) {
        go?.(null);
        throw e;
      }
    },
    changeCard: async () => {
      const go = openSoon();
      try {
        const done = await client!.call("account.auto_topup_card", { request_id: requestId() });
        setAwaiting(seen.current);
        go(done.url);
      } catch (e) {
        go(null);
        throw e;
      }
    },
    confirm: (url) => leaveForStripe(url),
  };

  // The gifts, read only once the plan has earned some (and again when that count moves).
  const [gifts, setGifts] = useState<ReadonlyArray<CodeGift> | null>(null);
  const earned = account?.credits?.gifts?.total ?? 0;
  const loadGifts = useCallback(() => {
    if (!client || earned === 0) return;
    client.call("account.gifts", {}).then((r) => setGifts(r.gifts), () => undefined);
  }, [client, earned]);
  useEffect(loadGifts, [loadGifts, account?.credits?.gifts?.open]);

  // A plan bought while this page was open: say thanks once, where its gifts appear.
  const before = useRef<number | null>(null);
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    if (!account?.credits) return;
    if (before.current === 0 && earned > 0) setThanks(true);
    before.current = earned;
  }, [account, earned]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const act = async (run: () => Promise<void>) => {
    if (!client && !cloudOnly) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /**
   * A call whose answer may be Stripe's page. With `page` (it will be), the tab opens now, inside the click
   * (openSoon), as a browser blocks one opened after the call; the answer points it there, or closes it.
   * Resolves to the answer when it named no page.
   */
  const viaStripe = async <T extends { readonly url?: string }>(page: boolean, call: () => Promise<T>): Promise<T | null> => {
    const go = page ? openSoon() : undefined;
    try {
      const done = await call();
      if (done.url) {
        setAwaiting(seen.current);
        if (go) go(done.url);
        else openExternal(done.url);
        return null;
      }
      go?.(null);
      return done;
    } catch (e) {
      go?.(null);
      throw e;
    }
  };
  const checkout = (params: Checkout) =>
    act(async () => {
      creditsAfter.current = seen.current;
      // A top-up and a first plan have a Checkout page; Cloud moves a held plan in place.
      const done = await viaStripe(params.kind === "topup" || !account?.credits?.subscription, (): Promise<{ readonly url?: string; readonly effective?: string }> =>
        client ? client.call("account.checkout", { request_id: requestId(), ...params }) : params.kind === "plan" ? hostedAccount.checkout(params.plan, params.interval) : Promise.reject(new Error("Buy credits on Caveman's billing page.")),
      );
      if (!done) return;
      setNotice(done.effective === "renewal" ? "Your plan changes at renewal." : done.effective === "payment" ? "Your plan changes once its prorated invoice is paid." : "Your plan changed.");
      load();
    });
  const billingPage = () => openExternal(BILLING_PATH);
  const billing = (action: "portal" | "resume") =>
    cloudOnly ? billingPage() : act(async () => {
      const done = await viaStripe(action === "portal", () => client!.call("account.billing", { request_id: requestId(), action }));
      if (!done) return;
      setNotice("Your plan keeps renewing.");
      load();
    });
  const sendGift = async (code: string, email: string) => {
    const sent = await client!.call("account.gift_send", { request_id: requestId(), code, email });
    setGifts((all) => all?.map((g) => (g.code === sent.code ? sent : g)) ?? all);
  };

  const [params] = useSearchParams();
  if (!account) return error ? <p className="text-[13px] text-destructive">{error}</p> : null;
  if (!account.signed_in) {
    return (
      <SettingsCard title="Caveman account" description={isHostedCloud(account.cloud_url ?? "") ? "Sign in to see your plan, buy one, and give free months to friends." : "Sign in to see your organization's plan."}>
        <SignIn remote={remote} />
      </SettingsCard>
    );
  }
  if (account.credits === null) {
    return (
      <SettingsCard title="Plan">
        <SettingsCardBody className="text-[13px] text-muted-foreground">This Caveman server does not sell Caveman Code plans or credits. Your engines run on your own keys and logins.</SettingsCardBody>
      </SettingsCard>
    );
  }
  if (!account.credits) return account.error ? <p className="text-[13px] text-muted-foreground">{account.error}</p> : null;
  return (
    <PlanView
      credits={account.credits}
      offer={account.offer ?? null}
      canManage={canManageBilling(account.role)}
      busy={busy}
      error={error}
      notice={notice}
      gifts={gifts}
      thanks={thanks}
      initialPlan={params.get("plan")}
      onCheckout={checkout}
      onBilling={billing}
      onSendGift={sendGift}
      creditsOn={account.credits_on === true}
      onCreditsChange={load}
      organization={account.organization_name}
      payg={payg}
      {...(cloudOnly ? { billingPage } : {})}
    />
  );
}

/** The page from what account.get answered: the plan held, its gifts, the plans on sale, then credits. */
export function PlanView(props: {
  credits: Credits;
  offer: Offer | null;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  gifts: ReadonlyArray<CodeGift> | null;
  thanks: boolean;
  initialPlan?: string | null;
  onCheckout: (c: Checkout) => void;
  onBilling: (action: "portal" | "resume") => void;
  onSendGift: (code: string, email: string) => Promise<void>;
  creditsOn: boolean;
  onCreditsChange: () => void;
  organization?: string | undefined;
  payg: PaygActions;
  /** A browser window with no computer behind it: opens Cloud's billing page, where credits are bought and gifts sent. */
  billingPage?: () => void;
}) {
  const { credits, offer, canManage } = props;
  // What a click answered (a refusal, "Your plan changed.") shows where the click was: under the plan cards for
  // their buttons, in the plan held for everything else. The cards are a screen below the plan held.
  const [fromCards, setFromCards] = useState(false);
  const from = <A extends unknown[]>(cards: boolean, run: (...args: A) => void) => (...args: A) => {
    setFromCards(cards);
    run(...args);
  };
  return (
    <div className="flex flex-col gap-10">
      <CurrentPlan credits={credits} offer={offer} canManage={canManage} busy={props.busy} error={fromCards ? null : props.error} notice={fromCards ? null : props.notice} onBilling={from(false, props.onBilling)} />
      {credits.gifts && credits.gifts.total > 0 && !props.billingPage ? (
        <GiftsCard credits={credits} offer={offer} gifts={props.gifts} thanks={props.thanks} canSend={canManage} onSend={props.onSendGift} />
      ) : null}
      <PlansCard
        credits={credits}
        offer={offer}
        canManage={canManage}
        busy={props.busy}
        error={fromCards ? props.error : null}
        notice={fromCards ? props.notice : null}
        initialPlan={props.initialPlan ?? null}
        onCheckout={from(true, props.onCheckout)}
        onBilling={from(true, props.onBilling)}
      />
      <CreditsCard
        credits={credits}
        offer={offer}
        buying={canManage && offer?.purchasable === true}
        busy={props.busy}
        onCheckout={from(false, props.onCheckout)}
        creditsOn={props.creditsOn}
        onCreditsChange={props.onCreditsChange}
        organization={props.organization}
        payg={props.payg}
        billingPage={props.billingPage}
      />
    </div>
  );
}

/** The plan held: its name and price, where its billing stands, its windows and computers, and the billing portal. */
function CurrentPlan({ credits, offer, canManage, busy, error, notice, onBilling }: {
  credits: Credits;
  offer: Offer | null;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onBilling: (action: "portal" | "resume") => void;
}) {
  const sub = credits.subscription;
  const line = sub ? subscriptionLine(sub, offer) : null;
  // A plan set to end, a cancelled free month included: Resume keeps it, and Cloud refuses changes until then.
  const ending = sub?.cancel_at_period_end === true && sub.status === "active";
  const held = offer?.plans.find((p) => p.plan === credits.plan);
  // A free month says its price in the line under the name; Free has none.
  const price = held && !sub?.trial_end ? planPrice(held, sub?.interval === "year" ? "year" : "month") : null;
  const tag = sub
    ? sub.status === "past_due"
      ? "Payment failed"
      : sub.status === "canceled"
        ? "Unpaid"
        : sub.trial_end
          ? line?.attention
            ? "Ends soon"
            : "Free month"
          : ending
            ? "Ending"
            : sub.status !== "active" || line?.attention
              ? "Pending"
              : null
    : null;
  return (
    <SettingsCard title="Your plan">
      <SettingRow
        icon={<Glyph name="plan" scale={2} />}
        label={
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{planLabel(credits.plan, offer)}</span>
            {credits.plan === "team" ? <span className="text-[13px] text-muted-foreground">{credits.seats === 1 ? "1 seat" : `${credits.seats} seats`}</span> : null}
            {tag ? <Tag tone={sub?.status === "past_due" || sub?.status === "canceled" ? "red" : tag === "Ends soon" || tag === "Ending" ? "yellow" : "neutral"}>{tag}</Tag> : null}
          </span>
        }
        description={
          line ? (
            <span className={line.attention ? "text-foreground" : undefined}>{line.text}</span>
          ) : credits.plan === "free" ? (
            "Your own keys and logins. Pick a plan below for included usage and Cloud."
          ) : undefined
        }
      >
        {price ? (
          <span className="text-[13px] tabular-nums text-muted-foreground">
            <span className="text-foreground">{price.amount}</span> {price.per}
          </span>
        ) : null}
        {canManage && ending ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onBilling("resume")}>
            Resume plan
          </Button>
        ) : null}
        {canManage && credits.customer_linked ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onBilling("portal")}>
            Manage billing
          </Button>
        ) : null}
      </SettingRow>
 {/* A limit is its percent used, a bar and its reset, never dollars. */}
      {planWindows(credits.windows).map((w) => (
        <SettingRow key={w.window} label={windowLabel(w.window)} description={resetsLabel(w.resets_at)}>
          <span aria-hidden className={cn("text-[13px] tabular-nums", w.used_pct >= 100 ? "text-destructive" : "text-muted-foreground")}>
            {w.used_pct >= 100 ? "Used up" : `${w.used_pct}%`}
          </span>
          {/* The sidebar meter's tones: amber from 80% used, red at the limit. */}
          <Progress
            className="w-40"
            value={w.used_pct}
            {...(w.used_pct >= 100 ? { indicatorClassName: "bg-destructive" } : w.used_pct >= 80 ? { indicatorClassName: "bg-warning" } : {})}
            aria-label={`${windowLabel(w.window)}: ${w.used_pct}% used`}
          />
        </SettingRow>
      ))}
      {credits.computers ? <ComputersRow computers={credits.computers} planUsage={credits.windows.length > 0} /> : null}
      {(credits.fulfillment_pending ?? 0) > 0 ? (
        <SettingRow label="Payment being reviewed" description="Paid, but the credits aren't added yet. Caveman adds them or refunds you; nothing more is charged." />
      ) : null}
      {!canManage ? (
        <SettingsCardBody className="text-[13px] text-muted-foreground">An owner of your organization can change the plan, buy credits or manage billing.</SettingsCardBody>
      ) : null}
      {notice ? (
        <SettingsCardBody className="text-[13px]">
          <p role="status">{notice}</p>
        </SettingsCardBody>
      ) : null}
      {error ? (
        <SettingsCardBody className="text-[13px] text-destructive">
          <p role="alert">{error}</p>
        </SettingsCardBody>
      ) : null}
    </SettingsCard>
  );
}

/** Cloud: the share of this month's plan it took, and nothing about what holds it. */
function ComputersRow({ computers, planUsage }: { computers: NonNullable<Credits["computers"]>; planUsage: boolean }) {
  const line = computersLine(computers, planUsage);
  if (line === undefined) return null;
  return (
    <SettingRow label="Cloud">
      <span className="text-[13px] tabular-nums text-muted-foreground">{line}</span>
    </SettingRow>
  );
}

/** The free months the plan earned: each one's link to copy or send, and who took the ones that are gone. */
function GiftsCard({ credits, offer, gifts, thanks, canSend, onSend }: {
  credits: Credits;
  offer: Offer | null;
  gifts: ReadonlyArray<CodeGift> | null;
  thanks: boolean;
  canSend: boolean;
  onSend: (code: string, email: string) => Promise<void>;
}) {
  const total = credits.gifts?.total ?? 0;
  const open = credits.gifts?.open ?? 0;
  const blurb = giftsBlurb(credits.plan, total, offer?.gift?.plan ?? "pro", offer);
  return (
    <SettingsCard
      title="Free months to give"
      description={thanks ? `Thanks for choosing ${planLabel(credits.plan, offer)}. ${blurb}` : blurb}
      actions={<span className="text-[13px] tabular-nums text-muted-foreground">{open === 0 ? "All given" : `${open} of ${total} left`}</span>}
    >
      {gifts === null ? (
        <SettingsCardBody className="text-[13px] text-muted-foreground">Loading…</SettingsCardBody>
      ) : (
        gifts.map((g) => <GiftRow key={g.code} gift={g} canSend={canSend} onSend={onSend} />)
      )}
    </SettingsCard>
  );
}

function GiftRow({ gift, canSend, onSend }: { gift: CodeGift; canSend: boolean; onSend: (code: string, email: string) => Promise<void> }) {
  const line = giftLine(gift);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  const live = gift.status === "open" || gift.status === "sent";
  const copy = () => void navigator.clipboard.writeText(gift.url).then(() => setCopied(true), () => setError("The clipboard is not reachable here. The link is " + gift.url));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSend(gift.code, email.trim());
      setSending(false);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="divide-y divide-border/60">
      <SettingRow
        icon={<Glyph name={gift.status === "redeemed" ? "state-done" : "gift"} />}
        label={<span className={cn(gift.status === "redeemed" && "text-muted-foreground")}>{line.label}</span>}
        description={line.description}
      >
        {live ? (
          <>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            {canSend && !sending ? (
              <Button size="sm" variant="outline" onClick={() => setSending(true)}>
                {gift.status === "sent" ? "Send again" : "Send by email"}
              </Button>
            ) : null}
          </>
        ) : null}
      </SettingRow>
      {sending ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-5 py-3 pl-[68px]">
          <label htmlFor={id} className="sr-only">
            Friend's email
          </label>
          <Input
            id={id}
            type="email"
            required
            autoFocus
            placeholder="friend@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSending(false)}
            className="h-8 w-64 max-w-full"
          />
          <Button size="sm" type="submit" disabled={busy || !email.trim()}>
            Send
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setSending(false)}>
            Cancel
          </Button>
          <p className="basis-full text-[12.5px] text-muted-foreground">We send one short email in your name with the link. Nothing else, ever.</p>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="px-5 py-2 pl-[68px] text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Member = { who: CastCharacter; pose: MascotPose };
/**
 * Who stands on a paid plan's card, cheapest plan first: the app's own cast (Settings > Appearance), more of them as
 * the plan grows, and the line they say. Free brings nobody. The lines are jokes, never figures.
 */
const TRIBES: ReadonlyArray<{ tribe: ReadonlyArray<Member>; says: string }> = [
  { tribe: [{ who: "caveman", pose: "working" }], says: "Small plan. Good start." },
  { tribe: [{ who: "caveman", pose: "working" }, { who: "cavewoman", pose: "working" }], says: "Bigger plan. More code." },
  { tribe: [{ who: "cavewoman", pose: "working" }, { who: "caveman", pose: "done" }, { who: "elder", pose: "working" }], says: "Caveman pick this one." },
  { tribe: [{ who: "elder", pose: "thinking" }, { who: "caveman", pose: "working" }, { who: "cavewoman", pose: "working" }, { who: "kid", pose: "working" }], says: "Whole tribe code all day." },
];

/** What the tribe says: pixel type on a notched block, its tail over whoever stands first (plan.css). */
function Say({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("plan-say", className)}>
      <span className="plan-pixel px-notch-2 block bg-foreground px-2 pb-[5px] pt-1 text-[16px] leading-[18px] text-background">{children}</span>
    </span>
  );
}

/**
 * Every plan side by side, as the website's pricing page draws them: a card per plan (Free first) with its people on
 * a stage, its name, price and headline, the one button that moves to it, and what else it holds. One card is raised:
 * the plan a link named, else the plan held, else the recommended one.
 */
function PlansCard({ credits, offer, canManage, busy, error, notice, initialPlan, onCheckout, onBilling }: {
  credits: Credits;
  offer: Offer | null;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  initialPlan: string | null;
  onCheckout: (c: Checkout) => void;
  onBilling: (action: "portal" | "resume") => void;
}) {
  const sub = credits.subscription;
  const [interval, setInterval] = useState<"month" | "year">(sub?.interval === "year" ? "year" : "month");
  if (!offer) {
    return (
      <SettingsCard title="Plans">
        <SettingsCardBody className="text-[13px] text-muted-foreground">This Caveman server does not list its plans to the app yet. Ask whoever runs it to update it.</SettingsCardBody>
      </SettingsCard>
    );
  }
  const ladder = planLadder(offer, credits.plan);
  const saving = yearlySaving(offer);
  const ending = sub?.cancel_at_period_end === true && sub.status === "active";
  const held = { label: planLabel(credits.plan, offer), periodEnd: sub?.current_period_end, trial: !!sub?.trial_end };
  // On Free, the plan the Unlock sheet recommends wears the ribbon here too.
  const columns = planColumns(offer);
  const pick = credits.plan === "free" ? columns[recommended(columns)]?.plan : undefined;
  // The meter or a used-up window linked here with a plan: that card is the raised one.
  const raised = initialPlan && ladder.some((p) => p.plan === initialPlan) ? initialPlan : credits.plan !== "free" ? credits.plan : pick;
  // Why no plan can be moved to from here, said once under the cards.
  const heldBack = !canManage ? "An owner of your organization can change the plan." : !offer.purchasable ? "This Caveman server does not take payments." : null;
  const paid = ladder.filter((p) => p.usd_month > 0);
  const cards = ladder.map((plan) => {
    const move = planMove(plan, { plan: credits.plan, interval: sub?.interval }, interval, offer);
    const action = moveAction(move, plan, held, interval);
    // A plan set to end takes no change until it is resumed; leaving for Free is still Manage billing's.
    const open = action !== null && heldBack === null && !(ending && move !== "free");
    return { plan, move, action: open ? action : null, current: move === "current" };
  });
  const waiting = heldBack ?? (ending ? "Resume your plan above before changing it." : null);
  // One note for every button says it once, under the cards; notes that differ sit under their own buttons.
  const notes = new Set(cards.flatMap((c) => (c.action ? [c.action.note] : [])));
  const shared = waiting === null && notes.size === 1 ? [...notes][0]! : null;
  const smallPrint = plansSmallPrint(ladder, offer);
  return (
    <SettingsCard
      title="Plans"
      actions={
        <Segmented
          label="Billing interval"
          value={interval}
          options={[
            { value: "month", label: "Monthly" },
            { value: "year", label: saving > 0 ? `Yearly · save ${saving}%` : "Yearly" },
          ]}
          onChange={setInterval}
        />
      }
    >
      <div className="plan-cards">
        <div role="group" aria-label="Plans" className="plan-grid" style={{ "--plans": ladder.length } as CSSProperties}>
          {cards.map(({ plan, move, action, current }) => (
            <PlanCardView
              key={plan.plan}
              plan={plan}
              offer={offer}
              interval={interval}
              tribe={plan.usd_month > 0 ? TRIBES[Math.min(paid.indexOf(plan), TRIBES.length - 1)] : undefined}
              ribbon={plan.plan === pick ? "Recommended" : null}
              raised={plan.plan === raised}
            >
              {current ? (
                <Button variant="secondary" className="w-full" disabled>
                  Your plan
                </Button>
              ) : action ? (
                <>
                  <Button
                    className="w-full"
                    variant={action.primary && plan.plan === raised ? "default" : "outline"}
                    disabled={busy || (move === "free" && !credits.customer_linked)}
                    onClick={() => (move === "free" ? onBilling("portal") : onCheckout({ kind: "plan", plan: plan.plan, interval }))}
                  >
                    {action.button}
                  </Button>
                  {shared ? null : <p className="mt-2 text-pretty text-[12px] leading-[17px] text-muted-foreground">{action.note}</p>}
                </>
              ) : null}
            </PlanCardView>
          ))}
        </div>
      </div>
      {error || notice || waiting || shared || smallPrint ? (
        <SettingsCardBody className="flex flex-col gap-1 text-pretty text-[12.5px] leading-[18px]">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          {waiting || shared ? <p className="text-muted-foreground">{waiting ?? shared}</p> : null}
          {smallPrint ? <p className="text-[hsl(var(--subtle-foreground))]">{smallPrint}</p> : null}
        </SettingsCardBody>
      ) : null}
    </SettingsCard>
  );
}

/**
 * One plan's card. Its rows line up with the other cards' through the grid (plan.css): the stage, the name, the
 * price, the headline, the button (`children`) and the rest. The people stand still until the card is pointed at or
 * holds focus; then they work, hop and say their line (the raised card's line always shows).
 */
function PlanCardView({ plan, offer, interval, tribe, ribbon, raised, children }: {
  plan: OfferPlan;
  offer: Offer;
  interval: "month" | "year";
  tribe: (typeof TRIBES)[number] | undefined;
  ribbon: string | null;
  raised: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [live, setLive] = useState(false);
  // Nothing moves while the app is in the background: a card's button sends the person to checkout in the browser
  // with the pointer still on the card.
  useEffect(() => {
    if (!live) return;
    const rest = () => setLive(false);
    window.addEventListener("blur", rest);
    return () => window.removeEventListener("blur", rest);
  }, [live]);
  const price = planPrice(plan, interval);
  const card = planCard(plan, offer);
  return (
    <article
      aria-labelledby={id}
      data-raised={raised ? "" : undefined}
      data-live={live ? "" : undefined}
      className="plan-card group/plan"
      onPointerEnter={() => setLive(true)}
      onPointerLeave={() => setLive(false)}
      // Keyboard focus only: a clicked button keeps focus long after the pointer has left.
      onFocus={(e) => setLive(e.target.matches(":focus-visible"))}
      onBlur={() => setLive(false)}
    >
      <div className="plan-stage">
        {ribbon ? <p className="plan-pixel absolute inset-x-0 top-0 flex h-6 items-center justify-center bg-foreground text-[16px] leading-none text-background">{ribbon}</p> : null}
        {tribe ? (
          <span aria-hidden className="flex min-w-0 flex-col items-start gap-1.5">
            <Say className={cn("transition-opacity duration-150 ease-snap", !raised && "opacity-0 group-focus-within/plan:opacity-100 group-hover/plan:opacity-100 touch:opacity-100")}>{tribe.says}</Say>
            <span className="flex w-full items-end">
              {tribe.tribe.map(({ who, pose }, i) => (
                <span key={who} className="plan-member" style={{ "--i": i } as CSSProperties}>
                  <Mascot character={who} pose={pose} scale={2} animate={live} />
                </span>
              ))}
            </span>
          </span>
        ) : null}
      </div>
      <div className="px-4 pt-4">
        {/* The card's name (aria-labelledby): the kit draws Settings' headings, so this is no heading of its own. */}
        <p id={id} className="plan-pixel whitespace-nowrap text-[24px] lowercase leading-none">
          {plan.label}
          <span aria-hidden className={raised ? undefined : "text-muted-foreground"}>
            _
          </span>
        </p>
        {card.fit ? <p className="mt-2 text-pretty text-[12.5px] leading-[17px] text-muted-foreground">{card.fit}</p> : null}
      </div>
      <div className="px-4 pt-4">
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[28px] font-semibold leading-8 tracking-[-0.02em] tabular-nums">{price.amount}</span>
          <span className="text-[12px] text-muted-foreground">/ month</span>
        </p>
        <p className="mt-0.5 text-[12px] text-[hsl(var(--subtle-foreground))]">{price.billed ?? (plan.usd_month > 0 ? "Billed monthly" : "No card needed")}</p>
      </div>
      <div className="mx-4 mt-4 border-t border-border/60 pt-3">
        <p className="text-[17px] font-semibold leading-[22px] tracking-[-0.01em] tabular-nums">{card.lead.figure}</p>
        <p className="text-[12.5px] leading-[18px] text-muted-foreground">{card.lead.rest}</p>
        {card.lead.line ? <p className="mt-1.5 text-pretty text-[12.5px] leading-[17px] text-[hsl(var(--subtle-foreground))]">{card.lead.line}</p> : null}
      </div>
      {/* Always in the grid, button or not: a card that dropped this cell would put its list a row too high. */}
      <div className="px-4 pt-4 empty:pt-0">{children}</div>
      <ul className="mx-4 mb-2 mt-4 self-start justify-self-stretch">
        {card.rows.map((row) => (
          <li key={row} className="border-t border-border/60 py-2 text-pretty text-[12.5px] leading-[17px] text-muted-foreground">
            {row}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Credits: the balance, top-ups, Pay as you go, and whether the Caveman engine runs on them. */
function CreditsCard({ credits, offer, buying, busy, onCheckout, creditsOn, onCreditsChange, organization, payg, billingPage }: {
  credits: Credits;
  offer: Offer | null;
  buying: boolean;
  busy: boolean;
  onCheckout: (c: Checkout) => void;
  creditsOn: boolean;
  onCreditsChange: () => void;
  organization: string | undefined;
  payg: PaygActions;
  billingPage?: (() => void) | undefined;
}) {
  const catalog = offer?.auto_topup;
  const balance = (
    <SettingRow
      label="Balance"
      description={credits.windows.length === 0 ? undefined : credits.use_balance ? "Credits pay once a limit is used up." : "Credits are off past the limits."}
    >
      <span className="text-[13px] tabular-nums">{usd(credits.balance_micros)}</span>
    </SettingRow>
  );
  // With no computer behind the window nothing here can top up or change Pay as you go: Cloud's own page does.
  if (billingPage) {
    return (
      <SettingsCard title="Credits" description="Usage at list price, on top of a plan or without one.">
        {balance}
        {credits.auto_topup ? <PayAsYouGoStatus auto={credits.auto_topup} /> : null}
        {buying ? (
          <SettingRow label="Top up" description="Credits, Pay as you go and invoices are on Caveman's billing page.">
            <Button size="sm" variant="outline" onClick={billingPage}>
              Open billing
            </Button>
          </SettingRow>
        ) : null}
      </SettingsCard>
    );
  }
  return (
    <SettingsCard title="Credits" description="Usage at list price, on top of a plan or without one.">
      {balance}
      {buying && offer ? (
        <SettingRow label="Top up" description={`Checkout opens in your browser. Credits last ${offer.top_up.expires_days} days.`}>
          {topUps(offer).map((amount) => (
            <Button key={amount} size="sm" variant="outline" disabled={busy} onClick={() => onCheckout({ kind: "topup", amount_usd: amount })}>
              ${amount}
            </Button>
          ))}
        </SettingRow>
      ) : null}
      {buying && catalog ? (
        <PayAsYouGo auto={credits.auto_topup} catalog={catalog} organization={organization} actions={payg} />
      ) : credits.auto_topup ? (
        <PayAsYouGoStatus auto={credits.auto_topup} />
      ) : null}
      <UseCredits on={creditsOn} onChange={onCreditsChange} />
    </SettingsCard>
  );
}

/** The name, and what needs the person beside it. */
function PaygLabel({ tag }: { tag: ReturnType<typeof paygStatus>["tag"] }) {
  return (
    <span className="flex items-center gap-2">
      Pay as you go
      {tag ? <Tag tone={tag.tone}>{tag.text}</Tag> : null}
    </span>
  );
}

/** Pay as you go for someone who cannot change it: where it stands, no card and no controls. Nothing while it is off. */
function PayAsYouGoStatus({ auto }: { auto: AutoTopup }) {
  const status = paygStatus(auto, false);
  if (status.state === "off") return null;
  return <SettingRow label={<PaygLabel tag={status.tag} />} description={<span className={status.attention ? "text-warning" : undefined}>{status.line}</span>} />;
}

/**
 * Pay as you go for Owner and Finance. Off: one line, then the limit and Turn on. On: the month so far, what one
 * charge adds below what, the card, and Edit limit, Change card and Turn off. Paused: why, in amber, its one fix, and Turn off.
 * Done for the month: when it starts again, and Raise limit. Every number is Cloud's.
 */
function PayAsYouGo({ auto, catalog, organization, actions }: { auto: AutoTopup | undefined; catalog: AutoTopupCatalog; organization: string | undefined; actions: PaygActions }) {
  const status = paygStatus(auto, true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const turnOff = () => void run(() => actions.save({ enabled: false }, false));
  const changeCard = () => void run(actions.changeCard);
  const form = status.state === "off" || editing;
  return (
    <div className="divide-y divide-border/60">
      <SettingRow label={<PaygLabel tag={status.tag} />} description={<span className={status.attention ? "text-warning" : undefined}>{status.line}</span>}>
        {status.state === "paused" ? (
          <>
            {status.action === "confirm" && auto?.confirm_url ? (
              <Button size="sm" variant="outline" onClick={() => actions.confirm(auto.confirm_url!)}>
                Confirm the payment
              </Button>
            ) : status.action === "contact" ? (
              // A plain link: the desktop hands mailto to the mail app, and only http(s) to a browser tab.
              <Button size="sm" variant="outline" asChild>
                <a href={disputeMail(organization)}>Contact us</a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={changeCard}>
                Change card
              </Button>
            )}
            {/* Off is always one click away, a pause included: nothing is charged while it is off. */}
            {auto?.enabled ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>
                Turn off
              </Button>
            ) : null}
          </>
        ) : status.state === "card" ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={changeCard}>
              Add card
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>
              Turn off
            </Button>
          </>
        ) : status.state === "on" || status.state === "limit" ? (
          <>
            {!editing ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                {status.state === "limit" ? "Raise limit" : "Edit limit"}
              </Button>
            ) : null}
            {status.state === "on" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={changeCard}>
                Change card
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>
              Turn off
            </Button>
          </>
        ) : null}
      </SettingRow>
      {form ? (
        <PaygForm
          auto={auto}
          catalog={catalog}
          organization={organization}
          on={status.state !== "off"}
          busy={busy}
          onSave={(settings) => run(() => actions.save(settings, !auto?.card)).then((saved) => saved && setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="px-5 py-2.5 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const amountField = "h-8 w-[104px] pl-5 tabular-nums text-foreground";

/** A dollar field: the sign drawn inside it, whole dollars typed. */
function DollarInput({ id, value, onChange, invalid, describedBy, label }: { id: string; value: string; onChange: (v: string) => void; invalid: boolean; describedBy?: string | undefined; label?: string }) {
  return (
    <span className="relative inline-flex">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        {...(label ? { "aria-label": label } : {})}
        className={cn(amountField, invalid && "border-warning focus-visible:border-warning")}
      />
    </span>
  );
}

/**
 * The limit with the ceiling beside it and what unlocks the next, a way to ask for more, and what one charge adds below
 * what: Cloud's default from the limit until the person opens Change and sets their own.
 */
function PaygForm({ auto, catalog, organization, on, busy, onSave, onCancel }: {
  auto: AutoTopup | undefined;
  catalog: AutoTopupCatalog;
  organization: string | undefined;
  on: boolean;
  busy: boolean;
  onSave: (settings: PaygSettings) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PaygDraft>(() => paygDraft(auto, catalog));
  // A new answer from Cloud (saved, or changed elsewhere) starts the form over from it.
  useEffect(() => setDraft(paygDraft(auto, catalog)), [auto?.month_limit_usd, auto?.amount_usd, auto?.below_usd, auto?.ceiling_usd]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = { limit: useId(), amount: useId(), below: useId(), problem: useId(), note: useId() };
  const problem = draftProblem(draft, catalog, auto?.ceiling_usd);
  const limit = wholeDollars(draft.limit);
  // Until the person sets their own: what Cloud holds for the limit it holds, else its default for the limit typed.
  const preview = auto && limit === auto.month_limit_usd ? { amount: auto.amount_usd, below: auto.below_usd } : limit ? defaultRefill(limit, catalog) : null;
  const set = (patch: Partial<PaygDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    onSave({ enabled: true, ...draftRequest(draft) });
  };
  const alerts = catalog.alert_pcts.filter((p) => p > 0);
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 px-5 py-3.5" aria-label="Pay as you go settings">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={ids.limit} className="text-[13.5px]">
            Monthly limit
          </label>
          <p id={ids.note} className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">
            {ceilingLine(auto, catalog)}{" "}
            <a href={higherLimitMail(organization, auto, catalog)} className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              Ask for a higher limit
            </a>
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <DollarInput id={ids.limit} value={draft.limit} onChange={(limit) => set({ limit })} invalid={problem?.field === "limit"} describedBy={problem ? ids.problem : ids.note} />
          <span className="text-[12.5px] text-muted-foreground">a month</span>
          {on ? (
            <>
              <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" type="submit" disabled={busy || problem !== null || !draftChanged(draft, auto)}>
                Save
              </Button>
            </>
          ) : (
            <Button size="sm" type="submit" disabled={busy || problem !== null}>
              Turn on
            </Button>
          )}
        </div>
      </div>
      {draft.custom ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          <label htmlFor={ids.amount}>Add</label>
          <DollarInput id={ids.amount} value={draft.amount} onChange={(amount) => set({ amount })} invalid={problem?.field === "amount"} describedBy={problem ? ids.problem : undefined} />
          <label htmlFor={ids.below}>when credits fall below</label>
          <DollarInput id={ids.below} value={draft.below} onChange={(below) => set({ below })} invalid={problem?.field === "below"} describedBy={problem ? ids.problem : undefined} />
          <Button size="sm" variant="ghost" type="button" onClick={() => set({ custom: false })}>
            Use the default
          </Button>
        </div>
      ) : preview ? (
        <p className="text-[12.5px] text-muted-foreground">
          {refillLine(preview.amount, preview.below)}.{" "}
          <button
            type="button"
            className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => set({ custom: true, amount: String(preview.amount), below: String(preview.below) })}
          >
            Change
          </button>
        </p>
      ) : null}
      {problem ? (
        <p id={ids.problem} role="status" className="text-[12.5px] text-warning">
          {problem.text}
        </p>
      ) : null}
      {!on ? (
        <p className="text-[12.5px] text-muted-foreground">
          {auto?.card ? "Charges the card you saved." : "Stripe opens in your browser once to save a card."}
          {alerts.length > 0 ? ` Owners and Finance get an email at ${alerts.map((p) => `${p}%`).join(" and ")} of the limit.` : ""}
        </p>
      ) : null}
    </form>
  );
}

/** Caveman credits on the Caveman engine: a credits key minted for this person, kept by the runtime. */
function UseCredits({ on, onChange }: { on: boolean; onChange: () => void }) {
  const { client } = useRuntimeClient();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (enabled: boolean) => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await client.call("account.credits", { request_id: requestId(), enabled });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        id={id}
        label="Use credits in the Caveman engine"
        description="Lists your plan's models there. They run on Caveman's keys, paid from your plan, then your credits."
      >
        <Switch id={id} disabled={!client || busy} checked={on} onCheckedChange={(next) => void set(next)} />
      </SettingRow>
      {error ? <SettingsCardBody className="text-[13px] text-destructive">{error}</SettingsCardBody> : null}
    </>
  );
}
