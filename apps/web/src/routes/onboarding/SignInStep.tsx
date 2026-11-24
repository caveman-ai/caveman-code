// 1. Sign in (required): a new account or the one you have, by email, GitHub or Google through Caveman Cloud's device
// flow, the telemetry disclosure the spec asks for, then the account, GitHub as this computer sees it, and the plan.
// docs/ "1. Sign in".

import type { CloudStatus } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRemoteControl } from "../../components/RemoteControl.tsx";
import { paidPlan } from "../../components/unlock-model.ts";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { HOSTED_CLOUD } from "../../state/cloud.ts";
import { funnelStep } from "../../state/desktop.ts";
import { useRuntimeLink } from "../../state/runtime.tsx";
import { planLabel, shortDay, subscriptionLine } from "../settings/account-model.ts";
import type { TelemetryChoice } from "../../state/desktop.ts";
import { useAccount, useGithubStatus } from "./data.ts";
import { Card, FlameMark, Nav, Ready, Row, Working } from "./parts.tsx";
import { registrationProblem, signedInAccount } from "./signin-model.ts";
import { SignInArt } from "./SignInArt.tsx";
import { ReportButton } from "../../components/ReportButton.tsx";

const firstName = (account: NonNullable<CloudStatus["account"]>) => {
  const local = account.email.split("@")[0] ?? "";
  const word = local.split(/[._-]/)[0] ?? local;
  return word ? word[0]!.toUpperCase() + word.slice(1) : "";
};

/** A new account or the one you have: the page's words, Cloud's form (cloud.signin `intent`) and the welcome follow it. */
type Intent = "signup" | "signin";

/** `onSkip` only where sign-in is not required (a development build, the smoke test, E2E): FirstRun decides. */
export function SignInStep({ onNext, onSkip }: { onNext: () => void; onSkip?: (() => void) | undefined }) {
  const remote = useRemoteControl();
  const { status } = remote;
  const link = useRuntimeLink();
  // Signed in as the rest of the app reads it (state/cloud.ts): an account Cloud has not since refused, with or
  // without a registered computer (signin-model.ts).
  const account = signedInAccount(status);
  const waiting = !account && status?.signin ? status.signin : null;
  // A code that ran out while waiting is replaced by the runtime: the page says the one on it is new.
  const code = waiting?.user_code ?? null;
  const [firstCode, setFirstCode] = useState<string | null>(null);
  if (code === null ? firstCode !== null : firstCode === null) setFirstCode(code);
  const renewed = firstCode !== null && code !== null && firstCode !== code;
  // A first run is most often someone new: it opens on a new account, one click from signing in.
  const [intent, setIntent] = useState<Intent>("signup");
  useEffect(() => {
    if (account) funnelStep("signed_in");
  }, [account]);

  if (account)
    return (
      <SignedIn
        account={account}
        fresh={intent === "signup"}
        onNext={onNext}
        problem={registrationProblem(status)}
        busy={remote.busy}
        onRetry={() => void remote.signIn({ intent: "signin" })}
      />
    );
  // The disclosure waits for the status too: shown, then replaced by the signed-in page, would count as seen unread.
  const foot = status ? <Disclosure onSkip={onSkip} /> : null;
  // The Terms of the Cloud this signs in to (a company's own, or Caveman's). A new account agrees to Caveman Cloud's
  // Free notice on Cloud's own page, never from here.
  const legal = cloudOrigin(status?.cloud_url);
  const signup = intent === "signup";
  const off = !status || remote.busy;
  const error = remote.error ?? status?.signin_error;

  if (waiting)
    return (
      <Split
        title={signup ? "Finish signing up in your browser" : "Finish in your browser"}
        desc={
          signup
            ? "Caveman's sign-in page is open in your browser. Make your account there and approve this computer; this window moves on by itself."
            : "Caveman's sign-in page is open in your browser. Approve this computer there and this window moves on by itself."
        }
        foot={foot}
      >
        {renewed ? <p className="mb-2 text-[13px] text-muted-foreground">The first code expired, so this one is new.</p> : null}
        <p className="text-[13px] text-muted-foreground">
          Only approve the code <span className="font-mono text-[15px] tracking-[0.12em] text-foreground">{waiting.user_code}</span>
        </p>
        <div className="-ml-3 mt-3 flex gap-1">
          <Button variant="ghost" onClick={() => openExternal(waiting.verification_uri_complete)}>
            Open it again
          </Button>
          {/* Switching Remote control off cancels the waiting sign-in (cloud.signin), back to the ways in. */}
          <Button variant="ghost" disabled={remote.busy} onClick={() => void remote.setOn(false)}>
            Use another way
          </Button>
        </div>
        {error ? <Problem text={error} /> : null}
      </Split>
    );

  return (
    <Split
      title={signup ? "Create your account" : "Welcome back"}
      desc={
        signup
          ? "Free to start, on the subscriptions you already have. Your account keeps your plan, chats and Cloud computers with you on every device."
          : "Sign in to pick up your plan, your chats and your Cloud computers."
      }
      foot={foot}
    >
      <div className="flex w-full flex-col gap-2">
        <Button size="lg" className="w-full" disabled={off} onClick={() => void remote.signIn({ provider: "github", intent })}>
          <BrandMark name="github" size={16} />
          Continue with GitHub
        </Button>
        <Button size="lg" variant="secondary" className="w-full" disabled={off} onClick={() => void remote.signIn({ provider: "google", intent })}>
          <GoogleMark />
          Continue with Google
        </Button>
        <EmailWay disabled={off} onContinue={(email) => void remote.signIn({ email, intent })} />
      </div>
      {error ? <Problem text={error} /> : null}
      {/* The first run shows from the first paint; the ways in wait for this computer's runtime, which says so. */}
      {status || link.open ? null : (
        <p role="status" className="mt-3 text-[12.5px]">
          <Working text={link.openedOnce ? "Reconnecting to Caveman Code…" : "Starting Caveman Code…"} />
        </p>
      )}
      <p className="mt-5 text-[13px] text-muted-foreground">
        {signup ? "Already have an account? " : "New to Caveman Code? "}
        <button type="button" className={LINK} onClick={() => setIntent(signup ? "signin" : "signup")}>
          {signup ? "Sign in" : "Create an account"}
        </button>
      </p>
      <p className="mt-2 text-[12px] leading-[18px] text-[hsl(var(--subtle-foreground))]">
        {signup ? "By creating an account" : "By continuing"}, you agree to the{" "}
        <a className={LEGAL} href={`${legal}/terms`} target="_blank" rel="noreferrer">
          Terms
        </a>{" "}
        and{" "}
        <a className={LEGAL} href={`${legal}/privacy`} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        .
      </p>
    </Split>
  );
}

const LINK = "font-medium text-foreground underline-offset-4 outline-none transition-colors duration-75 hover:underline focus-visible:underline";
const LEGAL = "text-muted-foreground underline underline-offset-2 transition-colors duration-75 hover:text-foreground";

/**
 * Step 1's page: the flame and the name, a large title over one grey line, the ways in at the bottom of the left
 * column, and the app on a sky on the right (SignInArt), which a narrow window drops.
 */
function Split({ title, desc, children, foot }: { title: string; desc: string; children: ReactNode; foot: ReactNode }) {
  return (
    <>
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-7 pb-6 pt-6 md:max-w-[540px] lg:px-11">
          <div className="flex items-center gap-2.5 text-foreground">
            <FlameMark size={24} mono />
            <span className="text-[20px] font-medium tracking-[-0.02em]">Caveman Code</span>
          </div>
          <div key={title} className="mt-12 animate-in fade-in duration-200 ease-snap">
            <h1 tabIndex={-1} className="max-w-[440px] text-balance text-[44px] font-medium leading-[1.06] tracking-[-0.03em] outline-none">
              {title}
            </h1>
            <p className="mt-4 max-w-[400px] text-balance text-[15px] leading-6 text-muted-foreground">{desc}</p>
          </div>
          <div className="mt-auto w-full max-w-[400px] pt-10">{children}</div>
        </div>
        <SignInArt className="hidden min-w-0 flex-[1.25] md:block" />
      </div>
      {foot}
    </>
  );
}

function Problem({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <p role="alert" className="mt-3 flex items-center gap-1 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1">{text}</span>
      {action}
      <ReportButton request={{ surface: "onboarding", error: { name: "SignInFailed", message: text } }} />
    </p>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The origin of the Cloud a sign-in goes to: Settings' cloud_url, else Caveman's hosted Cloud. */
const cloudOrigin = (cloudUrl: string | undefined) => {
  try {
    return new URL(cloudUrl ?? HOSTED_CLOUD).origin;
  } catch {
    return HOSTED_CLOUD;
  }
};

/** Email in place: the address typed here prefills Caveman Cloud's form, where the password stays. */
function EmailWay({ disabled, onContinue }: { disabled: boolean; onContinue: (email: string) => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const valid = EMAIL.test(email.trim());
  // Escape closes the field and gives focus back to the button that opened it.
  const button = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    if (!open && closed.current) button.current?.focus();
  }, [open]);
  if (!open)
    return (
      <Button ref={button} size="lg" variant="secondary" className="w-full" disabled={disabled} onClick={() => setOpen(true)}>
        Continue with email
      </Button>
    );
  return (
    <form
      className="flex w-full gap-2 animate-in fade-in duration-150 ease-snap"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !disabled) onContinue(email.trim());
      }}
    >
      <Input
        type="email"
        autoFocus
        autoComplete="email"
        aria-label="Email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          closed.current = true;
          setOpen(false);
        }}
        className="h-9 flex-1"
      />
      {/* Continue with GitHub stays the one white action. */}
      <Button type="submit" size="lg" variant="secondary" disabled={disabled || !valid}>
        Continue
      </Button>
    </form>
  );
}

/** Signed in: a new account is welcomed, a returning one welcomed back; the account, GitHub and the plan below. */
function SignedIn({
  account,
  fresh,
  onNext,
  problem,
  busy,
  onRetry,
}: {
  account: NonNullable<CloudStatus["account"]>;
  fresh: boolean;
  onNext: () => void;
  /** Why this computer is not registered with Caveman (Remote control is off); Continue stays signed in. */
  problem: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const github = useGithubStatus(true);
  const { account: summary } = useAccount(true);
  const sub = paidPlan(summary);
  const plan = sub ? planLabel(sub.plan, summary?.offer) : summary?.signed_in ? "Free" : null;
  const name = firstName(account);
  // Arriving from a gift link: the free month is the news, in Settings > Plan's own words (subscriptionLine).
  const gift = sub?.trial_end ? { from: sub.gift_from, line: subscriptionLine(sub, summary?.offer).text } : null;
  const hello = fresh ? "Welcome" : "Welcome back";
  return (
    <Split
      title={gift ? `${name ? `${name}, a` : "A"} month of ${plan ?? "Pro"} is yours` : name ? `${hello}, ${name}` : hello}
      desc={
        gift?.from
          ? `${gift.from} gave it to you. Next, Caveman Code looks at what's already on this computer.`
          : "Next, Caveman Code looks at what's already on this computer, so you start with the tools you have."
      }
      foot={
        <>
          <Disclosure />
          <Nav onNext={onNext} />
        </>
      }
    >
      <Card>
        <Row icon={<span className="grid size-4 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">{account.email[0]?.toUpperCase()}</span>} label={account.email} desc={account.organization_name ?? undefined} />
        <Row
          icon={<BrandMark name="github" size={16} />}
          label="GitHub"
          desc={github?.login ? `@${github.login}${github.source === "gh" ? ", from the GitHub CLI" : ""}` : github ? "Not connected yet" : undefined}
          right={github === null ? <Working text="Checking" /> : github.login ? <Ready text="Connected" /> : <span className="text-[hsl(var(--subtle-foreground))]">Next step</span>}
        />
        {plan ? (
          <Row
            icon={<FlameMark />}
            label="Plan"
            desc={gift && sub?.trial_end ? `${plan}, free until ${shortDay(sub.trial_end) ?? "the month ends"}` : plan}
            right={sub ? undefined : <span className="text-[hsl(var(--subtle-foreground))]">Runs on your own subscriptions</span>}
          />
        ) : null}
      </Card>
      {gift ? <p className="mx-[15px] mt-2 text-[12px] leading-[18px] text-[hsl(var(--subtle-foreground))]">{gift.line}</p> : null}
      {/* The account stays: Continue (below) goes on signed in with Remote control off, Try again asks Caveman again. */}
      {problem ? (
        <Problem
          text={problem}
          action={
            <Button variant="ghost" disabled={busy} onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : null}
    </Split>
  );
}

/** the spec's disclosure, in one line with its switch; the desktop sends nothing before this shows (welcome_shown). */
function Disclosure({ onSkip }: { onSkip?: (() => void) | undefined }) {
  const telemetry = window.cavemanDesktop?.telemetry;
  const [choice, setChoice] = useState<TelemetryChoice | null>(null);
  useEffect(() => {
    void telemetry?.choice().then(setChoice);
  }, [telemetry]);
  useEffect(() => {
    if (choice) funnelStep("welcome_shown");
  }, [choice]);
  const on = Boolean(choice?.enabled && !choice.envOff);
  // The Terms and Privacy links are in the line under the sign-in buttons; nothing else to say in a browser.
  if (!choice && !onSkip) return null;
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-6 pb-4 pt-3.5 text-center text-[12px] leading-[18px] text-[hsl(var(--subtle-foreground))]">
      {choice ? (
        <span>
          {choice.envOff
            ? "Usage counts are off on this computer (DO_NOT_TRACK or CAVEMAN_TELEMETRY)."
            : on
              ? "Caveman Code sends which first-run steps you reach, how each turn went (engine, model, timings, counts) and crash reports (the error and its stack, secrets and your home folder taken out), with an anonymous install id. Never code or prompts."
              : "Usage counts are off."}{" "}
          {choice.envOff ? null : (
            <button type="button" className="text-muted-foreground underline-offset-2 outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={() => void telemetry?.set(!on).then((next) => next && setChoice(next))}>
              {on ? "Turn off" : "Turn on"}
            </button>
          )}
        </span>
      ) : null}
      {choice && onSkip ? <span aria-hidden className="h-3 w-px bg-border" /> : null}
      {onSkip ? (
        <button type="button" className="text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={onSkip}>
          Skip (development build)
        </button>
      ) : null}
    </footer>
  );
}

/** Google's G, from Google's published sign-in button geometry. */
export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width={16} height={16} aria-hidden className="shrink-0">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.7-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.7-.4-3.9z" />
    </svg>
  );
}
