// Text fields on the desktop's terms (packages/ui/src/components/input.tsx, STYLE.md 5 "Every search box is
// SearchField"): typed text at 16pt, which also keeps iOS from zooming into the field, placeholders in the tertiary
// grey, an edge that lifts to the field grey while focused. A search box carries the pixel lens and, once it holds
// words, the desktop's clear button (FilterBar.tsx; a phone has no Escape to clear it). A picker's search (the model
// picker's) is the bare line with a hairline under it and no lens; a chooser's (where a chat runs) keeps a line lens.
// A sheet's search is the phone's capsule (native, IMG_5347), one field wherever a sheet searches (Search, Settings,
// the model picker, the agents sheets): 44pt, rounded 22, filled with the in-sheet control grey and nothing else (no
// edge, no shadow, no glass), a 20pt lens in grey, 17pt words with an ink caret, and a small grey clear circle once it
// holds words. Only a field that floats over rows at a sheet's foot (Connect's) is glass, since it floats.
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { TextInput, type TextInputInstance, type TextInputProps, View } from "react-native";
import { alpha, layout, mono as monoFace, radius, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { PixelIcon } from "../Pixel";
import { Squish } from "../Squish";
import { Frost, useInSheetFill } from "./Floating";

/** What a parent can do to a field it holds: give it the keyboard, or take it away. */
export interface FieldHandle {
  focus: () => void;
  blur: () => void;
}

export function SearchField({
  value,
  onChangeText,
  placeholder = "Search",
  variant = "box",
  autoFocus,
  onSubmitEditing,
  accessibilityLabel,
  mono = false,
  lens = false,
  glass = false,
  onFocus,
  onBlur,
  handle,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** `box`: the sidebar's search. `line`: a picker's search across its top. `capsule`: a sheet's search. */
  variant?: "box" | "line" | "capsule";
  autoFocus?: boolean;
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
  accessibilityLabel?: string;
  /** What's typed is code (a path, owner/name): it reads in mono once there is some, the placeholder stays sans. */
  mono?: boolean;
  /** A line search with the line lens before it, as the desktop's chooser has. */
  lens?: boolean;
  /** A capsule that floats over rows (Connect's, at the sheet's foot): glass instead of the fill. */
  glass?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  handle?: Ref<FieldHandle>;
}) {
  const { c, t } = useTheme();
  const fill = useInSheetFill();
  const [focused, setFocused] = useState(false);
  const field = useRef<TextInputInstance>(null);
  useImperativeHandle(handle, () => ({ focus: () => field.current?.focus(), blur: () => field.current?.blur() }), []);
  const capsule = variant === "capsule";
  const input = (
    <TextInput
      ref={field}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={c.subtle}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      autoFocus={autoFocus}
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      onSubmitEditing={onSubmitEditing}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      // The caret is ink, never the brand or the system blue (DECISIONS.md).
      cursorColor={c.text}
      selectionColor={capsule ? c.text : undefined}
      style={[t.body, { flex: 1, minWidth: 0, height: "100%", paddingVertical: 0 }, capsule ? { fontSize: 17, lineHeight: 22, letterSpacing: -0.2 } : null, mono && value ? { fontFamily: monoFace } : null, { outlineStyle: "none" } as object]}
    />
  );
  if (capsule) {
    const h = layout.float;
    const shape = { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, height: h, borderRadius: h / 2, paddingLeft: 13, paddingRight: value ? 2 : 14 };
    const inside = (
      <>
        <Icon name="search" size={20} color={c.muted} />
        {input}
        {value ? (
          <Squish
            label="Clear the search"
            onPress={() => {
              onChangeText("");
              field.current?.focus();
            }}
            depth={0.85}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: alpha(c.text, 0.32), alignItems: "center", justifyContent: "center" }}>
              <Icon name="close" size={11} stroke={2.6} color={c.panel} />
            </View>
          </Squish>
        ) : null}
      </>
    );
    return glass ? <Frost style={shape}>{inside}</Frost> : <View style={[shape, { backgroundColor: fill }]}>{inside}</View>;
  }
  if (variant === "line")
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.hairline }}>
        {lens ? <Icon name="search" size={16} color={c.muted} /> : null}
        {input}
      </View>
    );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingLeft: 10, paddingRight: value ? 4 : 12, borderRadius: radius.control, borderWidth: 1, borderColor: focused ? c.field : c.hairline }}>
      <PixelIcon name="search" ink={focused ? c.text : c.muted} />
      {input}
      {value ? (
        <Squish
          label="Clear the search"
          onPress={() => {
            onChangeText("");
            field.current?.focus();
          }}
          depth={0.85}
          hitSlop={6}
          style={{ width: 32, height: 32, borderRadius: radius.row, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="close" size={16} color={c.muted} />
        </Squish>
      ) : null}
    </View>
  );
}
