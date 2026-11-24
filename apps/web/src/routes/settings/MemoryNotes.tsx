// The notes in Settings › Memory: what Claude Agent, Codex and the Caveman engine remember between chats.
// Notes for you (every repository) and for one project; search, edit (an edit is Told), pin, forget with Undo,
// and where each was learned. The chat shows memory when it acts; this is where to find a note later. Spend
// never shows here.
import type { MemoryNote } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input, SearchField } from "@caveman-app/ui/components/input";
import { Tag } from "@caveman-app/ui/components/tag";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Textarea } from "@caveman-app/ui/components/textarea";
import { Icon, Add01Icon, PinIcon, PinOffIcon, Undo02Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { AUTHORITY, groupNotes, repoLabel, type ScopeFilter } from "./memory-model.ts";
import { Segmented, SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";

const message = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

const SCOPES: ReadonlyArray<{ value: ScopeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "me", label: "Me" },
  { value: "project", label: "Project" },
];

/** memory.list for the chosen project (or every note), reloaded after each change. */
function useNotes(query: string, projectId: string | undefined) {
  const { client } = useRuntimeClient();
  const [notes, setNotes] = useState<ReadonlyArray<MemoryNote> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      const r = await client.call("memory.list", { ...(query.trim() ? { query: query.trim() } : {}), ...(projectId ? { project_id: projectId } : {}) });
      setNotes(r.notes);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [client, query, projectId]);
  useEffect(() => void reload(), [reload]);
  return { notes, error, reload };
}

/** The Notes card (filters, Add, what just happened), then one card per group of notes. `onChange` runs after each change, for the counts above. */
export function MemoryNotes({ onChange }: { onChange: () => void }) {
  const { client } = useRuntimeClient();
  const projects = useRuntimeSelector((v) => v.projects);
  const settings = useRuntimeSelector((v) => v.settings);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const { notes, error, reload } = useNotes(query, projectId);
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const project = projects.find((p) => p.id === projectId);
  const groups = useMemo(() => groupNotes(notes ?? [], scope), [notes, scope]);
  const off = settings?.memory_enabled === false;

  const act = async (run: () => Promise<unknown>, after?: () => void) => {
    setFailure(null);
    try {
      await run();
      after?.();
      onChange();
      await reload();
    } catch (e) {
      setFailure(message(e));
    }
  };
  const forget = (note: MemoryNote) =>
    act(
      () => client!.call("memory.forget", { request_id: requestId(), id: note.id }),
      () => setUndo({ id: note.id, label: note.name }),
    );

  return (
    <>
      <SettingsCard
        title="Notes"
        description="Notes you add, edit or pin load in every chat. An agent's own stay drafts until you do."
        actions={
          <Button variant="secondary" onClick={() => setAdding(true)} disabled={!client}>
            <Icon icon={Add01Icon} className="size-3.5" /> Add a note
          </Button>
        }
      >
        <SettingsCardBody className="flex flex-wrap items-center gap-2 py-3">
          <SearchField aria-label="Search memory" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} containerClassName="min-w-[200px] flex-1" />
          <Segmented label="Scope" value={scope} options={SCOPES} onChange={setScope} />
          <Select value={projectId ?? "all"} onValueChange={(v) => setProjectId(v === "all" ? undefined : v)}>
            <SelectTrigger aria-label="Project" className="w-auto min-w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">Every project</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsCardBody>
        {off ? <SettingRow label="Memory is off" description="No agent reads or writes these notes." /> : null}
        {undo ? (
          <SettingRow label={`Forgot “${undo.label}”.`}>
            <Button variant="ghost" onClick={() => void act(() => client!.call("memory.undo", { request_id: requestId(), id: undo.id }), () => setUndo(null))}>
              <Icon icon={Undo02Icon} className="size-3.5" /> Undo
            </Button>
          </SettingRow>
        ) : null}
        {failure ? <SettingRow label="That didn't save" description={failure} /> : null}
        {error ? <SettingRow label="Couldn't load notes" description={error} /> : null}
        {adding ? (
          <SettingsCardBody>
            <NoteEditor
              title="New note"
              scopes={project ? ["me", "project"] : ["me"]}
              projectName={project?.name}
              onCancel={() => setAdding(false)}
              onSave={(text, name, noteScope) =>
                act(
                  () => client!.call("memory.put", { request_id: requestId(), text, scope: noteScope, ...(name ? { name } : {}), ...(noteScope === "project" && projectId ? { project_id: projectId } : {}) }),
                  () => setAdding(false),
                )
              }
            />
          </SettingsCardBody>
        ) : null}
        {notes === null && !error ? <SettingRow label="Loading…" /> : null}
        {notes !== null && notes.length === 0 && !query ? (
          <SettingRow
            label="Nothing on the cave wall yet"
            description="Tell an agent a preference, or correct it, and it saves a note here."
          />
        ) : null}
        {notes !== null && notes.length === 0 && query ? <SettingRow label={`No note matches “${query}”.`} /> : null}
      </SettingsCard>
      {groups.map((group) => (
        <SettingsCard key={group.key} title={`${group.title} · ${group.notes.length}`}>
          {group.notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onEdit={(text) => act(() => client!.call("memory.put", { request_id: requestId(), id: note.id, text, scope: note.scope }))}
              onPin={() => act(() => client!.call("memory.pin", { request_id: requestId(), id: note.id, pinned: !note.pinned }))}
              onKeep={() => act(() => client!.call("memory.keep", { request_id: requestId(), id: note.id }))}
              onForget={() => void forget(note)}
            />
          ))}
        </SettingsCard>
      ))}
    </>
  );
}

function NoteRow({ note, onEdit, onPin, onKeep, onForget }: { note: MemoryNote; onEdit: (text: string) => Promise<void>; onPin: () => void; onKeep: () => void; onForget: () => void }) {
  const [editing, setEditing] = useState(false);
  const authority = AUTHORITY[note.authority];
  if (editing)
    return (
      <SettingsCardBody>
        <NoteEditor title="Edit note" initial={note.text} onCancel={() => setEditing(false)} onSave={(text) => onEdit(text).then(() => setEditing(false))} />
      </SettingsCardBody>
    );
  return (
    <SettingRow
      className="group"
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{note.name}</span>
          <Tag className="shrink-0" title={authority.hint}>
            {authority.label}
          </Tag>
          <Tag className="shrink-0">{note.scope === "me" ? "Me" : "Project"}</Tag>
          {note.pinned ? <Icon icon={PinIcon} className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
          {note.tainted ? <Tag className="shrink-0 text-warning">Unverified</Tag> : null}
        </span>
      }
      description={
        <>
          <span className="block">{note.text}</span>
          <span className="mt-1 block text-[12px] text-[hsl(var(--subtle-foreground))]">
            {note.thread ? (
              <>
                Learned in{" "}
                <Link to={`/w/${note.thread.workspace_id}`} className="underline-offset-2 hover:text-foreground hover:underline">
                  {note.thread.title}
                </Link>
              </>
            ) : note.by === "user" ? (
              "Written by you"
            ) : note.by.startsWith("import:") ? (
              "Imported"
            ) : (
              "Saved by an agent"
            )}
            {" · "}
            {note.added}
            {note.repo ? ` · ${repoLabel(note.repo)}` : ""}
            {note.suspect ? ` · ${note.suspect}` : ""}
          </span>
        </>
      }
    >
      <span className="flex items-center gap-1 opacity-60 transition-opacity duration-75 group-hover:opacity-100 group-focus-within:opacity-100">
        {note.tainted ? (
          <Button variant="ghost" onClick={onKeep}>
            Keep
          </Button>
        ) : null}
        <Button variant="ghost" aria-label={note.pinned ? "Unpin" : "Pin"} title={note.pinned ? "Unpin" : "Pin: in every brief"} onClick={onPin}>
          {note.pinned ? <Icon icon={PinOffIcon} className="size-3.5" /> : <Icon icon={PinIcon} className="size-3.5" />}
        </Button>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="ghost" onClick={onForget}>
          Forget
        </Button>
      </span>
    </SettingRow>
  );
}

function NoteEditor(props: {
  title: string;
  initial?: string;
  scopes?: ReadonlyArray<"me" | "project">;
  projectName?: string | undefined;
  onCancel: () => void;
  onSave: (text: string, name: string, scope: "me" | "project") => Promise<void> | void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"me" | "project">(props.scopes?.includes("project") ? "project" : "me");
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (oneLine) void props.onSave(oneLine, name.trim(), scope);
      }}
    >
      <div className="text-[13px] font-medium">{props.title}</div>
      {props.scopes ? <Input aria-label="Title" placeholder="Title (optional)" value={name} onChange={(e) => setName(e.target.value)} className="h-8" /> : null}
      <Textarea aria-label="Note" autoFocus rows={2} maxLength={500} placeholder="One fact, preference or gotcha, in a line" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-2">
        {props.scopes && props.scopes.length > 1 ? (
          <Select value={scope} onValueChange={(v) => setScope(v as "me" | "project")}>
            <SelectTrigger aria-label="Holds for" className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="me">Me, in every repository</SelectItem>
              <SelectItem value="project">{props.projectName ?? "This project"} only</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <span className="text-[12px] text-muted-foreground">What you write is followed as your own words.</span>
        <span className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!oneLine}>
            Save
          </Button>
        </span>
      </div>
    </form>
  );
}
