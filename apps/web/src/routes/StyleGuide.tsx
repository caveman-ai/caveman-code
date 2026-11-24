import { useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import cavemanUrl from "@caveman-app/ui/assets/caveman.svg";
import rockUrl from "@caveman-app/ui/assets/rock.svg";
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { SearchField } from "@caveman-app/ui/components/input";
import { Keycap, menuItem } from "@caveman-app/ui/components/menu";
import { Switch } from "@caveman-app/ui/components/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { cn } from "@caveman-app/ui/lib/cn";
import { PIXEL_ICONS, PIXEL_ICON_NAMES, type PixelIconGroup, type PixelIconName, type PixelIconProps } from "@caveman-app/ui/icons/names";
import { MASCOT_POSES, type MascotPose, type MascotProps } from "@caveman-app/ui/mascot/poses";
import { NavButton, NavIcon } from "@caveman-app/ui/icons/NavButton";
import { PixelAppear, PixelIcon as PixelIconNow, PixelStrip, STATE_STRIPS } from "@caveman-app/ui/icons/PixelIcon";
import { Rock } from "../components/Rock.tsx";
import { AccessSetting, type AccessMode } from "@caveman-app/ui/components/access-picker";
import { ChatSettings } from "@caveman-app/ui/components/chat-settings";
import { pickEffort } from "@caveman-app/ui/components/effort";
import { findModel, ModelPicker, type ModelRef, type PickerEngine } from "@caveman-app/ui/components/model-picker";
import { chiefPickerEngines, chiefPickerValue } from "../state/chief-model.ts";
import { Icon as HugeIcon, Add01Icon, ArrowDown01Icon, CloudIcon, Copy01Icon, Delete02Icon, GitBranchIcon, LaptopIcon, PencilEdit02Icon, Attachment01Icon, Image01Icon, Target02Icon, FireIcon, NoteAddIcon, PuzzleIcon } from "@caveman-app/ui/icons/huge";
import { ComposerAddMenu, filterAddMenu, type AddSection } from "../components/ComposerAddMenu.tsx";
import { ComposerTray } from "../components/Composer.tsx";
import { SendKey, StopKey, type SendKeyMode } from "../components/SendKey.tsx";
import { MicButton } from "../dictation/MicButton.tsx";
import type { DictationPhase } from "../dictation/store.ts";
import { FootLabel, PlaceChip, type Place } from "../components/composer-foot.tsx";
import { ProjectBadge } from "../components/ProjectPicker.tsx";
import { WaitingOn } from "../components/pane/WaitingOn.tsx";
import { Queue, type QueueEntry } from "@caveman-app/ui/ai/queue";
import { IncomingCallCard, RingMutedPillView } from "../call/CallStage.tsx";
import { CodeView } from "@caveman-app/ui/markdown/CodeView";
import { MarkdownDocument } from "@caveman-app/ui/markdown/MarkdownDocument";
import { AgentStatesSection, ChatStyleSection } from "../components/transcript/ChatStyleSection.tsx";
import { GrillStyleSection } from "../components/transcript/GrillStyleSection.tsx";
import { AnnotateStyleSection } from "../components/annotate/AnnotateStyleSection.tsx";
import { ImageGenerationStyleSection } from "../components/gallery/ImageGenerationStyleSection.tsx";
import { ChiefStyleSection } from "./chief-style.tsx";
import { OverviewStyleSection } from "../components/pane/cards/OverviewStyleSection.tsx";
import { PaneHeader } from "../components/pane/PaneHeader.tsx";
import "../panes/panes.css";

// The living style page (#/style): packages/ui/STYLE.md made visible. The
// icon and mascot lanes' components show up here as soon as their files land
// in packages/ui/src/icons and packages/ui/src/mascot; until then each slot
// shows a labelled placeholder.
const iconModules = import.meta.glob<{ PixelIcon?: ComponentType<PixelIconProps> }>(
  ["../../../../packages/ui/src/icons/*.tsx", "!../../../../packages/ui/src/icons/*.test.tsx"],
  { eager: true },
);
const mascotModules = import.meta.glob<{ Mascot?: ComponentType<MascotProps> }>(
  ["../../../../packages/ui/src/mascot/*.tsx", "!../../../../packages/ui/src/mascot/*.test.tsx"],
  { eager: true },
);
const PixelIcon = Object.values(iconModules).find((m) => m.PixelIcon)?.PixelIcon;
const Mascot = Object.values(mascotModules).find((m) => m.Mascot)?.Mascot;

function Icon({ name, scale = 1 }: { name: PixelIconName; scale?: 1 | 2 | 3 }) {
  if (PixelIcon) return <PixelIcon name={name} scale={scale} />;
  const size = 16 * scale;
  return (
    <span
      aria-hidden
      title={`${name} (ui-icons)`}
      className="px-dither-25 inline-block shrink-0 text-[hsl(var(--subtle-foreground))] outline outline-1 -outline-offset-1 outline-border"
      style={{ width: size, height: size }}
    />
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="border-t border-border py-10 first:border-t-0 first:pt-0">
      <h2 id={`${id}-h`} className="text-[14px] font-medium text-foreground">{title}</h2>
      {note && <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Swatch({ token, label, text }: { token: string; label: string; text?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn("size-7 shrink-0 rounded-md", !text && "outline outline-1 -outline-offset-1 outline-foreground/10")}
        style={{ background: `hsl(var(${token}))` }}
      />
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-foreground">{label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{token}</span>
      </span>
    </div>
  );
}

const DECK = [
  ["--sidebar", "Shell"], ["--background", "Panel"], ["--card", "Card"], ["--popover", "Menu"],
  ["--secondary", "Quiet control"], ["--accent", "Hover / selected"], ["--border", "Hairline"], ["--input", "Field edge"],
] as const;
const INK = [["--foreground", "Label"], ["--muted-foreground", "Description"], ["--subtle-foreground", "Tertiary"]] as const;
const STATE = [["--warning", "Needs input"], ["--success", "Done"], ["--destructive", "Failed"], ["--info", "Info"], ["--target", "Here (the one blue)"]] as const;
const IDENTITY = [
  ["--id-outline", "Outline"], ["--id-hair", "Hair"], ["--id-hair-hi", "Hair light"], ["--id-skin-light", "Skin light"],
  ["--id-skin", "Skin"], ["--id-skin-shade", "Skin shade"], ["--id-skin-edge", "Skin edge"], ["--id-tunic", "Tunic"],
  ["--id-tunic-shade", "Tunic shade"], ["--id-bead", "Bead"], ["--id-rock-deep", "Rock deep"], ["--id-rock-dark", "Rock dark"],
  ["--id-rock-mid", "Rock mid"], ["--id-rock", "Rock"], ["--id-rock-light", "Rock light"],
  ["--id-engine-claude", "Claude Agent tint"], ["--id-engine-codex", "Codex tint"], ["--id-engine-acp", "ACP tint"], ["--id-engine-cursor", "Cursor tint"], ["--id-engine-opencode", "OpenCode tint"], ["--id-engine-muse", "Muse Code tint"], ["--id-engine-grok", "Grok tint"], ["--id-engine-pi", "Pi tint"], ["--id-engine-antigravity", "Antigravity tint"],
] as const;

const ADD_MENU: { section: string; rows: { icon: PixelIconName; label: string; desc?: string }[] }[] = [
  {
    section: "Add",
    rows: [
      { icon: "attach", label: "Files and folders" },
      { icon: "goal", label: "Goal", desc: "Set a goal to keep pursuing" },
      { icon: "grill-mode", label: "Grill mode", desc: "Answer its questions first, then build" },
      { icon: "record-skill", label: "Record a skill", desc: "Show it once, reuse it" },
    ],
  },
  {
    section: "Plugins and Spaces",
    rows: [
      { icon: "space", label: "Team space", desc: "Skills, commands and MCP servers" },
      { icon: "tool-mcp", label: "Postgres", desc: "Query the dev database" },
    ],
  },
];


const GROUPS: PixelIconGroup[] = ["nav", "engine", "tool", "state", "computer", "artifact", "action", "panel"];

const PIXEL_TIMING = [
  ["hover", "rise a pixel, glint across, land", "8 x 32ms"],
  ["press", "sinks a pixel, held", "at once"],
  ["working", "the ring: a comet turns, two tints of tail", "16 half steps, 12 fps"],
  ["agents", "the ring: two comets chase", "16 half steps, 12 fps"],
  ["stopped", "the ring halts, flashes, pulses out, closes on a square", "5f, 10 fps, once"],
  ["done", "the ring runs closed, turns green, fills in", "8f, 12 fps, once"],
  ["lands", "a new status dithers in", "4f, 16 fps"],
  ["sleeping", "slow breath, a rising z", "2 fps"],
  ["nav tick", "steps in", "2 frames"],
] as const;

const EASINGS = [
  ["ease-snap", "arrivals, poppers", "150ms"],
  ["ease-swift", "something on screen moving", "200-300ms"],
  ["ease-drawer", "sheets, long travel", "300ms"],
] as const;

export function StyleGuideRoute() {
  const [active, setActive] = useState<PixelIconName>("chief");
  const [moved, setMoved] = useState(false);
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-[1080px] px-10 py-12">
        <header className="mb-10 flex items-end gap-5">
          <img src={cavemanUrl} alt="" aria-hidden width={64} height={64} className="px-art" />
          <div>
            <h1 className="font-pixel text-[32px] leading-none tracking-wide">CAVEMAN CODE</h1>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Style, made visible. The rules live in <code className="font-mono text-[12px]">packages/ui/STYLE.md</code>.
            </p>
          </div>
        </header>

        <Section id="layers" title="Two layers" note="Quiet Linear-dark chrome for everything you read and operate; pixel art for who and what. Never blended on one element.">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[12px] text-muted-foreground">Chrome</div>
              <div className="mt-3 flex h-8 items-center gap-2 rounded-md bg-accent px-2 text-[13px]">
                <span className="text-foreground">Fix the flaky login test</span>
                <span className="truncate text-muted-foreground">caveman-cloud · 2m</span>
              </div>
              <pre className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12.5px] text-muted-foreground">pnpm --filter web test</pre>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[12px] text-muted-foreground">Identity</div>
              <div className="mt-3 flex items-end gap-6">
                <Icon name="engine-caveman" scale={3} />
                <img src={rockUrl} alt="" aria-hidden height={32} style={{ height: 32, width: "auto" }} className="px-art" />
                <Icon name="engine-claude-agent" scale={2} />
                <Icon name="engine-codex" scale={2} />
                <Icon name="engine-acp" scale={2} />
              </div>
            </div>
          </div>
        </Section>

        <Section id="colour" title="Colour" note="Deck tokens for chrome, state tokens for state, the sprite palette for identity only. One chrome blue: --target, meaning “here”.">
          <div className="grid grid-cols-4 gap-x-6 gap-y-4">
            {DECK.map(([t, l]) => <Swatch key={t} token={t} label={l} />)}
          </div>
          <div className="mt-6 grid grid-cols-4 gap-x-6 gap-y-4">
            {INK.map(([t, l]) => <Swatch key={t} token={t} label={l} text />)}
            {STATE.map(([t, l]) => <Swatch key={t} token={t} label={l} />)}
          </div>
          <h3 className="mt-8 text-[12px] text-muted-foreground">Identity (pixel art and engine tiles only)</h3>
          <div className="mt-3 grid grid-cols-6 gap-x-4 gap-y-4">
            {IDENTITY.map(([t, l]) => <Swatch key={t} token={t} label={l} />)}
          </div>
        </Section>

        <Section id="type" title="Type" note="The system face for reading, the system mono for code and paths only, Geist Pixel for three words at most.">
          <div className="space-y-3">
            <p className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">Page empty-state title, 17px 590</p>
            <p className="text-[14px] leading-6 text-foreground/80">Chat prose, 14px on a 24px line at 80% ink. The agent explains <strong className="font-semibold text-foreground">what it changed</strong> and why.</p>
            <p className="text-[13px]">Rows, buttons, menu items, 13px</p>
            <p className="text-[12px] text-muted-foreground">Meta and section headers, 12px muted</p>
            <p className="font-mono text-[12.5px] text-muted-foreground">apps/web/src/routes/StyleGuide.tsx · claude/split-view-7f3a</p>
            <div className="flex items-baseline gap-6 pt-2">
              <span className="font-pixel text-[16px]">EXTRA</span>
              <span className="font-pixel text-[24px]">HELLO</span>
              <span className="font-pixel text-[32px]">CAVEMAN</span>
            </div>
          </div>
        </Section>

        <Section id="hierarchy" title="Visual hierarchy" note="Small icon, label in white, description in grey on the same line, grey section headers. Every menu, picker, list and card.">
          <div className="w-[520px] rounded-[14px] border border-input bg-popover p-1.5 shadow-overlay">
            {ADD_MENU.map((group) => (
              <div key={group.section} role="group" aria-label={group.section}>
                <div className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">{group.section}</div>
                {group.rows.map((row, i) => (
                  <button
                    key={row.label}
                    type="button"
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors duration-75 ease-snap hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      group.section === "Add" && i === 0 && "bg-accent",
                    )}
                  >
                    <Icon name={row.icon} />
                    <span className="shrink-0 text-foreground">{row.label}</span>
                    {row.desc && <span className="truncate text-muted-foreground">{row.desc}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section id="pixel" title="Pixel utilities" note="Stepped corners, hard shadows, dither, held-frame presses. Integer scale only.">
          <div className="flex flex-wrap items-end gap-8">
            <Demo label="px-frame"><span className="px-frame block size-12 bg-card" /></Demo>
            <Demo label="px-frame-raised px-press">
              <button type="button" className="px-frame-raised px-press h-8 bg-secondary px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">Press</button>
            </Demo>
            <Demo label="px-notch"><span className="px-notch block size-12 bg-id-tunic" /></Demo>
            <Demo label="px-notch-2"><span className="px-notch-2 block size-12 bg-id-skin" /></Demo>
            <Demo label="px-dither-25"><span className="px-dither-25 block size-12 text-[hsl(var(--subtle-foreground))]" /></Demo>
            <Demo label="px-dither-50"><span className="px-dither-50 block size-12 text-[hsl(var(--subtle-foreground))]" /></Demo>
            <Demo label="shadow-px-2"><span className="block size-12 bg-secondary shadow-px-2" /></Demo>
            <Demo label="1x 2x 3x">
              <span className="flex items-end gap-3">
                {[16, 32, 48].map((s) => <img key={s} src={cavemanUrl} alt="" aria-hidden width={s} height={s} className="px-art" />)}
              </span>
            </Demo>
          </div>
        </Section>

        <Section id="motion" title="Motion" note="Pixel icons are toys, flipbooks on their own grid: hover wakes one up, a click sets it off. Chrome fades and settles, short, and never overshoots. Reduced motion stops all of it.">
          <div className="grid grid-cols-2 gap-6">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[12px] text-muted-foreground">Pixel: held frames on the icon's own grid. Hover a tile.</div>
              <PixelMotionDemo />
              <dl className="mt-4 space-y-1">
                {PIXEL_TIMING.map(([name, use, dur]) => (
                  <div key={name} className="flex gap-2 text-[13px]">
                    <dt className="w-28 shrink-0 font-mono text-[12px] text-foreground">{name}</dt>
                    <dd className="truncate text-muted-foreground">{use}</dd>
                    <dd className="ml-auto tabular-nums text-muted-foreground">{dur}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-[12px] text-muted-foreground">Chrome: transform and opacity, named curves</div>
              <button
                type="button"
                onClick={() => setMoved((v) => !v)}
                className="relative mt-4 h-8 w-[280px] rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Play the curve"
              >
                <span
                  className="px-notch-2 absolute left-1 top-1 block h-6 w-5 bg-foreground transition-transform duration-300 ease-swift"
                  style={{ transform: moved ? "translateX(252px)" : "translateX(0)" }}
                />
              </button>
              <dl className="mt-4 space-y-1">
                {EASINGS.map(([name, use, dur]) => (
                  <div key={name} className="flex gap-2 text-[13px]">
                    <dt className="w-28 shrink-0 font-mono text-[12px] text-foreground">{name}</dt>
                    <dd className="truncate text-muted-foreground">{use}</dd>
                    <dd className="ml-auto tabular-nums text-muted-foreground">{dur}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </Section>

        <Section id="nav" title="Special nav buttons" note="Hover or focus plays the icon hover once (rise and glint); pressed sinks the icon a pixel; the current page gets a pixel tick in the gutter.">
          <nav aria-label="Sample nav" className="w-[232px] rounded-xl bg-sidebar py-2 pl-4 pr-2">
            {NAV_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                aria-current={active === icon ? "page" : undefined}
                onClick={() => setActive(icon)}
                className={cn(
                  "px-nav px-play-hover flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground transition-colors duration-75 ease-snap hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === icon && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <NavIcon name={icon} />
                {PIXEL_ICONS[icon].label}
              </button>
            ))}
          </nav>
        </Section>

        <Section id="controls" title="Buttons, search and menus" note="One button family after the New chat button: a pixel icon wakes on hover and goes off on a click. The white action and the raised card are keys, lit from above, that sink when pressed. Every list that drops down is the composer menu, on glass.">
          <div className="flex flex-col gap-4">
            {[["panel", "bg-background"], ["card", "rounded-xl border border-border bg-card"]].map(([label, surface]) => (
              <div key={label} className={cn("flex flex-wrap items-center gap-2 p-4", surface)}>
                <Button>
                  <NavIcon name="new" /> New chat
                </Button>
                <Button variant="secondary">
                  <NavIcon name="spaces" /> Browse marketplace
                </Button>
                <Button variant="secondary" size="sm">
                  <HugeIcon icon={Add01Icon} /> Add note
                </Button>
                <Button variant="ghost" size="sm">
                  Settings
                </Button>
                <Button variant="destructive-outline" size="sm">
                  Remove
                </Button>
                <span className="ml-auto text-[12px] text-muted-foreground">on the {label}</span>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Keycap>⌘</Keycap>
                <Keycap>K</Keycap>
              </span>
              <Switch defaultChecked aria-label="On" />
              <Switch aria-label="Off" />
              <span>Keycaps are little keys. Hold a switch: its thumb stretches.</span>
            </div>
            <div className="relative h-[156px] overflow-hidden rounded-xl">
              <div aria-hidden className="absolute inset-0 grid grid-cols-6">
                {["bg-target", "bg-success", "bg-warning", "bg-destructive", "bg-info", "bg-id-tunic"].map((c) => (
                  <div key={c} className={c} />
                ))}
              </div>
              <div role="listbox" aria-label="Glass" className="glass absolute left-6 top-5 w-[320px] rounded-xl p-1.5 text-popover-foreground">
                <div role="option" aria-selected data-active="true" className={menuItem}>
                  <HugeIcon icon={PencilEdit02Icon} /> New chat <span className="ml-auto"><Keycap>⌘N</Keycap></span>
                </div>
                <div role="option" aria-selected={false} className={menuItem}>
                  <HugeIcon icon={Copy01Icon} /> Duplicate
                </div>
                <div role="option" aria-selected={false} className={menuItem}>
                  <HugeIcon icon={Delete02Icon} /> Delete
                </div>
              </div>
              <span className="absolute bottom-3 right-4 text-[12px] text-white/90">.glass over colour</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SearchField aria-label="Search notes" placeholder="Search notes" containerClassName="w-[280px]" />
              <Select defaultValue="all">
                <SelectTrigger aria-label="Project" className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Every project</SelectItem>
                  <SelectItem value="api">api-gateway</SelectItem>
                  <SelectItem value="web">web-dashboard</SelectItem>
                </SelectContent>
              </Select>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary">
                    Actions <HugeIcon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Chat</DropdownMenuLabel>
                  <DropdownMenuItem>
                    <HugeIcon icon={PencilEdit02Icon} /> Rename <DropdownMenuShortcut>R</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <HugeIcon icon={Copy01Icon} /> Duplicate <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem checked>Pinned</DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive">
                    <HugeIcon icon={Delete02Icon} /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </Section>

        <Section id="calls" title="Calls: the Chief ringing" note="The ring-back card: Answer, Later, or Mute for a while (15 minutes, an hour, until tomorrow morning, until you turn it back on). Muted, the Chief's header wears the pill: until when, what arrived quietly, one click to unmute.">
          <div className="flex flex-wrap items-start gap-6">
            <IncomingCallCard inline line="Dark mode for runs is ready for you to look at. Want me to walk you through it?" onAnswer={() => undefined} onLater={() => undefined} onMute={() => undefined} />
            <div className="flex h-11 items-center">
              <RingMutedPillView label="Calls muted until 9:15 AM" missed={2} onUnmute={() => undefined} />
            </div>
          </div>
        </Section>

        <Section id="icons" title="Pixel icons" note={PixelIcon ? "Every name in icons/names.ts, drawn by ui-icons. Hover a row to play its effect." : "Every name in icons/names.ts. Placeholders until ui-icons lands PixelIcon."}>
          <div className="space-y-6">
            {GROUPS.map((g) => (
              <div key={g}>
                <h3 className="text-[12px] text-muted-foreground">{g}</h3>
                <ul className="mt-2 grid grid-cols-4 gap-x-4 gap-y-1">
                  {PIXEL_ICON_NAMES.filter((n) => PIXEL_ICONS[n].group === g).map((n) => (
                    <li key={n} className="px-play-hover flex h-8 items-center gap-2 text-[13px]">
                      <Icon name={n} />
                      {/* 13px label and 11px mono name on one baseline, not each centred on its own box. */}
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-foreground">{PIXEL_ICONS[n].label}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{n}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <IconLegibility />
          <NavButtonsDemo />
        </Section>

        <Section id="mascot" title="Mascot" note={Mascot ? "Every pose as it plays (body 3x), each of its frames (body 2x), then the sizes the app uses: bust 2x and 1x, body 1x." : "Poses from mascot/poses.ts. The current bust stands in until ui-mascot lands Mascot."}>
          {Mascot ? (
            <MascotSheet Mascot={Mascot} />
          ) : (
            <ul className="grid grid-cols-7 gap-4">
              {(Object.keys(MASCOT_POSES) as MascotPose[]).map((pose) => (
                <li key={pose} className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card py-4">
                  <img src={cavemanUrl} alt="" aria-hidden width={48} height={48} className="px-art" />
                  <span className="text-[13px] text-foreground">{pose}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="target" title="Split view: the drop target" note="The region the drop will create wears the blue outline; the pane's content blurs; a pill rides the pointer; the hint names the action.">
          <div className="relative h-[220px] overflow-hidden rounded-xl border border-border bg-background">
            <div className="space-y-2 p-5 blur-[6px] brightness-[0.6]" aria-hidden>
              <p className="text-[14px]">Logs are measured and the stats are checked.</p>
              <p className="text-[14px] text-muted-foreground">Created article.md, ran a command</p>
              <p className="text-[14px]">Final article, 858 words, every number sourced or measured.</p>
              <p className="text-[14px]">The new hook comes from your logs. 422,000 calls and 88 billion tokens.</p>
              <p className="text-[14px] text-muted-foreground">Cut, because no source could be found.</p>
              <div className="h-12 rounded-xl border border-border bg-card" />
            </div>
            <div className="absolute inset-1 top-[45%] rounded-xl outline outline-2 -outline-offset-2 outline-target" />
            <span className="absolute left-[38%] top-[68%] rounded-full bg-target px-3 py-1 text-[12px] text-target-foreground shadow-overlay">Split view</span>
            <span className="absolute right-6 top-[62%] rounded-md bg-popover px-2.5 py-1.5 text-[13px] text-foreground">Open in split view</span>
          </div>
        </Section>

        <SplitViewSection />

        <ComposerSection />
        <QueueSection />
        <ChiefPickerSection />

        <ChatStyleSection />
        <ImageGenerationStyleSection />
        <AnnotateStyleSection />
        <AgentStatesSection />
        <OverviewStyleSection />

        <GrillStyleSection />

        <ChiefStyleSection />

        <Section id="markdown" title="Markdown and code" note="The side panel's reader (MarkdownDocument): the chat's elements at reading scale, front matter as properties, an outline rail that follows the reader, mermaid diagrams, GitHub alerts; fences are the chat's Code Block. CodeView opens any file: chunked, numbered, wrap, reveal. One Shiki for all of it (ai/highlight.ts).">
          <MarkdownAndCode />
        </Section>
      </div>
    </div>
  );
}

function Demo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

// Mascot section (lane ui-mascot). A frame is picked with --px-frame, which
// the strip inherits; "Play again" remounts every sprite so the poses that
// play once (done, wave) run from frame 0.
function MascotSheet({ Mascot }: { Mascot: ComponentType<MascotProps> }) {
  const [run, setRun] = useState(0);
  return (
    <div>
      <ul key={run} className="divide-y divide-border rounded-xl border border-border bg-card">
        {(Object.keys(MASCOT_POSES) as MascotPose[]).map((pose) => {
          const { frames, fps, loop } = MASCOT_POSES[pose];
          return (
            <li key={pose} className="flex items-end gap-8 px-5 py-4">
              <div className="w-40 shrink-0 self-center">
                <div className="text-[13px] text-foreground">{pose}</div>
                <div className="text-[12px] tabular-nums text-muted-foreground">
                  {frames} frames, {fps} fps{loop ? ", loops" : ", once"}
                </div>
              </div>
              <Mascot pose={pose} scale={3} label={`Caveman, ${pose}`} />
              <div className="flex w-[216px] items-end gap-2">
                {Array.from({ length: frames }, (_, i) => (
                  <span key={i} style={{ "--px-frame": i } as CSSProperties}>
                    <Mascot pose={pose} scale={2} animate={false} />
                  </span>
                ))}
              </div>
              <div className="flex items-end gap-4">
                <Mascot pose={pose} cut="bust" scale={2} />
                <Mascot pose={pose} cut="bust" scale={1} />
                <Mascot pose={pose} scale={1} />
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => setRun((n) => n + 1)}
        className="mt-3 h-7 rounded-md border border-border px-2.5 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Play again
      </button>
    </div>
  );
}

// Icons section (lane ui-icons): every glyph at 1x on the two grounds it lives
// on, then 2x and 3x; the nav buttons live, and each hover strip frame by frame.
const NAV_ICONS: PixelIconName[] = ["new", "search", "chief", "runs", "spaces", "settings"];

function IconLegibility() {
  const grounds = [
    ["bg-background", "Panel, 1x"],
    ["bg-sidebar", "Sidebar, 1x"],
  ] as const;
  return (
    <div className="mt-8 space-y-3">
      <h3 className="text-[12px] text-muted-foreground">Legibility</h3>
      {grounds.map(([bg, label]) => (
        <div key={bg} className={cn("rounded-xl border border-border px-4 py-3", bg)}>
          <div className="mb-2 text-[12px] text-muted-foreground">{label}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-2 text-muted-foreground">
            {PIXEL_ICON_NAMES.map((n) => <Icon key={n} name={n} />)}
          </div>
        </div>
      ))}
      {([2, 3] as const).map((scale) => (
        <div key={scale} className="rounded-xl border border-border bg-background px-4 py-3">
          <div className="mb-2 text-[12px] text-muted-foreground">{scale}x</div>
          <div className="flex flex-wrap gap-3 text-foreground">
            {PIXEL_ICON_NAMES.map((n) => <Icon key={n} name={n} scale={scale} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function NavButtonsDemo() {
  const [current, setCurrent] = useState<PixelIconName>("chief");
  return (
    <div className="mt-8 grid grid-cols-[232px_1fr] gap-8">
      <div>
        <h3 className="mb-2 text-[12px] text-muted-foreground">NavButton</h3>
        <nav aria-label="Nav buttons" className="rounded-xl bg-sidebar py-2 pl-4 pr-2">
          {NAV_ICONS.map((icon) => (
            <NavButton
              key={icon}
              icon={icon}
              aria-current={current === icon ? "page" : undefined}
              onClick={() => setCurrent(icon)}
              trailing={icon === "chief" ? 3 : undefined}
            >
              {PIXEL_ICONS[icon].label}
            </NavButton>
          ))}
        </nav>
      </div>
      <div>
        <h3 className="mb-2 text-[12px] text-muted-foreground">Frame by frame (3x)</h3>
        <ul className="space-y-2">
          {FRAME_ROWS.map(([label, frames, fps]) => (
            <li key={label} className="flex items-center gap-3">
              <span className="w-24 font-mono text-[11px] text-muted-foreground">{label}</span>
              {frames.map((_, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- a frame's place in its strip is its identity; two frames can be drawn alike.
                <span key={i} className="rounded-md bg-sidebar p-1 text-sidebar-foreground" style={{ "--px-frame": i } as CSSProperties}>
                  <PixelStrip frames={frames} fps={fps} scale={3} />
                </span>
              ))}
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {frames.length}f · {Math.round((frames.length / fps) * 1000)}ms
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const FRAME_ROWS = [
  ["working", STATE_STRIPS["state-working"].frames, STATE_STRIPS["state-working"].fps],
  ["agents", STATE_STRIPS["state-agents"].frames, STATE_STRIPS["state-agents"].fps],
  ["3 agents", STATE_STRIPS["state-agents-3"].frames, STATE_STRIPS["state-agents-3"].fps],
  ["4+ agents", STATE_STRIPS["state-agents-4"].frames, STATE_STRIPS["state-agents-4"].fps],
  ["stopped", STATE_STRIPS["state-stopped"].frames, STATE_STRIPS["state-stopped"].fps],
  ["done", STATE_STRIPS["state-done"].frames, STATE_STRIPS["state-done"].fps],
  ["thinking", STATE_STRIPS["state-thinking"].frames, STATE_STRIPS["state-thinking"].fps],
  ["compacted", STATE_STRIPS["state-compacted"].frames, STATE_STRIPS["state-compacted"].fps],
] as const;

const MOTION_ICONS: PixelIconName[] = ["chief", "runs", "mic", "call", "state-done", "state-failed", "tool-edit", "engine-claude-agent"];

/** The pixel motion at 3x: hover tiles, the ring's states and the Rock, and a status landing (replays on the button). */
function PixelMotionDemo() {
  const [take, setTake] = useState(0);
  const ring = (["state-working", "state-agents", "state-agents-3", "state-agents-4", "state-stopped", "state-done"] as const).map((name) => [name, STATE_STRIPS[name]] as const);
  const tile = "px-play-hover grid size-14 place-items-center rounded-lg text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-1">
        {MOTION_ICONS.map((n) => (
          <button key={n} type="button" aria-label={PIXEL_ICONS[n].label} className={tile}>
            <PixelIconNow name={n} scale={2} />
          </button>
        ))}
      </div>
      <div className="flex items-end gap-6 text-[11px] text-muted-foreground">
        {ring.map(([name, strip]) => (
          <span key={`${name}-${strip.play === "once" ? take : 0}`} className="flex flex-col items-center gap-2 text-foreground">
            <PixelStrip frames={strip.frames} fps={strip.fps} play={strip.play} scale={3} />
            <span className="text-muted-foreground">{PIXEL_ICONS[name].label.toLowerCase()}</span>
          </span>
        ))}
        <span className="flex flex-col items-center gap-2">
          <Rock size={32} working />
          <span>the Rock at work</span>
        </span>
        <span className="flex flex-col items-center gap-2 text-[hsl(var(--success))]">
          <span key={take} className="flex gap-2">
            <PixelAppear name="state-done" />
            <PixelAppear name="state-failed" />
            <PixelAppear name="state-needs-input" />
          </span>
          <span className="text-muted-foreground">a status lands</span>
        </span>
        <Button variant="secondary" size="sm" onClick={() => setTake((n) => n + 1)}>
          Land again
        </Button>
      </div>
    </div>
  );
}

// ---- Composer (lane ui-composer) ------------------------------------------
// Illustrative engines and plugins: the live composer reads engine.list,
// settings.get and plugin.list from the runtime.

const DEMO_ENGINES: PickerEngine[] = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"], default_effort: "high" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "opus-4.1", label: "Opus 4.1", efforts: ["low", "medium", "high"], legacy: true },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
      { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"] },
    ],
  },
  { id: "caveman", label: "Caveman", models: [{ id: "auto", label: "Auto", efforts: ["low", "medium", "high"], description: "Routes each turn to the cheapest model that can do it" }] },
];

const DEMO_ADD: AddSection[] = [
  {
    title: "Add",
    items: [
      { id: "files", icon: Attachment01Icon, label: "Files", description: "Attach files from your computer" },
      { id: "images", icon: Image01Icon, label: "Images", description: "Screenshots and pictures, or paste one" },
      { id: "goal", icon: Target02Icon, label: "Goal", description: "Set a goal to keep pursuing" },
      { id: "grill", icon: FireIcon, label: "Grill mode", description: "Answer its questions first, then build" },
      { id: "skill", icon: NoteAddIcon, label: "Record a skill", description: "Turn what you do next into a skill" },
    ],
  },
  {
    title: "Plugins and Spaces",
    items: [
      { id: "p1", icon: PuzzleIcon, label: "acme-backend", description: "Migration skill, Datadog and Linear MCP" },
      { id: "p2", icon: PuzzleIcon, label: "release-notes", description: "Draft release notes from merged PRs" },
    ],
  },
];

// The Chief's picker over what chief.get says is connected: an Anthropic key, a compact plan and a
// DeepSeek key on the Caveman engine, and a Claude plan through Claude Code.
const CHIEF_DEMO_ENGINES: PickerEngine[] = [
  {
    id: "caveman",
    label: "Caveman",
    models: [
      { id: "auto", label: "Auto", efforts: [], description: "The fast floor of what you connected" },
      { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
      { id: "chatgpt/openai/gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], description: "ChatGPT plan" },
      { id: "deepseek/deepseek-v4", label: "DeepSeek V4", efforts: [] },
    ],
  },
  {
    id: "claude-agent",
    label: "Claude Agent",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh"], default_effort: "high" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
    ],
  },
];
const CHIEF_DEMO_OPTIONS = [
  { engine: "caveman", models: ["auto", "anthropic/claude-sonnet-5-5", "chatgpt/openai/gpt-6-luna", "deepseek/deepseek-v4"] },
  { engine: "claude-agent", models: ["claude-opus-5-5", "claude-sonnet-5-5"], label: "Plan · via Claude Code", hint: "Claude models only. Counts against your Claude plan's limits." },
];

// Started a few minutes before the page opened, so the clock reads like a real one.
const DEMO_AGENTS = [{ id: "a1", title: "Build caveman-runtime agent exec", startedAt: new Date(Date.now() - 22 * 60_000).toISOString(), asking: false, activity: "Running pnpm test", activityAt: "" }];

function QueueSection() {
  const [items, setItems] = useState<QueueEntry[]>([
    { id: "q1", text: "Then run the runtime tests and fix whatever breaks" },
    { id: "q2", text: "Review finished: the migration drops the index before backfilling it.", sender: "From Review the migration" },
    { id: "q3", text: "So what can this actually do? Give me the short version" },
  ]);
  const queue = (list: ReadonlyArray<QueueEntry>, paused = false) => (
    <Queue
      items={list}
      onEdit={(id, text) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, text } : x)))}
      onRemove={(id) => setItems((xs) => xs.filter((x) => x.id !== id))}
      onMove={(id, before) =>
        setItems((xs) => {
          const moved = xs.find((x) => x.id === id)!;
          const rest = xs.filter((x) => x.id !== id);
          const at = before === null ? rest.length : rest.findIndex((x) => x.id === before);
          return [...rest.slice(0, at), moved, ...rest.slice(at)];
        })
      }
      {...(paused ? { onResume: () => undefined } : {})}
    />
  );
  const box = (text: string) => <div className="composer-card min-h-[72px] rounded-2xl px-3.5 pt-3 text-[14px] text-muted-foreground">{text}</div>;
  return (
    <Section
      id="queue"
      title="Queue"
      note="What waits behind the running turn sits on the box's top edge, in the same tray as the agents a chat waits on. Laid out like T3: a Queued header with the count folds the list away, and each row is a grip to drag, its words, edit and remove."
    >
      <div className="grid max-w-[720px] gap-8">
        <div>
          <ComposerTray queue={queue(items.slice(0, 1))} strip={<WaitingOn agents={DEMO_AGENTS} onOpen={() => undefined} />} />
          {box("Steer, or ⌥↵ to queue a follow-up…")}
        </div>
        <div>
          <ComposerTray queue={queue(items)} strip={<WaitingOn agents={DEMO_AGENTS} onOpen={() => undefined} />} />
          {box("Steer, or ⌥↵ to queue a follow-up…")}
        </div>
        <div>
          <ComposerTray queue={queue(items, true)} />
          {box("Ask for a change, / for commands, @ to add…")}
        </div>
      </div>
    </Section>
  );
}

function ChiefPickerSection() {
  const engines = chiefPickerEngines(CHIEF_DEMO_OPTIONS, CHIEF_DEMO_ENGINES);
  const [model, setModel] = useState<ModelRef | null>(chiefPickerValue(null, engines));
  const [favorites, setFavorites] = useState<string[]>([]);
  return (
    <Section
      id="chief-picker"
      title="The Chief's model picker"
      note="The composer's picker over what is connected. Auto on the fast floor by default; a pick pins the Chief to that account. A Claude plan runs through Claude Code: one quiet label, its tooltip says the rest."
    >
      <div className="relative mt-[380px] max-w-[560px] rounded-xl border border-input bg-card px-[11px] pb-2 pt-2.5">
        <div className="min-h-[66px] px-1 text-[14px] leading-[22px] text-muted-foreground">Tell the Chief what needs doing</div>
        <div className="mt-1.5 flex items-center gap-1">
          <span className="ml-auto" />
          <ModelPicker engines={engines} value={model} onChange={setModel} favorites={favorites} onFavoritesChange={setFavorites} className="max-w-[220px]" />
          <SendKey mode="idle" label="Send" ariaLabel="Send" onSend={() => undefined} onStop={() => undefined} />
        </div>
      </div>
    </Section>
  );
}

/** The places the foot's demo steps through: a Mac, Cloud over it, another Mac. */
const DEMO_PLACES: ReadonlyArray<Place> = [
  { id: "this_mac", name: "This Mac", icon: LaptopIcon, high: false },
  { id: "cloud", name: "Cloud", icon: CloudIcon, high: true },
  { id: "mac:studio", name: "Studio", icon: LaptopIcon, high: false },
];

function ComposerSection() {
  const [place, setPlace] = useState(0);
  const [model, setModel] = useState<ModelRef>({ engine: "claude-agent", model: "claude-opus-5-5" });
  const [favorites, setFavorites] = useState<string[]>(["claude-agent/opus", "codex/gpt-6.1-sol"]);
  const [effort, setEffort] = useState<string | undefined>("high");
  const [access, setAccess] = useState<AccessMode>("full");
  const [menuActive, setMenuActive] = useState(0);
  const current = findModel(DEMO_ENGINES, model);
  const levels = current?.model.efforts ?? [];
  const level = pickEffort(levels, effort, current?.model.default_effort);
  return (
    <Section
      id="composer"
      title="Composer"
      note="The bottom bar: + (or @), the chat's settings (its permissions), then the model and its effort on the right, the mic and Send. Under the box, its foot: where the chat is, and the computer it runs on, which opens the places it can move to. Click the computer here to watch a place swap. Pickers open upward; everything works from the keyboard."
    >
      <div>
        <div className="relative mt-[310px]">
          <ComposerAddMenu id="style-add" rows={filterAddMenu(DEMO_ADD, "")} active={menuActive} query="" onHover={setMenuActive} onPick={setMenuActive} search="Files, plugins, chats and more" />
          <div className="rounded-xl border border-input bg-card px-[11px] pb-2 pt-2.5">
            <div className="min-h-[66px] px-1 text-[14px] leading-[22px] text-foreground">@</div>
            <div className="mt-1.5 flex items-center gap-1">
              <span className="grid size-7 place-items-center rounded-[8px] bg-background text-foreground ring-1 ring-border" aria-hidden>
                <HugeIcon icon={Add01Icon} className="size-4 rotate-45" />
              </span>
              <ChatSettings>
                <AccessSetting modes={undefined} value={access} onChange={setAccess} />
              </ChatSettings>
              <span className="ml-auto" />
              <ModelPicker
                engines={DEMO_ENGINES}
                value={model}
                onChange={setModel}
                favorites={favorites}
                onFavoritesChange={setFavorites}
                effort={level}
                onEffortChange={setEffort}
                defaultModel={{ engine: "claude-agent", model: "claude-opus-5-5" }}
                // Settings > Agents' pins: Sonnet reviews and writes tests, Sol builds.
                roles={[
                  { model: { engine: "codex", model: "gpt-6.1-sol" }, label: "Implementation" },
                  { model: { engine: "claude-agent", model: "claude-sonnet-5-5" }, label: "Review" },
                  { model: { engine: "claude-agent", model: "claude-sonnet-5-5" }, label: "Tests" },
                ]}
              />
              <SendKey mode="send" label="Send" ariaLabel="Send" onSend={() => undefined} onStop={() => undefined} />
            </div>
          </div>
          {/* The foot: the chat's repository and branch as facts, then its computer. Here a click goes to the next place. */}
          <div className="flex min-w-0 items-center gap-x-1 pl-[10px] pr-1.5 pt-1.5">
            <FootLabel mark={<ProjectBadge github />}>handbook</FootLabel>
            <FootLabel icon={GitBranchIcon}>caveman/tidy-setup-page</FootLabel>
            <PlaceChip place={DEMO_PLACES[place]!} aria-label={`Runs on ${DEMO_PLACES[place]!.name}. Next place`} className="shrink-0" onClick={() => setPlace((i) => (i + 1) % DEMO_PLACES.length)} />
          </div>
        </div>
      </div>
      <ComposerKeys />
      <ul className="mt-6 grid grid-cols-2 gap-x-8 gap-y-1 text-[13px]">
        {(
          [
            ["@ or +", "the Add menu: type to filter, arrows, Enter or Tab, Esc"],
            ["⌘1 to ⌘9", "pick a favorite model while the picker is open (elsewhere they go to the tabs)"],
            ["Enter", "send; while it works, steer it now"],
            ["⌥Enter", "queue a follow-up for after this turn"],
            ["In the picker", "type to search every harness, ↑/↓, Enter, Esc"],
            ["Effort", "the slider at the foot of the picker: drag, click a stop, or ←/→ from the search"],
          ] as const
        ).map(([keys, what]) => (
          <li key={keys} className="flex h-7 items-center gap-2">
            <span className="shrink-0 text-foreground">{keys}</span>
            <span className="truncate text-muted-foreground">{what}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The composer's keys in every state, and a box to type in and run, to feel the morph. */
function ComposerKeys() {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const canSend = text.trim() !== "";
  const keys = (mode: SendKeyMode, label: string, opts: { stop?: boolean; mic?: DictationPhase } = {}) => (
    <div className="flex items-center">
      <MicButton phase={opts.mic ?? "idle"} shortcut="mod+shift+d" onToggle={() => undefined} />
      {opts.stop ? <StopKey onStop={() => undefined} /> : null}
      <SendKey mode={mode} label={label} ariaLabel={label} onSend={() => undefined} onStop={() => undefined} />
    </div>
  );
  return (
    <div className="mt-8">
      <div className="grid grid-cols-5 gap-4 text-[12px] text-muted-foreground">
        {(
          [
            ["Nothing to send", keys("idle", "Send")],
            ["Something to send", keys("send", "Send")],
            ["Working, box empty", keys("stop", "Steer")],
            ["Typing while it works", keys("send", "Steer", { stop: true })],
            ["Talking to type", keys("send", "Send", { mic: "starting" })],
          ] as const
        ).map(([what, row]) => (
          <div key={what} className="flex flex-col items-start gap-2 rounded-xl border border-input bg-card p-3">
            {row}
            <span>{what}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-input bg-card px-[11px] pb-2 pt-2.5">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={running ? "Steer it, or Stop" : "Type to feel Send morph"} className="w-full bg-transparent px-1 text-[14px] leading-[22px] text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))]" />
        <div className="mt-1.5 flex items-center gap-1">
          <button type="button" onClick={() => setRunning((r) => !r)} className="h-7 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
            {running ? "Finish the turn" : "Start a turn"}
          </button>
          <span className="ml-auto" />
          <MicButton phase={phase} shortcut="mod+shift+d" onToggle={() => setPhase((p) => (p === "idle" ? "starting" : "idle"))} />
          {running && canSend ? <StopKey onStop={() => setRunning(false)} /> : null}
          <SendKey mode={canSend ? "send" : running ? "stop" : "idle"} label={running ? "Steer" : "Send"} ariaLabel={running ? "Steer" : "Send"} onSend={() => setText("")} onStop={() => setRunning(false)} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Split view (lane ui-split)

const noop = () => undefined;

function SplitViewSection() {
  return (
    <Section id="split-view" title="Split view" note="Each pane is a whole session: header (title menu and drag handle, side panel views, more, close) and its own side panel, Overview cards first. Drag a chat from the sidebar onto a pane: the half it will fill wears the blue outline over blurred content.">
      <div className="flex flex-col gap-8">
        <Demo label="PaneHeader (focused)">
          <div className="w-[640px] rounded-xl border border-border bg-background">
            <PaneHeader
              workspaceId="style-guide"
              title="Fix webhook retry storm"
              status={{ label: "Running", dot: "bg-success" }}
              focused
              canSplit
              pinned={false}
              archived={false}
              onSplit={noop}
              onClose={noop}
              onTogglePin={noop}
              onRename={noop}
              onFork={noop}
              onArchive={noop}
              onRestore={noop}
              onRun={noop}
              onDragStart={noop}
            />
          </div>
        </Demo>
        <Demo label="PaneHeader (a delegated agent: its lead before the title)">
          <div className="w-[640px] rounded-xl border border-border bg-background">
            <PaneHeader
              workspaceId="style-guide-child"
              title="Find every caller of retry.Schedule"
              status={{ label: "Running", dot: "bg-success" }}
              focused
              canSplit
              pinned={false}
              archived={false}
              lead={{ title: "Fix webhook retry storm", open: noop }}
              onTogglePin={noop}
              onRename={noop}
              onArchive={noop}
              onRestore={noop}
              onRun={noop}
              onDragStart={noop}
            />
          </div>
        </Demo>
        <Demo label="Mid-drag: the bottom half of a pane will take the chat">
          <div className="relative h-[300px] w-[560px] overflow-hidden rounded-xl border border-border bg-background p-5">
            <p className="text-[14px] text-foreground">Tests pass. Checking the retries actually spread out under load.</p>
            <p className="mt-3 text-[14px] text-muted-foreground">Replace minute-rounding with full jitter on a 30s base, capped at 6h. Add a breaker keyed by endpoint id.</p>
            <p className="mt-3 text-[14px] text-muted-foreground">Record breaker state in the existing webhook_delivery metrics.</p>
            <p className="mt-3 text-[14px] text-foreground">The load script ran with 400 endpoints: p99 sender queue 0.8s, was 61s.</p>
            <p className="mt-3 text-[14px] text-muted-foreground">Updating the schedule table in docs/webhooks.md so it matches the new ranges.</p>
            <div className="mt-3 h-12 rounded-xl border border-border bg-card" />
            <div className="pane-zone absolute inset-x-1 bottom-1 top-[50%] rounded-xl border-2 border-target">
              <span className="absolute inset-x-0 top-4 mx-auto w-fit rounded-md bg-popover px-2.5 py-1 text-[13px] text-foreground shadow-overlay">Open in split view</span>
            </div>
            <div className="absolute left-[150px] top-[212px] flex flex-col items-start gap-2">
              <span className="rounded-full bg-target px-2.5 py-[3px] text-[12px] font-medium text-target-foreground shadow-overlay">Split view</span>
              <div className="w-[240px] origin-top-left scale-95 rounded-xl border border-border bg-popover px-3 py-2.5 shadow-overlay">
                <div className="truncate text-[13px] font-medium text-foreground">Idempotency keys on /send</div>
                <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">api-gateway · caveman/idem</div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">Claude Agent · This Mac</div>
              </div>
            </div>
          </div>
        </Demo>
        <ul className="space-y-1 text-[13px]">
          {[
            ["⌘D", "Split right (an empty pane: a new chat, or one to open)"],
            ["⌘⇧D", "Split down"],
            ["⌥⌘] / ⌥⌘[", "Focus the next / previous pane"],
            ["⌥⌘W", "Close the focused pane"],
            ["Esc", "Cancel a drag"],
          ].map(([keys, what]) => (
            <li key={keys} className="flex h-7 items-center gap-2">
              <Keycap>{keys}</Keycap>
              <span className="text-muted-foreground">{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function MarkdownAndCode() {
  const [wrap, setWrap] = useState(false);
  const [reveal, setReveal] = useState<number | undefined>(undefined);
  const [big, setBig] = useState(false);
  const code = useMemo(() => (big ? bigFile() : SAMPLE_CODE), [big]);
  const button = "h-7 rounded-md border border-border px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 ease-snap hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="space-y-6">
      {/* The reader as the side panel draws it: front matter, the outline rail (hover it), a diagram, alerts, code. */}
      <div className="flex h-[640px] overflow-hidden rounded-xl border border-border bg-background">
        <MarkdownDocument source={SAMPLE_MD} />
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex h-9 items-center gap-2 border-b border-border px-3">
          <span className="font-mono text-[12.5px] text-foreground">packages/runtime/src/eventLog.ts</span>
          <span className="text-[12px] tabular-nums text-muted-foreground">{big ? "30,000" : SAMPLE_CODE_LINES} lines</span>
          <span className="flex-1" />
          <button type="button" className={button} aria-pressed={big} onClick={() => setBig(!big)}>
            {big ? "300 lines" : "30,000 lines"}
          </button>
          <button type="button" className={button} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            {wrap ? "Wrap on" : "Wrap off"}
          </button>
          {[42, 201, 288].map((n) => (
            <button key={n} type="button" className={button} onClick={() => setReveal(n)}>
              Line {n}
            </button>
          ))}
        </div>
        <CodeView code={code} path="packages/runtime/src/eventLog.ts" wrap={wrap} revealLine={reveal} highlightLines={MARKED_LINES} className="h-[420px]" />
      </div>
    </div>
  );
}

const MARKED_LINES = [12, 13];

const SAMPLE_MD = `---
title: Session protocol v1
status: draft
owners:
  - runtime
  - web
---

# Session protocol v1

The runtime speaks **one protocol** to every client. Messages are JSON lines, and each carries a \`seq\` so a client that reconnects can [resume where it left off](#resume). The shape follows [T3 Code](https://github.com/pingdotgg/t3code), then goes further where we need it.

> [!NOTE]
> Tenant scope comes from verified auth, never from the payload.

## Resume

1. Open the socket with the last \`seq\` you saw.
2. The runtime replays everything after it, from the event log.
3. Live events follow, in order, on the same socket.

\`\`\`mermaid
sequenceDiagram
  participant C as Client
  participant R as Runtime
  C->>R: open(seq = 41)
  R-->>C: replay 42 to 57 from the log
  R-->>C: live events, in order
\`\`\`

Terminals outlive their clients:

- \`term.list\` lists the ones still running
- \`term.attach\` re-attaches, with scrollback
  - the runtime keeps the last 10,000 lines
  - older output is on disk, under the workspace
- Spend never appears inside a session; it lives in Settings.

### Checklist

- [x] Event log and projections
- [x] Hidden-ref checkpoints
- [ ] MCP endpoint
- [ ] Plugins with no ambient secrets

## Methods

The contract lives in \`packages/session-protocol/src/protocol.ts:1449\`.

| Method | Direction | Since | Notes |
|---|---|---:|---|
| \`fs.list\` | client → runtime | 1.0 | One directory, for the Files tree |
| \`fs.search\` | client → runtime | 1.1 | Streamed matches, capped at 2,000 |
| \`term.attach\` | client → runtime | 1.1 | Re-attach a terminal that outlived its client |
| \`turn.completed\` | runtime → client | 1.0 | Carries usage, which the session never shows |

> [!TIP]
> Batch \`fs.list\` calls when a user expands several folders at once.

> [!IMPORTANT]
> Engines get a structured transcript. A terminal is never an engine's UI.

> [!WARNING]
> A resume older than the log's retention starts a fresh projection.

> [!CAUTION]
> Never read, store or forward the Claude Agent's credentials.

## Code

A projection folds events into state:

\`\`\`ts
import type { RuntimeEvent } from "@caveman-app/session-protocol";

export interface Workspace {
  readonly id: string;
  readonly seq: number;
  readonly status: "idle" | "working" | "needs-input";
}

/** Fold one event; unknown events leave the state alone. */
export function fold(state: Workspace, event: RuntimeEvent): Workspace {
  switch (event.type) {
    case "turn.started":
      return { ...state, seq: event.seq, status: "working" };
    case "turn.completed":
      return { ...state, seq: event.seq, status: "idle" };
    default:
      return state;
  }
}
\`\`\`

The relay is Go:

\`\`\`go
package relay

import (
	"context"
	"time"
)

// Forward copies frames until the context ends or the peer goes quiet.
func Forward(ctx context.Context, in <-chan Frame, out chan<- Frame) error {
	idle := time.NewTimer(30 * time.Second)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case f := <-in:
			out <- f
			idle.Reset(30 * time.Second)
		case <-idle.C:
			return ErrIdle
		}
	}
}
\`\`\`

\`\`\`sh
pnpm --filter @caveman-app/web build
\`\`\`

> A plain quote stays grey: quieter than the text around it.

---

Read more in ~~the wiki~~ \`README.md\`.
`;

const SAMPLE_CODE_LINES = 300;
const SAMPLE_CODE = (() => {
  const lines = [
    "// Event log: append-only, one file per workspace; projections are rebuilt on boot.",
    'import { Effect, Schema } from "effect";',
    'import type { RuntimeEvent } from "@caveman-app/session-protocol";',
    "",
    "const RETENTION_DAYS = 30;",
    "",
  ];
  for (let i = 0; lines.length < SAMPLE_CODE_LINES; i++) {
    lines.push(
      `export interface Projection${i} {`,
      "  readonly id: string;",
      `  readonly seq: number; // folds ${i * 7 + 3} event kinds`,
      "}",
      "",
      `export function fold${i}(state: Projection${i}, event: RuntimeEvent): Projection${i} {`,
      '  if (event.type !== "turn.completed") return state;',
      i === 2
        ? '  const reason = `projection ${state.id} skipped ${event.seq - state.seq} events because the log was compacted while the client was offline, so it resumes from the newest checkpoint instead`;'
        : `  return { ...state, seq: state.seq + ${i + 1} };`,
      "}",
      "",
    );
    // A block comment across the chunk boundary at line 200: the next chunk inherits the grammar state.
    if (lines.length === 196) lines.push("/*", " * Compaction: this comment starts in the first chunk", " * and ends in the second, so the tokenizer has to", " * carry its state across line 200.", " */", "");
  }
  return lines.slice(0, SAMPLE_CODE_LINES).join("\n");
})();

// The stress case: ~1 MB, 30,000 lines.
function bigFile(): string {
  const lines: string[] = [];
  for (let i = 0; lines.length < 30_000; i++) {
    lines.push(`export function handler${i}(req: Request, res: Response): void {`, `  const id = req.params.id ?? "missing"; // request ${i}`, `  res.status(200).json({ id, at: Date.now(), n: ${i} });`, "}", "");
  }
  return lines.slice(0, 30_000).join("\n");
}
