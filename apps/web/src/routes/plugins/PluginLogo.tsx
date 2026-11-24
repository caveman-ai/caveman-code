// A plugin's logo on the theme's own tile, so a row of them reads as one set
// in light and dark: the manifest's dark variant in dark mode; a logo that is
// its own tile (Slack's square) fills the box. A mark that would vanish on the
// tile (black ink in dark mode with no dark variant) is flipped light when it
// is one colour, as the vendor's own dark variant would be, and otherwise sits
// on a plate it shows on. No logo: its initial on its brand colour.
import { cn } from "@caveman-app/ui/lib/cn";
import type { PluginSummary } from "./api.ts";
import { useLogoLook } from "./logo-look.ts";
import { displayName, whiteOn } from "./model.ts";

const SIZE = {
  // A menu row's icon: no tile of its own, like the pixel icons beside it.
  xs: "size-4 rounded-[3px] text-[10px]",
  sm: "size-5 rounded-[5px] text-[11px]",
  md: "size-9 rounded-[10px] text-[15px]",
  // A Plugins page tile's mark.
  tile: "size-11 rounded-xl text-[18px]",
  lg: "size-14 rounded-2xl text-[24px]",
} as const;
const PAD = { xs: "", sm: "p-px", md: "p-1.5", tile: "p-2", lg: "p-1.5" } as const;
const DARK_PAD = { xs: "", sm: "dark:p-px", md: "dark:p-1.5", tile: "dark:p-2", lg: "dark:p-1.5" } as const;

export function PluginLogo({ plugin, size = "md", className }: { plugin: Pick<PluginSummary, "name" | "interface">; size?: keyof typeof SIZE; className?: string }) {
  const { logo, logo_dark, brand_color } = plugin.interface;
  // Each theme's image, read for whether it is a tile and whether its ink shows on that theme's tile.
  const light = useLogoLook(logo);
  const dark = useLogoLook(logo_dark ?? logo);
  const framed = size !== "xs";
  const box = cn("shrink-0 overflow-hidden", framed && "border border-border bg-card", SIZE[size], className);
  if (logo) {
    const lost = { light: !!light && !light.tile && light.lightInk, dark: !!dark && !dark.tile && dark.darkInk };
    const lightPlate = lost.light && !light!.mono;
    const darkPlate = lost.dark && !dark!.mono;
    // Flipped: inverted, then turned back to its own hue.
    const flipLight = lost.light && light!.mono && "invert hue-rotate-180 dark:invert-0 dark:hue-rotate-0";
    const flipDark = lost.dark && dark!.mono && "dark:invert dark:hue-rotate-180";
    return (
      <span
        className={cn(
          box,
          "relative grid place-items-center",
          light?.tile ? "p-0" : PAD[size],
          dark?.tile ? "dark:p-0" : DARK_PAD[size],
          lightPlate && "border-transparent bg-[#1f1f21]",
          darkPlate ? "dark:border-transparent dark:bg-white" : lightPlate && (framed ? "dark:border-border dark:bg-card" : "dark:bg-transparent"),
        )}
      >
        <img src={logo} alt="" className={cn("size-full", light?.tile ? "object-cover" : "object-contain", flipLight, logo_dark ? "dark:hidden" : flipDark)} />
        {logo_dark ? <img src={logo_dark} alt="" className={cn("hidden size-full dark:block", dark?.tile ? "object-cover" : "object-contain", flipDark)} /> : null}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(box, "grid place-items-center font-semibold", !brand_color ? "text-muted-foreground" : whiteOn(brand_color) ? "text-white" : "text-black/80")}
      style={{ background: brand_color ?? "hsl(var(--secondary))", borderColor: brand_color ? "transparent" : undefined }}
    >
      {displayName(plugin).charAt(0).toUpperCase()}
    </span>
  );
}
