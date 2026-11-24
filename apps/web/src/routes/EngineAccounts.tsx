import type { EngineAccount, EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Icon, MoreHorizontalIcon } from "@caveman-app/ui/icons/huge";
import { Input } from "@caveman-app/ui/components/input";
import { VendorMark } from "@caveman-app/ui/components/model-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { isComposing } from "../panels/chrome.tsx";
import { runInTerminal } from "../panels/terminal/run.ts";
import { isConnection, pickableLogins } from "../state/accounts.ts";
import { OS, THIS_COMPUTER, thisComputer } from "../lib/platform.ts";
import { scanEngines } from "../state/engine-scan.ts";
import { cliMissing, isHarness, setupHereMessage, type ScanFound } from "../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { AccountPlace, ConnectionRows, PlanOfferRows, useConnect, useConnectionWrites, useNow } from "./settings/Connections.tsx";
import { planOffer } from "./settings/connections-model.ts";
import { HealthBadge } from "./settings/HealthBadge.tsx";
import { SettingRow, SettingsCardBody } from "./settings/rows.tsx";
import { installFor } from "./engines/install-commands.ts";
import { ReportButton } from "../components/ReportButton.tsx";

/** Codex's account on the person's own compact login (engineAccounts.ts). */
const CODEX_CHATGPT = "codex-account-chatgpt";
/** The person's own claude login; further ones are accounts the app made (engineAccounts.ts). */
const CLAUDE_OWN = "claudeAgent:default";

/** A further login the app made a folder for (another Claude login, another compact login): removable, the person's own never. */
const extraLogin = (engine: string, a: EngineAccount) =>
  (engine === "claude-agent" && a.id !== CLAUDE_OWN) || (engine === "codex" && a.id.startsWith(`${CODEX_CHATGPT}-`));
/** One login's own quota windows, where an engine has several. */
const usageText = (a: EngineAccount) => (a.usage_limits ?? []).map((w) => `${w.label} ${Math.round(w.used_percent)}%`).join(" · ") || undefined;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What a sign-in needs next: a command for a terminal, a page to open (a link: a window opened after
 * an await is stopped by popup blockers), a message, or all three. With `account`, the page's
 * redirect can be pasted back (engine.account.complete) for a sign-in on a remote or Cloud computer.
 */
type Steps = {
  readonly command?: string;
  readonly message?: string;
  readonly url?: string;
  readonly engine?: EngineDescriptor["id"];
  readonly account?: string;
  /** Asks again whether the sign-in landed (a terminal sign-in is finished outside the app). */
  readonly again?: () => void;
};

/**
 * Settings -> Models & keys: one engine's accounts. A key is typed once into a
 * password field, cleared on submit, and never shown again: the runtime
 * answers with labels only ("OpenAI API key ...4f2a"). The Caveman engine's
 * keys are added on its own card (CavemanProviders).
 * `rows`: Settings rows under an agent's row in Models & keys, which carries
 * its status line.
 *
 * Accounts are listed in the order they are tried: the plans and keys that
 * work everywhere first (settings/Connections.tsx), each saying where it works
 * and its state, then this computer's own logins and keys. What can be done to
 * one is in its row's menu; a plan that is only this computer's is made to
 * work everywhere from the agent's own row (ModelsAndKeys AgentRow).
 *
 * `form`: a harness's connect form opens at once, without its status lines (a way in that was already chosen).
 * `found`, `rescan`: what engine.scan found for this engine, and a way to look again (state/engine-scan.ts), where the
 * page has scanned; a Claude Agent or Codex whose command is missing shows its install command and Check again.
 */
export function EngineAccounts({
  engine,
  rows = false,
  form = false,
  found,
  rescan,
}: {
  engine: EngineDescriptor;
  rows?: boolean;
  form?: boolean;
  found?: ScanFound | undefined;
  rescan?: (() => Promise<ReadonlyMap<string, ScanFound> | null>) | undefined;
}) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One write, whoever takes it (this computer's runtime, or Cloud for a page on a Cloud computer). */
  const attempt = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: (c: Client) => Promise<unknown>) => {
    if (client) await attempt(() => action(client));
  };
  const id = engine.id;
  const now = useNow();
  const writes = useConnectionWrites(engine);
  // This computer's own logins and keys; the connections are rows of their own, above them.
  const own = pickableLogins(engine.auth.accounts);
  const many = engine.auth.accounts.length > 1;
  const ownMany = own.length > 1;
  // While a connection runs the engine, which of this computer's own logins comes next is not this page's to show.
  const onConnection = engine.auth.accounts.some((a) => isConnection(a) && a.active);
  // Where an account works is said only once connections are in play: without them the page reads as it always did.
  const placed = engine.auth.everywhere !== undefined || engine.auth.accounts.some(isConnection);
  const offer = planOffer(engine);
  /** Nothing is signed in or keyed on a Cloud computer: no sign-in, key field or removal is offered there. */
  const here = engine.auth.no_sign_in_here !== true;
  const connect = useConnect(engine, client, refresh);
  const harness = isHarness(id);
  // The last Check again says whether the command is there now, before the page's own scan has been read again.
  const [checked, setChecked] = useState<ScanFound | undefined>(undefined);
  const missing = here && cliMissing(engine, checked ?? found);
  const [steps, setSteps] = useState<Steps | null>(null);
 // A signed-out harness account (native login expired, Antigravity's runtime just landed) signs in again from its row.
  const signIn = (a: EngineAccount) =>
    harness && a.health?.state === "failing" ? (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async (c) => {
            const res = await c.call("engine.account.signin", { request_id: requestId(), engine: id, provider: a.id });
            setSteps(res.url || res.command || res.message ? { ...res, engine: id, account: a.id } : null);
          })
        }
      >
        Sign in
      </Button>
    ) : null;
  // Engines whose accounts are logins or keys of their own, one of them active.
  const switchable = id === "codex" || id === "claude-agent" || harness;
  if (rows) {
    const login = id === "claude-agent" || id === "codex";
    /** A sign-in made in a terminal on this computer: Claude's own login, or one more login of either agent. */
    const signInWith = (params: { readonly another?: true; readonly chatgpt?: true }): void =>
      void run(async (c) => {
        const res = await c.call("engine.account.add", { request_id: requestId(), engine: id, ...params });
        setSteps(res.sign_in?.command ? { ...res.sign_in, again: () => signInWith(params) } : null);
      });
    const anotherLogin = () => signInWith(id === "codex" ? { another: true, chatgpt: true } : { another: true });
    const activate = (a: EngineAccount) => void run((c) => c.call("engine.account.activate", { request_id: requestId(), engine: id, account_id: a.id }));
    const remove = (a: EngineAccount) => void run((c) => c.call("engine.account.remove", { request_id: requestId(), engine: id, account_id: a.id }));
    return (
      <>
        {engine.auth.accounts.length === 0 && writes.connections.length === 0 && offer === undefined && here && !login ? (
          <SettingRow label="No account yet" description={id === "caveman" ? "Add a key or sign in below." : undefined} />
        ) : null}
        <ConnectionRows
          engine={engine}
          writes={writes}
          busy={busy}
          run={attempt}
          onReconnect={engine.auth.everywhere === "available" ? (account) => connect.start({ replaces: account }) : undefined}
          tag={(a) => (a.tag ? <TagInput engine={id} account={a} busy={busy} run={run} /> : null)}
        />
        {missing ? (
          <SettingsCardBody>
            <InstallHelp engine={id as "claude-agent" | "codex"} rescan={rescan} onChecked={setChecked} />
          </SettingsCardBody>
        ) : null}
        {own.map((a) => {
          const extra = [a.active && ownMany && switchable ? "Active" : undefined, many ? usageText(a) : undefined].filter(Boolean).join(" · ");
          // What can be done to this login, in one menu: nothing that would be refused is listed.
          const first = switchable && ownMany && !a.active && !onConnection && here;
          const removable = here && (id === "caveman" || harness || (id === "codex" && a.kind === "api_key") || extraLogin(id, a));
          const switches = here && id === "claude-agent" && a.id === CLAUDE_OWN;
          const adds = here && login && a.kind !== "api_key";
          return (
            <SettingRow
              key={a.id}
              icon={
                <span className="flex items-center gap-1">
                  {/* Under plans and keys that drag: the handle's width, so the marks line up. */}
                  {writes.connections.length > 1 && !writes.readOnly ? <span className="size-3.5" aria-hidden /> : null}
                  <VendorMark engine={id} model={a.provider ? `${a.provider}/` : ""} />
                </span>
              }
              label={<span title={a.label} className="block truncate">{a.label}</span>}
              description={placed ? <AccountPlace account={a} now={now} extra={extra || undefined} /> : extra || undefined}
            >
              {a.tag ? <TagInput engine={id} account={a} busy={busy} run={run} /> : null}
              <HealthBadge account={a} />
              {signIn(a)}
              {first || removable || switches || adds ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={`${a.label} options`}>
                      <Icon icon={MoreHorizontalIcon} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[220px]">
                    {switches ? <DropdownMenuItem onSelect={() => signInWith({})}>Switch account</DropdownMenuItem> : null}
                    {adds ? <DropdownMenuItem onSelect={anotherLogin}>Add another account</DropdownMenuItem> : null}
                    {first ? <DropdownMenuItem onSelect={() => activate(a)}>Move to top</DropdownMenuItem> : null}
                    {removable ? (
                      <>
                        {switches || adds || first ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuItem onSelect={() => remove(a)}>Remove</DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </SettingRow>
          );
        })}
        {/* Claude Agent with no login of its own here: its own `claude`, signed in on this computer alone. */}
        {here && !missing && id === "claude-agent" && !own.some((a) => a.id === CLAUDE_OWN) ? (
          <SettingRow label={`${THIS_COMPUTER}'s Claude sign-in`} description="Not signed in">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => signInWith({})}>
              Sign in
            </Button>
          </SettingRow>
        ) : null}
        <PlanOfferRows engine={engine} writes={writes} busy={busy} run={attempt} />
        {!here ? null : id === "codex" ? (
          <>
            <SettingRow label="Add an API key" description="Paste an OpenAI API key. It is never shown again.">
              <KeyForm busy={busy} className="w-[280px] max-w-full" onAdd={(key) => run((c) => c.call("engine.account.add", { request_id: requestId(), engine: id, key }))} />
            </SettingRow>
            <ChatGptLoginSwitch engine={engine} row />
          </>
        ) : null}
        {here && harness ? <HarnessConnect engine={engine} busy={busy} run={run} onSteps={setSteps} row /> : null}
        {steps ? (
          <SettingsCardBody>
            <SignInSteps steps={steps} busy={busy} />
          </SettingsCardBody>
        ) : null}
        {error ? (
          <SettingsCardBody>
            <p role="alert" className="flex items-center gap-1 text-[12.5px] text-destructive"><span className="min-w-0 flex-1">{error}</span><ReportButton request={{ surface: "install", error: { name: "EngineSetupFailed", message: error } }} /></p>
          </SettingsCardBody>
        ) : null}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {engine.auth.accounts.length === 0 && !missing && !(form && harness) ? <span className="text-muted-foreground">None</span> : null}
      {/* A connection is managed in Settings > Models & keys: here it says where it works and its state. */}
      {writes.connections.map((a) => (
        <div key={a.id} className="flex min-h-7 flex-wrap items-center gap-x-2">
          <VendorMark engine={id} model={a.provider ? `${a.provider}/` : ""} />
          <span title={a.label} className="min-w-0 truncate">{a.label}</span>
          <span className="text-[12px] text-muted-foreground">
            <AccountPlace account={a} now={now} />
          </span>
        </div>
      ))}
      {own.map((a) => (
        <div key={a.id} className="flex min-h-7 flex-wrap items-center gap-x-2">
          <VendorMark engine={id} model={a.provider ? `${a.provider}/` : ""} />
          {a.tag ? <TagInput engine={id} account={a} busy={busy} run={run} /> : null}
          <span title={a.label} className="min-w-0 truncate">{a.label}</span>
          <HealthBadge account={a} />
          {signIn(a)}
          {switchable && ownMany && a.active ? <span className="text-[12px] text-muted-foreground">Active</span> : null}
          {many && usageText(a) ? <span className="text-[12px] tabular-nums text-muted-foreground">{usageText(a)}</span> : null}
          <span className="ml-auto flex items-center">
            {switchable && ownMany && !a.active && !onConnection && here ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run((c) => c.call("engine.account.activate", { request_id: requestId(), engine: id, account_id: a.id }))}>
                Use first
              </Button>
            ) : null}
            {here && (id === "caveman" || harness || (id === "codex" && a.kind === "api_key") || extraLogin(id, a)) ? (
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${a.label}`} onClick={() => void run((c) => c.call("engine.account.remove", { request_id: requestId(), engine: id, account_id: a.id }))}>
                Remove
              </Button>
            ) : null}
          </span>
        </div>
      ))}
      {engine.auth.message && !missing && !(form && harness) ? (
        // The Caveman engine's keys are added on its own card, which this page does not have: its line keeps the pointer.
        <span className="block text-[12.5px] text-muted-foreground">{setupHereMessage(engine.auth.message, id !== "caveman")}</span>
      ) : null}
      {missing ? <InstallHelp engine={id as "claude-agent" | "codex"} rescan={rescan} onChecked={setChecked} /> : null}
      {!here ? null : id === "codex" ? (
        <>
          <KeyForm busy={busy} onAdd={(key) => run((c) => c.call("engine.account.add", { request_id: requestId(), engine: id, key }))} />
          <ChatGptLoginSwitch engine={engine} />
          <AnotherLogin engine={engine} busy={busy} run={run} />
        </>
      ) : null}
      {here && !missing && id === "claude-agent" ? (
        <>
          <ClaudeSignIn engine={engine} busy={busy} run={run} />
          <AnotherLogin engine={engine} busy={busy} run={run} />
        </>
      ) : null}
      {here && harness ? <HarnessConnect engine={engine} busy={busy} run={run} onSteps={setSteps} startOpen={form} /> : null}
      {steps ? <SignInSteps steps={steps} /> : null}
      {error ? <span role="alert" className="inline-flex items-center gap-1 text-[12.5px] text-destructive">{error}<ReportButton request={{ surface: "install", error: { name: "EngineSetupFailed", message: error } }} /></span> : null}
    </div>
  );
}

/** Codex on the person's own compact login: a switch, and how to sign in while Codex reports none (Models & keys, onboarding). `row`: a Settings row. */
export function ChatGptLoginSwitch({ engine, row = false }: { engine: EngineDescriptor; row?: boolean }) {
  const switchId = useId();
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<{ command: string; message: string } | null>(null);
  const account = engine.auth.accounts.find((a) => a.id === CODEX_CHATGPT);
  const on = account !== undefined;
  const toggle = async (next: boolean) => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      if (!next) {
        setSteps(null);
        await client.call("engine.account.remove", { request_id: requestId(), engine: engine.id, account_id: CODEX_CHATGPT });
      } else setSteps((await client.call("engine.account.add", { request_id: requestId(), engine: engine.id, chatgpt: true })).sign_in ?? null);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  // Signed in once Codex reports the login's email; until then, how to sign in.
  const pending = steps && on && account?.label === "ChatGPT login";
  if (row) {
    return (
      <>
        <SettingRow
          id={switchId}
          label="Use my ChatGPT sign-in"
          description={
            <>
              Codex runs on your own <code className="font-mono">codex login</code> on {thisComputer}.
            </>
          }
        >
          <Switch id={switchId} checked={on} disabled={busy} onCheckedChange={(next) => void toggle(next)} />
        </SettingRow>
        {pending || error ? (
          <SettingsCardBody>
            {pending ? <SignInSteps steps={steps} /> : null}
            {error ? <p role="alert" className="flex items-center gap-1 text-[12.5px] text-destructive"><span className="min-w-0 flex-1">{error}</span><ReportButton request={{ surface: "install", error: { name: "EngineSetupFailed", message: error } }} /></p> : null}
          </SettingsCardBody>
        ) : null}
      </>
    );
  }
  return (
    <>
      <label className="mt-2 flex items-start gap-2.5">
        <Switch checked={on} disabled={busy} aria-label="Use my ChatGPT sign-in" onCheckedChange={(next) => void toggle(next)} className="mt-0.5" />
        <span className="text-[12.5px] leading-[18px]">
          <span className="block text-foreground">Use my ChatGPT sign-in</span>
          <span className="block text-muted-foreground">
            Codex runs on your own <code className="font-mono">codex login</code> and your plan's limits. Caveman Code never stores or reads the token; it only passes through on the way to OpenAI. Caveman signs in to ChatGPT separately.
          </span>
        </span>
      </label>
      {pending ? <SignInSteps steps={steps} /> : null}
      {error ? <span role="alert" className="inline-flex items-center gap-1 text-[12.5px] text-destructive">{error}<ReportButton request={{ surface: "install", error: { name: "EngineSetupFailed", message: error } }} /></span> : null}
    </>
  );
}

/**
 * An account's tag (EngineAccount.tag): two or three letters that tell its agents apart wherever they
 * show. Saved on Enter or leaving the field; emptied, it goes back to the one made from the label.
 */
export function TagInput(props: { engine: EngineDescriptor["id"]; account: EngineAccount; busy: boolean; run: (action: (c: Client) => Promise<unknown>) => Promise<void> }) {
  const [tag, setTag] = useState(props.account.tag ?? "");
  useEffect(() => setTag(props.account.tag ?? ""), [props.account.tag]);
  const save = () => {
    const next = tag.trim().toUpperCase();
    if (next === props.account.tag) return;
    if (next !== "" && !/^[A-Z0-9]{2,3}$/.test(next)) return setTag(props.account.tag ?? "");
    void props.run((c) =>
      c.call("engine.account.tag", { request_id: requestId(), engine: props.engine, account_id: props.account.id, tag: next === "" ? null : next }),
    );
  };
  return (
    <Input
      aria-label={`Tag for ${props.account.label}`}
      title="Two or three letters that mark this account's agents"
      maxLength={3}
      spellCheck={false}
      disabled={props.busy}
      value={tag}
      onChange={(e) => setTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isComposing(e)) e.currentTarget.blur();
      }}
      className="h-6 w-11 shrink-0 px-1 text-center font-mono text-[11.5px] uppercase"
    />
  );
}

/**
 * A harness's add-account form, from engine.providers (its settings schema): an optional key where it
 * takes one (Cursor), its settings, then its own sign-in: a browser page (Cursor) or its CLI.
 */
function HarnessConnect(props: {
  engine: EngineDescriptor;
  busy: boolean;
  run: (action: (c: Client) => Promise<unknown>) => Promise<void>;
  onSteps: (steps: Steps | null) => void;
  row?: boolean;
  /** The form is open from the start (a way in already chosen). */
  startOpen?: boolean;
}) {
  const { client } = useRuntimeClient();
  const [provider, setProvider] = useState<EngineProvider | null>(null);
  const [key, setKey] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(props.startOpen ?? false);
  useEffect(() => {
    if (!client) return;
    void client.call("engine.providers", { engine: props.engine.id }).then((r) => setProvider(r.providers[0] ?? null), () => setProvider(null));
  }, [client, props.engine.id]);
  if (!provider) return null;
  const label = props.engine.label;
  const connected = props.engine.auth.accounts.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    const before = new Set(props.engine.auth.accounts.map((a) => a.id));
    void props.run(async (c) => {
      const res = await c.call("engine.account.add", {
        request_id: requestId(),
        engine: props.engine.id,
        ...(value ? { key: value } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      });
      setOpen(false);
      setFields({});
      const account = res.accounts.find((a) => !before.has(a.id))?.id;
      props.onSteps(res.sign_in ? { ...res.sign_in, engine: props.engine.id, ...(account ? { account } : {}) } : null);
    });
  };
  if (!open && props.row) {
    return (
      <SettingRow label={connected ? "Another account" : `Connect ${label}`}>
        <Button size="sm" variant="outline" disabled={props.busy} onClick={() => setOpen(true)}>
          {connected ? "Add another account" : `Connect ${label}`}
        </Button>
      </SettingRow>
    );
  }
  if (!open) {
    return (
      <div className="mt-1 flex flex-col gap-2">
        <Button size="sm" variant="outline" className="self-start" disabled={props.busy} onClick={() => setOpen(true)}>
          {connected ? "Add another account" : `Connect ${label}`}
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className={props.row ? "flex flex-col gap-2 px-5 py-4" : "mt-1 flex flex-col gap-2"}>
      {provider.key_label ? (
        <Input
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          aria-label={provider.key_label}
          placeholder={`${provider.key_label} (optional: or sign in)`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="h-7 font-mono placeholder:font-sans"
        />
      ) : null}
      {(provider.fields ?? []).map((f) => (
        <HarnessField key={f.name} field={f} value={fields[f.name] ?? ""} onChange={(v) => setFields({ ...fields, [f.name]: v })} />
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={props.busy}>
          {props.busy ? "Connecting…" : key.trim() ? "Add key" : provider.auth === "cli" ? `Connect ${label}` : `Sign in to ${label}`}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One setting of a harness's add-account form: its choices where it has them, else a text field. */
export function HarnessField(props: { field: NonNullable<EngineProvider["fields"]>[number]; value: string; onChange: (value: string) => void }) {
  const f = props.field;
  if (f.options) {
    return (
      <Select value={props.value} onValueChange={(v) => props.onChange(String(v ?? ""))}>
        <SelectTrigger aria-label={f.label} className="h-7 text-[12.5px]">
          <SelectValue placeholder={f.label} />
        </SelectTrigger>
        <SelectContent>
          {f.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      // A server password is a credential: never shown, never offered to a password manager.
      {...(/password|secret|token|key/i.test(f.name) ? { type: "password", autoComplete: "new-password", "data-1p-ignore": true } : {})}
      aria-label={f.label}
      placeholder={f.placeholder ? `${f.label}: ${f.placeholder}` : f.label}
      spellCheck={false}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className="h-7 font-mono placeholder:font-sans"
    />
  );
}

/**
 * One more Claude login, or one more compact login for Codex: an account of its own with a config folder of
 * its own, signed in there with the person's own claude or codex (engine.account.add another). The app
 * never sees the login's credentials.
 */
function AnotherLogin(props: { engine: EngineDescriptor; busy: boolean; run: (action: (c: Client) => Promise<unknown>) => Promise<void>; row?: boolean }) {
  const [steps, setSteps] = useState<Steps | null>(null);
  const claude = props.engine.id === "claude-agent";
  const label = claude ? "Another Claude account" : "Another ChatGPT account";
  const description = claude
    ? "Run a second Claude account (work and personal, say) beside your own. Pick which one a chat runs on in the model picker."
    : "Run a second ChatGPT account beside your own. Pick which one a chat runs on in the model picker.";
  const add = () =>
    props.run(async (c) => {
      const res = await c.call("engine.account.add", { request_id: requestId(), engine: props.engine.id, another: true, ...(claude ? {} : { chatgpt: true }) });
      setSteps(res.sign_in?.command ? res.sign_in : null);
    });
  const button = (
    <Button size="sm" variant="outline" className={props.row ? undefined : "ml-auto"} disabled={props.busy} onClick={() => void add()}>
      {steps ? (props.busy ? "Checking…" : "Check again") : "Add account"}
    </Button>
  );
  if (props.row) {
    return (
      <>
        <SettingRow label={label} description={description}>
          {button}
        </SettingRow>
        {steps ? (
          <SettingsCardBody>
            <SignInSteps steps={steps} />
          </SettingsCardBody>
        ) : null}
      </>
    );
  }
  return (
    <>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[12.5px] text-muted-foreground">{label}</span>
        {button}
      </div>
      {steps ? <SignInSteps steps={steps} /> : null}
    </>
  );
}

/** What a sign-in needs next (Steps): its message, its command in a terminal on this computer, its page as a link. */
export function SignInSteps({ steps, busy = false }: { steps: Steps; busy?: boolean }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const navigate = useNavigate();
  const [callback, setCallback] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const workspace = workspaces.find((w) => w.computer.kind === "this_mac" && !w.asleep);
  const finish = (e: FormEvent) => {
    e.preventDefault();
    const url = callback.trim();
    if (!client || !url || !steps.engine || !steps.account) return;
    setCallback("");
    void client
      .call("engine.account.complete", { request_id: requestId(), engine: steps.engine, account_id: steps.account, callback_url: url })
      .then(
        () => {
          setNote({ tone: "ok", text: "Signed in." });
          return refresh();
        },
        (error: unknown) => setNote({ tone: "error", text: message(error) }),
      );
  };
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg bg-secondary/40 px-3 py-2.5">
      {steps.message ? <p className="text-[12.5px] leading-5 text-muted-foreground">{steps.message}</p> : null}
      {steps.command ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[12px]">{steps.command}</code>
          {workspace ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // A failed start shows in the terminal's tab.
                if (client) void runInTerminal(client, workspace.id, steps.command!).catch(() => undefined);
                navigate(`/w/${workspace.id}`);
              }}
            >
              Open a terminal
            </Button>
          ) : null}
        </div>
      ) : null}
      {steps.url ? (
        <a href={steps.url} target="_blank" rel="noopener noreferrer" className="self-start rounded-sm text-[12.5px] font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Open the sign-in page
        </a>
      ) : null}
      {steps.again ? (
        <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={steps.again}>
          {busy ? "Checking…" : "Check again"}
        </Button>
      ) : null}
      {steps.url && steps.account ? (
        <form onSubmit={finish} className="flex items-center gap-2">
          <Input
            aria-label="Address the sign-in page ended on"
            placeholder="Signing in on another computer? Paste the address the page ended on"
            spellCheck={false}
            value={callback}
            onChange={(e) => setCallback(e.target.value)}
            className="h-7 min-w-0 flex-1 font-mono text-[12px] placeholder:font-sans"
          />
          <Button type="submit" size="sm" variant="outline" disabled={callback.trim() === ""}>
            Finish
          </Button>
        </form>
      ) : null}
      {note ? (
        <p role={note.tone === "error" ? "alert" : undefined} className={cn("text-[12.5px]", note.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function KeyForm(props: { busy: boolean; onAdd: (key: string) => Promise<void>; className?: string }) {
  const [key, setKey] = useState("");
  const name = "OpenAI";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    if (value) void props.onAdd(value);
  };
  return (
    <form onSubmit={submit} className={cn("flex items-center gap-2", props.className ?? "mt-1")}>
      <Input
        type="password"
        // A key is not a site password: keep browsers and password managers from offering to save it.
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
        aria-label={`${name} API key`}
        placeholder="Paste an OpenAI API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="h-7 min-w-0 flex-1 font-mono placeholder:font-sans"
      />
      <Button type="submit" size="sm" disabled={props.busy || key.trim() === ""}>
        {props.busy ? "Adding…" : "Add key"}
      </Button>
    </form>
  );
}

/**
 * The Claude Agent or Codex command is not on this computer: the command that installs it here, to copy and run in
 * a terminal, and Check again (engine.scan looks afresh). The app installs nothing itself (providerInstallation.ts).
 * `rescan`: the page's own scan, so the rest of the page reads the answer too; else one is made here.
 */
export function InstallHelp(props: {
  engine: "claude-agent" | "codex";
  rescan?: (() => Promise<ReadonlyMap<string, ScanFound> | null>) | undefined;
  onChecked?: ((found: ScanFound | undefined) => void) | undefined;
}) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Anthropic's own installer for Claude Agent, per computer (routes/engines/install-commands.ts, which cites
  // https://docs.claude.com/en/docs/claude-code/setup); the runtime's not-found line names the same command.
  const install = installFor(props.engine, OS);
  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const found = props.rescan
        ? await props.rescan()
        : client
          ? await scanEngines(client).then(async (map) => (await refresh(), map))
          : null;
      const mine = found?.get(props.engine);
      props.onChecked?.(mine);
      if (!found) setNote("Couldn't check. Try again.");
      else if (mine === "not_found") setNote("Still not found on this computer.");
    } catch (e) {
      setNote(message(e));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary/40 px-3 py-2.5">
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        {props.engine === "claude-agent" ? "Claude Agent runs the claude app, and it isn't on this computer yet." : "Codex isn't on this computer yet."} Install it in a terminal, then check again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[12px]">{install.command}</code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void (navigator.clipboard?.writeText(install.command) ?? Promise.reject(new Error("no clipboard"))).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="outline" className="ml-auto" disabled={checking || (!client && !props.rescan)} onClick={() => void check()}>
          {checking ? "Checking…" : "Check again"}
        </Button>
      </div>
      {install.needs ? <p className="text-[12px] text-muted-foreground">{install.needs}</p> : null}
      {note ? (
        <p role="status" className="text-[12.5px] text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** Claude Agent never takes a credential: sign-in is the user's own `claude`, in a terminal. */
function ClaudeSignIn(props: { engine: EngineDescriptor; busy: boolean; run: (action: (c: Client) => Promise<unknown>) => Promise<void>; row?: boolean }) {
  const { client } = useRuntimeClient();
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const navigate = useNavigate();
  const [steps, setSteps] = useState<{ command: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const signedIn = props.engine.auth.state === "signed_in";
  const ask = () =>
    props.run(async (c) => {
      const res = await c.call("engine.account.add", { request_id: requestId(), engine: "claude-agent" });
      setSteps(res.sign_in ?? null);
    });
  // Only a terminal on this computer: `claude` /login on a Cloud computer would leave the user's Claude login there.
  const workspace = workspaces.find((w) => w.computer.kind === "this_mac" && !w.asleep);
  const signInButton = (
    <Button size="sm" variant="outline" className={props.row ? undefined : "ml-auto"} disabled={props.busy} onClick={() => void ask()}>
      {signedIn ? "Switch account" : "Sign in"}
    </Button>
  );
  if (!steps && props.row) {
    return (
      <SettingRow label="Claude sign-in" description={signedIn ? "Signed in with your own claude." : "Not signed in"}>
        {signInButton}
      </SettingRow>
    );
  }
  if (!steps) {
    return (
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[12.5px] text-muted-foreground">{signedIn ? "Signed in with your own claude." : "Not signed in."}</span>
        {signInButton}
      </div>
    );
  }
  const panel = (
    <div className={cn("flex flex-col gap-2 rounded-lg bg-secondary/40 px-3 py-2.5", !props.row && "mt-1")}>
      <p className="text-[12.5px] leading-5 text-muted-foreground">{steps.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[12px]">{steps.command}</code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(steps.command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {workspace ? (
          <Button
            size="sm"
            variant="ghost"
            title={`Opens a terminal in ${workspace.title}`}
            onClick={() => {
              if (client) void runInTerminal(client, workspace.id, steps.command).catch(() => undefined);
              navigate(`/w/${workspace.id}`);
            }}
          >
            Open a terminal
          </Button>
        ) : null}
        <Button size="sm" variant="outline" className="ml-auto" disabled={props.busy} onClick={() => void ask()}>
          {props.busy ? "Checking…" : "Check again"}
        </Button>
      </div>
    </div>
  );
  return props.row ? <SettingsCardBody>{panel}</SettingsCardBody> : panel;
}
