import {
  ONE_PASSWORD_REFERENCE_PLACEHOLDER,
  type Result,
  type SecretProviderInfo,
  type SecretSlot,
} from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caveman-app/ui/components/select";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { credentialsOutside } from "../../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import {
  groupSlots,
  providerLine,
  referenceProblem,
  slotKey,
  slotLine,
} from "./secret-providers-model.ts";
import { Segmented, SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

type View = Result<"secret_provider.list">;
type Client = NonNullable<ReturnType<typeof useRuntimeClient>["client"]>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const KEPT_HERE =
  "Keep keys and tokens in 1Password instead of pasting them here. Caveman Code keeps only the reference and reads the value on this computer each time it is needed. Values are never stored, logged or shown, and are hidden from what agents send to models.";
/**
 * In a window on a Cloud computer that keeps nothing of its person's (state/engines.ts credentialsOutside): the
 * runtime there connects no secret manager and points no setting at one (secret_provider.save and secret_slot.set
 * are refused), so the page offers neither. One an earlier version connected there still shows, to be removed.
 */
export const MANAGER_ELSEWHERE = "Connect 1Password on your Mac (Settings > Secret providers).";

/**
 * Settings > Secret providers: connect 1Password and point engine keys and source control tokens at it instead of
 * pasting them. Only the reference (op://vault/item/field) is kept; the value is read on this computer when it is
 * used, never stored, logged or shown.
 */
export function SecretProvidersSettings() {
  const { client } = useRuntimeClient();
  const outside = credentialsOutside(useRuntimeSelector((v) => v.engines));
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setView(await client.call("secret_provider.list", {}));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [client]);
  useEffect(() => void load(), [load]);

  /** Runs a call that answers with the whole view; false when it failed (its error shows under the card). */
  const run = async (call: (c: Client) => Promise<View>) => {
    if (!client) return false;
    setBusy(true);
    setError(null);
    try {
      setView(await call(client));
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view)
    return error ? (
      <SettingsCard title="Secret managers">
        <SettingsCardBody className="py-3">
          <p role="alert" className="text-[12.5px] text-destructive">
            Could not read secret providers: {error}
          </p>
        </SettingsCardBody>
      </SettingsCard>
    ) : null;

  return (
    <>
      <SettingsCard
        title="Secret managers"
        description={outside ? MANAGER_ELSEWHERE : KEPT_HERE}
        actions={
          view.providers.length > 0 ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run((c) => c.call("secret_provider.refresh", { request_id: requestId() }))
              }
            >
              Read again
            </Button>
          ) : null
        }
      >
        {view.providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            busy={busy}
            onRemove={() =>
              void run((c) =>
                c.call("secret_provider.remove", { request_id: requestId(), id: p.id }),
              )
            }
          />
        ))}
        {outside ? null : (
          <AddProvider
            busy={busy}
            first={view.providers.length === 0}
            onAdd={(params) =>
              run((c) => c.call("secret_provider.save", { request_id: requestId(), ...params }))
            }
          />
        )}
        {error ? (
          <SettingsCardBody className="py-3">
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          </SettingsCardBody>
        ) : null}
      </SettingsCard>
      {/* Where no setting is pointed at one, only a setting that reads from one has a row: its Stop using. */}
      {groupSlots(outside ? view.slots.filter((slot) => slot.ref !== undefined) : view.slots).map(
        (group) => (
          <SettingsCard
            key={group.title}
            title={group.title}
            description={
              group.title === "Engine keys"
                ? "Engines start with the key read from 1Password. Claude Agent isn't here: it runs on your own claude login."
                : undefined
            }
          >
            {group.slots.map((slot) => (
              <SlotRow
                key={slotKey(slot.target)}
                slot={slot}
                providers={view.providers.filter((p) => p.supported)}
                busy={busy}
                onSet={(ref) =>
                  run((c) =>
                    c.call("secret_slot.set", {
                      request_id: requestId(),
                      target: slot.target,
                      ref,
                    }),
                  )
                }
              />
            ))}
          </SettingsCard>
        ),
      )}
    </>
  );
}

function ProviderRow({
  provider,
  busy,
  onRemove,
}: {
  provider: SecretProviderInfo;
  busy: boolean;
  onRemove: () => void;
}) {
  const { client } = useRuntimeClient();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const check = async () => {
    if (!client) return;
    setChecking(true);
    setResult(null);
    try {
      setResult(
        await client.call("secret_provider.check", { request_id: requestId(), id: provider.id }),
      );
    } catch (e) {
      setResult({ ok: false, message: message(e) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <SettingRow
      icon={<Glyph name="secret" className="text-muted-foreground" />}
      label={provider.label}
      description={
        <>
          {providerLine(provider)}
          {/* Always there, so a screen reader hears the answer when it comes. */}
          <span
            role="status"
            aria-live="polite"
            className={result?.ok ? "block text-success" : "block text-warning"}
          >
            {result?.message}
          </span>
        </>
      }
    >
      <Button
        variant="secondary"
        disabled={busy || checking || !provider.supported}
        onClick={() => void check()}
      >
        {checking ? "Checking…" : "Check"}
      </Button>
      <Button
        variant="ghost"
        disabled={busy}
        aria-label={`Remove ${provider.label}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </SettingRow>
  );
}

type AddParams = {
  label: string;
  account?: string;
  service_account?: boolean;
  service_account_token?: string;
};

function AddProvider({
  busy,
  first,
  onAdd,
}: {
  busy: boolean;
  first: boolean;
  onAdd: (params: AddParams) => Promise<boolean>;
}) {
  const [name, setName] = useState(first ? "1Password" : "");
  const [mode, setMode] = useState<"app" | "service">("app");
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const nameId = useId();
  const valueId = useId();
  const ready =
    name.trim() !== "" && (mode === "app" ? account.trim() !== "" : token.trim() !== "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const params: AddParams =
      mode === "app"
        ? { label: name.trim(), account: account.trim() }
        : { label: name.trim(), service_account: true, service_account_token: token.trim() };
    // The field never keeps a token, whatever the answer.
    setToken("");
    if (await onAdd(params)) {
      setName("");
      setAccount("");
    }
  };
  return (
    <SettingRow
      label={first ? "Connect 1Password" : "Add another"}
      description="Through the 1Password app, or a service account for a computer nobody sits at. Needs the op CLI."
      stacked
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="self-start">
          <Segmented
            label="Sign in with"
            value={mode}
            options={[
              { value: "app", label: "1Password app" },
              { value: "service", label: "Service account" },
            ]}
            onChange={setMode}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label htmlFor={nameId} className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            Name
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="1Password"
              className="h-8 w-[160px]"
              autoComplete="off"
            />
          </label>
          {mode === "app" ? (
            <label
              htmlFor={valueId}
              className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-muted-foreground"
            >
              Account
              <Input
                id={valueId}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="my.1password.com or you@example.com"
                className="h-8"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <label
              htmlFor={valueId}
              className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-muted-foreground"
            >
              Service account token
              <Input
                id={valueId}
                type="password"
                // A token is not a site password: keep browsers and password managers from offering to save it.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ops_…"
                className="h-8 font-mono placeholder:font-sans"
              />
            </label>
          )}
          <Button type="submit" disabled={busy || !ready}>
            Connect
          </Button>
        </div>
      </form>
    </SettingRow>
  );
}

function SlotRow({
  slot,
  providers,
  busy,
  onSet,
}: {
  slot: SecretSlot;
  providers: ReadonlyArray<SecretProviderInfo>;
  busy: boolean;
  onSet: (ref: { provider: string; reference: string } | null) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState(providers[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const inputId = useId();
  const problem = referenceProblem(reference);
  const chosen = providers.some((p) => p.id === provider) ? provider : (providers[0]?.id ?? "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem !== null || reference.trim() === "" || chosen === "") return;
    if (await onSet({ provider: chosen, reference: reference.trim() })) setReference("");
  };
  return (
    <SettingRow
      label={<span className="font-mono text-[12.5px]">{slot.label}</span>}
      description={
        <>
          {slotLine(slot, providers)}
          {slot.ref ? (
            <span className="block font-mono text-[12px] text-foreground/80">
              {slot.ref.reference}
            </span>
          ) : null}
          {slot.problem ? <span className="block text-warning">{slot.problem}</span> : null}
          {problem ? <span className="block text-destructive">{problem}</span> : null}
        </>
      }
    >
      {slot.ref ? (
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={`Stop reading ${slot.label} from 1Password`}
          onClick={() => void onSet(null)}
        >
          Stop using
        </Button>
      ) : providers.length === 0 ? (
        <span className="text-[12.5px] text-muted-foreground">Connect 1Password above first</span>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex items-center gap-2">
          {providers.length > 1 ? (
            <Select value={chosen} onValueChange={setProvider}>
              <SelectTrigger
                aria-label="Secret provider"
                className="h-8 w-auto min-w-[120px] text-[13px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Input
            id={inputId}
            aria-label={`1Password reference for ${slot.label}`}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={ONE_PASSWORD_REFERENCE_PLACEHOLDER}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-[220px] font-mono text-[12.5px] placeholder:font-sans"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || reference.trim() === "" || problem !== null}
          >
            Use
          </Button>
        </form>
      )}
    </SettingRow>
  );
}
