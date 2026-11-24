import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useState } from "react";
import { formatChord, IS_DESKTOP, IS_MAC } from "../../panels/chrome.tsx";
import { Keys, fixedShortcuts } from "../../shell/ShortcutHelp.tsx";
import { chordFromEvent, defaultChord, SHORTCUTS, setKeybindings, shortcutError, useKeybindings, type ShortcutCommand, type ShortcutGroup } from "../../state/keybindings.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { Segmented, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";

/** Settings > Keyboard: the send key, every shortcut with a way to change it, and the fixed ones. "?" opens the same list anywhere. */
export function KeyboardSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const sendWithMod = settings?.send_shortcut === "mod_enter";
  return (
    <>
      <SettingsCard>
        <SettingRow label="Send a message with" description={sendWithMod ? "Enter adds a new line." : "Shift+Enter adds a new line."}>
          <Segmented
            label="Send a message with"
            value={settings?.send_shortcut ?? "enter"}
            options={[
              { value: "enter", label: formatChord("enter") },
              { value: "mod_enter", label: formatChord("mod+enter") },
            ]}
            onChange={(send_shortcut) => void save({ send_shortcut })}
          />
        </SettingRow>
      </SettingsCard>
      <Rebindable group="App" />
      {IS_DESKTOP ? <Rebindable group="Tabs" /> : null}
      <Rebindable group="Panes" />
      {fixedShortcuts(sendWithMod).map((g) => (
        <SettingsCard key={g.title} title={g.title}>
          {g.rows.map((r) => (
            <SettingRow key={r.label} label={r.label}>
              <Keys>{r.keys}</Keys>
            </SettingRow>
          ))}
        </SettingsCard>
      ))}
    </>
  );
}

function Rebindable({ group }: { group: ShortcutGroup }) {
  const { client } = useRuntimeClient();
  const bound = useKeybindings();
  const [recording, setRecording] = useState<ShortcutCommand | null>(null);
  const [error, setError] = useState<{ command: ShortcutCommand; message: string } | null>(null);

  const set = async (command: ShortcutCommand, key: string | null) => {
    if (!client) return;
    setError(null);
    try {
      setKeybindings((await client.call("keybindings.set", { request_id: requestId(), command, key })).keybindings);
    } catch (e) {
      setError({ command, message: e instanceof Error ? e.message : String(e) });
    }
  };

  // The next key press (with its modifiers) becomes the shortcut; Escape keeps the old one.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const next = chordFromEvent(e, IS_MAC);
      if (next === null) return;
      setRecording(null);
      // A bare key would fire while typing; only the cheat sheet may have one.
      if (recording !== "app.shortcuts" && !/(^|\+)(mod|ctrl|alt|meta)\+/.test(next)) {
        return setError({ command: recording, message: `Add ${IS_MAC ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} so it never fires while you type.` });
      }
      void set(recording, next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <SettingsCard title={group}>
      {SHORTCUTS.filter((s) => s.group === group).map((s) => {
        const key = bound[s.command] ?? s.key;
        const changed = key !== defaultChord(s.command);
        return (
          <SettingRow key={s.command} label={s.label} description={error?.command === s.command ? <span className="text-destructive">{shortcutError(error.message, formatChord)}</span> : undefined}>
            <div className="flex items-center gap-2">
              {changed ? (
                <Button variant="ghost" onClick={() => void set(s.command, null)}>
                  Reset
                </Button>
              ) : null}
              <button
                type="button"
                aria-label={`${s.label}: ${formatChord(key)}. Change`}
                aria-pressed={recording === s.command}
                onClick={() => setRecording(recording === s.command ? null : s.command)}
                className="h-8 w-28 rounded-md border border-input bg-control px-2.5 font-mono text-[12px] outline-none transition-colors hover:bg-accent focus-visible:border-ring aria-pressed:border-ring"
              >
                {recording === s.command ? <span className="font-sans text-muted-foreground">Press keys…</span> : formatChord(key)}
              </button>
            </div>
          </SettingRow>
        );
      })}
    </SettingsCard>
  );
}
