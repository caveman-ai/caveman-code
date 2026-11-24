import { BrandMark } from "@caveman-app/ui/icons/brand";
import { cn } from "@caveman-app/ui/lib/cn";
import type { ProjectView } from "../state/model.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";
import { FolderGlyph } from "@caveman-app/ui/icons/Glyph";

/** One of a Chief's projects as it reads: its name, and whether it lives on GitHub (owner/name in its tooltip). */
export interface ChiefRepo {
  readonly id: string;
  readonly name: string;
  readonly github: boolean;
  /** owner/name on its host, else the folder on this computer. */
  readonly detail: string | null;
}

const repoOf = (p: ProjectView): ChiefRepo => ({ id: p.id, name: p.name, github: p.repository?.host === "github.com", detail: p.repository?.full_name ?? p.path });

/** A Chief's projects in sidebar order; null: it works in every project (none named). Ids of removed projects drop out. */
export function useChiefRepos(ids: ReadonlyArray<string> | undefined): ReadonlyArray<ChiefRepo> | null {
  const projects = useRuntimeSelector((v) => v.projects);
  if (!ids || ids.length === 0) return null;
  return projects.filter((p) => ids.includes(p.id)).map(repoOf);
}

/** A repo's mark: GitHub's when it lives there, else a folder. */
export function RepoMark({ repo, size }: { repo: Pick<ChiefRepo, "github">; size: number }) {
  return repo.github ? <BrandMark name="github" size={size} className="shrink-0 opacity-80" /> : <FolderGlyph open={false} className="shrink-0" />;
}

/**
 * The repos a Chief works in, as chips beside its name (upstream header chips): each its GitHub mark or folder and
 * name; past `max`, a count. Every project reads as one quiet chip. A click opens its settings at Projects.
 */
export function RepoChips({ repos, max = 3, onOpen }: { repos: ReadonlyArray<ChiefRepo> | null; max?: number; onOpen: () => void }) {
  const chip =
    "inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:border-border hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  if (repos === null)
    return (
      <button type="button" onClick={onOpen} title="It works in every project. Click to keep it to a few." className={chip}>
        <FolderGlyph open className="shrink-0" />
        All projects
      </button>
    );
  if (repos.length === 0)
    return (
      <button type="button" onClick={onOpen} title="Its projects were removed: it can't start chats until it has one." className={cn(chip, "border-warning/40 text-warning hover:text-warning")}>
        <FolderGlyph open={false} className="shrink-0" />
        No projects
      </button>
    );
  const shown = repos.slice(0, max);
  const rest = repos.length - shown.length;
  return (
    <>
    {/* A narrow header (styles.css .chief-head) shows one chip that counts them instead of chips too thin to read. */}
    {repos.length > 1 ? (
      <button type="button" onClick={onOpen} title={repos.map((r) => r.detail ?? r.name).join("\n")} className={cn(chip, "chief-chips-short")}>
        <RepoMark repo={repos[0]!} size={12} />
        {repos.length} projects
      </button>
    ) : null}
    <span role="list" aria-label="Its projects" className={cn("flex min-w-0 shrink items-center gap-1.5", repos.length > 1 && "chief-chips-full")}>
      {shown.map((repo) => (
        // Names give way first (down to the mark), so the count after them always shows.
        <button key={repo.id} role="listitem" type="button" onClick={onOpen} title={repo.detail ?? repo.name} className={cn(chip, "min-w-[30px] shrink")}>
          <RepoMark repo={repo} size={12} />
          <span className="truncate">{repo.name}</span>
        </button>
      ))}
      {rest > 0 ? (
        <button type="button" onClick={onOpen} title={repos.slice(max).map((r) => r.name).join(", ")} className={cn(chip, "px-1.5 tabular-nums")}>
          +{rest}
        </button>
      ) : null}
    </span>
    </>
  );
}
