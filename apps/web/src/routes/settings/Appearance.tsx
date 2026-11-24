import { Button } from "@caveman-app/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { CAST, DEFAULT_COMPANION, SKIN_TONES, setCompanion, useCast, useCompanion } from "@caveman-app/ui/mascot/cast";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { cn } from "@caveman-app/ui/lib/cn";
import type { Settings } from "@caveman-app/session-protocol";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { attachedFile } from "../../components/Composer.tsx";
import { MONO_FONTS } from "../../state/appearance.ts";
import { flushDrafts, keepDraft, keepFiles } from "../../state/composer-drafts.ts";
import { companionPrompt, loadCompanions, useCompanionsFolder } from "../../state/companions.ts";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { CONTROL, Segmented, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";
import { ThemeSettingsCard } from "./Themes.tsx";
import { WallpaperSettingsCard } from "./Wallpaper.tsx";

type MonoFont = NonNullable<Settings["mono_font"]>;

/** Settings > Appearance: theme, text, code font and density for this runtime's clients; the wallpaper and the companion for this device. */
export function AppearanceSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const mono = settings?.mono_font ?? "sf_mono";
  return (
    <>
      <ThemeSettingsCard />
      <WallpaperSettingsCard />
      <SettingsCard title="Interface">
        <SettingRow label="Text size">
          <Segmented
            label="Text size"
            value={settings?.text_size ?? "default"}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
              { value: "larger", label: "Larger" },
            ]}
            onChange={(text_size) => void save({ text_size })}
          />
        </SettingRow>
        <SettingRow label="Code font" description={<span style={{ fontFamily: "var(--font-jetbrains)" }}>const answer = few_words(); // 0O 1lI</span>}>
          <Select value={mono} onValueChange={(v) => void save({ mono_font: v as MonoFont })}>
            <SelectTrigger aria-label="Code font" className={CONTROL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MONO_FONTS) as MonoFont[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {MONO_FONTS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Density">
          <Segmented
            label="Density"
            value={settings?.density ?? "comfortable"}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={(density) => void save({ density })}
          />
        </SettingRow>
      </SettingsCard>
      <CompanionCard />
    </>
  );
}

/** Who stands in the new chat, the empty states and the working line, and their skin tone. Kept on this device (cast.ts). */
function CompanionCard() {
  const { character, tone } = useCompanion();
  const cast = useCast();
  const current = cast.find((c) => c.id === character) ?? CAST[0]!;
  // People take a skin tone (the made ones too, on the caveman's build); the animals and the pet rock don't.
  const groups = [
    { label: "People", members: cast.filter((c) => c.skin) },
    { label: "Animals", members: cast.filter((c) => !c.skin) },
  ];
  return (
    <SettingsCard title="Companion" description={`${current.name}: ${current.line}`}>
      <div role="radiogroup" aria-label="Companion" className="flex flex-col gap-3 px-5 py-4">
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="flex flex-col gap-1.5">
            <span aria-hidden className="text-xs text-muted-foreground">
              {g.label}
            </span>
            <div className="flex flex-wrap gap-2">
              {g.members.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={c.id === character}
                  aria-label={c.name}
                  title={c.name}
                  onClick={() => setCompanion({ character: c.id })}
                  className={cn(
                    "px-play-hover grid size-14 place-items-center rounded-lg border border-transparent outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    c.id === character && "border-foreground/40 bg-accent/60",
                  )}
                >
                  <Mascot character={c.id} pose="wave" scale={2} animate={false} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <CreateCompanionRow />
      <SettingRow label="Skin tone" description={current.skin ? undefined : `${current.name} has no skin tone.`}>
        <div role="radiogroup" aria-label="Skin tone" className="flex items-center gap-1">
          {SKIN_TONES.map((t, i) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={t === tone}
              aria-label={`Skin tone ${i + 1} of ${SKIN_TONES.length}`}
              disabled={!current.skin}
              onClick={() => setCompanion({ tone: t })}
              className={cn(
                "grid size-8 place-items-center rounded-lg border border-transparent outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                t === tone && "border-foreground/40",
              )}
            >
              {/* The tone's own skin token on a notched pixel tile (pixel.css .px-skin-*). */}
              <span aria-hidden className={cn("px-notch block size-5", t !== DEFAULT_COMPANION.tone && `px-skin-${t}`)} style={{ background: "hsl(var(--id-skin))" }} />
            </button>
          ))}
        </div>
      </SettingRow>
    </SettingsCard>
  );
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Make your own: an image goes to a New chat with the message that asks for a companion
 * from it (state/companions.ts); the chat saves it to the folder and it joins the cast
 * above. The folder is read again each time this opens, and files it cannot use are listed.
 */
function CreateCompanionRow() {
  const { client } = useRuntimeClient();
  const navigate = useNavigate();
  const made = useCompanionsFolder();
  const picker = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (client) void loadCompanions(client);
  }, [client]);
  const start = async (file: File | undefined) => {
    if (!file || !made) return;
    if (!file.type.startsWith("image/")) return setNote("Choose an image file.");
    if (file.size > MAX_IMAGE_BYTES) return setNote(`${file.name} is over 10 MB.`);
    keepDraft("new-chat", { text: companionPrompt(made.folder), refs: [] });
    flushDrafts("new-chat");
    keepFiles("new-chat", [await attachedFile(file)]);
    navigate("/new");
  };
  return (
    <SettingRow
      label="Make your own"
      description={
        <>
          {made ? "A chat draws it from any image, in the cast's style." : "Update Caveman Code to make your own."}
          {note ? <span className="block text-destructive">{note}</span> : null}
          {made?.problems.map((p) => (
            <span key={p.id} className="block text-destructive">
              {p.id}.json: {p.problem}
            </span>
          ))}
        </>
      }
    >
      <input ref={picker} type="file" accept="image/*" hidden onChange={(e) => void start(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      <Button variant="outline" disabled={!made} onClick={() => picker.current?.click()}>
        Choose an image…
      </Button>
    </SettingRow>
  );
}
