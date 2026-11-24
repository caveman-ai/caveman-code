import { projectSources, type Project, type ProjectSource } from "@caveman-app/session-protocol";
import { ACCESS, ACCESS_MODES, DEFAULT_ACCESS, type AccessMode } from "@caveman-app/ui/components/access-picker";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Textarea } from "@caveman-app/ui/components/textarea";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState, type FormEvent, type ReactNode } from "react";
import { isTypedPath, tildify } from "../../lib/paths.ts";
import { thisComputer } from "../../lib/platform.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { sourceLine } from "../../state/sources.ts";
import { SecretsSettings } from "../Secrets.tsx";
import { NewChatModelPicker, newChatEngines, settingModel } from "./new-chat-model.tsx";
import { SettingRow, SettingsCard } from "./rows.tsx";

/**
 * Settings > Projects: the project picked at the top right of its first card, which lists what it is made of (its
 * sources); then the user's preferences for it (permissions and models for new chats, instructions, hidden paths)
 * and its secrets.
 */
export function ProjectsSettings() {
  const projects = useRuntimeSelector((v) => v.projects);
  const [picked, setPicked] = useState<string | null>(null);
  const project = projects.find((p) => p.id === picked) ?? projects[0];
  if (!project)
    return (
      <div className="flex flex-col gap-8">
        <SettingsCard title="Project">
          <SettingRow label="No projects yet" description="Add a project in the sidebar first: these settings belong to a repository." />
        </SettingsCard>
      </div>
    );
  return (
    <div className="flex flex-col gap-8">
      <SourcesSettings
        key={`s:${project.id}`}
        project={project}
        picker={
          <Select value={project.id} onValueChange={setPicked}>
            <SelectTrigger aria-label="Project" className="h-8 w-auto min-w-[180px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsCard title="Preferences" description="Private to this computer and never committed.">
        <AccessSetting key={`a:${project.id}`} project={project} />
        <ModelSettings key={`m:${project.id}`} project={project} />
        <TextSetting
          key={`i:${project.id}`}
          id="project-instructions"
          project={project}
          title="Your instructions for this repo"
          description="Every engine gets them at the start of each session in this repository, after its own instructions."
          placeholder="Use pnpm, never npm. Run make test-fast before you say a change works."
          value={project.instructions ?? ""}
          patch={(text) => ({ instructions: text })}
        />
        <TextSetting
          key={`h:${project.id}`}
          id="project-hidden-paths"
          project={project}
          title="Hidden paths"
          description={
            <>
              File search, @ mentions, the file panel and agents' file tools skip them. One gitignore pattern per line; a committed{" "}
              <code className="font-mono text-[12px]">.cavemanignore</code> adds its own. Not a security boundary: shell commands can still read them, so keep keys in Secrets.
            </>
          }
          placeholder={"fixtures/recordings/\n*.snap\n/vendor/"}
          mono
          value={(project.ignorePaths ?? []).join("\n")}
          patch={(text) => ({ ignorePaths: text.split("\n") })}
        />
      </SettingsCard>
      <SecretsSettings repo={{ path: project.path }} />
    </div>
  );
}

/** Where a source sits on this computer, or that it will be cloned; then the part of it the project is about. */
export function sourcePlace(source: ProjectSource): string {
  const place = source.path ? tildify(source.path) : `Not on ${thisComputer} yet: cloned when a chat first works in it`;
  return source.focus ? `${place} · Focus on ${source.focus}` : place;
}

/** The add in flight, among the removes in flight by source name: no source is named this. */
const ADDING = "\0add";

/** project.add_source's argument for what was typed: a folder's path as `path`, anything else as a repository. */
export function sourceToAdd(typed: string): { path: string } | { repository: string } | null {
  const value = typed.trim();
  if (!value) return null;
  return isTypedPath(value) ? { path: value } : { repository: value };
}

/**
 * The project's sources: the repositories and folders its chats can work in, its own first. One is added by its
 * GitHub owner/name or URL, or as a folder on this computer (the desktop's folder chooser, or a typed path), and
 * removed again; the project's own stays. The runtime's refusal (a source that is another project's) shows as it is.
 * `picker`: which project this is, level with the card's heading.
 */
export function SourcesSettings({ project, picker }: { project: Project; picker?: ReactNode }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const sources = projectSources(project);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pickFolder = typeof window === "undefined" ? undefined : window.cavemanDesktop?.pickFolder;
  const run = async (key: string, call: () => Promise<unknown>) => {
    if (!client || busy) return false;
    setBusy(key);
    setError(null);
    try {
      await call();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const add = async (source: { path: string } | { repository: string }) => {
    if (await run(ADDING, () => client!.call("project.add_source", { request_id: requestId(), project_id: project.id, ...source }))) setTyped("");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const source = sourceToAdd(typed);
    if (source) void add(source);
  };
  const choose = async () => {
    const folder = await pickFolder?.();
    if (folder) void add({ path: folder });
  };
  return (
    <SettingsCard title="Project" description="Its sources: the repositories and folders its chats work in, one or several at a time." actions={picker}>
      {sources.map((s, i) => (
        <SettingRow
          key={s.name}
          label={s.name}
          description={
            <span className="block truncate" title={s.path}>
              {sourceLine(s)} · {sourcePlace(s)}
            </span>
          }
        >
          {/* The project's own repository or folder is the project: it stays. */}
          {i > 0 ? (
            <Button variant="ghost" disabled={busy !== null} aria-label={`Remove ${s.name}`} onClick={() => void run(s.name, () => client!.call("project.remove_source", { request_id: requestId(), project_id: project.id, name: s.name }))}>
              {busy === s.name ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </SettingRow>
      ))}
      <SettingRow
        id="project-add-source"
        label="Add a source"
        description={error ? <span className="text-destructive">{error}</span> : `By GitHub owner/name or URL, or a folder on ${thisComputer}.`}
      >
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            id="project-add-source"
            spellCheck={false}
            autoComplete="off"
            placeholder="owner/name or a folder's path"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            className="h-8 w-[220px] font-mono text-[12.5px] placeholder:font-sans"
          />
          <Button type="submit" variant="secondary" disabled={busy !== null || sourceToAdd(typed) === null}>
            {busy === ADDING ? "Adding…" : "Add"}
          </Button>
          {pickFolder ? (
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void choose()}>
              Choose folder…
            </Button>
          ) : null}
        </form>
      </SettingRow>
    </SettingsCard>
  );
}

/** The project's model for new chats on each engine, over Settings > General, as its permissions are. */
function ModelSettings({ project }: { project: Project }) {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const engines = useRuntimeSelector((v) => v.engines);
  const refresh = useRuntimeSelector((v) => v.refresh);
  // The engine whose save failed, and why: shown under that engine's row.
  const [error, setError] = useState<{ readonly engine: string; readonly message: string } | null>(null);
  const save = async (engine: string, model: string | null) => {
    if (!client) return;
    setError(null);
    try {
      await client.call("project.update", { request_id: requestId(), project_id: project.id, default_models: { [engine]: model } });
      await refresh();
    } catch (e) {
      setError({ engine, message: e instanceof Error ? e.message : String(e) });
    }
  };
  return newChatEngines(engines).map((engine) => {
    const own = project.default_models?.[engine.id];
    const inherited = `Default (${settingModel(engine, settings, project)?.label ?? "none"})`;
    return (
      <SettingRow
        key={engine.id}
        label={`${engine.label} model`}
        description={error?.engine === engine.id ? <span className="text-destructive">{error.message}</span> : "New chats in this project start on this."}
      >
        <NewChatModelPicker
          engine={engine}
          value={own}
          onChange={(model) => void save(engine.id, model)}
          inherit={{ label: inherited, selected: own === undefined }}
          ariaLabel={`Model for this project's new ${engine.label} chats: ${own === undefined ? inherited : (engine.models.find((m) => m.id === own)?.label ?? own)}`}
        />
      </SettingRow>
    );
  });
}

/** The project's permissions for new chats, over Settings > General (upstream project override). */
function AccessSetting({ project }: { project: Project }) {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [error, setError] = useState<string | null>(null);
  const inherited = ACCESS[settings?.default_access ?? DEFAULT_ACCESS].label;
  const save = async (value: string) => {
    if (!client) return;
    setError(null);
    try {
      await client.call("project.update", { request_id: requestId(), project_id: project.id, default_access: value === "inherit" ? null : (value as AccessMode) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SettingRow
      id="project-access"
      label="Permissions for new chats"
      description={error ? <span className="text-destructive">{error}</span> : "New chats in this project start with this. Change a chat's in its composer."}
    >
      <Select value={project.default_access ?? "inherit"} onValueChange={(v) => void save(v)}>
        <SelectTrigger id="project-access" aria-label="Permissions for this project's new chats" className="h-8 w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Default ({inherited})</SelectItem>
          {ACCESS_MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {ACCESS[mode].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/** A text field saved to the project on demand. */
function TextSetting(props: {
  id: string;
  project: Project;
  title: string;
  description: React.ReactNode;
  placeholder: string;
  value: string;
  mono?: boolean;
  patch: (text: string) => { instructions: string } | { ignorePaths: string[] };
}) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [text, setText] = useState(props.value);
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});
  const dirty = text.trim() !== props.value.trim();
  const save = async () => {
    if (!client) return;
    setState({ busy: true });
    try {
      await client.call("project.update", { request_id: requestId(), project_id: props.project.id, ...props.patch(text) });
      await refresh();
      setState({ saved: true });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <SettingRow id={props.id} label={props.title} description={props.description} stacked>
      <Textarea
        id={props.id}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState({});
        }}
        rows={5}
        spellCheck={!props.mono}
        placeholder={props.placeholder}
        className={cn("resize-y leading-5", props.mono && "font-mono text-[12.5px]")}
      />
      <div className="flex items-center justify-end gap-3">
        <span aria-live="polite" className={cn("text-[12.5px]", state.error ? "text-destructive" : "text-muted-foreground")}>
          {state.error ?? (state.saved && !dirty ? "Saved" : "")}
        </span>
        <Button variant="secondary" disabled={!dirty || state.busy === true} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </SettingRow>
  );
}
