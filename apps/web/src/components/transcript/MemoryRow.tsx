// A memory change or recall in the chat, at the moment it happened (docs/memory.md "In the transcript"): one
// quiet line naming the notes, each with Forget and, once forgotten, Undo. Recalls fold into "Worked for" with
// the turn's work (rows.ts); what the person or an agent saved stays in view. Never a note's cost.
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, NotebookPenIcon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";

export type MemoryItem = Extract<TranscriptItem, { kind: "memory" }>;

/** "Remembered", "Saved 2 notes, unconfirmed", "Recalled a note". */
export function memoryLabel(item: Pick<MemoryItem, "action" | "notes">): string {
  const n = item.notes.length;
  const count = n === 1 ? "a note" : `${n} notes`;
  return item.action === "remembered" ? "Remembered" : item.action === "saved" ? `Saved ${count}, unconfirmed` : `Recalled ${count}`;
}

export function MemoryRow({ item }: { readonly item: MemoryItem }) {
  const { client } = useRuntimeClient();
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const act = async (id: string, forget: boolean) => {
    if (!client) return;
    setBusy(id);
    setFailure(null);
    try {
      await client.call(forget ? "memory.forget" : "memory.undo", { request_id: requestId(), id });
      setForgotten((current) => {
        const next = new Set(current);
        if (forget) next.add(id);
        else next.delete(id);
        return next;
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div role="status" className="my-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-[12.5px] text-muted-foreground">
      <Icon icon={NotebookPenIcon} className="size-3.5 shrink-0" />
      <span>{memoryLabel(item)}</span>
      {item.notes.map((note) => {
        const gone = forgotten.has(note.id);
        return (
          <span key={note.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden>·</span>
            <span className={cn("text-foreground/80", gone && "line-through opacity-60")}>{note.name}</span>
            {client ? (
              <button
                type="button"
                disabled={busy === note.id}
                onClick={() => void act(note.id, !gone)}
                className="rounded px-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                aria-label={`${gone ? "Undo forgetting" : "Forget"} ${note.name}`}
              >
                {gone ? "Undo" : "Forget"}
              </button>
            ) : null}
          </span>
        );
      })}
      {failure ? <span className="text-destructive">{failure}</span> : null}
    </div>
  );
}
