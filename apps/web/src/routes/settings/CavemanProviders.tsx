import type { EngineAccount, EngineDescriptor, EngineProvider, Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, ArrowLeft02Icon, ArrowUpRight01Icon, Search01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { openSoon } from "../../panels/browser/BrowserBar.tsx";
import { isComposing } from "../../panels/chrome.tsx";
import { pickableLogins } from "../../state/accounts.ts";
import { offersCredits } from "../../state/cloud.ts";
import { requestId, useRuntimeClient, useRuntimeSelector, useRuntime } from "../../state/runtime.tsx";
import { TagInput } from "../EngineAccounts.tsx";
import { ConnectionRows, useConnectionWrites } from "./Connections.tsx";
import { HealthBadge } from "./HealthBadge.tsx";
import {
  accountsOf,
  connectedSources,
  keyChoiceCount,
  keyChoices,
  parseSourceKey,
  providerBrand,
  providerFor,
  providerOf,
  sourceName,
  subscriptions,
  worstAccount,
  type SourceMode,
} from "./caveman-sources.ts";
import { SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type KeyTest = NonNullable<Result<"engine.account.add">["test"]>;

const testLine = (t: KeyTest) =>
  t.ok ? `Checked: ${t.model} answered.` : t.kind === "limit" ? `The key works, but the provider is rate limiting it: ${t.message}` : `Kept, but the test call failed: ${t.message}`;

/** A provider's mark: the vendor's logo where the kit has one, else its initial. */
export function SourceMark({ id, label, size = 16 }: { id: string; label: string; size?: number }) {
  const brand = providerBrand(id);
  if (brand) return <BrandMark name={brand} size={size} className="text-foreground" />;
  return (
    <span aria-hidden style={{ width: size + 4, height: size + 4 }} className="flex shrink-0 items-center justify-center rounded-[5px] bg-secondary text-[11px] font-semibold text-muted-foreground">
      {label.replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase()}
    </span>
  );
}

/** What the Caveman engine takes (engine.providers): null until the runtime has answered, empty when it cannot. */
export function useCavemanProviders(enabled = true): ReadonlyArray<EngineProvider> | null {
  const { client } = useRuntimeClient();
  const [providers, setProviders] = useState<ReadonlyArray<EngineProvider> | null>(null);
  useEffect(() => {
    if (!client || !enabled) return;
    client.call("engine.providers", { engine: "caveman" }).then(
      (r) => setProviders(r.providers),
      () => setProviders([]),
    );
  }, [client, enabled]);
  return providers;
}

/** True where the picker and a source's form sit in the page (SourcePanel) instead of a dialog: they take no dialog parts then. */
const InPlace = createContext(false);

function FormHeader({ children }: { children: ReactNode }) {
  return useContext(InPlace) ? <div className="flex flex-col gap-1">{children}</div> : <DialogHeader>{children}</DialogHeader>;
}
function FormTitle({ children }: { children: ReactNode }) {
  return useContext(InPlace) ? <h4 className="text-[13px] font-medium">{children}</h4> : <DialogTitle className="text-[15px]">{children}</DialogTitle>;
}
function FormDescription({ children }: { children: ReactNode }) {
  return useContext(InPlace) ? <p className="text-[12.5px] leading-relaxed text-muted-foreground">{children}</p> : <DialogDescription>{children}</DialogDescription>;
}

/** The dialog's state: picking a provider, or one source open (`from` the picker, so Back returns there). */
type Open = { readonly pick: true } | { readonly key: string; readonly from?: "pick" };

/**
 * Settings > Models & keys: what the Caveman engine runs on. Subscriptions are tiles you click once
 * (sign-ins, then coding plans); below them everything connected, one row per provider and kind, each
 * managed in the same dialog that connected it; then Caveman credits, then any provider's key, a gateway
 * or your own server through one searchable picker. Every connection is in use at once.
 *
 * A key the person connected once in Caveman Cloud is a row of its own above those, saying where it works
 * (settings/Connections.tsx). A Cloud computer takes no sign-in and no key: its page lists those rows only.
 */
export function CavemanProviders({ engine }: { engine: EngineDescriptor }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const providers = useCavemanProviders() ?? [];
  const [open, setOpen] = useState<Open | null>(null);
  // This computer's own sign-ins and keys; what was connected once in Caveman Cloud has rows of its own.
  const accounts = pickableLogins(engine.auth.accounts);
  const writes = useConnectionWrites(engine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const here = engine.auth.no_sign_in_here !== true;
  const sources = connectedSources(accounts, providers);
  const cloudUrl = useRuntimeSelector((v) => v.settings?.cloud_url);
  const creditsProvider = providers.find((p) => p.group === "credits");
  const creditsOn = creditsProvider !== undefined && accounts.some((a) => providerOf(a) === creditsProvider.id);
  // A company's own Cloud sells no credits unless Account turned them on there.
  const credits = creditsProvider && offersCredits(cloudUrl, creditsOn) ? creditsProvider : undefined;
  const subs = here ? subscriptions(providers) : [];
  const connected = (key: string) => accountsOf(accounts, key).length > 0;

  if (!here && writes.connections.length === 0 && !credits) return null;
  return (
    <SettingsCard
      title="Caveman"
      description={here ? "Our agent. Bring the subscriptions and keys you already pay for; it uses all of them at once, each for its own models." : "Our agent. It uses every key you connected, each for its own models."}
    >
      {subs.length > 0 ? (
        <SettingsCardBody className="py-5">
          <h4 className="mb-3 text-[13px] font-medium">Use a subscription</h4>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {subs.map((s) => {
              const on = connected(s.key);
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => setOpen({ key: s.key })}
                    className={cn(
                      "group flex h-full w-full items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left outline-none transition-colors",
                      "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-success/35" : "border-border hover:border-foreground/20",
                    )}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-card">
                      <SourceMark id={s.provider.id} label={s.name} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{s.name}</span>
                      <span className={cn("flex items-center gap-1 text-[12px]", on ? "text-success" : "text-muted-foreground")}>
                        {on ? (
                          <>
                            <Icon icon={Tick02Icon} className="size-3" /> Connected
                          </>
                        ) : s.how === "sign_in" ? (
                          "Sign in"
                        ) : (
                          "Paste your plan key"
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[12.5px] text-muted-foreground">Paying for Claude Pro or Max? It runs through Claude Agent, under Other agents.</p>
        </SettingsCardBody>
      ) : null}

      <ConnectionRows engine={engine} writes={writes} busy={busy} run={run} />
      {error ? (
        <SettingsCardBody className="py-3">
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        </SettingsCardBody>
      ) : null}

      {(here ? sources : []).map((s) => {
        const worst = worstAccount(s.accounts);
        return (
          <SettingRow
            key={s.key}
            icon={<SourceMark id={s.provider.id} label={sourceName(s)} />}
            label={
              <span className="flex items-center gap-2">
                {sourceName(s)}
                <span className="text-[12px] text-muted-foreground">{s.mode === "plan" ? "Subscription" : s.provider.group === "local" ? "Server" : s.provider.plan ? "Coding plan" : "API key"}</span>
              </span>
            }
            description={<span className="block truncate">{s.accounts.length > 1 ? `${s.accounts.length} keys, all in use` : s.accounts[0]?.label}</span>}
          >
            {worst ? <HealthBadge account={worst} /> : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen({ key: s.key })} aria-label={`Manage ${sourceName(s)}`}>
              Manage
            </Button>
          </SettingRow>
        );
      })}

      {credits ? (
        <SettingRow to="/settings/plan" label="Caveman credits" description="Pay as you go from your Caveman plan, for anything your own keys don't cover.">
          {creditsOn ? "On" : "Turn on in Account"}
        </SettingRow>
      ) : null}

      {here ? (
        <SettingRow label="API keys and servers" description="Any provider's key, a gateway like OpenRouter, or a model server like Ollama.">
          <Button size="sm" variant="outline" onClick={() => setOpen({ pick: true })}>
            <Icon icon={Add01Icon} className="size-3.5" /> Add
          </Button>
        </SettingRow>
      ) : null}

      <SourceDialog open={open} onOpen={setOpen} providers={providers} accounts={accounts} client={client} onDone={refresh} />
    </SettingsCard>
  );
}

/**
 * The source picker in the page, for a first run and New chat (routes/engines/WaysIn.tsx): the same picker and
 * forms as the dialog, with no dialog around them. It opens on an Anthropic key, the commonest, with the key field
 * ready; "Another provider or server" opens the picker (the 14 key providers, gateways, coding plans, Ollama, LM
 * Studio, your own endpoint). `providers`: already loaded by the caller (useCavemanProviders), else loaded here.
 */
export function SourcePanel({ engine, providers }: { engine: EngineDescriptor; providers?: ReadonlyArray<EngineProvider> | null }) {
  const own = useCavemanProviders(providers === undefined);
  const loaded = providers === undefined ? own : providers;
  if (loaded === null) return <p role="status" className="text-muted-foreground">Loading…</p>;
  return <SourcePanelBody engine={engine} providers={loaded} />;
}

function SourcePanelBody({ engine, providers }: { engine: EngineDescriptor; providers: ReadonlyArray<EngineProvider> }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const accounts = pickableLogins(engine.auth.accounts);
  const [open, setOpen] = useState<Open>(() => (providers.some((p) => p.id === "anthropic") ? { key: "anthropic" } : { pick: true }));
  return (
    <InPlace.Provider value>
      <div className="flex flex-col gap-3">
        {"pick" in open ? (
          <Picker providers={providers} accounts={accounts} onPick={(key) => setOpen({ key, from: "pick" })} />
        ) : (
          <>
            <SourceForm
              key={open.key}
              sourceKey={open.key}
              providers={providers}
              accounts={accounts}
              client={client}
              onDone={refresh}
              {...(open.from === "pick" ? { onBack: () => setOpen({ pick: true }) } : {})}
            />
            {open.from === undefined ? (
              <button type="button" className="self-start text-[12.5px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground focus-visible:underline" onClick={() => setOpen({ pick: true })}>
                Another provider or server
              </button>
            ) : null}
          </>
        )}
      </div>
    </InPlace.Provider>
  );
}

/** Picking a provider, then connecting or managing one source: one dialog for every way in. */
function SourceDialog(props: {
  open: Open | null;
  onOpen: (open: Open | null) => void;
  providers: ReadonlyArray<EngineProvider>;
  accounts: ReadonlyArray<EngineAccount>;
  client: ReturnType<typeof useRuntime>["client"];
  onDone: () => Promise<void>;
}) {
  const open = props.open;
  return (
    <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : props.onOpen(null))}>
      {/* Moving from the picker to a form unmounts what had focus, which lands on the dialog itself: no ring for that. */}
      <DialogContent size="md" className="outline-none focus-visible:ring-0">
        {open && "pick" in open ? (
          <Picker providers={props.providers} accounts={props.accounts} onPick={(key) => props.onOpen({ key, from: "pick" })} />
        ) : open ? (
          <SourceForm
            key={open.key}
            sourceKey={open.key}
            providers={props.providers}
            accounts={props.accounts}
            client={props.client}
            onDone={props.onDone}
            {...(open.from === "pick" ? { onBack: () => props.onOpen({ pick: true }) } : {})}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Picker(props: { providers: ReadonlyArray<EngineProvider>; accounts: ReadonlyArray<EngineAccount>; onPick: (key: string) => void }) {
  const [query, setQuery] = useState("");
  const inPlace = useContext(InPlace);
  // The dialog's page has the coding plans as tiles above its Add button; the panel has no tiles, so they are listed here.
  const q = query.trim().toLowerCase();
  const plans = inPlace ? props.providers.filter((p) => p.section === "plans" && (!q || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))) : [];
  const groups = [...keyChoices(props.providers, query), ...(plans.length > 0 ? [{ label: "Coding plans", items: plans }] : [])];
  const first = groups[0]?.items[0];
  return (
    <>
      <FormHeader>
        <FormTitle>Add an API key or server</FormTitle>
        <FormDescription>Each key pays for its own provider's models. Add as many as you like.</FormDescription>
      </FormHeader>
      <div className="relative">
        <Icon icon={Search01Icon} className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          aria-label="Search providers"
          placeholder={`Search ${keyChoiceCount(props.providers)} providers`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && first && !isComposing(e)) props.onPick(first.id);
          }}
          className="h-9 pl-8"
        />
      </div>
      <div className={cn("-mx-1 flex flex-col gap-4 overflow-y-auto px-1", inPlace ? "max-h-[40dvh]" : "max-h-[52dvh]")}>
        {groups.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            No provider called “{query.trim()}”. Any OpenAI-compatible service works as{" "}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={() => props.onPick("custom")}>
              your own endpoint
            </button>
            .
          </p>
        ) : null}
        {groups.map((g) => (
          <div key={g.label}>
            <h4 className="mb-1.5 text-[12px] text-muted-foreground">{g.label}</h4>
            <ul className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {g.items.map((p) => {
                const on = accountsOf(props.accounts, p.id).length > 0;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => props.onPick(p.id)}
                      className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="flex w-5 justify-center">
                        <SourceMark id={p.id} label={p.label} size={14} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.label}</span>
                      {on ? <Icon icon={Tick02Icon} className="size-3.5 text-success" aria-label="Connected" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

/** What a source's dialog said after its last action; a sign-in's keeps its page (`url`), to open again. */
type Note = { tone: "ok" | "warn" | "error"; text: string; url?: string };
export type SignInNote = Note;

/**
 * One Caveman engine sign-in (compact, GitHub Copilot, SuperGrok, external tools: provider-caveman signIn.ts, on this
 * computer, no Cloud). Call it from the click itself: the page opens in the click (openSoon), as a browser blocks a
 * tab opened after the call. Says what to do next; a refused sign-in throws.
 */
export async function startSignIn(client: NonNullable<ReturnType<typeof useRuntime>["client"]>, provider: string): Promise<SignInNote> {
  const go = openSoon();
  try {
    const res = await client.call("engine.account.signin", { request_id: requestId(), engine: "caveman", provider });
    go(res.url);
    const url = res.url ? { url: res.url } : {};
    if (res.code === undefined) return { tone: "ok", text: "Approve in your browser. It shows here once you have.", ...url };
    const copied = await (navigator.clipboard?.writeText(res.code).then(() => true, () => false) ?? false);
    return { tone: "ok", text: `Enter ${res.code} on the page that opened${copied ? " (copied)" : ""}. It shows here once you approve.`, ...url };
  } catch (e) {
    go(null);
    throw e;
  }
}

/** What a source's dialog says under its name. */
function formLine(p: EngineProvider, mode: SourceMode, name: string): string {
  if (mode === "plan") return `Sign in with your ${name} account. Caveman runs on your plan's models and limits.`;
  if (p.auth === "account") return "Linked through your Caveman account.";
  if (p.auth === "optional_key") return p.id === "custom" ? "Any server that speaks the OpenAI API: its address and the models it serves." : "Its address and the models it serves. A key only if it needs one.";
  if (p.plan) return `Paste your ${name} key. What Caveman uses counts against your plan.`;
  return `Paste ${/^[aeiou]/i.test(name) ? "an" : "a"} ${name} key. Add more than one and Caveman uses them all.`;
}

/**
 * One source, connected or not: its accounts (test, sign in again, tag, remove), then a way to add one:
 * the sign-in for a subscription, a key (or a sign-in that hands back a key, external tools) for a provider,
 * an address for a server. A key is typed once, never shown again; the runtime tests it with one tiny
 * call and refuses one the provider refuses.
 */
function SourceForm(props: {
  sourceKey: string;
  providers: ReadonlyArray<EngineProvider>;
  accounts: ReadonlyArray<EngineAccount>;
  client: ReturnType<typeof useRuntime>["client"];
  onDone: () => Promise<void>;
  onBack?: () => void;
}) {
  const { mode, id } = parseSourceKey(props.sourceKey);
  const accounts = accountsOf(props.accounts, props.sourceKey);
  const p = providerFor(id, props.providers, accounts[0]);
  const name = sourceName({ mode, provider: p });
  // The first key leads; further keys are added beside it, never over it.
  const account = accounts[0];
  const endpoint = p.auth === "optional_key";
  const takesKey = mode === "key" && !p.sign_in_only && p.auth !== "account";
  // A plan signs in until it has (then its row signs in again: the runtime keeps a sign-in's slot); a
 // provider's keys offer a sign-in only where it hands back a key (external tools).
  const offersSignIn = p.sign_in === true && (mode === "plan" ? accounts.length === 0 : p.sign_in_plan === undefined);
  const [key, setKey] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [endpointName, setEndpointName] = useState(p.id === "custom" ? "" : p.label);
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? "");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const run = async (action: () => Promise<Note | null>) => {
    if (!props.client) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(await action());
      await props.onDone();
    } catch (e) {
      setNote({ tone: "error", text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  /**
   * A sign-in: the provider's (a new source), or an account's slot signing in again. Its page opens in the click
   * (openSoon), as a browser blocks a tab opened after the call, and stays a link; the code is copied when the browser lets it.
   */
  const signIn = (provider: string) => void run(() => startSignIn(props.client!, provider));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    void run(async () => {
      const res = await props.client!.call("engine.account.add", {
        request_id: requestId(),
        engine: "caveman",
        provider: p.id === "custom" ? `custom-${slug(endpointName)}` : p.id,
        ...(value ? { key: value } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        ...(endpoint ? { endpoint: { name: endpointName.trim() || p.label, base_url: baseUrl.trim(), models: models.split(/[\s,]+/).filter(Boolean) } } : {}),
      });
      return res.test ? { tone: res.test.ok ? "ok" : "warn", text: testLine(res.test) } : null;
    });
  };
  const keyName = p.key_label ?? `${p.label} API key`;
  return (
    <>
      <FormHeader>
        <div className="flex items-center gap-2.5">
          {props.onBack ? (
            <Button size="icon-sm" variant="ghost" className="-ml-1.5" aria-label="Back to providers" onClick={props.onBack}>
              <Icon icon={ArrowLeft02Icon} className="size-4" />
            </Button>
          ) : null}
          <SourceMark id={p.id} label={name} size={18} />
          <FormTitle>{name}</FormTitle>
        </div>
        <FormDescription>{formLine(p, mode, name)}</FormDescription>
      </FormHeader>

      {accounts.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
          {accounts.map((a) => (
            <li key={a.id} className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]">
              <span title={a.label} className="min-w-0 flex-1 truncate">
                {a.label}
              </span>
              {a.tag ? <TagInput engine="caveman" account={a} busy={busy} run={(action) => run(async () => (await action(props.client!), null))} /> : null}
              <HealthBadge account={a} />
              {a.kind === "login" ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => signIn(a.id.replace(/^caveman:/, ""))}>
                  Sign in again
                </Button>
              ) : null}
              {p.auth === "account" ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await props.client!.call("engine.account.test", { request_id: requestId(), engine: "caveman", account_id: a.id });
                      return { tone: res.test.ok ? "ok" : "warn", text: res.test.ok ? `Checked: ${res.test.model} answered.` : res.test.message };
                    })
                  }
                >
                  Test
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${a.label}`}
                onClick={() => void run(async () => (await props.client!.call("engine.account.remove", { request_id: requestId(), engine: "caveman", account_id: a.id }), null))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {offersSignIn ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => signIn(p.id)}>
            {p.sign_in_label ?? `Sign in with ${p.label}`}
          </Button>
          {takesKey ? <span className="text-[12.5px] text-muted-foreground">or paste a key</span> : null}
        </div>
      ) : null}

      {takesKey ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          {endpoint ? (
            <>
              {p.id === "custom" ? <Input aria-label="Name" placeholder="Name, like Work vLLM" value={endpointName} onChange={(e) => setEndpointName(e.target.value)} className="h-8" /> : null}
              <Input aria-label="Base URL" placeholder="https://host/v1" spellCheck={false} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="h-8 font-mono placeholder:font-sans" />
              <Input aria-label="Model ids" placeholder="Model ids, comma separated" spellCheck={false} value={models} onChange={(e) => setModels(e.target.value)} className="h-8 font-mono placeholder:font-sans" />
            </>
          ) : null}
          {(p.fields ?? []).map((f) => (
            <Input key={f.name} aria-label={f.label} placeholder={f.placeholder ? `${f.label}, like ${f.placeholder}` : f.label} value={fields[f.name] ?? ""} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} className="h-8" />
          ))}
          <div className="flex items-center gap-2">
            <Input
              type="password"
              // A key is not a site password: keep browsers and password managers from offering to save it.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              autoFocus={!offersSignIn && !endpoint}
              aria-label={keyName}
              placeholder={endpoint ? "Key, if it needs one" : account ? "Paste another key to use it too" : `Paste ${/^[aeiou]/i.test(keyName) ? "an" : "a"} ${keyName}`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="h-8 min-w-0 flex-1 font-mono placeholder:font-sans"
            />
            <Button type="submit" size="sm" disabled={busy || (!endpoint && key.trim() === "") || (endpoint && (baseUrl.trim() === "" || models.trim() === ""))}>
              {busy ? "Checking…" : account && endpoint ? "Replace" : "Add"}
            </Button>
          </div>
          {p.key_url ? (
            <a href={p.key_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 self-start text-[12.5px] text-muted-foreground hover:text-foreground">
              Get {/^[aeiou]/i.test(p.label) ? "an" : "a"} {p.label} key <Icon icon={ArrowUpRight01Icon} className="size-3" />
            </a>
          ) : null}
        </form>
      ) : null}

      {note ? (
        <p role={note.tone === "error" ? "alert" : "status"} className={cn("text-[12.5px]", note.tone === "ok" ? "text-success" : note.tone === "warn" ? "text-warning" : "text-destructive")}>
          {note.text}
        </p>
      ) : null}
      {note?.url ? (
        <a href={note.url} target="_blank" rel="noopener noreferrer" className="self-start text-[12.5px] font-medium text-foreground underline underline-offset-2">
          Open the sign-in page
        </a>
      ) : null}

      <p className="text-[12px] text-muted-foreground">Checked with one tiny call, then stored encrypted on this computer.</p>
    </>
  );
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "endpoint";
