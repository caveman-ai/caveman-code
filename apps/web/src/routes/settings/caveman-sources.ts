import type { EngineAccount, EngineProvider } from "@caveman-app/session-protocol";
import type { BrandName } from "@caveman-app/ui/icons/brand";

/**
 * What the Caveman engine runs on, as Models & keys shows it: a subscription you sign in to ("plan"),
 * or a provider's keys ("key"). One source can hold several accounts: a further key of a provider is a
 * slot of its own (`openai~2`) under the same provider.
 */
export type SourceMode = "plan" | "key";
export interface Source {
  readonly key: string;
  readonly mode: SourceMode;
  readonly provider: EngineProvider;
  readonly accounts: ReadonlyArray<EngineAccount>;
}

/** An endpoint of the person's own: named by them, saved as `custom-<slug>`. */
export const CUSTOM: EngineProvider = { id: "custom", label: "OpenAI-compatible endpoint", group: "local", auth: "optional_key" };

export const providerOf = (a: EngineAccount): string => a.provider ?? a.id.replace(/^caveman:/, "");
/** A subscription's entry is `plan:` + its provider; its provider's keys are the bare id. */
export const sourceKey = (mode: SourceMode, id: string): string => (mode === "plan" ? `plan:${id}` : id);
export const parseSourceKey = (key: string): { mode: SourceMode; id: string } =>
  key.startsWith("plan:") ? { mode: "plan", id: key.slice(5) } : { mode: "key", id: key };
const modeOf = (a: EngineAccount): SourceMode => (a.kind === "login" ? "plan" : "key");

/**
 * The provider for an id: the catalog's, else one made from its account. An endpoint of your own keeps the
 * name you gave it (its label is "<name> at <host>"); anything else outside the catalog (a compact plan
 * linked through Caveman Cloud) is managed elsewhere, so it takes no key here.
 */
export function providerFor(id: string, providers: ReadonlyArray<EngineProvider>, account?: EngineAccount): EngineProvider {
  const known = providers.find((p) => p.id === id);
  if (known) return known;
  if (id === CUSTOM.id) return CUSTOM;
  if (id.startsWith("custom-")) return { id, label: account?.label.replace(/ at \S+$/, "") ?? id, group: "local", auth: "optional_key" };
  return { id, label: account?.label ?? id, group: "more", auth: "account" };
}

/** The accounts a source holds: its provider's sign-ins for a plan, its keys and endpoints otherwise. */
export const accountsOf = (accounts: ReadonlyArray<EngineAccount>, key: string): ReadonlyArray<EngineAccount> => {
  const { mode, id } = parseSourceKey(key);
  return accounts.filter((a) => providerOf(a) === id && modeOf(a) === mode);
};

/** Everything connected, one source per provider and kind, in the runtime's order. Caveman credits have their own row. */
export function connectedSources(accounts: ReadonlyArray<EngineAccount>, providers: ReadonlyArray<EngineProvider>): ReadonlyArray<Source> {
  const sources = new Map<string, Source>();
  for (const a of accounts) {
    const id = providerOf(a);
    if (providers.find((p) => p.id === id)?.group === "credits") continue;
    const key = sourceKey(modeOf(a), id);
    const known = sources.get(key);
    sources.set(key, known ? { ...known, accounts: [...known.accounts, a] } : { key, mode: modeOf(a), provider: providerFor(id, providers, a), accounts: [a] });
  }
  return [...sources.values()];
}

/** A source's name: the subscription for a sign-in ("compact"), the provider for keys ("OpenAI"). */
export const sourceName = (s: Pick<Source, "mode" | "provider">): string => (s.mode === "plan" ? (s.provider.sign_in_plan ?? s.provider.label) : s.provider.label);

/** The account to show a source's health by: the one in the worst state. */
export function worstAccount(accounts: ReadonlyArray<EngineAccount>): EngineAccount | undefined {
  const rank = (a: EngineAccount) => (a.health?.state === "failing" ? 3 : a.health?.state === "limited" ? 2 : a.health ? 1 : 0);
  return [...accounts].sort((a, b) => rank(b) - rank(a))[0];
}

export interface Subscription {
  readonly key: string;
  readonly provider: EngineProvider;
  readonly name: string;
 /** sign_in: a browser sign-in (compact); key: a coding plan billed through its key (GLM Coding Plan). */
  readonly how: "sign_in" | "key";
}

/** The subscriptions you can bring: sign-ins first (compact, GitHub Copilot, SuperGrok), then coding plans. */
export function subscriptions(providers: ReadonlyArray<EngineProvider>): ReadonlyArray<Subscription> {
  return [
    ...providers.filter((p) => p.sign_in_plan !== undefined).map((p): Subscription => ({ key: sourceKey("plan", p.id), provider: p, name: p.sign_in_plan!, how: "sign_in" })),
    ...providers.filter((p) => p.section === "plans").map((p): Subscription => ({ key: p.id, provider: p, name: p.label, how: "key" })),
  ];
}

export interface ChoiceGroup {
  readonly label: string;
  readonly items: ReadonlyArray<EngineProvider>;
}

/**
 * The providers you add a key or an address for, by section. With no query: the featured sections and your own
 * server; a query also searches every other provider. Subscriptions and coding plans live on their tiles,
 * and a sign-in with no key to paste (GitHub Copilot) has nothing to add here.
 */
export function keyChoices(providers: ReadonlyArray<EngineProvider>, query: string): ReadonlyArray<ChoiceGroup> {
  const q = query.trim().toLowerCase();
  const pool = keyPool(providers);
  const groups: ReadonlyArray<ChoiceGroup> = [
    { label: "API keys", items: pool.filter((p) => p.section === "keys") },
    { label: "Gateways", items: pool.filter((p) => p.section === "gateways") },
    { label: "Your own server", items: [...pool.filter((p) => p.group === "local" && p.section === undefined), CUSTOM] },
    ...(q ? [{ label: "More providers", items: pool.filter((p) => p.group === "more") }] : []),
  ];
  const matches = (p: EngineProvider) => !q || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  return groups.map((g) => ({ label: g.label, items: g.items.filter(matches) })).filter((g) => g.items.length > 0);
}

const keyPool = (providers: ReadonlyArray<EngineProvider>) => providers.filter((p) => p.group !== "credits" && !p.sign_in_only && p.section !== "plans");

/** How many providers take a key or an address, your own endpoint included: the picker's search says so. */
export const keyChoiceCount = (providers: ReadonlyArray<EngineProvider>): number => keyPool(providers).length + 1;

/** The vendor's mark where the kit has one. */
export function providerBrand(id: string): BrandName | undefined {
  const base = id.split("~")[0];
  if (base === "openai" || base === "chatgpt" || base === "azure") return "openai";
  if (base === "anthropic") return "claude";
  if (base === "github-copilot") return "github";
  if (base === "xai") return "grok";
  if (base === "opencode" || base === "opencode-go") return "opencode";
  return undefined;
}
