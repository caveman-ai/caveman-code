import { cn } from "@caveman-app/ui/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { menuDescription } from "@caveman-app/ui/components/menu";
import { Icon, Add01Icon, Archive02Icon, ArchiveRestoreIcon, ArrowDown01Icon, ArrowExpand01Icon, ArrowShrink02Icon, ArrowUpRight01Icon, Cancel01Icon, GitForkIcon, MoreVerticalIcon, PencilEdit02Icon, PinIcon, PinOffIcon, LayoutTwoColumnIcon, LayoutTwoRowIcon } from "@caveman-app/ui/icons/huge";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ACTION_ICONS } from "../../panels/actions/icons.ts";
import { formatChord, isComposing } from "../../panels/chrome.tsx";
import { markTyped, renamedTo } from "../rename-field.ts";
import { actionIcon, actionKey, useActionsList } from "../../state/actions.ts";
import { chord, useKeybindings } from "../../state/keybindings.ts";
import { surfaceDef } from "../../panels/registry.ts";
import { PanelToggle } from "../../panels/SidePanel.tsx";
import { InUseButton } from "../../panels/live/InUseButton.tsx";
import { openSurface, toggleSurface, usePanel, type SurfaceKind } from "../../panels/store.ts";
import "../../panels/surfaces.tsx";
import { SidebarMenuButton } from "../../shell/SidebarToggle.tsx";
import { usePhone } from "../../lib/screen.ts";

/** Actions the title menu lists before "All actions" opens the tab. */
const MENU_ACTIONS = 6;

/** The side panel kinds More lists, in the reference's order. */
export const PANE_VIEWS: ReadonlyArray<SurfaceKind> = ["overview", "actions", "terminal", "diff", "browser", "files"];

export interface PaneHeaderProps {
  readonly workspaceId: string;
  readonly title: string;
  /** Who runs this chat: its model's vendor mark (VendorMark), before the title. */
  readonly mark?: ReactNode;
  /** After the title, only what is out of the ordinary: the way back for a chat running elsewhere, its pull request. */
  readonly meta?: ReactNode;
  /** At the top of the title menu: its sources, a delegated agent's model. Where it runs is the box's foot (WhereItRuns). */
  readonly where?: ReactNode;
  /** A dot before the title while the chat is doing something or needs you; null when there is nothing to say. */
  readonly status: { readonly label: string; readonly dot: string } | null;
  /** The focused pane (or the only one); the others' titles step back to grey. */
  readonly focused: boolean;
  readonly canSplit: boolean;
  readonly pinned: boolean;
  readonly archived: boolean;
  /** Absent outside the split view (the inbox): no split or close controls. */
  readonly onSplit?: ((zone: "right" | "bottom") => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  /** In a split of two or more panes: zoom this one to fill the tab (or back), or move it to a tab of its own. */
  readonly layout?: { readonly count: number; readonly solo: "zoomed" | "squeezed" | null; readonly onToggleZoom: () => void; readonly onMoveToTab: () => void } | undefined;
  readonly onTogglePin: () => void;
  readonly onRename: (title: string) => void;
  /** A new chat from the latest finished turn; absent when the engine cannot fork or nothing finished yet. */
  readonly onFork?: (() => void) | undefined;
  /** The chat that delegated this one: shown before the title, opens it. */
  readonly lead?: { readonly title: string; readonly open: () => void } | undefined;
  /**
   * The sources of its project the chat does not work in yet (state/sources.ts addableSources), each with one line
   * on what it is: the title menu adds one to the chat. Absent or empty: nothing to add.
   */
  readonly addSources?: { readonly list: ReadonlyArray<{ readonly name: string; readonly line: string }>; readonly onAdd: (name: string) => void } | undefined;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  /** Runs one of the chat's actions, in front (the menu lists them, read when it opens). */
  readonly onRun: (command: string) => void;
  /** Start dragging this pane (onPointerDown on the title). */
  readonly onDragStart: (e: PointerEvent<HTMLElement>) => void;
}

/**
 * A pane's header: the title (drag handle and workspace menu), what it runs on, the side panel's switch, More (the
 * panel's views among the rest), close. The panel's tabs sit beside it in a bar of the same height (SidePanel.tsx).
 */
export function PaneHeader(p: PaneHeaderProps) {
  // The menu's keys follow Settings > Keyboard.
  useKeybindings();
  const phone = usePhone();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Rename opens a field of its own: the menu must not pull focus back to its trigger.
  const handoff = useRef(false);
  const actions = useActionsList(p.workspaceId, menu).list?.actions ?? [];
  const panel = usePanel(p.workspaceId);
  const showing = panel.open ? panel.tabs.find((t) => t.id === panel.active)?.kind : undefined;
  const views = PANE_VIEWS.flatMap((kind) => {
    const def = surfaceDef(kind);
    return def ? [{ kind, def, on: showing === kind || (kind === "files" && showing === "file") }] : [];
  });
  return (
    <header className="flex h-11 shrink-0 items-center gap-0.5 pl-2 pr-1.5">
      <SidebarMenuButton className="ml-0" />
      {p.lead ? (
        <>
          <button
            type="button"
            onClick={p.lead.open}
            title={`Started by ${p.lead.title}`}
            // With a delegated agent's meta beside the title, the crumb has no cap and gives way first.
            className={cn("h-8 min-w-0 truncate rounded-md px-2", p.meta ? "shrink-[4]" : "max-w-[30%] shrink", "text-[14px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
          >
            {p.lead.title}
          </button>
          <span aria-hidden className="shrink-0 text-[14px] text-[hsl(var(--subtle-foreground))]">
            /
          </span>
        </>
      ) : null}
      {p.mark ? <span className="ml-1.5 mr-0.5 flex shrink-0 items-center">{p.mark}</span> : null}
      {renaming ? (
        <input
          autoFocus
          defaultValue={p.title}
          aria-label="Chat name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={markTyped}
          onBlur={(e) => {
            setRenaming(false);
            const title = renamedTo(e.currentTarget, p.title);
            if (title) p.onRename(title);
          }}
          onKeyDown={(e) => {
            // An input method's Enter picks its candidate and its Escape cancels the composition: neither ends the rename.
            if (isComposing(e)) return;
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = p.title;
              e.currentTarget.blur();
            }
          }}
          className="h-7 min-w-0 max-w-[60%] flex-1 rounded-md border border-ring/60 bg-background px-2 text-[14px] text-foreground outline-none"
        />
      ) : (
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger
          // Radix opens on pointerdown; that press may be the start of a
          // drag, so it opens on click instead (keys still open it).
          onPointerDown={(e) => {
            e.preventDefault();
            p.onDragStart(e);
          }}
          onClick={() => setMenu((o) => !o)}
          className="flex h-8 min-w-[72px] max-w-[50%] shrink-0 cursor-grab items-center gap-1.5 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        >
          {p.status ? <span role="img" aria-label={p.status.label} title={p.status.label} className={cn("size-1.5 shrink-0 rounded-full", p.status.dot)} /> : null}
          <span className={cn("min-w-0 truncate text-[14px] font-medium transition-colors duration-75", p.focused ? "text-foreground" : "text-muted-foreground")}>{p.title}</span>
          <Icon icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[260px]"
          onCloseAutoFocus={(e) => {
            if (!handoff.current) return;
            handoff.current = false;
            e.preventDefault();
          }}
        >
          {p.where ? (
            <>
              <div className="flex flex-col gap-1.5 px-2 py-1.5 text-[12.5px] text-muted-foreground">{p.where}</div>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onSelect={() => {
              handoff.current = true;
              setRenaming(true);
            }}
          >
            <Icon icon={PencilEdit02Icon} className="size-3.5" /> Rename
          </DropdownMenuItem>
          {p.onFork ? (
            <DropdownMenuItem onSelect={p.onFork}>
              <Icon icon={GitForkIcon} className="size-3.5" /> Fork
            </DropdownMenuItem>
          ) : null}
          {/* An archived chat's thread takes no pin until Restore brings it back (as its row menu, InboxItems). */}
          {p.archived ? null : (
            <DropdownMenuItem onSelect={p.onTogglePin}>
              {p.pinned ? <Icon icon={PinOffIcon} className="size-3.5" /> : <Icon icon={PinIcon} className="size-3.5" />} {p.pinned ? "Unpin" : "Pin to the sidebar"}
            </DropdownMenuItem>
          )}
          {/* One source left to add: named on the row. Several: a submenu of them. */}
          {p.addSources?.list.length === 1 ? (
            <DropdownMenuItem onSelect={() => p.addSources!.onAdd(p.addSources!.list[0]!.name)}>
              <Icon icon={Add01Icon} className="size-3.5" /> Add {p.addSources.list[0]!.name}
              <span className={cn(menuDescription, "ml-auto pl-3")}>{p.addSources.list[0]!.line}</span>
            </DropdownMenuItem>
          ) : p.addSources && p.addSources.list.length > 1 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Icon icon={Add01Icon} className="size-3.5" /> Add a source
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {p.addSources.list.map((s) => (
                  <DropdownMenuItem key={s.name} onSelect={() => p.addSources!.onAdd(s.name)}>
                    {s.name}
                    <span className={cn(menuDescription, "ml-auto pl-3")}>{s.line}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {actions.length > 0 ? <DropdownMenuSeparator /> : null}
          {actions.slice(0, MENU_ACTIONS).map((a) => {
            const glyph = ACTION_ICONS[actionIcon(a)];
            return (
              <DropdownMenuItem key={actionKey(a)} title={a.command} onSelect={() => p.onRun(a.command)}>
                <Icon icon={glyph} className="size-3.5" /> {a.name} <span className="ml-auto max-w-[180px] truncate pl-3 font-mono text-[11.5px] text-muted-foreground">{a.command}</span>
              </DropdownMenuItem>
            );
          })}
          {actions.length > 0 ? <DropdownMenuItem onSelect={() => openSurface(p.workspaceId, "actions", {})}>All actions</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          {p.archived ? (
            <DropdownMenuItem onSelect={p.onRestore}>
              <Icon icon={ArchiveRestoreIcon} className="size-3.5" /> Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={p.onArchive}>
              <Icon icon={Archive02Icon} className="size-3.5" /> Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
      {/* The chat's name keeps its width (up to half the header); where it runs gives way first, its branch cutting. */}
      {p.meta && !renaming ? <span className="pane-meta ml-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-muted-foreground">{p.meta}</span> : null}

      <span className="min-w-2 flex-1" />

      {/* While the agent uses its browser or computer out of view: the way to it, pulsing in the blue. */}
      <InUseButton workspaceId={p.workspaceId} />
      {/* One switch for the side panel; its views are its tabs (and More, and the panel's +). */}
      <PanelToggle workspaceId={p.workspaceId} />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More"
          title="More"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:size-9"
        >
          <Icon icon={MoreVerticalIcon} className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          {views.map(({ kind, def, on }) => {
            const SurfaceIcon = def.icon;
            return (
              <DropdownMenuItem key={kind} onSelect={() => toggleSurface(p.workspaceId, kind)}>
                <SurfaceIcon className="size-4" /> {def.label}
                {on ? <span className="ml-auto text-[12px] text-muted-foreground">Showing</span> : def.chord ? <DropdownMenuShortcut>{formatChord(def.chord)}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            );
          })}
          {/* A phone shows one pane: nothing to split into. */}
          {p.onSplit && !phone ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!p.canSplit} onSelect={() => p.onSplit?.("right")}>
                <Icon icon={LayoutTwoColumnIcon} /> Split right <DropdownMenuShortcut>{formatChord(chord("app.splitRight"))}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!p.canSplit} onSelect={() => p.onSplit?.("bottom")}>
                <Icon icon={LayoutTwoRowIcon} /> Split down <DropdownMenuShortcut>{formatChord(chord("app.splitDown"))}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          ) : null}
          {p.layout ? (
            <>
              <DropdownMenuSeparator />
              {p.layout.solo !== "squeezed" ? (
                <DropdownMenuItem onSelect={p.layout.onToggleZoom}>
                  <Icon icon={p.layout.solo === "zoomed" ? ArrowShrink02Icon : ArrowExpand01Icon} /> {p.layout.solo === "zoomed" ? "Show all panes" : "Zoom to fill the tab"}
                  <DropdownMenuShortcut>{formatChord(chord("app.zoomPane"))}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={p.layout.onMoveToTab}>
                <Icon icon={ArrowUpRight01Icon} /> Move to a new tab
              </DropdownMenuItem>
            </>
          ) : null}
          {p.onClose ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.onClose}>
                <Icon icon={Cancel01Icon} /> Close pane <DropdownMenuShortcut>{formatChord(chord("app.closePane"))}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Alone in the tab while the split holds others: how many, and the way back. */}
      {p.layout?.solo === "zoomed" ? (
        <button
          type="button"
          onClick={p.layout.onToggleZoom}
          title={`Show all ${p.layout.count} panes (${formatChord(chord("app.zoomPane"))})`}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-[12px] font-medium tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={ArrowShrink02Icon} className="size-3.5" /> 1 of {p.layout.count}
        </button>
      ) : p.layout?.solo === "squeezed" ? (
        <span title="The window is too small to show the split; widen it to see every pane" className="shrink-0 px-1 text-[12px] tabular-nums text-muted-foreground">
          1 of {p.layout.count}
        </span>
      ) : null}
      {/* On a phone the menu button is the way elsewhere, and More still has Close pane. */}
      {p.onClose && !phone ? (
        <IconButton label="Close pane" onClick={p.onClose}>
          <Icon icon={Cancel01Icon} className="size-4" />
        </IconButton>
      ) : null}
    </header>
  );
}

export function IconButton({ label, onClick, active, className, children }: { label: string; onClick: () => void; active?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:size-9",
        active && "bg-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
