// What a finished turn changed and the row under it, as the desktop draws them (apps/web/src/components/transcript/
// TurnChanges.tsx, using compact styling): "Changed 4 files" with the lines added and removed and Review, then each file with
// its type's mark and its counts in their own columns (a zero says nothing), the first three and "Show 1 more file".
// The board keeps no checkpoints, so the card has no Undo or Keep, as the desktop's has none for files no checkpoint
// saw. Under the turn, its footer: copy the answer, read it aloud and share it (the phone's own, 2026-10-26), then when
// it ended. The screenshots a turn took show as one thumbnail strip under its line, and open the change.
import * as Clipboard from "expo-clipboard";
import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { Share, Text, type TextStyle, View } from "react-native";
import type { FileChange } from "../../board/model";
import { alpha, mono, useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Squish } from "../Squish";
import { FileTypeMark } from "./FileTypeMark";

/** Files shown before "Show N more files" (compact three). */
const SHOWN = 3;

const fileRow = { flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 12 } as const;

/** Lines added and removed in the diff inks, a true minus; in a list each count keeps its own column. */
function Counts({ add, del, column = false, size = 12 }: { add: number; del: number; column?: boolean; size?: number }) {
  const { c } = useTheme();
  const style: TextStyle = { fontSize: size, fontWeight: "600", fontVariant: ["tabular-nums"], minWidth: column ? 34 : undefined, textAlign: column ? "right" : undefined };
  const plus = add > 0 || del === 0 ? `+${add.toLocaleString()}` : "";
  const minus = del > 0 ? `−${del.toLocaleString()}` : "";
  return (
    <View style={{ flexDirection: "row", gap: column ? 6 : 6, flexShrink: 0 }}>
      {plus || column ? <Text style={[style, { color: c.added }]}>{plus}</Text> : null}
      {minus || column ? <Text style={[style, { color: c.removed }]}>{minus}</Text> : null}
    </View>
  );
}

export function TurnChanges({ files, onReview }: { files: readonly FileChange[]; /** Opens the change; absent, the card only lists. */ onReview?: () => void }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState(false);
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const listed = open ? files : files.slice(0, SHOWN);
  const more = files.length - SHOWN;
  const ink = (a: number) => alpha(c.text, a);
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: ink(0.06), backgroundColor: ink(0.03), overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: 8, paddingVertical: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: ink(0.08), alignItems: "center", justifyContent: "center" }}>
          <Icon name="diff" size={18} color={ink(0.55)} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.label, { color: ink(0.8) }]}>
            Changed {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
          <Counts add={add} del={del} size={13} />
        </View>
        {onReview ? (
          <Squish label="Review the change" depth={0.95} hitSlop={4} onPress={onReview} style={{ height: 36, paddingHorizontal: 14, borderRadius: 8, backgroundColor: ink(0.08), alignItems: "center", justifyContent: "center" }}>
            <Text style={[t.button, { fontSize: 14, color: ink(0.75) }]}>Review</Text>
          </Squish>
        ) : null}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: ink(0.05), paddingVertical: 4 }}>
        {listed.map((file) => {
          const label = `${file.path}, ${file.add} added, ${file.del} removed`;
          const row = (
            <>
              <FileTypeMark path={file.path} size={15} />
              <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontFamily: mono, fontSize: 13, color: ink(0.65) }}>
                {file.path}
              </Text>
              <Counts add={file.add} del={file.del} column />
            </>
          );
          // With nothing to open, a row is a line of the list, not a button (the desktop's disabled rows).
          return onReview ? (
            <Squish key={file.path} label={label} depth={0.99} highlight onPress={onReview} style={fileRow}>
              {row}
            </Squish>
          ) : (
            <View key={file.path} accessible accessibilityLabel={label} style={fileRow}>
              {row}
            </View>
          );
        })}
      </View>
      {more > 0 ? (
        <Squish label={open ? "Show fewer files" : `Show ${more} more ${more === 1 ? "file" : "files"}`} depth={0.99} highlight onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: ink(0.05) }}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} color={c.subtle} />
          <Text style={t.meta}>{open ? "Show fewer files" : `Show ${more} more ${more === 1 ? "file" : "files"}`}</Text>
        </Squish>
      ) : null}
    </View>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Under a finished turn (TurnFooter): copy the answer, with the desktop's check for two seconds; read it aloud; share
 * it; then a dot and when it ended. Quiet glyphs in the tertiary grey, 44pt to hit.
 */
export function TurnFooter({ text, at }: { text: string; at: number }) {
  const { c, t } = useTheme();
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => () => void Speech.stop(), []);
  const plain = text.replace(/\*\*|`|^#+\s/gm, "");
  const buttons: { icon: IconName; label: string; on?: boolean; ink?: string; run: () => void }[] = [
    { icon: copied ? "check" : "copy", label: copied ? "Copied" : "Copy answer", ink: copied ? c.success : undefined, run: () => void Clipboard.setStringAsync(plain).then(() => setCopied(true)) },
    {
      icon: speaking ? "stop" : "speak",
      label: speaking ? "Stop reading" : "Read aloud",
      on: speaking,
      run: () => {
        if (speaking) {
          void Speech.stop();
          setSpeaking(false);
          return;
        }
        setSpeaking(true);
        Speech.speak(plain, { onDone: () => setSpeaking(false), onStopped: () => setSpeaking(false), onError: () => setSpeaking(false) });
      },
    },
    { icon: "share", label: "Share", run: () => void Share.share({ message: plain }).catch(() => {}) },
  ];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 40, marginLeft: -11 }}>
      {buttons.map((b) => (
        <Squish
          key={b.label}
          label={b.label}
          selected={b.on}
          depth={0.85}
          hitSlop={2}
          onPress={b.run}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name={b.icon} size={18} color={b.ink ?? (b.on ? c.text : c.subtle)} stroke={b.icon === "check" ? 2 : 1.75} />
        </Squish>
      ))}
      <View style={{ width: 3, height: 3, borderRadius: 2, marginLeft: 6, marginRight: 10, backgroundColor: alpha(c.text, 0.25) }} />
      <Text style={t.meta}>{time(at)}</Text>
    </View>
  );
}
