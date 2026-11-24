import { SearchField } from "@caveman-app/ui/components/input";
import { NavButton } from "@caveman-app/ui/icons/NavButton";
import { Icon, ArrowLeft02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams } from "react-router";
import { AccountSettings } from "./settings/Account.tsx";
import { PlanSettings } from "./settings/Plan.tsx";
import { AgentsSettings } from "./settings/Agents.tsx";
import { AppearanceSettings } from "./settings/Appearance.tsx";
import { ArchivedSettings } from "./settings/Archived.tsx";
import { ReportsSettings } from "./settings/Reports.tsx";
import { CavemanMcpSettings } from "./settings/CavemanMcp.tsx";
import { ChiefSettings } from "./settings/Chief.tsx";
import { ReviewSettings } from "./settings/Review.tsx";
import { ComputersSettings } from "./settings/Computers.tsx";
import { ComputerUseSettings } from "./settings/ComputerUse.tsx";
import { EnvironmentsSettings } from "./settings/Environments.tsx";
import { GeneralSettings } from "./settings/General.tsx";
import { KeyboardSettings } from "./settings/Keyboard.tsx";
import { MemorySettings } from "./settings/Memory.tsx";
import { ModelsAndKeysSettings } from "./settings/ModelsAndKeys.tsx";
import { ProjectsSettings } from "./settings/Projects.tsx";
import { SecretProvidersSettings } from "./settings/SecretProviders.tsx";
import { UsageSettings } from "./settings/Usage.tsx";
import { ImportSettings } from "./plugins/Import.tsx";
import { DeviceSettings } from "../components/Devices.tsx";
import { RemoteControlSettings } from "../components/RemoteControl.tsx";
import { SaveFailure, SettingsPage } from "./settings/rows.tsx";
import { holdsHere, SETTINGS_SECTIONS, settingsGroups, settingsHome, settingsRedirect, type SettingsSection, type SettingsSectionId, type WebHome } from "./settings/sections.ts";
import { credentialsOutside } from "../state/engines.ts";
import { useRuntimeSelector, useWebWindow } from "../state/runtime.tsx";
import { PanelTitleBar, TitleBar } from "../shell/TitleBar.tsx";
import { isComposing } from "../panels/chrome.tsx";
import { windowTabs } from "../panes/store.ts";
import { usePhone } from "../lib/screen.ts";

interface Section extends SettingsSection {
  readonly Body: ComponentType;
}

/** One file per section under ./settings/; its words live in ./settings/sections.ts, so ⌘K finds it without this file. */
const BODIES: Readonly<Record<SettingsSectionId, ComponentType>> = {
  general: GeneralSettings,
  appearance: AppearanceSettings,
  keyboard: KeyboardSettings,
  "computer-use": ComputerUseSettings,
  reports: ReportsSettings,
  account: AccountSettings,
  plan: PlanSettings,
  usage: UsageSettings,
  models: ModelsAndKeysSettings,
  "secret-providers": SecretProvidersSettings,
  chief: ChiefSettings,
  agents: AgentsSettings,
  memory: MemorySettings,
  "caveman-mcp": CavemanMcpSettings,
  import: ImportSettings,
  projects: ProjectsSettings,
  review: ReviewSettings,
  archived: ArchivedSettings,
  computers: ComputersSettings,
  devices: DevicesSettings,
  environments: EnvironmentsSettings,
};

/** Settings > Devices: reaching this computer through Caveman, and the devices allowed to. */
function DevicesSettings() {
  return (
    <>
      <RemoteControlSettings />
      <DeviceSettings />
    </>
  );
}

export const SETTINGS_GROUPS: ReadonlyArray<{ label: string; sections: ReadonlyArray<Section> }> = SETTINGS_SECTIONS.map((g) => ({
  label: g.label,
  sections: (g.sections as ReadonlyArray<SettingsSection & { id: SettingsSectionId }>).map((section) => ({ ...section, Body: BODIES[section.id] })),
}));

const SECTIONS = SETTINGS_GROUPS.flatMap((g) => g.sections);

export function SettingsRoute() {
  const { section } = useParams();
  // A phone shows one thing at a time: the list of sections first (`/settings`), then the one picked, with the way
  // back. A wider window opens on General, the list beside it.
  const phone = usePhone();
  // A window on a Cloud computer that keeps nothing of its person's: a setting changed here goes no further.
  const outside = credentialsOutside(useRuntimeSelector((v) => v.engines));
  // A browser window opens on a page Cloud alone answers, and lists a computer's pages only while it uses one.
  const home = useWebWindow()?.home;
  if (!section && !phone) return <Navigate to={settingsHome(home)} replace />;
  // An old section id lands where it moved; one that never was, or that this window has no computer for, lands
  // where Settings opens, with the address to match.
  const moved = section ? settingsRedirect(section, home) : null;
  if (moved) return <Navigate to={moved} replace />;
  const current = section ? SECTIONS.find((s) => s.id === section)! : null;
  const note = current ? holdsHere(current.id, outside) : null;
  return (
    <div className="window-shell dashboard-scope flex h-full bg-sidebar text-foreground max-md:bg-background">
      <aside data-focus-area="settings-sections" aria-label="Settings sections" className={cn("flex w-[248px] shrink-0 flex-col overflow-y-auto px-3 pb-3 text-sidebar-foreground max-md:w-full max-md:px-4", current && "max-md:hidden")}>
        <TitleBar className="-mx-3" />
        {/* The sidebar's own title is the way out: the arrow, then where you are. */}
        <NavLink
          to={windowTabs.frontPath()}
          aria-label="Back to app"
          title="Back to app"
          className="group mt-2 flex h-9 items-center gap-2 rounded-lg px-2 text-[14px] font-medium text-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:h-11 max-md:text-[16px]"
        >
          <Icon icon={ArrowLeft02Icon} className="size-4 text-muted-foreground transition-colors duration-75 group-hover:text-foreground" /> Settings
        </NavLink>
        <SettingsNav home={home} />
      </aside>
      {current ? (
        <main data-focus-area="settings-section" className="panel-frame relative flex min-w-0 flex-1 flex-col pb-2 pr-2 pt-2 max-md:p-0">
          <PanelTitleBar />
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)] max-md:rounded-none max-md:border-0 max-md:shadow-none">
            {/* A phone's bar: the way back to the list, and the section's name (wider windows show it over the page). */}
            <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-4 text-[15px] md:hidden">
              <Link to="/settings" aria-label="All settings" className="-ml-2 grid size-10 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent">
                <Icon icon={ArrowLeft02Icon} className="size-[18px]" />
              </Link>
              <h1 aria-live="polite" className="font-medium">
                {current.label}
              </h1>
            </header>
            <SaveFailure />
            <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-9 max-md:px-4 max-md:pt-5">
              <SettingsPage title={current.label} note={note} wide={current.wide === true}>
                <current.Body />
              </SettingsPage>
            </div>
          </div>
        </main>
      ) : null}
    </div>
  );
}

/** The sections, grouped, under a filter: "/" focuses it, Enter opens the first match, Escape clears it. */
export function SettingsNav({ home }: { home?: WebHome | undefined }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, button, [contenteditable="true"], [role="dialog"], [role="listbox"], [role="menu"]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const needle = query.trim().toLowerCase();
  const groups = settingsGroups(home).map((g) => ({
    ...g,
    sections: g.sections.filter((s) => !needle || `${s.label} ${s.description} ${s.keywords ?? ""}`.toLowerCase().includes(needle)),
  })).filter((g) => g.sections.length > 0);
  const first = groups[0]?.sections[0];
  return (
    <>
      <div className="relative mt-1.5">
        <SearchField
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
 // An input method's Enter picks its candidate and its Escape cancels the composition (upstream #28298).
            if (isComposing(e)) return;
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
            if (e.key === "Enter" && first) {
              navigate(`/settings/${first.id}`);
              setQuery("");
            }
          }}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="pr-8"
        />
        {query ? null : (
          <kbd aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 grid h-[18px] min-w-[18px] -translate-y-1/2 place-items-center rounded bg-secondary font-sans text-[11px] text-muted-foreground touch:hidden">
            /
          </kbd>
        )}
      </div>
      {groups.map((g) => (
        <nav key={g.label} aria-label={g.label || "App"} className={g.label ? "mt-5" : "mt-3"}>
          {/* The app's own basics lead with no heading; every other group names itself in the section-header grey. */}
          {g.label ? <div className="px-2 pb-1.5 text-[12px] text-[hsl(var(--subtle-foreground))]">{g.label}</div> : null}
          {g.sections.map(({ id, label, icon }) => (
            // Taller and brighter than the app sidebar's rows: this list is read, top to bottom, every visit.
            <NavButton key={id} asChild icon={icon} className="mb-0.5 h-8 gap-2.5 text-foreground/80 max-md:h-11 max-md:text-[15px]">
              <NavLink to={`/settings/${id}`} onClick={() => setQuery("")}>
                {label}
              </NavLink>
            </NavButton>
          ))}
        </nav>
      ))}
      {groups.length === 0 ? <p className="mt-5 px-2 text-[13px]">No setting matches “{query.trim()}”</p> : null}
    </>
  );
}
