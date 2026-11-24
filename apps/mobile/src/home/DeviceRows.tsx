// A computer's line (DECISIONS.md "Home, exactly" 6, the rows for computers wherever they appear: Search, a
// computer's page). Each place your chats run, a Mac by its own name and Cloud as the one place it is, gets a dot and
// words: green "Online · 4 running ● 1 needs you" for a Mac and "Running" for Cloud, the ask's colour in its own 6 pt
// dot and never in the words (as a workspace's line), a hollow grey dot for "Asleep" and for "Offline · last seen
// 18 min ago". The state is the one word a person's own computers are said in (live/words.ts): Online, Asleep or
// Offline for a Mac; Running, Asleep or Waking… for Cloud.
import { Text, View } from "react-native";
import type { Device } from "../board/model";
import type { DeviceRow } from "../store/select";
import { useTheme } from "../theme";
import { seenAgo } from "./model";
import { StateDot } from "./WorkspaceRows";

/** The words after a device's dot. */
export function deviceWords(d: Pick<DeviceRow, "device" | "needs" | "working">, now: number): { lead: string; rest: string[]; needs: string | null } {
  const { device } = d;
  if (device.status === "asleep") return { lead: "Asleep", rest: [], needs: null };
  if (device.status === "offline") return { lead: "Offline", rest: [`last seen ${seenAgo(device.lastSeen, now)}`], needs: null };
  if (device.status === "starting") return { lead: "Waking…", rest: [], needs: null };
  // A Mac is Online; Cloud is Running, so its chats at work are counted in another word.
  const cloud = device.kind === "cloud";
  return { lead: cloud ? "Running" : "Online", rest: d.working ? [`${d.working} ${cloud ? "working" : "running"}`] : [], needs: d.needs ? `${d.needs} ${d.needs === 1 ? "needs" : "need"} you` : null };
}

/** A device's dot: green while it answers, hollow grey while it sleeps or is gone. */
export function DeviceDot({ device }: { device: Device }) {
  const { c } = useTheme();
  const on = device.status === "online" || device.status === "starting";
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: on ? c.success : undefined, borderWidth: on ? 0 : 1.5, borderColor: c.subtle }} />;
}

export function DeviceLine({ d, now }: { d: Pick<DeviceRow, "device" | "needs" | "working">; now: number }) {
  const { c, t } = useTheme();
  const { lead, rest, needs } = deviceWords(d, now);
  const words = [t.row, { fontSize: 14, lineHeight: 18, color: c.muted }];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
      <DeviceDot device={d.device} />
      <Text numberOfLines={1} style={[words, { flexShrink: 1 }]}>
        {[lead, ...rest].join(" · ")}
      </Text>
      {/* The ask's dot stands in for the separator: "Online · 2 running ● 1 needs you". */}
      {needs ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 4, flexShrink: 0 }}>
          <StateDot color={c.warning} />
          <Text numberOfLines={1} style={words}>
            {needs}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const deviceGlyph = (d: Device) => (d.kind === "cloud" ? ("computer-cloud" as const) : ("computer-this-mac" as const));
