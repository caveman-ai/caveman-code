// The chat's marks: chrome, so Hugeicons from the one map (CHROME_ICON,
// packages/ui STYLE.md section 7). Who speaks
// keeps its logo: Caveman the bust, a harness its vendor's real mark
// (EngineLogo), any other ACP agent its tile.
import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { CHROME_ICON } from "@caveman-app/ui/icons/Glyph";
import { Icon as HugeIcon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { COMPUTER_KIND_ICON } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import type { ArtifactKind, ToolItem } from "../../state/transcript-model.ts";

/** A 16px Hugeicon; decorative unless `label` is passed. */
export function Icon({ icon, label, className }: { icon: IconSvgElement; label?: string; className?: string }) {
  return <HugeIcon icon={icon} className={cn("size-4 shrink-0", className)} {...(label ? { "aria-label": label } : {})} />;
}

/** Who speaks: the mascot bust for Caveman, the harness's logo for the others. */
export function EngineMark({ engine, className }: { engine: string; className?: string }) {
  return <EngineLogo engine={engine} className={className} />;
}

export const TOOL_ICON: Record<ToolItem["icon"], IconSvgElement> = {
  search: CHROME_ICON["tool-search"],
  read: CHROME_ICON["tool-read"],
  edit: CHROME_ICON["tool-edit"],
  create: CHROME_ICON["tool-create"],
  run: CHROME_ICON["tool-run"],
  web: CHROME_ICON["tool-web"],
  mcp: CHROME_ICON["tool-mcp"],
  browser: CHROME_ICON["tool-browser"],
  agent: CHROME_ICON["tool-subagent"],
  other: CHROME_ICON["tool-other"],
};

/** Where a chat runs (ComputerKind). Unknown kinds get the server rack. */
export const computerIcon = (kind: string): IconSvgElement => CHROME_ICON[(COMPUTER_KIND_ICON[kind] as "computer-this-mac" | "computer-cloud" | "computer-vpc" | undefined) ?? "computer-vpc"];

export function artifactIcon(kind: ArtifactKind, detail?: { change?: "edited" | "created"; path?: string }): IconSvgElement {
  switch (kind) {
    case "code":
      return CHROME_ICON["artifact-code"];
    case "table":
      return CHROME_ICON["artifact-table"];
    case "image":
    case "browser":
      return CHROME_ICON["artifact-image"];
    case "pr":
      return CHROME_ICON["artifact-pr"];
    case "terminal":
      return CHROME_ICON["artifact-terminal"];
    case "page":
      return CHROME_ICON["tool-browser"];
    case "file":
      if (detail?.change === "edited") return CHROME_ICON["artifact-diff"];
      return CHROME_ICON[detail?.path && /\.(md|mdx|markdown)$/i.test(detail.path) ? "artifact-markdown" : "artifact-file"];
  }
}
