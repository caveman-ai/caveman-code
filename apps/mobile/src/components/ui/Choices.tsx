// An ask's options, as the desktop's approval and question card draws them (apps/web/src/components/Transcript.tsx,
// the ask card): one full-width row per option, stacked, rounded 10 with an edge. The way forward (the first Allow)
// sits raised on the secondary card's fill with the field edge and a 500 label; the rest stay outlined in the
// hairline. A description goes under its label in grey. The desktop's number keys mean nothing on a phone, so there
// are none; the row is the target.
//
// And the one yes-and-no every screen draws the same way (DECISIONS.md "Approval dock"): ApprovalPair, Deny on the
// `control` grey at the left and Allow, the one `primary` action, at the right, equal widths 8 apart and fully round,
// 48 pt where the decision stands alone (the thread's dock, the Chief's dock and Ready card, Peek) and 44 inline (a
// Needs you row, an agents sheet); and CommandChip, what Allow lets run, in mono on `control` behind a grey "$".
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import { haptic } from "../../motion";
import { alpha, mono, radius, useTheme, weight } from "../../theme";
import { PixelIcon, StateMark } from "../Pixel";
import { Squish } from "../Squish";

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

export function Choices({ options, lead = 0, onPick, disabled }: { options: readonly Choice[]; /** The option that goes forward, raised; -1 for none. */ lead?: number; onPick: (id: string) => void; disabled?: boolean }) {
  const { c, t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {options.map((o, i) => {
        const raised = i === lead;
        return (
          <Squish
            key={o.id}
            label={o.description ? `${o.label}, ${o.description}` : o.label}
            onPress={() => onPick(o.id)}
            disabled={disabled}
            depth={0.98}
            style={{
              minHeight: 48,
              justifyContent: "center",
              paddingHorizontal: 14,
              paddingVertical: 11,
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: raised ? c.field : c.hairline,
              backgroundColor: raised ? alpha(c.text, 0.08) : undefined,
            }}
          >
            <Text style={[t.row, { fontWeight: raised ? "500" : "400" }]}>{o.label}</Text>
            {o.description ? <Text style={[t.small, { marginTop: 2 }]}>{o.description}</Text> : null}
          </Squish>
        );
      })}
    </View>
  );
}

/** Allow or Deny: Allow raised as the way forward, Deny outlined under it. */
export function Approval({ onAllow, onDeny, allow = "Allow", deny = "Deny" }: { onAllow: () => void; onDeny: () => void; allow?: string; deny?: string }) {
  return (
    <Choices
      options={[
        { id: "allow", label: allow },
        { id: "deny", label: deny },
      ]}
      onPick={(id) => (id === "allow" ? onAllow() : onDeny())}
    />
  );
}

// ---------------------------------------------------------------- the one yes-and-no

/** How long a pair stays deaf after it arrives, reflows or pages, so a tap meant for what was there never decides. */
export const ARM_MS = 450;

/** The pair's heights: alone (a dock, a card, Peek) and inline (a row, a sheet's row). */
export const PAIR_HEIGHT = { standard: 48, inline: 44 } as const;

/**
 * Deny | Allow (or Later | Ship it). Neither hears a tap for ARM_MS after it appears, or after `armKey` changes (the
 * card paged, the list reflowed under it), or while `armed` says the moment isn't the person's yet.
 */
export function ApprovalPair({
  onAllow,
  onDeny,
  allow = "Allow",
  deny = "Deny",
  size = "standard",
  command,
  armKey,
  armed,
}: {
  onAllow: () => void;
  onDeny: () => void;
  allow?: string;
  deny?: string;
  size?: keyof typeof PAIR_HEIGHT;
  /** What Allow lets run, for VoiceOver ("Allow: vercel deploy --prod"). */
  command?: string;
  /** Changes when what the pair answers changes (paging), which arms it again. */
  armKey?: string | number;
  /** Whether a tap now is meant, given when the pair last armed; by default only ARM_MS. */
  armed?: (since: number) => boolean;
}) {
  const since = useRef(Date.now());
  useEffect(() => {
    since.current = Date.now();
  }, [armKey]);
  const ready = () => (armed ? armed(since.current) : Date.now() - since.current >= ARM_MS);
  const press = (yes: boolean) => {
    if (!ready()) return;
    if (yes) haptic.thud();
    else haptic.tap();
    (yes ? onAllow : onDeny)();
  };
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <PairButton label={deny} said={command ? `${deny}: ${command}` : deny} size={size} onPress={() => press(false)} />
      <PairButton label={allow} said={command ? `${allow}: ${command}` : allow} size={size} primary onPress={() => press(true)} />
    </View>
  );
}

function PairButton({ label, said, size, primary = false, onPress }: { label: string; said: string; size: keyof typeof PAIR_HEIGHT; primary?: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const h = PAIR_HEIGHT[size];
  return (
    <View style={{ flex: 1 }}>
      <Squish label={said} depth={0.97} onPress={onPress} style={{ height: h, borderRadius: h / 2, alignItems: "center", justifyContent: "center", backgroundColor: primary ? c.primary : c.control }}>
        <Text numberOfLines={1} style={[t.button, { fontSize: size === "standard" ? 17 : 16, lineHeight: 22, fontWeight: weight.medium, color: primary ? c.onPrimary : c.text }]}>
          {label}
        </Text>
      </Squish>
    </View>
  );
}

/**
 * A command set to break only where a reader would: at its spaces and after a "/", never inside a token at a hyphen
 * ("@caveman-app/" may end a line; "react-native-keyboard-controller" never splits).
 */
export function breakable(command: string): string {
  // A word joiner after each hyphen takes away the break the browser and CoreText would make there; a zero-width space
  // after each slash gives one where a path or a scope may wrap.
  return command.replace(/-/g, "-\u2060").replace(/\//g, "/\u200b");
}

/**
 * A command cut for one line of meta, from the middle, keeping the start (the tool) and as much of the end (what it
 * acts on) as fits: "pnpm … add react-native-keyboard-controller".
 */
export function middleOf(command: string, budget = 44): string {
  if (command.length <= budget) return command;
  const words = command.split(" ");
  const head = words[0] ?? "";
  const tail: string[] = [];
  for (let i = words.length - 1; i > 0; i--) {
    const next = [words[i]!, ...tail].join(" ");
    if (head.length + 3 + next.length > budget && tail.length) break;
    tail.unshift(words[i]!);
  }
  return `${head} … ${tail.join(" ")}`;
}

/**
 * What Allow lets run: mono 15 on `control`, radius 12, "$" in the tertiary grey. Beside an Allow it wraps (three
 * lines at most for any command an agent sends) and never truncates; `line` cuts it from the middle for one line of
 * meta instead.
 */
export function CommandChip({ command, line = false, trailing }: { command: string; line?: boolean; trailing?: ReactNode }) {
  const { c } = useTheme();
  return (
    <View accessible accessibilityLabel={`Command: ${command}`} style={{ flexDirection: "row", alignItems: "flex-start", borderRadius: 12, backgroundColor: c.control, paddingHorizontal: 14, paddingVertical: 12 }}>
      <Text selectable={!line} numberOfLines={line ? 1 : undefined} style={{ flex: 1, fontFamily: mono, fontSize: 15, lineHeight: 21, color: c.text }}>
        <Text style={{ color: c.subtle }}>$ </Text>
        {line ? middleOf(command) : breakable(command)}
      </Text>
      {trailing}
    </View>
  );
}

/**
 * A command cut to keep its tail, for the resolved line: from the middle when its tool and last words fit ("pnpm …
 * --env staging"); else only its end, from a hyphen, slash or space ("…keyboard-controller"), never its start alone.
 */
export function tailOf(command: string, budget: number): string {
  const mid = middleOf(command, budget);
  if (mid.length <= budget) return mid;
  const end = command.slice(-(budget - 1));
  const at = end.search(/[-/ ]/);
  return `…${at >= 0 && at < end.length - 6 ? end.slice(at + 1) : end}`;
}

/** The resolved line's height: an answered ask, wherever it was answered. */
export const RESOLVED_HEIGHT = 56;

/** A mono 14 character, near enough, for how much of a command the resolved line can keep. */
const MONO_CH = 8.5;

/**
 * An answer waiting behind its Undo, drawn the one way wherever it was given (a Needs you row, the thread's dock, the
 * Chief's deck and sheet): a 16 pt pixel check in `success` (a stop mark for a no), "Allowing" or "Denying" in the
 * description grey, the command Allow let run in mono 14, cut from the middle so its tail stays ("pnpm … --env
 * staging", the part that says what it touches), and Undo, a 44 pt text button in ink at the right. It is 56 tall and
 * draws no surface of its own: in a dock or a card it sits on that opaque card. Undo is deaf for ARM_MS, so the second
 * tap of a double tap on Allow never takes it back. `code: false` says a plain subject instead ("Shipping Dark mode
 * for Runs").
 */
export function ResolvedLine({ yes, verb, what, code = true, onUndo }: { yes: boolean; verb?: string; what: string; code?: boolean; onUndo: () => void }) {
  const { c, t } = useTheme();
  const since = useRef(Date.now());
  const [width, setWidth] = useState(0);
  const said = verb ?? (yes ? "Allowing" : "Denying");
  // VoiceOver hears what it is doing and that it can still be taken back.
  useEffect(() => AccessibilityInfo.announceForAccessibility(`${said} ${what}. Undo is next to it.`), [said, what]);
  // The room the command has: the line, less the mark, the verb, Undo and the gaps between them.
  const budget = width ? Math.max(12, Math.floor((width - 16 - 10 - said.length * 8 - 6 - 64) / MONO_CH)) : 22;
  return (
    <View
      accessibilityLiveRegion="polite"
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: RESOLVED_HEIGHT }}
    >
      {yes ? <PixelIcon name="state-done" label="Done" /> : <StateMark name="state-stopped" />}
      <Text numberOfLines={1} style={[t.body, { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: "400", color: c.muted }]}>
        {said}{" "}
        <Text style={code ? { fontFamily: mono, fontSize: 14 } : null}>{code ? tailOf(what, budget) : what}</Text>
      </Text>
      <Squish
        label={`Undo: ${said.toLowerCase()} ${what}`}
        depth={0.95}
        onPress={() => {
          if (Date.now() - since.current < ARM_MS) return;
          haptic.tap();
          onUndo();
        }}
        style={{ height: 44, minWidth: 44, paddingHorizontal: 12, marginRight: -12, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={[t.button, { fontSize: 15, lineHeight: 20, fontWeight: weight.semibold, color: c.text }]}>Undo</Text>
      </Squish>
    </View>
  );
}
