import { Button } from "@caveman-app/ui/components/button";
import { SearchField } from "@caveman-app/ui/components/input";
import { useState } from "react";
import { Link } from "react-router";
import { useArchivedChats } from "../../state/archived.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { archivedGroups, archivedWhen } from "./archived-model.ts";
import { CONTROL, SettingRow, SettingsCard } from "./rows.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings > Work > Archived chats: every archived chat by project, each with Restore (its uncommitted work comes back too). */
export function ArchivedSettings() {
  const projects = useRuntimeSelector((v) => v.projects);
  const { chats: archived, error, reload: load, restore: restoreChat } = useArchivedChats();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ id: string; title: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const restore = async (id: string, title: string) => {
    setBusy(id);
    setRowError(null);
    try {
      await restoreChat(id);
      setRestored({ id, title });
    } catch (e) {
      setRowError({ id, message: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const groups = archived ? archivedGroups(archived, projects, query) : [];
  const total = archived?.length ?? 0;
  // What the list says about itself (a restore, an error, loading, empty), in a card only when there is something to say.
  const status =
    restored || error || archived === null || groups.length === 0 ? (
      <>
        {restored ? (
          <SettingRow label={`Restored “${restored.title}”`} description="It's back in the sidebar.">
            <Button asChild variant="secondary">
              <Link to={`/w/${restored.id}`}>Open</Link>
            </Button>
          </SettingRow>
        ) : null}
        {error ? (
          <SettingRow label="Couldn't load archived chats" description={<span className="text-destructive">{error}</span>}>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </SettingRow>
        ) : archived === null ? (
          <SettingRow label="Loading…" />
        ) : total === 0 ? (
          <SettingRow label="No archived chats" description="Archive a chat from its menu and it waits here." />
        ) : groups.length === 0 ? (
          <SettingRow label={`No archived chat matches “${query.trim()}”`} />
        ) : null}
      </>
    ) : null;
  return (
    <>
      {total > 5 || status ? (
        <SettingsCard>
          {total > 5 ? (
            <SettingRow label="Find a chat" id="archived-find">
              <SearchField
                id="archived-find"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))}
                placeholder="Title, project or branch"
                className={CONTROL}
              />
            </SettingRow>
          ) : null}
          {status}
        </SettingsCard>
      ) : null}
      {groups.map((g) => (
        <SettingsCard key={g.key} title={g.label} description={g.removed ? "Not in the sidebar. Restoring a chat adds the project back." : undefined}>
          {g.chats.map((chat) => (
            <SettingRow
              key={chat.id}
              label={chat.title}
              description={
                rowError?.id === chat.id ? (
                  <span className="text-destructive">{rowError.message}</span>
                ) : (
                  <>
                    <span className="font-mono text-[12px]">{chat.branch}</span> · {archivedWhen(chat.at)}
                  </>
                )
              }
            >
              <Button variant="secondary" disabled={busy !== null} aria-label={`Restore ${chat.title}`} onClick={() => void restore(chat.id, chat.title)}>
                {busy === chat.id ? "Restoring…" : "Restore"}
              </Button>
            </SettingRow>
          ))}
        </SettingsCard>
      ))}
    </>
  );
}
