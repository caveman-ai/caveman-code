import { Button } from "@caveman-app/ui/components/button";
import { isHiddenSecret, isReservedEnvName, SECRET_NAME_PATTERN, type SecretEntry } from "@caveman-app/session-protocol/secrets";

/** A name a secret can take: an env var name that doesn't change how processes themselves run (PATH, BASH_ENV, proxies). */
const usable = (name: string) => SECRET_NAME_PATTERN.test(name) && !isReservedEnvName(name, "process");
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, LockPasswordIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState } from "react";
import { isComposing } from "../../panels/chrome.tsx";

/**
 * Caught secrets, above the composer: names (editable), masked values, and
 * where they go. Enter saves, Escape drops them; nothing caught here ever
 * becomes message text. `mode` "send" means the draft itself held them, so
 * there is no "paste as text".
 */
export function SecretSheet({
  entries: initial,
  existing,
  repoLabel,
  mode,
  busy,
  error,
  onSave,
  onCancel,
  onPasteAsText,
}: {
  entries: ReadonlyArray<SecretEntry>;
  /** Names the repository already has: saving replaces them. */
  existing: ReadonlySet<string>;
  /** Null when the composer has no repository to store them in. */
  repoLabel: string | null;
  mode: "paste" | "send";
  busy: boolean;
  error: string | null;
  onSave: (entries: SecretEntry[]) => void;
  onCancel: () => void;
  onPasteAsText?: () => void;
}) {
  // Names that would change how processes run (NODE_OPTIONS, PATH) are left out from the start, and said so.
  const leftOut = initial.filter((e) => isReservedEnvName(e.name, "process")).map((e) => e.name);
  const [rows, setRows] = useState(() => initial.filter((e) => !isReservedEnvName(e.name, "process")).map((e) => ({ ...e })));
  const root = useRef<HTMLDivElement>(null);
  const firstUnnamed = rows.findIndex((r) => !usable(r.name));

  useEffect(() => {
    const el = root.current;
    const target = firstUnnamed >= 0 ? el?.querySelector<HTMLInputElement>(`[data-row="${firstUnnamed}"]`) : el?.querySelector<HTMLButtonElement>("[data-save]");
    target?.focus();
    // Only on open: later edits keep focus where the user put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invalid = rows.some((r) => !usable(r.name));
  const reserved = rows.find((r) => SECRET_NAME_PATTERN.test(r.name) && isReservedEnvName(r.name, "process"));
  const canSave = rows.length > 0 && !invalid && repoLabel !== null && !busy;
  const save = () => {
    if (!canSave) return;
    // A name given twice keeps its last value, as a .env file does.
    const byName = new Map(rows.map((r) => [r.name, r] as const));
    onSave([...byName.values()]);
  };
  const plain = rows.filter((r) => !isHiddenSecret(r.name, r.value)).length;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Store as secrets"
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) {
          e.preventDefault();
          save();
        }
      }}
      className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-input bg-popover shadow-overlay origin-bottom animate-in fade-in-0 zoom-in-[0.97] slide-in-from-bottom-1 duration-200 ease-snap motion-reduce:animate-none"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px]">
        <Icon icon={LockPasswordIcon} className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">
          {rows.length === 1 ? "This looks like a secret" : `${rows.length} secrets`}
        </span>
        <span className="text-muted-foreground">· kept out of the chat; the agent sees names only</span>
      </div>
      <ul className="max-h-[260px] overflow-y-auto overscroll-contain p-1.5">
        {rows.map((r, i) => {
          const bad = !usable(r.name);
          return (
            <li key={i} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <input
                data-row={i}
                value={r.name}
                onChange={(e) => setRows((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)))}
                placeholder="NAME"
                aria-label={`Name for secret ${i + 1}`}
                aria-invalid={bad}
                spellCheck={false}
                autoComplete="off"
                className={cn(
                  "h-7 w-[220px] shrink-0 rounded-md border bg-transparent px-2 font-mono text-[12.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  bad ? "border-destructive/60" : "border-input",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground" aria-label="Value, hidden">
                {mask(r.value)}
              </span>
              {existing.has(r.name) ? <span className="shrink-0 text-[12px] text-muted-foreground">replaces</span> : null}
              {!isHiddenSecret(r.name, r.value) ? (
                <span className="shrink-0 text-[12px] text-warning" title="Public config or too plain to hide: stored and set in every command, but the agent can see it if a command prints it.">
                  visible if printed
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
                aria-label={`Leave out ${r.name || `secret ${i + 1}`}`}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={Cancel01Icon} className="size-3.5" strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 line-clamp-2">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : repoLabel === null ? (
            <span className="text-warning">Start in a repository first: secrets belong to one.</span>
          ) : reserved ? (
            `${reserved.name} can't be a secret: it changes how every command runs. Rename it or leave it out.`
          ) : invalid ? (
            "Give each one a name like STRIPE_SECRET_KEY."
          ) : (
            <>
              Saved to <span className="text-foreground">{repoLabel}</span>, just you, set as env vars in every command
              {plain ? `; ${plain} ${plain === 1 ? "stays" : "stay"} visible to the agent` : ""}
              {leftOut.length ? `; left out ${leftOut.join(", ")} (changes how commands run)` : ""}
            </>
          )}
        </span>
        <span className="ml-auto" />
        {mode === "paste" && onPasteAsText ? (
          <button
            type="button"
            onClick={onPasteAsText}
            title="Puts the text in the message as typed: the agent will read it"
            className="h-7 shrink-0 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Paste as text
          </button>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="h-7 shrink-0 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Keep editing
          </button>
        )}
        <Button
          type="button"
          data-save=""
          onClick={save}
          disabled={!canSave}
          size="sm"
          className="shrink-0"
        >
          {busy ? "Saving…" : rows.length === 1 ? "Save secret ↵" : `Save ${rows.length} secrets ↵`}
        </Button>
      </div>
    </div>
  );
}

/** Enough to recognise your own key, never enough to use it. */
export function mask(value: string): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length >= 16 ? `••••••••${flat.slice(-4)}` : "••••••••";
}
