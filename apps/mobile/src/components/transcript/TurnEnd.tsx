// What closes a finished turn (DECISIONS.md "Changes pill", "Action row"): what it changed as one quiet line, a flat
// card 48pt tall with a hairline, rounded 14 (a file glyph, "2 files changed", the lines added and removed, ›), which
// opens the change when it is the one waiting for you, or lists its files in place on an older turn; then on the
// latest turn only, copy, share and retry on 44pt centres and when it ended. Thumbs and fork live in the ··· menu.
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Share, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import type { FileChange } from "../../board/model";
import { enter } from "../../motion";
import { mono, touch, useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { PixelIcon } from "../Pixel";
import { Squish } from "../Squish";
import { Counts } from "./Parts";

/** One line for everything a turn changed; zero counts are left out, never "−0". */
export function ChangesPill({ files, onOpen }: { files: readonly FileChange[]; /** Opens the change; absent, the pill lists its files in place. */ onOpen?: () => void }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState(false);
  const added = files.reduce((n, f) => n + f.add, 0);
  const removed = files.reduce((n, f) => n + f.del, 0);
  const words = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
  const label = `${words}${added ? `, ${added} added` : ""}${removed ? `, ${removed} removed` : ""}`;
  return (
    <View style={{ borderRadius: 14, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.card, overflow: "hidden" }}>
      <Squish
        label={onOpen ? `${label}. Review the change` : `${label}. ${open ? "Hide" : "Show"} the files`}
        depth={0.985}
        highlight
        onPress={onOpen ?? (() => setOpen(!open))}
        style={{ height: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 }}
      >
        <PixelIcon name="artifact-file" />
        <Text numberOfLines={1} style={[t.row, { flexShrink: 1 }]}>
          {words}
          <Counts added={added} removed={removed} size={14} />
        </Text>
        <View style={{ flex: 1 }} />
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} color={c.subtle} />
      </Squish>
      {open ? (
        <Animated.View entering={enter.fade} style={{ borderTopWidth: 1, borderTopColor: c.hairline, paddingVertical: 4 }}>
          {files.map((file) => {
            const slash = file.path.lastIndexOf("/");
            return (
              <View key={file.path} accessible accessibilityLabel={`${file.path}, ${file.add} added, ${file.del} removed`} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 14 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: mono, fontSize: 13 }}>
                  <Text style={{ color: c.subtle }}>{file.path.slice(0, slash + 1)}</Text>
                  <Text style={{ color: c.text }}>{file.path.slice(slash + 1)}</Text>
                </Text>
                <Text>
                  <Counts added={file.add} removed={file.del} />
                </Text>
              </View>
            );
          })}
        </Animated.View>
      ) : null}
    </View>
  );
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Under the latest answer: copy (a check for two seconds once copied), share, retry, then when it ended. */
export function ActionRow({ text, at, onRetry }: { text: string | null; at: number | null; /** Absent on a subagent: its parent asks again. */ onRetry?: () => void }) {
  const { c, t } = useTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const plain = text?.replace(/\*\*|`|^#+\s|\[\[|\]\]/gm, "") ?? "";
  const buttons: { icon: IconName; label: string; ink?: string; run: () => void }[] = [];
  if (plain) {
    buttons.push({ icon: copied ? "check" : "copy", label: copied ? "Copied" : "Copy the answer", ink: copied ? c.success : undefined, run: () => void Clipboard.setStringAsync(plain).then(() => setCopied(true)) });
    buttons.push({ icon: "share", label: "Share the answer", run: () => void Share.share({ message: plain }).catch(() => {}) });
  }
  if (onRetry) buttons.push({ icon: "retry", label: "Try it again", run: onRetry });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: touch, marginLeft: -13 }}>
      {buttons.map((b) => (
        <Squish key={b.label} label={b.label} depth={0.85} onPress={b.run} style={{ width: touch, height: touch, borderRadius: touch / 2, alignItems: "center", justifyContent: "center" }}>
          <Icon name={b.icon} size={18} color={b.ink ?? c.subtle} stroke={b.icon === "check" ? 2 : 1.75} />
        </Squish>
      ))}
      {at ? <Text style={[t.meta, { marginLeft: buttons.length ? 4 : 13 }]}>{timeOf(at)}</Text> : null}
    </View>
  );
}
