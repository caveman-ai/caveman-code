// File-type marks for the Files tree, the breadcrumbs and the launcher: the
// coloured language marks the chat's file chips use (ui icons/file-type.tsx,
// STYLE.md section 7). Its own module so the launcher stays out of the lazy
// Files chunk.
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import type { ComponentType } from "react";

export type FileGlyph = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

// One component per name, so a re-render never remounts a row's icon.
const glyphs = new Map<string, FileGlyph>();

export function fileIcon(name: string): FileGlyph {
  let glyph = glyphs.get(name);
  if (!glyph) {
    glyph = function FileGlyph({ className }) {
      return <FileTypeIcon path={name} {...(className ? { className } : {})} />;
    };
    glyphs.set(name, glyph);
  }
  return glyph;
}
