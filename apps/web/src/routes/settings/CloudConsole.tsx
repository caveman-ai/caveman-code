import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { Icon, LinkSquare02Icon } from "@caveman-app/ui/icons/huge";
import { CONSOLE, consoleHost, consoleUrl } from "../automations/cloud.ts";
import { SettingsCard } from "./rows.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** The console pages for running agents on their own, in the order a team sets them up. */
export const CONSOLE_PAGES: ReadonlyArray<{ readonly id: string; readonly icon: PixelIconName; readonly label: string; readonly description: string; readonly path: string }> = [
  {
    id: "service-accounts",
    icon: "secret",
    label: "Service accounts and keys",
    description: "Who unattended runs act as, and their keys",
    path: CONSOLE.serviceAccounts,
  },
  {
    id: "policy",
    icon: "settings",
    label: "Code policy",
    description: "The engines, models and budgets your org allows",
    path: CONSOLE.policy,
  },
  {
    id: "board",
    icon: "automations",
    label: "Automations board",
    description: "Runs, merged pull requests and what they cost",
    path: CONSOLE.board,
  },
  {
    id: "agents",
    icon: "tool-subagent",
    label: "Agents",
    description: "Published agents and the sessions they ran",
    path: CONSOLE.agents,
  },
];

/**
 * Settings > Account > Caveman Platform: links to the Platform's pages where a team runs agents on their own. Each
 * opens in the browser; what unattended runs cost is on the board there, never in a chat.
 */
export function CloudConsoleView({ base }: { base: string }) {
  return (
    <>
      {/* Where the links go, said once: a company's own Cloud is not caveman.so. */}
      <SettingsCard title="Caveman Platform" actions={<span className="text-[12.5px] text-[hsl(var(--subtle-foreground))]">{consoleHost(base)}</span>}>
        {CONSOLE_PAGES.map((p) => (
          <a
            key={p.id}
            href={consoleUrl(base, p.path)}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-14 items-center gap-3 px-5 py-3 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
          >
            <span className="flex size-7 shrink-0 items-center justify-center">
              <Glyph name={p.icon} className="text-muted-foreground" />
            </span>
            <span className="min-w-[12rem] flex-1">
              <span className="block text-[13px]">{p.label}</span>
              <span className="mt-0.5 block text-[12.5px] leading-[18px] text-muted-foreground">{p.description}</span>
            </span>
            <Icon icon={LinkSquare02Icon} className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </a>
        ))}
      </SettingsCard>
    </>
  );
}
