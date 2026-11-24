import { Button } from "@caveman-app/ui/components/button";
import { isReservedEnvName, SECRET_NAME_PATTERN } from "@caveman-app/session-protocol/secrets";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, Cancel01Icon, LockPasswordIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState } from "react";
import { isComposing } from "../../panels/chrome.tsx";

/** One save while writing a message: a paste stays one chip however many names it holds. */
export type Mention = {
  /** "Pasted"; null for a single secret, which shows by name. */
  readonly label: string | null;
  readonly names: ReadonlyArray<string>;
  /** Names stored but too plain to scrub: the agent can see them if a command prints them. */
  readonly plain: ReadonlyArray<string>;
};

/** Secrets saved while writing this message: the message will name them, never show them. */
export function SavedSecrets({ mentions, onRemove }: { mentions: ReadonlyArray<Mention>; onRemove: (index: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open === null ? undefined : mentions[open];
  return (
    <div className="px-1 pb-2">
      <ul className="flex flex-wrap gap-1.5" aria-label="Secrets this message names">
        {mentions.map((m, i) => {
          const single = m.label === null && m.names.length === 1;
          return (
            <li
              key={i}
              title={single ? `${m.names[0]} is saved to the repository. The message tells the agent its name; the value stays hidden.` : undefined}
              className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary pl-1.5 pr-1 text-[12.5px]"
            >
              <Icon icon={LockPasswordIcon} className="size-4 shrink-0 text-muted-foreground" />
              {single ? (
                <span className="font-mono text-foreground">{m.names[0]}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpen(open === i ? null : i)}
                  aria-expanded={open === i}
                  className="inline-flex items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono text-foreground">{m.label ?? "Pasted"}</span>
                  <span className="text-muted-foreground">
                    · {m.names.length} {m.names.length === 1 ? "secret" : "secrets"}
                  </span>
                  <Icon icon={ArrowDown01Icon} className={cn("size-3 text-muted-foreground transition-transform duration-150", open === i && "rotate-180")} strokeWidth={2} />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(null);
                  onRemove(i);
                }}
                aria-label={single ? `Don't mention ${m.names[0]} in this message (it stays saved)` : `Don't mention these ${m.names.length} in this message (they stay saved)`}
                className="grid size-5 place-items-center rounded text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 touch:opacity-100"
              >
                <Icon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
      {shown ? (
        <div className="mt-1.5 rounded-lg border border-border bg-secondary/40">
          <p className="border-b border-border px-2.5 py-1.5 text-[12px] text-muted-foreground">
            Stored for this repository. The message names them; the values stay hidden.
          </p>
          <ul className="grid max-h-36 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 overflow-y-auto overscroll-contain px-2.5 py-1.5">
            {shown.names.map((name) => (
              <li key={name} className="flex min-w-0 items-center gap-1.5 py-0.5 font-mono text-[12px] text-foreground">
                <span className="truncate">{name}</span>
                {shown.plain.includes(name) ? (
                  <span className="shrink-0 font-sans text-[11px] text-warning" title="Too short or too plain to scrub: the agent can see it if a command prints it.">
                    visible if printed
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A name a file may hold that can't be a secret: not a variable name, or one that changes how commands run. */
const refused = (name: string) => !SECRET_NAME_PATTERN.test(name) || isReservedEnvName(name, "process");

/**
 * Reviewing a .env before it is stored: which names, and where they go.
 * Only names cross here; the runtime reads the values itself. Enter stores
 * the picked names, Escape closes.
 */
export function EnvImportSheet({
  file,
  repoLabel,
  busy,
  error,
  onImport,
  onCancel,
  className,
}: {
  file: { readonly path: string; readonly names: ReadonlyArray<string> };
  repoLabel: string | null;
  busy: boolean;
  error: string | null;
  onImport: (names: string[]) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(file.names.filter((n) => !refused(n))));
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.querySelector<HTMLElement>("[data-first]")?.focus(), []);

  const q = filter.trim().toUpperCase();
  const visible = q ? file.names.filter((n) => n.toUpperCase().includes(q)) : file.names;
  const pickable = visible.filter((n) => !refused(n));
  const left = file.names.filter(refused);
  const many = file.names.length > 8;
  const canImport = picked.size > 0 && repoLabel !== null && !busy;
  const save = () => canImport && onImport(file.names.filter((n) => picked.has(n)));
  const setAll = (on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const n of pickable) on ? next.add(n) : next.delete(n);
      return next;
    });

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Store ${file.path} as secrets`}
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && !e.shiftKey && !isComposing(e) && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          save();
        }
      }}
      className={cn(
        "overflow-hidden rounded-xl border border-input bg-popover shadow-overlay origin-bottom animate-in fade-in-0 zoom-in-[0.97] slide-in-from-bottom-1 duration-200 ease-snap motion-reduce:animate-none",
        className,
      )}
    >
      <div className="flex items-start gap-2.5 border-b border-border px-3.5 py-3">
        <Icon icon={LockPasswordIcon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">
            Store <span className="font-mono">{file.path}</span> as secrets
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            This computer reads the file and keeps the values encrypted. They never pass through this window or the chat: commands get them as environment
            variables, and they are scrubbed from what the agent sees.
          </p>
        </div>
        <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-muted-foreground">
          {picked.size} of {file.names.length - left.length}
        </span>
      </div>
      <div className="flex items-center gap-1 px-3.5 pt-2.5">
        {many ? (
          <input
            data-first=""
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter names"
            aria-label="Filter names"
            spellCheck={false}
            autoComplete="off"
            className="mr-1 h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-[12.5px] placeholder:font-sans placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => setAll(true)}
          className="h-7 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {q ? "Pick shown" : "Pick all"}
        </button>
        <button
          type="button"
          onClick={() => setAll(false)}
          className="h-7 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {q ? "Clear shown" : "Clear"}
        </button>
      </div>
      <ul className="grid max-h-[280px] grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-2 overflow-y-auto overscroll-contain px-2 py-2">
        {visible.map((name) => {
          const no = refused(name);
          return (
            <li key={name}>
              <label
                title={no ? `${name} can't be a secret: it changes how every command runs.` : undefined}
                className={cn(
                  "flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 font-mono text-[12.5px]",
                  no ? "cursor-not-allowed text-[hsl(var(--subtle-foreground))]" : "cursor-pointer hover:bg-accent",
                )}
              >
                <Checkbox
                  checked={picked.has(name)}
                  disabled={no}
                  onCheckedChange={(v) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      v === true ? next.add(name) : next.delete(name);
                      return next;
                    })
                  }
                />
                <span className={cn("truncate", !no && !picked.has(name) && "text-muted-foreground")}>{name}</span>
                {no ? <span className="ml-auto shrink-0 font-sans text-[11px]">reserved</span> : null}
              </label>
            </li>
          );
        })}
        {visible.length === 0 ? <li className="px-1.5 py-1 text-[12.5px] text-muted-foreground">No name matches.</li> : null}
      </ul>
      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 line-clamp-2">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : repoLabel === null ? (
            <span className="text-warning">Start in a repository first: secrets belong to one.</span>
          ) : (
            <>
              Saved to <span className="text-foreground">{repoLabel}</span>, just you
              {left.length ? `; ${left.length} reserved ${left.length === 1 ? "name stays" : "names stay"} out` : ""}. The file itself is left as it is.
            </>
          )}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onCancel}
          className="h-7 shrink-0 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <Button
          type="button"
          data-first={many ? undefined : ""}
          onClick={save}
          disabled={!canImport}
          size="sm"
          className="shrink-0"
        >
          {busy ? "Storing…" : picked.size === 1 ? "Store 1 secret ↵" : `Store ${picked.size} secrets ↵`}
        </Button>
      </div>
    </div>
  );
}
