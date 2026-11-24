import type { ChiefAvatar, ChiefProfile } from "@caveman-app/session-protocol";
import { ACCESS, ACCESS_MODES, DEFAULT_ACCESS, type AccessMode } from "@caveman-app/ui/components/access-picker";
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "@caveman-app/ui/components/dialog";
import { ChatSettings, SettingRow as MenuSettingRow } from "@caveman-app/ui/components/chat-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { menuDescription } from "@caveman-app/ui/components/menu";
import { ModelPicker } from "@caveman-app/ui/components/model-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { cn } from "@caveman-app/ui/lib/cn";
import { CAST, SKIN_TONES, useCast } from "@caveman-app/ui/mascot/cast";
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { Icon, Add01Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { withModelSources } from "../components/Composer.tsx";
import { ChiefSprite, DEFAULT_AVATAR } from "../components/ChiefSprite.tsx";
import { MarkdownField } from "../components/MarkdownField.tsx";
import { AUTONOMY, LevelSlider, levelsOf } from "../components/ChiefControls.tsx";
import { RepoMark } from "../components/ChiefRepos.tsx";
import type { useChief } from "../state/chief.ts";
import { chiefModelSetting, chiefPickerEngines, chiefPickerValue } from "../state/chief-model.ts";
import { useChiefs } from "../state/chiefs.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";
import { IS_MAC, isComposing } from "../panels/chrome.tsx";
import { SettingRow, SettingsCard, useSaveSettings } from "./settings/rows.tsx";
import { FolderGlyph } from "@caveman-app/ui/icons/Glyph";

type ChiefHandle = ReturnType<typeof useChief>;

/**
 * The Chief's model picker: the composer's own, over what is connected (chief.get), in its box and its settings.
 * Auto, on the fast floor, is the default; a pick pins the Chief to that account and model until its account is gone.
 * Its stars are the person's favorites, the composer's too (Settings.favorite_models).
 */
export function ChiefPicker({ chief, onError, className }: { chief: ChiefHandle; onError: (text: string) => void; className?: string }) {
  const engines = useRuntimeSelector((v) => v.engines);
  const favorites = useRuntimeSelector((v) => v.settings?.favorite_models ?? []);
  const saveSettings = useSaveSettings({ throws: true });
  const picker = chiefPickerEngines(chief.picker, withModelSources(engines));
  const value = chiefPickerValue(chief.model, picker);
  const model = value ? picker.find((e) => e.id === value.engine)?.models.find((m) => m.id === value.model) : undefined;
  const efforts = model?.efforts ?? [];
  const effort = efforts.length === 0 ? undefined : (chief.model?.effort ?? model?.default_effort ?? efforts[efforts.length - 1]);
  if (picker.length === 0) return null;
  const pick = (engine: string, id: string, level?: string) =>
    void chief.setModel(chiefModelSetting(engine, id, level)).catch(() => onError("The Chief's model did not change"));
  return (
    <ModelPicker
      engines={picker}
      value={value}
      onChange={(r) => pick(r.engine, r.model)}
      favorites={favorites}
      onFavoritesChange={(favorite_models) => void saveSettings({ favorite_models }).catch(() => onError("The favorite did not save"))}
      {...(effort === undefined || !value ? {} : { effort, onEffortChange: (level: string) => pick(value.engine, value.model, level) })}
      className={className ?? "min-w-0 max-w-[260px]"}
    />
  );
}

/**
 * A Chief's settings, one page: who it is (its character and name),
 * what it thinks with and what its chats may do, the projects it works in, and its soul. Every change saves as
 * it is made; nothing waits on a Save button.
 */
export function ChiefSheet({
  chief,
  open,
  onOpenChange,
  naming = false,
  atProjects = false,
}: {
  chief: ChiefHandle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Just made: the name takes focus, to be typed over. */
  naming?: boolean;
  /** Opened from its repo chips or "Projects and permissions": scrolled to Projects. */
  atProjects?: boolean;
}) {
  const chiefs = useChiefs();
  const navigate = useNavigate();
  const settings = useRuntimeSelector((v) => v.settings);
  // The list holds edits the moment they are made; the Chief's own copy follows the runtime.
  const profile = chiefs.chiefs.find((c) => c.id === chief.profile?.id) ?? chief.profile;
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setProblem(null);
  }, [open]);
  const save = (patch: Parameters<typeof chiefs.update>[1]) => {
    if (!profile) return Promise.resolve();
    setProblem(null);
    return chiefs.update(profile.id, patch).then(
      () => undefined,
      (e: unknown) => {
        setProblem(e instanceof Error ? e.message : String(e));
        throw e;
      },
    );
  };
  const quiet = (patch: Parameters<typeof chiefs.update>[1]) => void save(patch).catch(() => undefined);
  const levels = levelsOf(profile, settings);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        aria-describedby={undefined}
        // Only a Chief just made puts you in its name; otherwise nothing is focused until you reach for it.
        onOpenAutoFocus={(e) => {
          if (naming) return;
          e.preventDefault();
          const sheet = e.currentTarget as HTMLElement | null;
          sheet?.focus();
          if (atProjects) sheet?.querySelector("#chief-projects")?.scrollIntoView({ block: "start" });
        }}
        className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 outline-none"
      >
        <header className="flex h-14 shrink-0 items-center border-b border-border pl-6 pr-14">
          <DialogTitle className="min-w-0 truncate text-[14px] font-medium">{profile ? `${profile.name} settings` : "Chief settings"}</DialogTitle>
          <span role="alert" className="ml-auto truncate pl-4 text-[12.5px] text-destructive">
            {problem}
          </span>
        </header>
        {profile ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 pb-10 [scrollbar-width:thin]">
            <Identity profile={profile} onSave={save} naming={naming} />
            <div className="mt-10 flex flex-col gap-9">
              <SettingsCard title="Model">
                <SettingRow label="Model" description="What it thinks and replies with.">
                  {chief.picker.length > 0 ? (
                    <ChiefPicker chief={chief} onError={setProblem} className="max-w-[240px]" />
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => navigate("/settings/models")}>
                      Connect a model
                    </Button>
                  )}
                </SettingRow>
                <SettingRow id="chief-access" label="Permissions" description="What the chats it starts may do without asking.">
                  <AccessSelect value={profile.access} onChange={(access) => quiet({ access })} />
                </SettingRow>
              </SettingsCard>
              <SettingsCard title="Working with you">
                <SettingRow label="Autonomy">
                  <LevelSlider label="Autonomy" value={levels.autonomy.id} options={AUTONOMY} onChange={(autonomy) => quiet({ autonomy })} />
                </SettingRow>
              </SettingsCard>
              <div id="chief-projects" className="scroll-mt-6">
                <Projects ids={profile.project_ids} name={profile.name} onChange={(project_ids) => quiet({ project_ids })} />
              </div>
              <Soul key={profile.id} value={profile.soul} onSave={(soul) => save({ soul })} />
              {profile.home ? null : <Remove profile={profile} onRemoved={() => onOpenChange(false)} />}
            </div>
          </div>
        ) : (
          <p className="px-6 py-8 text-[13px] text-muted-foreground">This runtime keeps one Chief with no settings of its own. Update Caveman Code to name it and give it a character.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sliders in the Chief's box, as a chat's box has them: the settings you reach for mid-conversation
 * (what its chats may do, where it works), and the rest of its sheet one row away. Edits apply at once.
 */
export function ChiefBoxSettings({ chief, onSettings, onProjects }: { chief: ChiefHandle; onSettings: () => void; onProjects: () => void }) {
  const chiefs = useChiefs();
  const projects = useRuntimeSelector((v) => v.projects);
  const fallback = useRuntimeSelector((v) => v.settings?.default_access ?? DEFAULT_ACCESS);
  const profile = chiefs.chiefs.find((c) => c.id === chief.profile?.id) ?? chief.profile;
  if (!profile) return null;
  const listed = profile.project_ids.filter((id) => projects.some((p) => p.id === id)).length;
  const reach = profile.project_ids.length === 0 ? "Every project" : listed === 0 ? "None" : listed === 1 ? (projects.find((p) => profile.project_ids.includes(p.id))?.name ?? "1 project") : `${listed} projects`;
  const access = profile.access ?? SAME_AS_NEW;
  return (
    <ChatSettings>
      <MenuSettingRow label="Permissions" value={profile.access ? ACCESS[profile.access].label : ACCESS[fallback].label} className="min-w-[420px]">
        <DropdownMenuRadioGroup value={access} onValueChange={(v) => void chiefs.update(profile.id, { access: v === SAME_AS_NEW ? null : (v as AccessMode) }).catch(() => undefined)}>
          <DropdownMenuRadioItem value={SAME_AS_NEW}>
            <span aria-hidden className="size-4 shrink-0" />
            <span className="shrink-0">Same as new chats</span>
            <span className={menuDescription}>{ACCESS[fallback].label}</span>
          </DropdownMenuRadioItem>
          {ACCESS_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode}>
              <Icon icon={ACCESS[mode].icon} className="size-4 shrink-0" />
              <span className="shrink-0">{ACCESS[mode].label}</span>
              <span className={menuDescription}>{ACCESS[mode].line}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </MenuSettingRow>
      <DropdownMenuItem onSelect={onProjects}>
        <span className="shrink-0">Projects</span>
        <span className="flex min-w-0 flex-1 justify-end text-muted-foreground">
          <span className="truncate">{reach}</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onSettings}>{profile.name} settings…</DropdownMenuItem>
    </ChatSettings>
  );
}

/** The skin tones light to dark, as a screen reader says them (the swatches show them). */
const TONE_NAMES = ["Lightest skin", "Light skin", "Medium skin", "Dark skin", "Darkest skin"];

/** "Same as new chats" (null): the chats it starts take what a chat you start in that project would. */
const SAME_AS_NEW = "same";

function AccessSelect({ value, onChange }: { value: AccessMode | null; onChange: (access: AccessMode | null) => void }) {
  const fallback = useRuntimeSelector((v) => v.settings?.default_access ?? DEFAULT_ACCESS);
  return (
    <Select value={value ?? SAME_AS_NEW} onValueChange={(next) => onChange(next === SAME_AS_NEW ? null : (next as AccessMode))}>
      <SelectTrigger id="chief-access" aria-label="Permissions for the chats it starts" className="h-8 w-[244px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SAME_AS_NEW}>Same as new chats ({ACCESS[fallback].label})</SelectItem>
        {ACCESS_MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {ACCESS[mode].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Who it is: its character on the cave at dusk, its name under it, the cast to pick from and a skin tone. The stage
 * is the sheet's one moving thing: it breathes, and waves once when you pick someone new.
 */
function Identity({ profile, onSave, naming }: { profile: ChiefProfile; onSave: (patch: { name?: string; avatar?: ChiefAvatar }) => Promise<void>; naming: boolean }) {
  const cast = useCast();
  const avatar = profile.avatar ?? DEFAULT_AVATAR;
  const member = cast.find((c) => c.id === avatar.character) ?? CAST[0]!;
  const [pose, setPose] = useState<MascotPose>("idle");
  const waving = useRef(0);
  useEffect(() => () => window.clearTimeout(waving.current), []);
  const pick = (next: Partial<ChiefAvatar>) => {
    void onSave({ avatar: { ...avatar, ...next } }).catch(() => undefined);
    // Hello once, then back to breathing: four frames at 8 fps, held a beat.
    setPose("wave");
    window.clearTimeout(waving.current);
    waving.current = window.setTimeout(() => setPose("idle"), 900);
  };
  return (
    <section aria-label="Character" className="flex flex-col items-center pt-8">
      <div className="flex h-[136px] w-[136px] items-end justify-center">
        <span className="mb-2.5 flex">
          <ChiefSprite key={`${avatar.character}-${pose}`} avatar={avatar} pose={pose} scale={4} animate label={`${profile.name}, played by ${member.name}`} />
        </span>
      </div>
      <NameField value={profile.name} onSave={(name) => onSave({ name })} select={naming} />
      <p className="mt-1 text-[13px] text-muted-foreground">{profile.home ? "Your home Chief: the capture shortcut lands here, and it stays." : member.line}</p>

      <div role="radiogroup" aria-label="Character" className="mt-6 flex flex-wrap justify-center gap-1.5">
        {cast.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === avatar.character}
            aria-label={c.name}
            title={`${c.name}: ${c.line}`}
            onClick={() => c.id !== avatar.character && pick({ character: c.id })}
            className={cn(
              "px-play-hover grid size-14 place-items-center rounded-xl border border-transparent outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              c.id === avatar.character && "border-foreground/40 bg-accent/60",
            )}
          >
            <ChiefSprite avatar={{ character: c.id, tone: avatar.tone }} scale={2} />
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Skin tone" className="mt-2 flex items-center gap-1">
        {SKIN_TONES.map((t, i) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={t === avatar.tone}
            aria-label={TONE_NAMES[i] ?? `Skin tone ${i + 1}`}
            disabled={!member.skin}
            title={member.skin ? undefined : `${member.name} has no skin tone`}
            onClick={() => t !== avatar.tone && pick({ tone: t })}
            className={cn(
              "grid size-7 place-items-center rounded-md border border-transparent outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30",
              t === avatar.tone && member.skin && "border-foreground/40",
            )}
          >
            {/* The tone's own skin token on a notched pixel tile (pixel.css .px-skin-*). */}
            <span aria-hidden className={cn("px-notch block size-4", t !== "medium-light" && `px-skin-${t}`)} style={{ background: "hsl(var(--id-skin))" }} />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Its name, edited where it shows: Enter or leaving the field saves, Escape puts it back. Never empty. */
function NameField({ value, onSave, select }: { value: string; onSave: (name: string) => Promise<void>; select: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const name = text.trim();
    if (name === "" || name === value) return setText(value);
    void onSave(name).catch(() => setText(value));
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => select && e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape" && text !== value) {
          // Puts the name back without closing the sheet.
          e.stopPropagation();
          setText(value);
        }
      }}
      maxLength={60}
      spellCheck={false}
      aria-label="Name"
      className="mt-4 w-[min(100%,320px)] rounded-lg border border-transparent bg-transparent px-2 py-1 text-center text-[19px] font-semibold tracking-[-0.01em] outline-none transition-colors duration-75 hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
    />
  );
}

/** The projects it may see and start chats in. None listed means every project. */
function Projects({ ids, name, onChange }: { ids: ReadonlyArray<string>; name: string; onChange: (ids: ReadonlyArray<string>) => void }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const listed = ids.flatMap((id) => projects.filter((p) => p.id === id));
  // Only projects that still exist go back to the runtime: a removed one's id would be refused.
  const known = listed.map((p) => p.id);
  const rest = projects.filter((p) => !ids.includes(p.id));
  const all = projects.length === 2 ? "both" : projects.length === 1 ? "your one project" : `all ${projects.length}`;
  return (
    <SettingsCard title="Projects" description="It sees every chat, note and folder in these, and starts chats only here.">
      {ids.length > 0 && listed.length === 0 ? (
        // Its projects were removed: it can start nothing until it has one. Never widened to every project unasked.
        <SettingRow
          icon={<FolderGlyph open={false} className="text-warning" />}
          label="Its projects were removed"
          description={`${name} can't start chats anywhere until you add a project here, or let it work in every project.`}
        >
          <Button size="sm" variant="secondary" onClick={() => onChange([])}>
            Use every project
          </Button>
        </SettingRow>
      ) : listed.length === 0 ? (
        <SettingRow
          icon={<FolderGlyph open className="text-muted-foreground" />}
          label="Every project"
          description={projects.length === 0 ? "You have no projects yet." : `It works in ${all} of your projects, and in any you add later. Add one to keep it to a few.`}
        />
      ) : (
        listed.map((p) => (
          <div key={p.id} className="group flex min-h-[52px] items-center gap-3 px-5 py-2.5">
            <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
              <RepoMark repo={{ github: p.repository?.host === "github.com" }} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{p.name}</div>
              {/* Where it lives: owner/name on GitHub, else the folder on this computer. */}
              {p.repository ? (
                <div className="truncate text-[12px] text-muted-foreground">{p.repository.full_name}</div>
              ) : p.path ? (
                <div className="truncate font-mono text-[12px] text-muted-foreground">{p.path}</div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Remove ${p.name} from ${name}`}
              title={`Remove from ${name}`}
              onClick={() => onChange(known.filter((id) => id !== p.id))}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,background-color] duration-75 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
            >
              <Icon icon={Cancel01Icon} className="size-3.5" />
            </button>
          </div>
        ))
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={rest.length === 0}
          className="flex h-14 w-full items-center gap-3 px-5 text-left text-[13.5px] outline-none transition-colors duration-75 hover:bg-accent/40 focus-visible:bg-accent/40 disabled:pointer-events-none disabled:text-muted-foreground"
        >
          <span aria-hidden className="grid size-8 place-items-center rounded-lg border border-dashed border-muted-foreground/50 text-muted-foreground">
            <Icon icon={Add01Icon} className="size-3.5" />
          </span>
          {rest.length === 0 && projects.length > 0 ? "All your projects are on its list" : "Add project"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px]">
          {rest.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onChange([...known, p.id])}>
              <RepoMark repo={{ github: p.repository?.host === "github.com" }} size={14} />
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsCard>
  );
}

const SOUL_SAVE_MS = 700;

/**
 * Its soul, markdown it keeps in mind every turn: typed in a mono editor whose headings and list marks are tinted
 * as they are in code. Saves a moment after you stop typing, and when you leave the field (or ⌘S).
 */
function Soul({ value, onSave }: { value: string; onSave: (soul: string) => Promise<void> }) {
  const [text, setText] = useState(value);
  const [state, setState] = useState<"saved" | "saving" | "error" | null>(null);
  // What the runtime has: a change from elsewhere replaces the text only while nothing typed here waits.
  const saved = useRef(value);
  const timer = useRef(0);
  useEffect(() => {
    if (text === saved.current) setText(value);
    saved.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new value from the runtime replaces the text; typing here must not.
  }, [value]);
  const flush = (next = text) => {
    window.clearTimeout(timer.current);
    if (next === saved.current) return;
    setState("saving");
    const sent = next;
    onSave(sent).then(
      () => {
        saved.current = sent;
        setState("saved");
      },
      () => setState("error"),
    );
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const status = state === "saving" ? "Saving…" : state === "saved" && text === saved.current ? "Saved" : state === "error" ? "Not saved" : "";
  return (
    <SettingsCard
      title="Soul"
      description={
        <>
          Who it is and what it always keeps in mind. A <code className="font-mono text-[12px] text-foreground/90">## Crew rules</code> section goes to every chat it starts.
        </>
      }
    >
      <MarkdownField
        value={text}
        label="Soul"
        onChange={(next) => {
          setText(next);
          setState(null);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => flush(next), SOUL_SAVE_MS);
        }}
        onBlur={() => flush()}
        onSave={() => flush()}
      />
      <div className="flex h-8 items-center justify-between px-5 text-[12px] text-muted-foreground">
        <span>Markdown</span>
        <span aria-live="polite" className={cn(state === "error" && "text-destructive")}>
          {status || `${IS_MAC ? "⌘" : "Ctrl+"}S saves now`}
        </span>
      </div>
    </SettingsCard>
  );
}

/** The way out, for any Chief but home. Its open items, chats running included, move to the home Chief. */
function Remove({ profile, onRemoved }: { profile: ChiefProfile; onRemoved: () => void }) {
  const chiefs = useChiefs();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const home = chiefs.chiefs.find((c) => c.home)?.name ?? "your home Chief";
  return (
    <section aria-label="Remove" className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
      <div className="min-w-0">
        <div className="text-[13.5px]">Remove {profile.name}</div>
        <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">{problem ?? `Its open items move to ${home}; its conversation is archived.`}</div>
      </div>
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setAsking(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${profile.name}?`}
        description={`Its conversation is archived and can't come back. Its open items move to ${home}, which keeps watching their chats. The chats it started stay where they are.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          setProblem(null);
          chiefs.remove(profile.id).then(
            () => {
              onRemoved();
              navigate("/chief", { replace: true });
            },
            (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
          );
        }}
      />
    </section>
  );
}
