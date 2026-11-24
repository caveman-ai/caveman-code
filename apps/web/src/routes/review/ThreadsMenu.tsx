// The bar's comments button (compact Review's): every line thread and comment on the pull request, open ones first, with
// a search over who said what where. A line thread opens Files at its line; a comment without a line opens Discussion.
import type { PrDiscussionItem } from "@caveman-app/session-protocol";
import { SearchField } from "@caveman-app/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Comment01Icon } from "@caveman-app/ui/icons/huge";
import { useMemo, useState } from "react";
import { rowAge } from "../../state/model.ts";
import { readableBody } from "./model.ts";
import { Avatar } from "./parts.tsx";

export function ThreadsMenu({ items, onOpen }: { items: ReadonlyArray<PrDiscussionItem>; onOpen: (item: { path: string; line: number | null; side: "new" | "old" } | { path?: undefined; line?: undefined; side?: undefined }) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const list = items
      .map((item) => {
        const first = item.type === "thread" ? item.comments[0] : item;
        const body = readableBody(first?.body ?? "");
        return {
          item,
          author: first?.author,
          at: first?.at ?? "",
          body,
          where: item.type === "thread" ? `${item.path.split("/").pop()}${item.line ? `:${item.line}` : ""}` : null,
          open: item.type === "thread" && !item.resolved,
          resolved: item.type === "thread" && item.resolved,
          replies: item.type === "thread" ? item.comments.length - 1 : 0,
        };
      })
      .filter((r) => r.body || r.item.type === "thread");
    // Open threads first, then the rest, newest first within each.
    return list.sort((a, b) => Number(b.open) - Number(a.open) || b.at.localeCompare(a.at));
  }, [items]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => `${r.author?.login ?? ""} ${r.where ?? ""} ${r.item.type === "thread" ? r.item.path : ""} ${r.body}`.toLowerCase().includes(q)) : rows;
  const openCount = rows.filter((r) => r.open).length;
  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Comments: ${openCount} open`}
          title="Comments and threads"
          className="relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
        >
          <Icon icon={Comment01Icon} className="size-3.5" />
          <span className={cn("tabular-nums", openCount > 0 && "text-warning")}>{openCount > 0 ? openCount : rows.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[440px] p-1.5">
        <SearchField autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search comments" aria-label="Search comments" />
        <div className="mt-1.5 max-h-[420px] overflow-y-auto [scrollbar-width:thin]">
          {shown.length === 0 ? <p className="px-2 py-3 text-[12.5px] text-muted-foreground">No comment says that.</p> : null}
          {shown.map((r) => (
            <button
              key={r.item.id}
              type="button"
              onClick={() => {
                setOpen(false);
                if (r.item.type === "thread") onOpen({ path: r.item.path, line: r.item.line ?? null, side: r.item.side });
                else onOpen({});
              }}
              className={cn("flex w-full gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent", r.resolved && "opacity-60")}
            >
              <Avatar actor={r.author} size={20} className="mt-px" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5 text-[12.5px]">
                  <span className="truncate font-medium text-foreground">{r.author?.login ?? "someone"}</span>
                  {r.where ? <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{r.where}</span> : null}
                  <span className="ml-auto shrink-0 text-[11.5px] text-[hsl(var(--subtle-foreground))]">
                    {r.resolved ? "Resolved" : r.replies > 0 ? `${r.replies} ${r.replies === 1 ? "reply" : "replies"}` : r.at ? rowAge(r.at, now) : ""}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-muted-foreground">{plain(r.body)}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A comment's first words as plain text: Markdown's marks (emphasis, code ticks, headings, quotes, links) dropped. */
const plain = (body: string) =>
  body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+|^#+\s*|^>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
