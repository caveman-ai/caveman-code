import type { MemoryStatus } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Switch } from "@caveman-app/ui/components/switch";
import { useCallback, useEffect, useState } from "react";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { MemoryNotes } from "./MemoryNotes.tsx";
import { SettingRow, SettingsCard, SettingsCardBody, useSaveSettings } from "./rows.tsx";

type Status = typeof MemoryStatus.Type;

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const message = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

/** Settings > Memory: the master switch, what is in memory, the one-time Claude Agent import, and every note. */
export function MemorySettings() {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setStatus(await client.call("memory.status", {}));
    } catch (e) {
      setNote(message(e));
    }
  }, [client]);
  useEffect(() => void reload(), [reload]);
  const on = settings?.memory_enabled !== false;
  const run = async (call: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await call());
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <>
      <SettingsCard>
        <SettingRow id="memory-on" label="Remember between chats" description="For every agent and subagent, Claude Agent's own memory included.">
          <Switch id="memory-on" disabled={!settings} checked={on} onCheckedChange={(next) => void save({ memory_enabled: next }).then(reload)} />
        </SettingRow>
        {status ? (
          <SettingRow label="In memory" description="Unverified notes never load until you keep them.">
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {status.notes} notes · {status.drafts} drafts · {status.unverified} unverified
            </span>
          </SettingRow>
        ) : null}
        {status ? (
          <SettingRow label="Brief" description="What every chat starts with.">
            <span className="text-[13px] tabular-nums text-muted-foreground">{tokens(status.brief_tokens)} tokens</span>
          </SettingRow>
        ) : null}
        {note ? (
          <SettingsCardBody className="py-3">
            <p aria-live="polite" className="text-[12.5px] text-muted-foreground">
              {note}
            </p>
          </SettingsCardBody>
        ) : null}
      </SettingsCard>
      {status && (status.claude_import.available > 0 || status.claude_import.imported) ? (
        <SettingsCard title="Claude Agent's memories">
          <SettingRow
            label={status.claude_import.imported ? "Imported" : "Import once"}
            description={
              status.claude_import.imported
                ? "Claude Agent now saves here."
                : `${status.claude_import.available} notes come in as drafts. Nothing is sent to a model.`
            }
          >
            {status.claude_import.imported ? null : (
              <Button
                variant="secondary"
                disabled={!client || busy || !on}
                onClick={() =>
                  void run(async () => {
                    const r = await client!.call("memory.import", { request_id: requestId(), source: "claude" });
                    return `Imported ${r.imported} notes as drafts${r.skipped ? `; ${r.skipped} skipped (projects not opened here)` : ""}.`;
                  })
                }
              >
                Import
              </Button>
            )}
          </SettingRow>
        </SettingsCard>
      ) : null}
      <MemoryNotes onChange={() => void reload()} />
    </>
  );
}
