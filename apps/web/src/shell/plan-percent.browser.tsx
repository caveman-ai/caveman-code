// Where plan usage shows, on fixture data, through the production components: the sidebar meter and its popover,
// Settings > Plan with the plan picker, and the Unlock sheet. No runtime and no Cloud. It checks what it draws: a
// limit is a percent, a bar and a reset from Cloud's percent; the sidebar and its popover say no dollars at all (the
// person's credits, Pay as you go and the plans are in Settings > Plan); and the only dollars about a plan are its
// price and its headline (docs/ section 9).
// /src/shell/plan-percent.browser.html (?view=meter | plan | picker | member | unlock; ?light for the light theme).
import type { AccountSummary, CodeOffer } from "@caveman-app/session-protocol";
import { menuSurface } from "@caveman-app/ui/components/menu";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { UnlockPlans } from "../components/UnlockPlans.tsx";
import { planMeter } from "./plan-meter-model.ts";
import { GetAPlanRow, PlanRing, PlanUsageDetails } from "./PlanMeter.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";
import { CATALOG, ON } from "../routes/settings/auto-topup.fixture.ts";
import offerFixture from "../routes/settings/code-plans-offer.fixture.json";
import { planDollars, PRIVATE_WORDS } from "../routes/settings/plan-dollars.fixture.ts";
import { PlanView } from "../routes/settings/Plan.tsx";
import { SettingsPage } from "../routes/settings/rows.tsx";

type Credits = NonNullable<AccountSummary["credits"]>;
const offer = { ...(offerFixture as unknown as CodeOffer), auto_topup: CATALOG };
const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "all";
if (query.has("light")) document.documentElement.classList.remove("dark");

const NOW = new Date();
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const windows = (week: number, month: number): Credits["windows"] => [
  { window: "week", used_pct: week, resets_at: inHours(4 * 24 + 5) },
  { window: "month", used_pct: month, resets_at: inHours(21 * 24) },
];
const credits = (plan: string, used: Credits["windows"], over: Partial<Credits> = {}): Credits => ({
  plan,
  seats: 1,
  windows: used,
  balance_micros: 12_340_000,
  grants: [],
  use_balance: true,
  customer_linked: true,
  ...(plan === "free"
    ? {}
    : {
        subscription: {
          plan,
          seats: 1,
          status: "active",
          interval: "month",
          current_period_end: inHours(21 * 24),
          cancel_at_period_end: false,
          pending_update: false,
        },
      }),
  ...over,
});
const meterOf = (c: Credits) => planMeter({ signed_in: true, credits: c, offer }, NOW)!;
/** The popover's meter: only a plan with limits has one. */
const windowsOf = (c: Credits) => {
  const meter = meterOf(c);
  return meter.kind === "windows" ? meter : null;
};

/** The meter as the sidebar holds it, in each state it has. */
const METERS: ReadonlyArray<{ id: string; note: string; credits: Credits; popover?: boolean }> = [
  {
    id: "calm",
    note: "Under 80%: the week as a ring in the account row",
    credits: credits("pro", windows(58, 47)),
    popover: true,
  },
  { id: "amber", note: "From 80%: amber", credits: credits("pro", windows(85, 60)), popover: true },
  {
    id: "cap",
    note: "At the limit: red, the reset, credits carry on",
    credits: credits("max", windows(100, 72), { auto_topup: ON, gifts: { open: 2, total: 2 } }),
    popover: true,
  },
  {
    id: "month",
    note: "The week, though the month is fuller; a plan's price is not in its name here",
    credits: credits("go", windows(7, 33)),
  },
  {
    id: "five",
    note: "A 5-hour window shows only once it is used up",
    credits: credits("pro", [
      { window: "5h", used_pct: 100, resets_at: inHours(3) },
      ...windows(7, 33),
    ]),
    popover: true,
  },
  {
    id: "free",
    note: "Free: its name and the way to a plan, never a balance",
    credits: credits("free", []),
  },
];

function Meters() {
  return (
    <div className="flex flex-wrap items-start gap-6">
      {METERS.map((m) => (
        <figure
          key={m.id}
          data-case={`meter-${m.id}`}
          className="m-0 flex w-[280px] flex-col gap-2"
        >
          <figcaption className="h-8 text-[12px] leading-4 text-muted-foreground">
            {m.note}
          </figcaption>
          {/* The foot of the sidebar: its width, its colour, Free's row over the account row, a plan's ring in it. */}
          <div
            data-foot
            className="w-[248px] rounded-xl border-[0.5px] border-border bg-sidebar pt-3 text-sidebar-foreground"
          >
            {(() => {
              const meter = meterOf(m.credits);
              return (
                <>
                  {meter.kind === "credits" ? <GetAPlanRow meter={meter} /> : null}
                  <div className="flex h-[34px] items-center gap-1 pb-1 pl-3 pr-2">
                    <span className="flex h-7 min-w-0 flex-1 items-center gap-2 px-1.5 text-[13px] font-medium">
                      <span className="truncate text-sidebar-accent-foreground/90">
                        Ada Lovelace
                      </span>
                      <span className="truncate">· {meter.plan}</span>
                    </span>
                    {meter.kind === "windows" ? <PlanRing meter={meter} /> : null}
                  </div>
                </>
              );
            })()}
          </div>
          {m.popover && windowsOf(m.credits) ? (
            <div data-popover className={cn(menuSurface, "w-[280px] p-0 text-[13px]")}>
              <PlanUsageDetails meter={windowsOf(m.credits)!} />
            </div>
          ) : null}
        </figure>
      ))}
    </div>
  );
}

/**
 * Settings > Plan in Settings' own pane, as routes/Settings.tsx draws a list page: the bar that names it, then the page
 * across the pane. It follows the window: as wide as the pane beside Settings' sidebar, or the whole narrow window.
 */
function Page({
  id,
  held,
  look,
  canManage = true,
}: {
  id: string;
  held: Credits;
  look?: string;
  canManage?: boolean;
}) {
  return (
    <section
      data-case={id}
      className="w-full max-w-[1032px] overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)] max-md:rounded-none max-md:border-0 max-md:shadow-none"
    >
      <header className="flex h-12 items-center gap-1.5 border-b border-border px-5 text-[15px] max-md:px-4">
        <span className="text-muted-foreground max-md:hidden">Settings</span>
        <span className="text-[hsl(var(--subtle-foreground))] max-md:hidden">/</span>
        <h1 className="font-medium">Plan</h1>
      </header>
      <div className="px-8 pt-4 max-md:px-4 max-md:pt-2">
        <SettingsPage title="Plan" wide>
          <PlanView
            credits={held}
            offer={offer}
            canManage={canManage}
            busy={false}
            error={null}
            notice={null}
            gifts={null}
            thanks={false}
            initialPlan={look ?? null}
            onCheckout={() => undefined}
            onBilling={() => undefined}
            onSendGift={async () => undefined}
            creditsOn
            onCreditsChange={() => undefined}
            organization="Analytical Engines"
            payg={{
              save: async () => undefined,
              changeCard: async () => undefined,
              confirm: () => undefined,
            }}
          />
        </SettingsPage>
      </div>
    </section>
  );
}

const HELD = credits(
  "max",
  [{ window: "5h", used_pct: 14, resets_at: inHours(3) }, ...windows(85, 100)],
  {
    computers: {
      kept: 3,
      kept_limit: 30,
      awake_gib: 32,
      awake_gib_limit: 384,
      max_size: "16x64",
      used_pct: 12,
    },
    auto_topup: ON,
  },
);
const FREE = credits("free", [], {
  balance_micros: 0,
  customer_linked: false,
  computers: { kept: 1, kept_limit: 1, awake_gib: 0, awake_gib_limit: 16, max_size: "4x16" },
});
const account: AccountSummary = {
  signed_in: true,
  email: "ada@caveman.test",
  role: "owner",
  organization_name: "Analytical Engines",
  credits: FREE,
  offer,
};

const runtime = {
  client: null,
  connection: "open",
  engines: [],
  workspaces: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const shows = (name: string) => view === "all" || view === name;
const Title = ({ children }: { children: ReactNode }) => (
  <h2 className="mb-3 mt-8 text-[13px] font-medium text-muted-foreground first:mt-0">{children}</h2>
);

const host = document.getElementById("plan-percent")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <RuntimeContext.Provider value={runtime}>
        <TooltipProvider>
          <main className="p-5 text-foreground max-md:p-0">
            {shows("meter") ? (
              <>
                <Title>The sidebar meter and its popover</Title>
                <Meters />
              </>
            ) : null}
            {shows("plan") ? (
              <>
                <Title>Settings &gt; Plan: Max $100, the week at 85%, the month used up</Title>
                <Page id="plan" held={HELD} look="max20" />
              </>
            ) : null}
            {shows("picker") ? (
              <>
                <Title>Settings &gt; Plan: Free, choosing a plan</Title>
                <Page id="picker" held={FREE} look="max" />
              </>
            ) : null}
            {shows("member") ? (
              <>
                <Title>
                  Settings &gt; Plan: a member who cannot change the plan (one card has a button)
                </Title>
                <Page id="member" held={HELD} canManage={false} />
              </>
            ) : null}
            {view === "unlock" ? (
              <UnlockPlans
                open
                onOpenChange={() => undefined}
                source={{ get: async () => account, checkout: async () => ({}) }}
              />
            ) : null}
          </main>
        </TooltipProvider>
      </RuntimeContext.Provider>
    </MemoryRouter>,
  ),
);

async function run() {
  const checks: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) throw new Error(name);
    checks.push(name);
  };
  // The Unlock sheet reads its account before it draws its columns.
  if (view === "unlock") {
    for (let i = 0; i < 50 && !document.body.textContent!.includes("computers kept"); i++)
      await new Promise((r) => setTimeout(r, 40));
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    check(
      "the Unlock sheet says no dollar of a plan but its price and headline",
      planDollars(sheet.innerHTML).length === 0 && !PRIVATE_WORDS.test(sheet.textContent!),
    );
  }
  for (const figure of host.querySelectorAll<HTMLElement>('[data-case^="meter-"]')) {
    const row = figure.querySelector<HTMLElement>("[data-foot]")!;
    // The sidebar says no money at all: not a plan's, not the person's own credits, not a plan's price.
    check(
      `${figure.dataset.case}: the sidebar says no dollars`,
      !row.textContent!.includes("$") && planDollars(row.innerHTML).length === 0,
    );
    const popover = figure.querySelector<HTMLElement>("[data-popover]");
    if (popover)
      check(
        `${figure.dataset.case}: the popover says no dollars, no Pay as you go and no other plan`,
        !/\$|Pay as you go|Need more room|Move to/.test(popover.textContent!) &&
          !PRIVATE_WORDS.test(popover.textContent!),
      );
  }
  if (shows("meter")) {
    const ring = (id: string) =>
      host
        .querySelector<HTMLElement>(`[data-case="meter-${id}"] [data-foot] button`)
        ?.getAttribute("aria-label") ?? "";
    check(
      'the sidebar is a ring named "Plan usage: Pro plan, this week: 58% used"',
      ring("calm") === "Plan usage: Pro plan, this week: 58% used",
    );
    check(
      'at the limit the ring says "Max plan, this week: used up. Resets <day and time>", the price left out of the name',
      /^Plan usage: Max plan, this week: used up\. Resets \S/.test(ring("cap")),
    );
    check(
      "the ring shows the week though the month is fuller",
      ring("month") === "Plan usage: Pro plan, this week: 7% used",
    );
    check(
      "the ring shows the 5 hours once they are used up",
      /^Plan usage: Pro plan, 5 hours: used up/.test(ring("five")),
    );
    const free =
      host.querySelector<HTMLElement>('[data-case="meter-free"] [data-foot] a')?.textContent ?? "";
    check(
      'Free reads "Free" and "Get a plan", with no ring',
      /^Free\s*Get a plan$/.test(free) && ring("free") === "",
    );
    const popover = host.querySelector<HTMLElement>(
      '[data-case="meter-calm"] [data-popover]',
    )!.textContent!;
    check(
      'the popover reads "This week 58% · Resets <day and time>" and leaves the month to Settings',
      /This week\s*58% · Resets \S/.test(popover) && !popover.includes("This month"),
    );
  }
  for (const page of host.querySelectorAll<HTMLElement>(
    '[data-case="plan"], [data-case="picker"], [data-case="member"]',
  )) {
    // Down to the Credits card, the page is about plans; below it, the money is the person's own.
    const cards = [...page.querySelectorAll<HTMLElement>("section")];
    const aboutPlans = cards.filter((card) => !/^Credits/.test(card.textContent ?? ""));
    check(
      `${page.dataset.case}: has its plan cards`,
      aboutPlans.length >= 2 && aboutPlans.length < cards.length,
    );
    check(
      `${page.dataset.case}: no plan dollars but prices and headlines`,
      aboutPlans.every(
        (card) =>
          planDollars(card.innerHTML).length === 0 && !PRIVATE_WORDS.test(card.textContent!),
      ),
    );
    // Side by side, the cards share their rows: each one's list starts on the same line, button or no button.
    const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
    const planCards = [...page.querySelectorAll<HTMLElement>(".plan-card")];
    if (new Set(planCards.map(top)).size === 1)
      check(
        `${page.dataset.case}: every plan card's rows line up`,
        new Set(planCards.map((card) => top(card.querySelector("ul")!))).size === 1,
      );
  }
  if (shows("plan")) {
    const text = host.querySelector<HTMLElement>('[data-case="plan"]')!.textContent!;
    check(
      `plan says "Cloud" and "12% of this month", and no size or count of computers`,
      /Cloud\s*12% of this month/.test(text) &&
        !/GB awake|16x64|computers kept|32 of 384/.test(text),
    );
    const bars = [
      ...host.querySelectorAll<HTMLElement>('[data-case="plan"] [role="progressbar"]'),
    ].map((bar) => bar.getAttribute("aria-label"));
    check(
      "plan draws exactly the windows Cloud sends as bars from its percent",
      bars.join("|") === "5 hours: 14% used|This week: 85% used|This month: 100% used",
    );
  }
  document.documentElement.dataset.result = "passed";
  result.textContent = `PASS (${checks.length} checks)`;
}
void run().catch((error: unknown) => {
  document.documentElement.dataset.result = "failed";
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
