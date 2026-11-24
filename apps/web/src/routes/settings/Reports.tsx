// Settings > App > Problem reports (docs/): the reports
// this computer sent or is waiting to send, what the team made of each, and
// Delete, which takes a report and its logs out of Caveman too. Report a
// problem opens the same preview as the button beside an error.
import { Button } from "@caveman-app/ui/components/button";
import type { BugReportRecord } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useState } from "react";
import { reportProblem, statusLine } from "../../state/bug-report.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard } from "./rows.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ReportsSettings() {
  const { client, status } = useRuntimeClient();
  const [reports, setReports] = useState<ReadonlyArray<BugReportRecord> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    async (refresh: boolean) => {
      if (!client || status !== "connected") return;
      try {
        setReports((await client.call("bug_report.list", { refresh })).reports);
        setError(null);
      } catch (e) {
        setError(message(e));
      }
    },
    [client, status],
  );
  // What this computer holds at once, then what Caveman says of each sent one.
  useEffect(() => {
    void load(false).then(() => load(true));
  }, [load]);
  const remove = async (id: string) => {
    if (!client) return;
    setBusy(id);
    try {
      await client.call("bug_report.delete", { request_id: crypto.randomUUID(), report_id: id });
      await load(false);
    } catch (e) {
      setError(`Couldn't delete it: ${message(e)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <SettingsCard>
        <SettingRow
          label="Report a problem"
          description="Your model writes it up from the last few hours of logs. You read and edit everything before it's sent; keys, emails and your name are removed on this computer first."
        >
          <Button variant="secondary" onClick={() => reportProblem({ surface: "other" })}>
            Report a problem
          </Button>
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="From this computer">
        {error ? (
          <SettingRow
            label="Couldn't load your reports"
            description={<span className="text-destructive">{error}</span>}
          />
        ) : null}
        {status !== "connected" ? (
          <SettingRow
            label="Waiting for Caveman Code's runtime"
            description="Your reports show once it's running."
          />
        ) : reports === null ? (
          <SettingRow label="Loading…" />
        ) : reports.length === 0 ? (
          <SettingRow
            label="No reports yet"
            description="They show here once sent, with what the team made of them."
          />
        ) : (
          reports.map((r) => (
            <SettingRow
              key={r.report_id}
              label={r.title}
              description={
                <span className={r.state === "failed" ? "text-destructive" : undefined}>
                  {when(r.created_at)} · {statusLine(r)}
                </span>
              }
            >
              <Button
                variant="ghost"
                disabled={busy === r.report_id}
                onClick={() => void remove(r.report_id)}
              >
                {busy === r.report_id ? "Deleting…" : "Delete"}
              </Button>
            </SettingRow>
          ))
        )}
      </SettingsCard>
    </>
  );
}
