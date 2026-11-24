import type { Client } from "@caveman-app/session-protocol/client";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { useEffect, useState } from "react";
import { Segmented } from "../routes/settings/rows.tsx";
import { requestId, useRuntimeSelector } from "../state/runtime.tsx";
import { Icon, NoteAddIcon, FileTextIcon } from "@caveman-app/ui/icons/huge";

type Recorded = { readonly name: string; readonly path: string; readonly markdown: string };
const record = (client: Client, params: { request_id: string; session_id: string; scope: "me" | "project"; project_id?: string; name?: string; note?: string }): Promise<Recorded> =>
  client.call("skill.record", params);

/**
 * Record a skill: the runtime writes a SKILL.md from this session into my
 * skills (~/.agents/skills) or this project's (.agents/skills). Every engine
 * loads it from the next chat.
 */
export function RecordSkillDialog({ client, sessionId, projectId, open, onOpenChange }: { client: Client; sessionId: string; projectId?: string | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const project = projects.find((p) => p.id === projectId);
  const [scope, setScope] = useState<"me" | "project">("me");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Recorded | null>(null);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setError(null);
  }, [open]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(
        await record(client, {
          request_id: requestId(),
          session_id: sessionId,
          scope,
          ...(scope === "project" && project ? { project_id: project.id } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={NoteAddIcon} className="size-4" />
            Record a skill
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px]">
              <Icon icon={FileTextIcon} className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[12.5px] text-foreground">{done.path}</span>
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[12.5px] leading-5 text-secondary-foreground">{done.markdown}</pre>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {project ? (
              <Segmented
                label="Whose"
                value={scope}
                options={[
                  { value: "me", label: "Me" },
                  { value: "project", label: project.name },
                ]}
                onChange={setScope}
              />
            ) : null}
            <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="From the session"
                className="h-8 rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
              What should it capture?
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Optional: the part of the session that matters"
                className="resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {done ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? "Writing the skill…" : "Record"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function message(e: unknown): string {
  const err = e as { message?: string; error?: { message?: string } };
  return err.error?.message ?? err.message ?? String(e);
}
