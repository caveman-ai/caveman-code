"use client";

import * as React from "react";
import { Tag, type TagTone } from "./tag";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "../lib/cn";

export type TagItem = { id: string; label: string; tone?: TagTone };

/** Compact property list. Overflow stays available to keyboard and touch users. */
export function TagGroup({
  items,
  maxVisible = 2,
  label = "Tags",
  className,
}: {
  items: readonly TagItem[];
  maxVisible?: number;
  label?: string;
  className?: string;
}) {
  const limit = Number.isFinite(maxVisible) ? Math.max(0, Math.floor(maxVisible)) : items.length;
  const hidden = items.slice(limit);
  if (!items.length) return null;
  return (
    <span role="group" aria-label={label} className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-[3px]", className)}>
      {items.slice(0, limit).map((item) => <Tag key={item.id} tone={item.tone}>{item.label}</Tag>)}
      {hidden.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Tag asChild>
              <button type="button" aria-label={`Show ${hidden.length} more ${label.toLowerCase()}`}>+{hidden.length}</button>
            </Tag>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-80 p-3" aria-label={label}>
            <span className="flex flex-wrap gap-[3px]">
              {hidden.map((item) => <Tag key={item.id} tone={item.tone} className="tag-wrap">{item.label}</Tag>)}
            </span>
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
