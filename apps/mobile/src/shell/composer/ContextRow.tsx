// Where a new chat will run, at the top of the focused card (Cursor 5340, DECISIONS.md Home 8): the repo glyph and the
// workspace, its branch in mono, then the computer's glyph and its name as the Devices list says it, never "This Mac"
// (from a phone, "This Mac" is no Mac in particular). Each is a chip with a 44pt hit area that opens the Where sheet,
// leading with what was tapped: the workspace's chip with the projects, the computer's with the computers. The chip
// is 44 tall, its words centred in it, standing 10 past the 24 the row lays out at, above and below.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { type Device } from "../../board/model";
import { Icon } from "../../components/Icon";
import { DeviceGlyph, PixelIcon } from "../../components/Pixel";
import { Squish } from "../../components/Squish";
import { mono, sans, useTheme } from "../../theme";
import { HIT } from "./Controls";

/** The row as drawn; its chips are pressed at 44. */
const ROW = 24;

/** A computer's name without its owner: "Julius's MacBook Pro" reads "MacBook Pro" in a chip. */
export const deviceShort = (name: string) => name.replace(/^[^\s']+['’]s\s+/, "");

function Chip({ label, onPress, children }: { label: string; onPress?: () => void; children: ReactNode }) {
  const { c } = useTheme();
  const shape = { flexDirection: "row", alignItems: "center", gap: 6, height: HIT, minWidth: 0 } as const;
  // Fixed, it is only words: a disabled press would dim it to half ink.
  if (!onPress)
    return (
      <View accessible accessibilityLabel={label} style={shape}>
        {children}
      </View>
    );
  return (
    <Squish label={label} onPress={onPress} depth={0.96} style={shape}>
      {children}
      <Icon name="chevronDown" size={12} stroke={2} color={c.subtle} />
    </Squish>
  );
}

/**
 * About how wide the row stands at 15pt (SF averages 0.55em a character, SF Mono 0.6em at 14), with its glyphs, gaps
 * and chevrons. Close enough to decide whether the branch fits; the names themselves still truncate if they must.
 */
const wide = (repo: string, branch: string, name: string, fixed: boolean) => 22 + repo.length * 8.3 + 6 + branch.length * 8.4 + (fixed ? 0 : 18) + 16 + 22 + name.length * 8.3 + 18;

export function ContextRow({ repo, branch, device, width, onPress, fixed = false }: { repo: string; branch: string; device: Device; /** The room the row has: the card's width less its insets. */ width: number; /** Opens the Where sheet, leading with the projects or the computers. */ onPress: (focus: "repo" | "computer") => void; /** A workspace's own box: the workspace is the screen's, so only the computer changes. */ fixed?: boolean }) {
  const { c } = useTheme();
  const name = deviceShort(device.name);
  const asleep = device.status !== "online";
  // Where room is short, the branch steps aside before a workspace's name would cut (a new chat starts from it anyway).
  const showBranch = wide(repo, branch, name, fixed) <= width;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, minWidth: 0, height: ROW }}>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        {/* No project yet (a real computer with none): the chip asks for one. No branch is named where none is known. */}
        <Chip label={repo ? `Workspace ${repo}${branch ? `, branch ${branch}` : ""}${fixed ? "" : ". Change"}` : "Pick a project"} onPress={fixed ? undefined : () => onPress("repo")}>
          <PixelIcon name="repo" ink={c.subtle} />
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: "500", color: c.soft }}>
            {repo || "Pick a project"}
          </Text>
          {showBranch && branch ? (
            <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: mono, fontSize: 14, lineHeight: 20, color: c.subtle }}>
              {branch}
            </Text>
          ) : null}
        </Chip>
      </View>
      {/* The workspace's name gives way; the computer's never does (names are short, and it says where code runs). */}
      <View style={{ flexShrink: 0 }}>
        <Chip label={`Runs on ${device.name}${asleep ? `, ${device.status}` : ""}. Change`} onPress={() => onPress("computer")}>
          <DeviceGlyph device={device} ink={c.subtle} />
          <Text numberOfLines={1} style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: "500", color: c.soft }}>
            {name}
          </Text>
        </Chip>
      </View>
    </View>
  );
}
