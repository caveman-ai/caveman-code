// What the Plugins pages are about: everywhere (what every project gets), or one project (what its chats get, each
// switch the project's own). One choice for the whole page, kept across visits; every plugin call reads it (shared.tsx
// useHere, useSwitchHere), so the list, an install, a switch and a page opened from the list all mean the same place.
import { Button } from "@caveman-app/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Glyph } from "@caveman-app/ui/icons/Glyph";
import { Icon, ArrowDown01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import type { Project } from "@caveman-app/session-protocol";
import { useSyncExternalStore } from "react";
import { useRuntimeSelector } from "../../state/runtime.tsx";

const KEY = "plugins.scope";
const listeners = new Set<() => void>();
let chosen: string | null = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);

/** Picks a project by id, or everywhere (null). */
export function chooseScope(projectId: string | null) {
  chosen = projectId;
  if (projectId === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, projectId);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** The project picked, or undefined for everywhere (also when the one picked is gone). */
export function useScopeProject(): Project | undefined {
  const id = useSyncExternalStore(subscribe, () => chosen);
  const projects = useRuntimeSelector((v) => v.projects);
  return id === null ? undefined : projects.find((p) => p.id === id);
}

/** "Everywhere ▾", or the project's name: the one control that says what the page, and each switch on it, is about. */
export function ScopePicker() {
  const projects = useRuntimeSelector((v) => v.projects);
  const project = useScopeProject();
  if (projects.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="min-w-0 max-w-[220px]"
          aria-label={
            project ? `Showing what ${project.name} gets` : "Showing what every project gets"
          }
        >
          {project ? <Glyph name="folder" /> : null}
          <span className="truncate">{project ? project.name : "Everywhere"}</span>
          <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <Choice
          label="Everywhere"
          picked={project === undefined}
          onSelect={() => chooseScope(null)}
        />
        <DropdownMenuSeparator />
        {projects.map((p) => (
          <Choice
            key={p.id}
            label={p.name}
            folder
            picked={project?.id === p.id}
            onSelect={() => chooseScope(p.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Choice({
  label,
  folder,
  picked,
  onSelect,
}: {
  label: string;
  folder?: boolean;
  picked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      {folder ? <Glyph name="folder" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {picked ? (
        <Icon icon={Tick02Icon} className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
    </DropdownMenuItem>
  );
}
