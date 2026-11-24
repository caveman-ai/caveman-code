import type { EngineDescriptor, Result } from "@caveman-app/session-protocol";
import { Progress } from "@caveman-app/ui/components/progress";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState } from "react";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { Segmented, SettingRow, SettingsCard, SettingsCardBody, SettingsLine, useSaveSettings } from "./rows.tsx";

type Spend = Result<"spend.summary">;
type Row = Spend["rows"][number];
const GROUPS = ["engine", "project", "workspace", "model", "day"] as const;
const GROUP_OPTIONS = GROUPS.map((g) => ({ value: g, label: g[0]!.toUpperCase() + g.slice(1) }));

const BASIS: Record<Row["basis"], { label: string; title: string }> = {
  billed: { label: "Billed", title: "What the provider billed" },
  list_price: { label: "List price", title: "Tokens at the provider's public list price, computed here: not a bill" },
  mixed: { label: "Mixed", title: "Some of it priced, some on a plan or unpriced: the cost covers the priced part only" },
  plan: { label: "Plan", title: "On a subscription plan: tokens only, no per-call price" },
  unpriced: { label: "Unpriced", title: "On your key, but the model has no public price: tokens only" },
  none: { label: "Tokens", title: "Older usage that recorded no price" },
};

/** A row's name: by engine, the engine's own label ("Claude Agent", not "claude-agent"); anything else as reported. Its web searches go in their column. */
export function usageRowLabel(row: Pick<Row, "key" | "label">, groupBy: (typeof GROUPS)[number], engines: ReadonlyArray<{ readonly id: string; readonly label: string }>): string {
  return groupBy === "engine" ? (engines.find((e) => e.id === row.key)?.label ?? row.label) : row.label;
}

/** A row's basis badge. Web searches are no tokens: on your own key each is the provider's list price, an estimate; on credits, what was billed. */
export function basisOf(row: Pick<Row, "basis" | "bucket">): { label: string; title: string } {
  if (row.bucket === "web" && row.basis === "list_price") return { label: "Estimated", title: "Each search at the provider's list price, computed here: your own key is billed by the provider" };
  if (row.bucket === "web" && row.basis === "billed") return { label: "Billed", title: "What your Caveman credits were billed for these searches" };
  return BASIS[row.basis];
}

const ms = (n: number | undefined) => (n === undefined ? "—" : n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(n < 10 ? 2 : 0)}`);

/** Settings > Usage: measured spend on this computer, by engine, project, workspace, model or day; plan windows; latency. */
export function UsageSettings() {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const [groupBy, setGroupBy] = useState<(typeof GROUPS)[number]>("engine");
  const [data, setData] = useState<Spend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  useEffect(() => {
    client?.call("cloud.status", {}).then((s) => setReported(s.usage_reported === true), () => setReported(false));
  }, [client]);
  useEffect(() => {
    if (!client) return;
    client.call("spend.summary", { group_by: groupBy }).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [client, groupBy]);

  const measured = data?.rows.reduce((sum, r) => sum + (r.measured_usd ?? 0), 0) ?? 0;
  const anyMeasured = data?.rows.some((r) => r.measured_usd !== null) ?? false;
  const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
  // Web searches (Claude Agent counts them): a column only once some row has one.
  const searched = data?.rows.some((r) => (r.web_searches ?? 0) > 0) ?? false;

  return (
    <>
      <SettingsCard title="Summary" description={reported ? "Usage (tokens and cost) is sent to your Caveman account." : undefined}>
        <div className="grid grid-cols-2 divide-x divide-border/60">
          <Figure label="Measured" value={anyMeasured ? usd(measured) : "—"} foot="From usage the engines reported" />
          <Figure label="Verified saving" value={data?.verified_usd != null ? usd(data.verified_usd) : null} foot="A/B on your own work" />
        </div>
      </SettingsCard>
      <PlanWindows engines={engines} />
      <CursorKeychainUsage />
      <SettingsCard
        title="Measured spend"
        actions={<Segmented label="Group by" value={groupBy} options={GROUP_OPTIONS} onChange={setGroupBy} />}
      >
        {error ? (
          <SettingsLine tone="bad">{error}</SettingsLine>
        ) : data === null ? (
          <SettingsLine>Loading…</SettingsLine>
        ) : data.rows.length === 0 ? (
          <SettingsLine>No usage recorded yet.</SettingsLine>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead>
                <tr className="text-[12px] text-muted-foreground">
                  <th className="h-9 border-b border-border/60 px-5 text-left font-normal capitalize">{groupBy}</th>
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal">Input</th>
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal">Output</th>
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal">Cache read</th>
                  {searched ? <th className="h-9 border-b border-border/60 px-3 text-right font-normal" title="Their price is already in the cost">Web searches</th> : null}
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal">Cost</th>
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal">Basis</th>
                  <th className="h-9 border-b border-border/60 px-3 text-right font-normal" title="Median time to the first streamed text or reasoning">First token p50</th>
                  <th className="h-9 border-b border-border/60 px-5 text-right font-normal" title="Median turn length">Turn p50</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child_td]:border-b-0">
                {data.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="max-w-56 truncate border-b border-border/60 px-5 py-2.5" title={usageRowLabel(r, groupBy, engines)}>{usageRowLabel(r, groupBy, engines)}</td>
                    {/* Web searches are no tokens. */}
                    <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums">{r.bucket === "web" ? "—" : tokens(r.input_tokens)}</td>
                    <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums">{r.bucket === "web" ? "—" : tokens(r.output_tokens)}</td>
                    <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums">{r.bucket === "web" ? "—" : tokens(r.cache_read_tokens)}</td>
                    {searched ? <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums">{r.web_searches ? r.web_searches.toLocaleString() : "—"}</td> : null}
                    <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums">{r.measured_usd === null ? "—" : usd(r.measured_usd)}</td>
                    <td className="border-b border-border/60 px-3 py-2.5 text-right">
                      <span title={basisOf(r).title} className="inline-flex h-5 items-center rounded border border-border px-1.5 text-[11px] text-muted-foreground">
                        {basisOf(r).label}
                      </span>
                    </td>
                    <td className="border-b border-border/60 px-3 py-2.5 text-right tabular-nums text-muted-foreground">{ms(r.p50_ttft_ms)}</td>
                    <td className="border-b border-border/60 px-5 py-2.5 text-right tabular-nums text-muted-foreground">{ms(r.p50_turn_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>
    </>
  );
}

/**
 * Subscription logins' quota windows (Claude's five hours and week, Codex's), as each engine reports them: one
 * set per login where an engine has several (two Claude accounts), named by the login's tag.
 */
export function planLogins(engines: ReadonlyArray<EngineDescriptor>) {
  return engines.flatMap((e) => {
    const several = e.auth.accounts.length > 1;
    const per = several ? e.auth.accounts.filter((a) => (a.usage_limits ?? []).length > 0) : [];
    if (per.length > 0) return per.map((a) => ({ key: `${e.id}:${a.id}`, name: `${e.label} ${a.tag ?? a.label}`, windows: a.usage_limits!, onCredits: a.active && e.usage_on_credits === true }));
    return (e.usage_limits ?? []).length > 0 ? [{ key: e.id, name: e.label, windows: e.usage_limits!, onCredits: e.usage_on_credits === true }] : [];
  });
}

function PlanWindows({ engines }: { engines: ReadonlyArray<EngineDescriptor> }) {
  const logins = planLogins(engines);
  if (logins.length === 0) return null;
  return (
    <SettingsCard title="Plan limits">
      {logins.flatMap((e) =>
        e.windows.map((w) => (
          <SettingsCardBody key={`${e.key}:${w.id}`}>
            <div className="flex items-baseline gap-4 text-[13px]">
              <span title={`${e.name} · ${w.label}`} className="min-w-0 flex-1 truncate">
                {e.name} <span className="text-muted-foreground">· {w.label}{e.onCredits && w.used_percent >= 100 ? " · now on credits" : ""}</span>
              </span>
              <span className="shrink-0 tabular-nums">{Math.round(w.used_percent)}%</span>
            </div>
            <Progress value={Math.min(100, Math.max(0, w.used_percent))} aria-label={`${e.name} ${w.label}: ${Math.round(w.used_percent)}% used`} className="mt-2 h-1.5" />
            {w.resets_at ? (
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                Resets {new Date(w.resets_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
              </p>
            ) : null}
          </SettingsCardBody>
        )),
      )}
    </SettingsCard>
  );
}

/**
 * native plan limits on a Mac: its login sits in the Keychain, so reading them asks macOS for
 * access (upstream enableCursorKeychain). Off until the person turns it on; shown once Cursor is connected.
 */
export function CursorKeychainUsage() {
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings({ throws: true });
  const [error, setError] = useState<string | null>(null);
  const cursor = engines.find((e) => e.id === "cursor");
  if (settings?.cursor_keychain_usage === undefined || !cursor || cursor.auth.accounts.length === 0) return null;
  return (
    <SettingsCard title="Cursor">
      <SettingRow
        id="cursor-keychain-usage"
        label="Show Cursor's plan limits"
        description="Reads your Cursor login from the macOS Keychain, where it stays. macOS asks you once."
      >
        <Switch
          id="cursor-keychain-usage"
          checked={settings.cursor_keychain_usage}
          onCheckedChange={(on) => void save({ cursor_keychain_usage: on }).then(() => setError(null), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
        />
      </SettingRow>
      {error ? <SettingsLine tone="bad">{error}</SettingsLine> : null}
    </SettingsCard>
  );
}

/** One figure of the summary; `null` is the honest "Not measured yet". */
function Figure({ label, value, foot }: { label: string; value: string | null; foot: string }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="text-[12.5px] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 truncate tabular-nums", value === null ? "text-[15px] leading-7 text-muted-foreground" : "text-[20px] font-medium leading-7 tracking-[-0.01em]")}>
        {value ?? "Not measured yet"}
      </div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">{foot}</div>
    </div>
  );
}
