import type { Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Icon, ArrowUpRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type FormEvent } from "react";
import { offersCredits } from "../../state/cloud.ts";
import { credentialsOutside } from "../../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";

type WebKeys = Result<"web.keys.status">;
type Provider = WebKeys["providers"][number]["id"];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The search providers in the order searches try them, then Firecrawl, with what Settings says about each. */
export const WEB_PROVIDERS: ReadonlyArray<{ id: Provider; label: string; line: string; keyUrl: string }> = [
  { id: "brave", label: "Brave Search", line: "Tried first. Doesn't train on your searches.", keyUrl: "https://api-dashboard.search.brave.com/app/keys" },
  { id: "perplexity", label: "Perplexity", line: "Tried when Brave Search is busy or not set. Doesn't train on your searches.", keyUrl: "https://www.perplexity.ai/account/api/keys" },
  { id: "exa", label: "Exa", line: "Used only once you add its key. Exa may use your searches to improve its service.", keyUrl: "https://dashboard.exa.ai/api-keys" },
  {
    id: "firecrawl",
    label: "Firecrawl",
    line: "Reads pages the agent can't open itself, like JavaScript apps and sites with bot checks. Only those addresses go to Firecrawl.",
    keyUrl: "https://www.firecrawl.dev/app/api-keys",
  },
];

/**
 * The Firecrawl row's line, by whether Firecrawl Local is on the runtime's computer (web_fetch then reads every page
 * with it). Absent: a runtime that does not say, so the line about the key alone.
 */
export const firecrawlLine = (local: boolean | undefined): string =>
  local === true
    ? "Firecrawl Local reads pages on this computer, JavaScript apps included. A key lets Firecrawl Cloud try sites that still block it."
    : local === false
      ? "Install Firecrawl Local to read JavaScript apps and blocked pages on this computer: cargo install firecrawl-local. Or add a key to use Firecrawl Cloud."
      : WEB_PROVIDERS.find((p) => p.id === "firecrawl")!.line;

/** Firecrawl reads pages; it never searches, so it is not one of the keys credits stand behind. */
const searches = (id: Provider) => id !== "firecrawl";

/**
 * Settings > Models & keys > Web search: the Caveman engine's web_search, and the Firecrawl key its web_fetch reads
 * hard pages with. Search runs on Caveman credits, at cost, unless the person adds a key of their own; Claude Agent
 * and Codex search with their own tools.
 */
export function WebSearchKeys() {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const [keys, setKeys] = useState<WebKeys | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    client.call("web.keys.status", {}).then(
      (next) => {
        if (!live) return;
        setKeys(next);
        setLoadError(null);
      },
      (e: unknown) => live && setLoadError(message(e)),
    );
    return () => {
      live = false;
    };
    // Turning credits on or off in Account changes the Caveman engine's models, so engine.changed follows it.
  }, [client, engines]);
  const cloudUrl = useRuntimeSelector((v) => v.settings?.cloud_url);
  return (
    <WebSearchCard keys={keys} loadError={loadError} error={error} onChange={setKeys} onError={setError} credits={offersCredits(cloudUrl, keys?.credits === true)} outside={credentialsOutside(engines)} />
  );
}

const DESCRIPTION =
  "How the Caveman engine searches and reads the web. Search runs on Caveman credits, at cost, unless you add a key of your own; your key is used first. A key is checked once, then stored encrypted on this computer. Claude Agent and Codex use their own web search.";
/** On a company's own Cloud that sells no credits. */
const OWN_KEYS_DESCRIPTION =
  "How the Caveman engine searches and reads the web, on a key of your own. A key is checked once, then stored encrypted on this computer. Claude Agent and Codex use their own web search.";
/**
 * In a window on a Cloud computer that keeps nothing of its person's (state/engines.ts credentialsOutside): the
 * runtime there takes no key (web.keys.set is refused), so the card offers no field for one. A key an earlier
 * version kept there still shows, to be removed.
 */
export const WEB_KEYS_ELSEWHERE = "Web search in Cloud runs on Caveman credits. Add your own key on your Mac (Settings > Models & keys).";

/** The card for what the runtime said (or could not say) about web search. */
export function WebSearchCard(props: {
  keys: WebKeys | null;
  loadError: string | null;
  error: string | null;
  onChange: (keys: WebKeys) => void;
  onError: (error: string | null) => void;
  /** Whether Caveman credits are offered here (state/cloud.ts offersCredits). Absent: they are. */
  credits?: boolean;
  /** This window's runtime takes no key (WEB_KEYS_ELSEWHERE). */
  outside?: boolean;
}) {
  const { keys, loadError, error, onChange: setKeys, onError: setError } = props;
  const offered = props.credits !== false;
  const outside = props.outside === true;
  const description = outside ? WEB_KEYS_ELSEWHERE : offered ? DESCRIPTION : OWN_KEYS_DESCRIPTION;
  if (!keys) {
    if (loadError === null) return null;
    return (
      <SettingsCard title="Web search" description={description}>
        <SettingsCardBody className="py-3">
          <p role="alert" className="text-[12.5px] text-destructive">
            Could not read the web search settings: {loadError}
          </p>
        </SettingsCardBody>
      </SettingsCard>
    );
  }
  const own = keys.providers.some((p) => p.configured && searches(p.id));
  return (
    <SettingsCard title="Web search" description={description}>
      {offered ? (
        <SettingRow to="/settings/plan" label="Caveman credits" description={own ? "Used when none of your keys answers." : "Searches run on your credits, at cost."}>
          {keys.credits ? "On" : "Turn on in Account"}
        </SettingRow>
      ) : null}
      {/* Where no key is taken, only a provider with one kept from before has a row: its Remove. */}
      {WEB_PROVIDERS.filter((p) => !outside || keys.providers.some((s) => s.id === p.id && s.configured)).map((p) => (
        <WebKeyRow
          key={p.id}
          provider={p.id === "firecrawl" ? { ...p, line: firecrawlLine(keys.firecrawl_local) } : p}
          status={keys.providers.find((s) => s.id === p.id)}
          onChange={setKeys}
          onError={setError}
        />
      ))}
      {error || loadError ? (
        <SettingsCardBody className="py-3">
          <p role="alert" className="text-[12.5px] text-destructive">
            {error ?? `Could not refresh the web search settings: ${loadError}`}
          </p>
        </SettingsCardBody>
      ) : null}
    </SettingsCard>
  );
}

export function WebKeyRow(props: {
  provider: (typeof WEB_PROVIDERS)[number];
  status: WebKeys["providers"][number] | undefined;
  onChange: (keys: WebKeys) => void;
  onError: (error: string | null) => void;
}) {
  const { client } = useRuntimeClient();
  const p = props.provider;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (action: () => Promise<WebKeys & { note?: string }>) => {
    setBusy(true);
    setNote(null);
    props.onError(null);
    try {
      const next = await action();
      props.onChange(next);
      setNote(next.note ?? null);
    } catch (e) {
      props.onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    if (!client || value === "") return;
    void run(() => client.call("web.keys.set", { request_id: requestId(), provider: p.id, key: value }));
  };
  return (
    <SettingRow
      label={p.label}
      description={
        <>
          {p.line}
          {props.status?.refused ? <span className="block text-destructive">{p.label} refused this key at its last {searches(p.id) ? "search" : "read"}. Remove it and add a new one.</span> : null}
          {/* Always there, so a screen reader hears a note when it appears. */}
          <span role="status" aria-live="polite" className="block text-warning">
            {note}
          </span>
        </>
      }
    >
      {props.status?.configured ? (
        <>
          <span className="font-mono text-[12.5px] text-muted-foreground">{props.status.hint ?? "Key set"}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !client}
            aria-label={`Remove the ${p.label} key`}
            onClick={() => void run(() => client!.call("web.keys.clear", { request_id: requestId(), provider: p.id }))}
          >
            Remove
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="flex items-center gap-2">
          <a
            href={p.keyUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Get a ${p.label} key (opens in a new tab)`}
            className="inline-flex items-center gap-0.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            Get a key <Icon icon={ArrowUpRight01Icon} className="size-3" />
          </a>
          <Input
            type="password"
            // A key is not a site password: keep browsers and password managers from offering to save it.
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            spellCheck={false}
            aria-label={`${p.label} API key`}
            placeholder="Paste a key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 w-[200px] font-mono placeholder:font-sans"
          />
          <Button type="submit" size="sm" disabled={busy || key.trim() === ""}>
            {busy ? "Checking…" : "Add"}
          </Button>
        </form>
      )}
    </SettingRow>
  );
}
