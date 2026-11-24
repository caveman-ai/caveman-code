// Click a name in the diff: every place it appears on the page lights up (the CSS Custom Highlight API, so no row
// re-renders), and a card beside the click says where the change defines and uses it, then where the rest of the
// repository does (pr.symbol: git grep in this computer's checkout, at the head when it is here). A row of the change
// jumps there; a line elsewhere opens on the host at the commit searched. ⌘-click goes straight to the definition
// when the change has it. Esc or a click elsewhere puts it away. Selecting text still asks, fixes or comments
// (Ask.tsx): only a plain click on a name looks it up.
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, FunctionIcon, LinkSquare02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { SectionHeader } from "../../panels/chrome.tsx";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { usePrSymbol } from "./data.ts";
import type { PrAddress } from "./model.ts";
import { findInDiff, repoHits, wordAt, type SymbolHit } from "./symbols.ts";

const HIGHLIGHT = "review-symbol";
/** Rows a list shows before "N more". */
const SHOWN = 6;
const CARD_W = 460;

interface Active {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** `off` (from Cloud, which has no checkout to search): the diff as it is, no lookups. */
export function SymbolNav(props: Parameters<typeof Lookups>[0] & { off?: boolean }) {
  const { off, ...rest } = props;
  return off ? <>{rest.children}</> : <Lookups {...rest} />;
}

function Lookups({
  root,
  files,
  address,
  head,
  blobUrl,
  onGoTo,
  children,
}: {
  /** What a lookup searches for occurrences: the Files tab. */
  root: RefObject<HTMLElement | null>;
  files: ReadonlyArray<DiffFile>;
  address: PrAddress;
  head: string;
  /** The host's page of a file at a commit, at a line. */
  blobUrl: (commit: string, path: string, line: number) => string;
  onGoTo: (path: string, line: number, side: "new" | "old") => void;
  children: ReactNode;
}) {
  const [active, setActive] = useState<Active | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const onClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || e.altKey) return;
    // A double click selects the word for Ask, Fix and Comment (Ask.tsx): that bar, not the card.
    if (e.detail > 1) return setActive(null);
    const code = (e.target as HTMLElement).closest("[data-code]");
    if (!code || !window.getSelection()?.isCollapsed) return;
    const at = caretAt(e.clientX, e.clientY);
    const name = at ? wordAt(at.node.data, at.offset) : null;
    if (!name) return setActive(null);
    if (e.metaKey || e.ctrlKey) {
      const def = findInDiff(files, name).find((h) => h.definition);
      if (def) {
        e.preventDefault();
        setActive(null);
        return onGoTo(def.path, def.line, def.side);
      }
    }
    setActive({ name, x: e.clientX, y: e.clientY });
  };

  useOccurrences(root, active?.name ?? null);

  return (
    <div ref={box} onClick={onClick}>
      {children}
      {active ? (
        <SymbolCard
          key={`${active.name}:${active.x}:${active.y}`}
          active={active}
          files={files}
          address={address}
          head={head}
          blobUrl={blobUrl}
          onGoTo={(hit) => {
            setActive(null);
            onGoTo(hit.path, hit.line, hit.side);
          }}
          onClose={() => setActive(null)}
        />
      ) : null}
    </div>
  );
}

/** The text node and offset under a point: the standard call where there is one, WebKit's otherwise. */
function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos && pos.offsetNode.nodeType === Node.TEXT_NODE) return { node: pos.offsetNode as Text, offset: pos.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) return { node: range.startContainer as Text, offset: range.startOffset };
  return null;
}

/**
 * Every whole-word `name` in the code under `root`, painted as one CSS highlight, and again as rows build or fold
 * (a file scrolled near builds its rows then). Nothing where the browser has no Custom Highlight API.
 */
function useOccurrences(root: RefObject<HTMLElement | null>, name: string | null) {
  useEffect(() => {
    const el = root.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!name || !el || !registry || typeof Highlight === "undefined") return;
    const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g");
    const paint = () => {
      const ranges: Range[] = [];
      for (const code of el.querySelectorAll<HTMLElement>("[data-code]")) {
        if (!code.textContent?.includes(name)) continue;
        // A name can straddle two coloured spans; read the line as one string and map matches back to its text nodes.
        const nodes: Array<{ node: Text; start: number }> = [];
        let text = "";
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          nodes.push({ node: n as Text, start: text.length });
          text += (n as Text).data;
        }
        for (const m of text.matchAll(word)) {
          const range = document.createRange();
          const from = locate(nodes, m.index);
          const to = locate(nodes, m.index + name.length);
          if (!from || !to) continue;
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
          ranges.push(range);
        }
      }
      registry.set(HIGHLIGHT, new Highlight(...ranges));
    };
    paint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(paint, 80);
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      registry.delete(HIGHLIGHT);
    };
  }, [root, name]);
}

function locate(nodes: ReadonlyArray<{ node: Text; start: number }>, at: number): { node: Text; offset: number } | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (at >= n.start && at <= n.start + n.node.data.length) return { node: n.node, offset: at - n.start };
  }
  return null;
}

function SymbolCard({
  active,
  files,
  address,
  head,
  blobUrl,
  onGoTo,
  onClose,
}: {
  active: Active;
  files: ReadonlyArray<DiffFile>;
  address: PrAddress;
  head: string;
  blobUrl: (commit: string, path: string, line: number) => string;
  onGoTo: (hit: SymbolHit) => void;
  onClose: () => void;
}) {
  const { client } = useRuntimeClient();
  const card = useRef<HTMLDivElement>(null);
  const inDiff = useMemo(() => findInDiff(files, active.name), [files, active.name]);
  const repo = usePrSymbol(client, address, head, active.name);
  const changed = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const elsewhere = useMemo(() => (repo.value ? repoHits(repo.value.hits, active.name, repo.value.at, changed, inDiff) : []), [repo.value, active.name, changed, inDiff]);

  // Beside the click, kept on screen: below it when there is room, else above.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = card.current?.offsetHeight ?? 240;
    const left = Math.max(12, Math.min(active.x - 24, window.innerWidth - CARD_W - 12));
    const below = active.y + 18;
    const top = below + h > window.innerHeight - 12 ? Math.max(12, active.y - h - 12) : below;
    setPos({ left, top });
  }, [active, inDiff.length, elsewhere.length, repo.loading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-code]")) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const defs = inDiff.filter((h) => h.definition);
  const uses = inDiff.filter((h) => !h.definition);
  const repoDefs = elsewhere.filter((h) => h.definition);
  const repoUses = elsewhere.filter((h) => !h.definition);
  const commit = repo.value?.commit ?? "";
  const open = (h: SymbolHit) => window.open(blobUrl(commit, h.path, h.line), "_blank", "noreferrer");

  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-label={`Where ${active.name} is defined and used`}
      className="fixed z-50 flex max-h-[min(520px,70vh)] flex-col overflow-hidden rounded-[12px] border border-border bg-popover text-[13px] shadow-overlay animate-in fade-in-0 zoom-in-[0.98] duration-150 ease-snap"
      style={{ width: CARD_W, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pl-3 pr-1.5">
        <Icon icon={FunctionIcon} className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">{active.name}</span>
        <span className="text-[12px] text-muted-foreground">{summary(defs.length + repoDefs.length, uses.length + repoUses.length, repo.loading)}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto py-1.5 [scrollbar-width:thin]">
        <Group title="In this change" empty="Not in the change's lines.">
          {defs.length > 0 ? <Hits label="Defined" hits={defs} onPick={onGoTo} /> : null}
          {uses.length > 0 ? <Hits label="Used" hits={uses} onPick={onGoTo} /> : null}
        </Group>
        <Group
          title={repo.value ? `In the repository, ${repo.value.at === "head" ? "at the head" : "on the base branch"}` : "In the repository"}
          meta={repo.value ? commit.slice(0, 7) : undefined}
          empty={repo.error ? repo.error : repo.loading || !repo.value ? null : "Nowhere else."}
          loading={repo.loading && !repo.value}
        >
          {repoDefs.length > 0 ? <Hits label="Defined" hits={repoDefs} onPick={open} external /> : null}
          {repoUses.length > 0 ? <Hits label="Used" hits={repoUses} onPick={open} external /> : null}
          {repo.value?.truncated ? <p className="px-3 pt-1 text-[11.5px] text-[hsl(var(--subtle-foreground))]">More lines than shown; the first {repo.value.hits.length} are here.</p> : null}
        </Group>
      </div>
      <footer className="shrink-0 border-t border-border/70 px-3 py-1.5 text-[11.5px] text-[hsl(var(--subtle-foreground))]">⌘-click a name to go to its definition · Esc closes</footer>
    </div>,
    document.body,
  );
}

const summary = (defs: number, uses: number, searching: boolean) =>
  `${defs === 0 ? "no definition" : defs === 1 ? "1 definition" : `${defs} definitions`}, ${uses === 1 ? "1 use" : `${uses} uses`}${searching ? "…" : ""}`;

function Group({ title, meta, empty, loading = false, children }: { title: string; meta?: string | undefined; empty: string | null; loading?: boolean; children: ReactNode }) {
  const has = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <section className="py-1">
      <SectionHeader className="gap-2 px-3 pb-1 pt-1.5">
        {title}
        {meta ? <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{meta}</span> : null}
      </SectionHeader>
      {loading ? <p className="lucy-shimmer px-3 py-1 text-[12.5px] text-muted-foreground">Searching the repository…</p> : has ? children : empty ? <p className="px-3 py-1 text-[12.5px] text-muted-foreground">{empty}</p> : null}
    </section>
  );
}

function Hits({ label, hits, onPick, external = false }: { label: string; hits: ReadonlyArray<SymbolHit>; onPick: (hit: SymbolHit) => void; external?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? hits : hits.slice(0, SHOWN);
  return (
    <div className="px-1.5">
      {shown.map((h) => (
        <button
          key={`${h.path}:${h.side}:${h.line}`}
          type="button"
          onClick={() => onPick(h)}
          title={`${h.path}:${h.line}${h.side === "old" ? " (removed by this change)" : ""}`}
          className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent"
        >
          <span className={cn("w-[52px] shrink-0 text-[11.5px]", label === "Defined" ? "text-foreground/85" : "text-[hsl(var(--subtle-foreground))]")}>{label}</span>
          <span className={cn("shrink-0 font-mono text-[12px]", h.side === "old" ? "text-diff-del-ink line-through decoration-diff-del-ink/40" : "text-foreground/90")}>
            {h.path.split("/").pop()}:{h.line}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{h.text.trim()}</span>
          {external ? <Icon icon={LinkSquare02Icon} className="size-3 shrink-0 text-[hsl(var(--subtle-foreground))] opacity-0 group-hover:opacity-100" /> : null}
        </button>
      ))}
      {hits.length > SHOWN ? (
        <button type="button" onClick={() => setAll(!all)} className="ml-[60px] rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
          {all ? "Fewer" : `${hits.length - SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}
