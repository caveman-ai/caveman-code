import { Input } from "@caveman-app/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowUpRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useChief } from "../../state/chief.ts";
import { chiefPath, useChiefs } from "../../state/chiefs.ts";
import { ChiefSprite } from "../../components/ChiefSprite.tsx";
import { ACCESS, DEFAULT_ACCESS } from "@caveman-app/ui/components/access-picker";
import { acceleratorFrom, DEFAULT_CAPTURE_SHORTCUT, formatAccelerator } from "../../state/chief-model.ts";
import type { CaptureShortcutState } from "../../state/desktop.ts";
import { credentialsOutside } from "../../state/engines.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { Button } from "@caveman-app/ui/components/button";
import { CONTROL, NumberInput, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";
import type { Settings } from "@caveman-app/session-protocol";
import { IS_MAC, keysText } from "../../panels/chrome.tsx";
import { AUTONOMY, LevelSlider, levelsOf } from "../../components/ChiefControls.tsx";

type Patience = NonNullable<Settings["chief_voice_patience"]>;
/** How long a call waits on a pause (chief_voice_patience), as the person picks it. */
const PATIENCE: ReadonlyArray<{ id: Patience; label: string; hint: string }> = [
  { id: "quick", label: "Jump in quickly", hint: "Answers as soon as you sound done." },
  { id: "normal", label: "Wait a moment", hint: "A short pause or an um means more is coming." },
  { id: "patient", label: "Wait longer", hint: "For thinking out loud." },
];

/**
 * Settings > Work > Chief: your Chiefs (each one's own settings open from here or its page), the limits the
 * runtime holds them all to in code (never in a prompt), calls, and the desktop's capture shortcut.
 */
export function ChiefSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  // Settings' levels alone (no Chief's own): what every Chief that picked none of its own follows.
  const { autonomy } = levelsOf(null, settings);
  return (
    <>
      <ChiefList />
      <SettingsCard title="Defaults" description="For Chiefs that haven't picked their own.">
        <SettingRow label="Autonomy">
          <LevelSlider label="Autonomy" value={autonomy.id} options={AUTONOMY} onChange={(chief_autonomy) => void save({ chief_autonomy })} />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Limits" description="Shared by all your Chiefs. Past one, a note waits in the Queue and says why.">
        <LimitRow
          id="chief-concurrent"
          label="Chats at once"
          description="How many chats your Chiefs run between them. Past it, the next one waits."
          value={settings?.chief_max_concurrent}
          suggested={4}
          min={1}
          max={20}
          onSave={(chief_max_concurrent) => save({ chief_max_concurrent })}
        />
        <SettingRow id="chief-ask" label="Ask first above" description="Below Manage, a note that needs more chats than this comes back as Suggested chats.">
          <NumberInput id="chief-ask" value={settings?.chief_ask_above_chats ?? 3} min={1} max={20} onCommit={(v) => void save({ chief_ask_above_chats: v })} />
        </SettingRow>
        <SettingRow
          id="chief-wait"
          label="Go ahead after, minutes"
          description="A Chief then takes its own recommendation. Approvals and secrets always wait; 0 waits forever."
        >
          <NumberInput id="chief-wait" value={settings?.chief_ask_wait_minutes ?? 15} min={0} max={1440} onCommit={(v) => void save({ chief_ask_wait_minutes: v })} />
        </SettingRow>
        <LimitRow
          id="chief-cap"
          label="Daily cap, US dollars"
          description="Measured spend of your Chiefs and their chats in a day. Usage shows the Chiefs' own turns."
          value={settings?.chief_daily_cap_usd}
          suggested={20}
          min={1}
          max={10_000}
          onSave={(chief_daily_cap_usd) => save({ chief_daily_cap_usd })}
        />
        <LimitRow
          id="chief-turns"
          label="Turns a day"
          description="Holds where spend is not measured, as on a Claude plan, whose turns count against its own limits."
          value={settings?.chief_daily_turns}
          suggested={200}
          min={1}
          max={100_000}
          onSave={(chief_daily_turns) => save({ chief_daily_turns })}
        />
      </SettingsCard>
      <SettingsCard title="Smart View" description="Chiefs open what's worth a look beside their chat. What you're reading never moves.">
        <SettingRow id="chief-smart-view" label="Smart View" description="Off, Chiefs open nothing and tell you in words. Also in the Chief's bar.">
          <Switch id="chief-smart-view" disabled={!settings} checked={settings?.chief_smart_view !== false} onCheckedChange={(on) => void save({ chief_smart_view: on })} />
        </SettingRow>
      </SettingsCard>
      <Calls />
      <CaptureShortcut value={settings?.chief_capture_shortcut ?? DEFAULT_CAPTURE_SHORTCUT} onSave={(chief_capture_shortcut) => save({ chief_capture_shortcut })} />
    </>
  );
}

/**
 * A limit the runtime holds the Chiefs to, off unless the person turns it on (absent or 0 is off). On starts at
 * `suggested`; off saves 0, and items waiting on it start at once.
 */
function LimitRow({ id, label, description, value, suggested, min, max, onSave }: { id: string; label: string; description: string; value: number | undefined; suggested: number; min: number; max: number; onSave: (value: number) => unknown }) {
  const on = value !== undefined && value > 0;
  return (
    <SettingRow id={`${id}-on`} label={label} description={description}>
      <div className="flex items-center gap-3">
        {on && <NumberInput id={id} value={value} min={min} max={max} onCommit={(v) => void onSave(v)} />}
        <Switch id={`${id}-on`} checked={on} onCheckedChange={(next) => void onSave(next ? suggested : 0)} />
      </div>
    </SettingRow>
  );
}

/** What the voice engine's row says where the runtime takes no key (state/engines.ts credentialsOutside). */
export const VOICE_KEY_ELSEWHERE = "Calls and talk to type run on Caveman credits in Cloud. Add a voice key on your Mac (Settings > Chiefs).";

/**
 * Calls: talk to the Chief from anywhere. Who pays: Caveman credits, or the voice engine's own key, which goes first
 * when there is one (checked before it is kept, never shown again); the voice it speaks in, and whether it rings you
 * back when work you asked for on a call is ready.
 */
export function Calls() {
  const settings = useRuntimeSelector((v) => v.settings);
  // A Cloud computer that keeps nothing of its person's takes no key (chief.voice.key is refused): no field for one.
  const outside = credentialsOutside(useRuntimeSelector((v) => v.engines));
  const chief = useChief();
  const save = useSaveSettings();
  const voice = chief.voice;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!voice) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    // The field never keeps a key, whatever the answer.
    setKey("");
    if (value === "") return;
    setBusy(true);
    setError(null);
    chief.setVoiceKey(voice.engine, value).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  // A key of their own is kept. A runtime from before `paid_by` says credits only while there is no key, and one from
  // before both only had keys: ready (or capped) meant a key.
  const hasKey = voice.key_hint !== undefined || voice.paid_by === "key" || (voice.paid_by === undefined && voice.credits === undefined && voice.state !== "no_key");
  const onCredits = voice.paid_by === "credits" || voice.credits === "on";
  const patience: Patience = settings?.chief_voice_patience ?? "normal";
  const voiceId = voice.voices.some((v) => v.id === settings?.chief_voice_name) ? settings!.chief_voice_name! : (voice.voices[0]?.id ?? "");
  return (
    <SettingsCard
      title="Calls"
      description={`Calls and talk to type send your voice to ${voice.engine_label}${onCredits ? " through Caveman Cloud, and neither keeps any of it" : ", which keeps none of it"}.`}
    >
      <SettingRow
        label={voice.engine_label}
        description={
          <>
            {hasKey
              ? `${voice.key_help} Your key goes before Caveman credits.`
              : outside
                ? VOICE_KEY_ELSEWHERE
                : onCredits
                  ? `On your Caveman credits, at ${voice.engine_label}'s list price, nothing to set up. Add a ${voice.engine_label} key of your own to use it instead.`
                  : voice.credits === "unavailable"
                    ? `Calls on Caveman credits aren't on yet. Add a ${voice.engine_label} key of your own to call now.`
                    : `${voice.key_help} Or get a Caveman plan or credits, and calls run on them.`}
            <span role="status" aria-live="polite" className="block text-destructive">
              {error}
            </span>
          </>
        }
      >
        {hasKey ? (
          <>
            <span className="font-mono text-[12.5px] text-muted-foreground">{voice.key_hint ?? "Key set"}</span>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={`Remove the ${voice.engine_label} key`}
              onClick={() => {
                setBusy(true);
                void chief.setVoiceKey(voice.engine, null).finally(() => setBusy(false));
              }}
            >
              Remove
            </Button>
          </>
        ) : outside ? null : (
          <form onSubmit={submit} className="flex items-center gap-2">
            <a
              href={voice.key_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Get a ${voice.engine_label} key (opens in a new tab)`}
              className="inline-flex items-center gap-0.5 text-[12.5px] text-muted-foreground hover:text-foreground"
            >
              Get a key <Icon icon={ArrowUpRight01Icon} className="size-3" />
            </a>
            <Input
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              aria-label={`${voice.engine_label} API key`}
              placeholder="Paste a key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className={cn(CONTROL, "font-mono placeholder:font-sans")}
            />
            <Button type="submit" variant="secondary" disabled={busy || key.trim() === ""}>
              {busy ? "Checking…" : "Add"}
            </Button>
          </form>
        )}
      </SettingRow>
      <SettingRow id="chief-voice" label="Voice" description={voice.voices.find((v) => v.id === voiceId)?.hint}>
        <Select value={voiceId} onValueChange={(chief_voice_name) => void save({ chief_voice_name })}>
          <SelectTrigger id="chief-voice" aria-label="Voice" className={CONTROL}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {voice.voices.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow id="chief-patience" label="When you pause" description={PATIENCE.find((p) => p.id === patience)?.hint ?? ""}>
        <Select value={patience} onValueChange={(v) => void save({ chief_voice_patience: v as Patience })}>
          <SelectTrigger id="chief-patience" aria-label="When you pause" className={CONTROL}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PATIENCE.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow id="chief-ring-back" label="Ring me back" description="When work from a call is ready or stuck.">
        <Switch id="chief-ring-back" disabled={!settings} checked={settings?.chief_voice_ring_back !== false} onCheckedChange={(on) => void save({ chief_voice_ring_back: on })} />
      </SettingRow>
    </SettingsCard>
  );
}

/** Each Chief, by its character: its model, permissions and projects at a glance; a click opens its settings. */
function ChiefList() {
  const chiefs = useChiefs();
  const projects = useRuntimeSelector((v) => v.projects);
  const engines = useRuntimeSelector((v) => v.engines);
  const newChats = useRuntimeSelector((v) => v.settings?.default_access ?? DEFAULT_ACCESS);
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  if (chiefs.status !== "ready" || chiefs.chiefs.length === 0) return null;
  const reach = (ids: ReadonlyArray<string>) =>
    ids.length === 0 ? "Every project" : ids.length === 1 ? (projects.find((p) => p.id === ids[0])?.name ?? "one project") : `${ids.length} projects`;
  const thinks = (c: (typeof chiefs.chiefs)[number]) =>
    c.model === null ? "Auto" : (engines.find((e) => e.id === c.model!.engine)?.models.find((m) => m.id === c.model!.model)?.label ?? c.model.model);
  return (
    <SettingsCard
      title="Your Chiefs"
      actions={
        <Button
          variant="secondary"
          onClick={() =>
            chiefs.create().then(
              (made) => navigate(`${chiefPath(made)}?settings=name`),
              (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
            )
          }
        >
          New Chief
        </Button>
      }
    >
      {problem ? (
        <p role="alert" className="px-5 py-3 text-[13px] text-destructive">
          {problem}
        </p>
      ) : null}
      {chiefs.chiefs.map((c) => (
        <SettingRow key={c.id} to={`${chiefPath(c)}?settings`} icon={<ChiefSprite avatar={c.avatar} />} label={c.name} description={`${thinks(c)} · ${ACCESS[c.access ?? newChats].label} · ${reach(c.project_ids)}`}>
          {c.home ? "Home" : null}
        </SettingRow>
      ))}
    </SettingsCard>
  );
}

/**
 * The global capture shortcut: press it in any app for a one-line box that
 * drops a note on the Queue. Click the field and press the new chord; the
 * desktop says at once whether macOS let it have it.
 */
function CaptureShortcut({ value, onSave }: { value: string; onSave: (accelerator: string) => Promise<void> }) {
  const desktop = typeof window !== "undefined" ? window.cavemanDesktop?.capture : undefined;
  const [state, setState] = useState<CaptureShortcutState | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.status().then(setState);
  }, [desktop, value]);
  const bind = async (accelerator: string) => {
    setRecording(false);
    if (!desktop) return;
    const next = await desktop.setShortcut(accelerator);
    setState(next);
    if (next?.registered && next.accelerator === accelerator) {
      setNote(null);
      await onSave(accelerator);
    } else setNote(`${formatAccelerator(accelerator)} is taken by another app; ${next?.registered ? `${formatAccelerator(next.accelerator)} still works` : "nothing is bound"}.`);
  };
  const shown = state?.accelerator ?? value;
  return (
    <SettingsCard title="Capture" description={`A note from any app to the Chief of the project it is about. ${keysText("⌥Enter", "alt+enter")} queues it without the Chief.`}>
      <SettingRow
        label="Shortcut"
        description={
          !desktop ? (
            "In the desktop app."
          ) : note ? (
            <span className="text-destructive">{note}</span>
          ) : state && !state.registered ? (
            <span className="text-destructive">{formatAccelerator(shown)} could not be registered: another app has it. Pick another.</span>
          ) : (
            `Click, then press keys with ${IS_MAC ? "⌃, ⌥ or ⌘" : "Ctrl or Alt"}.`
          )
        }
      >
        <button
          type="button"
          disabled={!desktop}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return;
            e.preventDefault();
            if (e.key === "Escape") return setRecording(false);
            const accelerator = acceleratorFrom(e);
            if (accelerator) void bind(accelerator);
          }}
          aria-label={recording ? "Press the new shortcut" : `Capture shortcut ${formatAccelerator(shown)}`}
          className={cn(
            CONTROL,
            "h-8 rounded-md border bg-control px-2.5 text-[13px] tabular-nums outline-none transition-colors duration-75 focus-visible:border-ring disabled:opacity-50",
            recording ? "border-ring text-muted-foreground" : "border-input text-foreground hover:bg-accent",
          )}
        >
          {recording ? "Press keys…" : formatAccelerator(shown)}
        </button>
      </SettingRow>
    </SettingsCard>
  );
}
