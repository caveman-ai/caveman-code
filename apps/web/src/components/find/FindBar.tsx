// The find bar at the top right of a chat or a panel (⌘F): type to find, ↵ / ⇧↵ (or ⌘G / ⇧⌘G) step through the matches,
// esc closes and hands focus back to the chat's box. Layout .

import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef } from "react";
import { isComposing } from "../../panels/chrome.tsx";
import { hitCount } from "./chat-find.ts";

export function FindBar({
  query,
  index,
  total,
  onQuery,
  onStep,
  onClose,
  focusKey,
  label = "Find in chat",
}: {
  query: string;
  index: number;
  total: number;
  onQuery: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  /** Bumps on each ⌘F, so pressing it again with the bar open selects what is typed. */
  focusKey: number;
  /** The field's name and placeholder. */
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);
  const none = query.trim() !== "" && total === 0;
  return (
    <div
      role="search"
      aria-label={label}
      className="pointer-events-auto flex h-9 items-center gap-0.5 rounded-lg border border-border bg-popover pl-2.5 pr-1 shadow-lg"
    >
      <input
        ref={input}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          const g = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g";
          if (e.key === "Enter" || g) {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={label}
        aria-label={label}
        aria-invalid={none || undefined}
        spellCheck={false}
        className="h-7 w-44 min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))]"
      />
      <span aria-live="polite" className={cn("min-w-10 px-1 text-right text-[12px] tabular-nums", none ? "text-destructive" : "text-muted-foreground")}>
        {query.trim() ? hitCount(index, total) : ""}
      </span>
      <FindButton label="Previous match" disabled={total === 0} onClick={() => onStep(-1)}>
        <Icon icon={ArrowUp01Icon} />
      </FindButton>
      <FindButton label="Next match" disabled={total === 0} onClick={() => onStep(1)}>
        <Icon icon={ArrowDown01Icon} />
      </FindButton>
      <FindButton label="Close find" onClick={onClose}>
        <Icon icon={Cancel01Icon} />
      </FindButton>
    </div>
  );
}

function FindButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
