// The notes list's grouping and labels, kept out of the component so they are tested.
import type { MemoryNote } from "@caveman-app/session-protocol";

export type ScopeFilter = "all" | "me" | "project";

/** A repository's memory id as people read it: `github.com/acme/web`, or a local repo by its first commit. */
export const repoLabel = (repo: string | null) => (repo === null ? "This project" : repo.startsWith("local/") ? `Local repository ${repo.slice(6, 13)}` : repo);

/** What each authority means to the person reading the panel. */
export const AUTHORITY: Record<MemoryNote["authority"], { label: string; hint: string }> = {
  told: { label: "Told", hint: "Your words: Claude Agent, Codex and the Caveman engine follow it." },
  team: { label: "Team", hint: "Reviewed by your team." },
  learned: { label: "Learned", hint: "Kept from past chats by an earlier version of memory. It loads in chats only if you pin it." },
  draft: { label: "Draft", hint: "Saved by an agent on its own. It loads in chats only if you pin it or edit it." },
};

/** Notes for you first, then each repository's, newest first inside each. */
export function groupNotes(notes: ReadonlyArray<MemoryNote>, scope: ScopeFilter): Array<{ key: string; title: string; notes: MemoryNote[] }> {
  const kept = notes.filter((n) => scope === "all" || n.scope === scope);
  const groups = new Map<string, { key: string; title: string; notes: MemoryNote[] }>();
  for (const note of kept) {
    const key = note.scope === "me" ? "me" : `repo:${note.repo ?? ""}`;
    const title = note.scope === "me" ? "Me, in every repository" : repoLabel(note.repo);
    const group = groups.get(key) ?? { key, title, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return [...groups.values()].sort((a, b) => (a.key === "me" ? -1 : b.key === "me" ? 1 : a.title.localeCompare(b.title)));
}
