// One rule file (CLAUDE.md, AGENTS.md), at home or in a project: its text, edited in place, and which engines read it.
// A file that does not exist yet is created on save.
import { Button } from "@caveman-app/ui/components/button";
import { Textarea } from "@caveman-app/ui/components/textarea";
import { useEffect, useState } from "react";
import { Bar, Page, PageEmpty, Pane, RailRow, RailSection } from "../../components/ListFrame.tsx";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { useLeaveGuard } from "../automations/Form.tsx";
import type { RuleInfo } from "./api.ts";
import { usePluginsData } from "./data.tsx";
import { skillEngines, tokenLabel } from "./model.ts";
import { EngineMarks, ErrorLine, message } from "./shared.tsx";

const HOME = { label: "Plugins", to: "/plugins" };

export function RulePage({ path }: { path: string }) {
  const data = usePluginsData();
  const projects = useRuntimeSelector((v) => v.projects);
  const rule = data.rules.data?.find((r) => r.path === path);
  if (rule === undefined) {
    return (
      <Page bar={<Bar crumbs={[HOME, { label: "Rule" }]} />}>
        {data.rules.data !== null ? (
          <Pane>
            <p className="text-[13px] text-muted-foreground">This rule file is no longer listed.</p>
          </Pane>
        ) : data.rules.error ? (
          <PageEmpty
            icon="artifact-markdown"
            title="Couldn't read your rules"
            actions={
              <Button variant="secondary" onClick={() => void data.rules.reload()}>
                Try again
              </Button>
            }
          >
            {data.rules.error}
          </PageEmpty>
        ) : null}
      </Page>
    );
  }
  const where =
    rule.scope === "me"
      ? "Home"
      : (projects.find((p) => p.id === rule.project_id)?.name ?? "A project");
  const engines = skillEngines(rule.engines);
  return (
    <Page
      bar={<Bar crumbs={[HOME, { label: `${rule.name} · ${where}` }]} />}
      rail={
        <>
          <RailSection title="Status" className="pt-4">
            <RailRow label="Status">
              {rule.engines.length === 0
                ? "Another file takes its place"
                : rule.exists
                  ? "Read every chat"
                  : "Not written yet"}
            </RailRow>
            <RailRow label="Where">{where}</RailRow>
          </RailSection>
          <RailSection title="Reach">
            <RailRow label="Engines">
              <EngineMarks engines={engines} />
            </RailRow>
            <RailRow
              label="Idle cost"
              title="Read whole into every request; estimated from bytes, 4 per token"
            >
              {rule.exists ? (tokenLabel(rule.idle_tokens_estimate) ?? "None") : "None"}
            </RailRow>
          </RailSection>
          <RailSection title="File">
            <p className="break-all pb-6 font-mono text-[12px] leading-[18px] text-muted-foreground">
              {rule.path}
            </p>
          </RailSection>
        </>
      }
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">
          {rule.name}
        </h1>
        <p className="mt-1 text-[14px] leading-[22px] text-muted-foreground">
          {where === "Home"
            ? "What every chat on this computer is told."
            : `What every chat in ${where} is told.`}{" "}
          Changes apply to chats started after you save.
        </p>
        <RuleEditor rule={rule} onSaved={data.rules.reload} />
      </Pane>
    </Page>
  );
}

/** The file's text, read when its page opens, saved back with rule.save. */
function RuleEditor({ rule, onSaved }: { rule: RuleInfo; onSaved: () => Promise<void> }) {
  const { client } = useRuntimeClient();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [redacted, setRedacted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Another rule is the same path with another ?path=: leaving it is leaving too.
  const guard = useLeaveGuard(
    text !== null && text !== saved,
    rule.name,
    (current, next) => current.pathname !== next.pathname || current.search !== next.search,
  );
  useEffect(() => {
    client!.call("rule.read", { path: rule.path }).then(
      (r) => (setText(r.text), setSaved(r.text), setRedacted(r.redacted)),
      (e) => setError(message(e)),
    );
  }, [client, rule.path]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await client!.call("rule.save", {
        request_id: requestId(),
        path: rule.path,
        text: text ?? "",
      });
      setSaved(text ?? "");
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (text === null)
    return error ? (
      <ErrorLine>{error}</ErrorLine>
    ) : (
      <div aria-hidden className="mt-6 h-64 rounded-lg bg-foreground/[0.03]" />
    );
  return (
    <div className="mt-6 flex flex-col gap-2">
      {guard}
      <Textarea
        aria-label={rule.name}
        readOnly={redacted}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={22}
        className="font-mono text-[12.5px] leading-[19px]"
        placeholder={`What every chat should know. Saving creates ${rule.name}.`}
      />
      {redacted ? (
        <p className="text-[12.5px] text-warning">
          This file holds a stored secret, shown here as [secret:NAME]. Edit it in your editor so
          the real value stays.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || redacted || text === saved} onClick={() => void save()}>
          {busy ? "Saving…" : rule.exists ? "Save" : "Create"}
        </Button>
        {text !== saved ? (
          <Button size="sm" variant="ghost" onClick={() => setText(saved)}>
            Undo changes
          </Button>
        ) : null}
        <ErrorLine>{error}</ErrorLine>
      </div>
    </div>
  );
}
