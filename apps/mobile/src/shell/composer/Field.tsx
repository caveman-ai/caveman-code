// The box's field: what you type at 17 with an ink caret, and under it a see-through copy of the same words laid out at
// the card's width. The copy measures how tall the words stand, so the card grows with them before they wrap out of
// view, and while the mic listens it paints what's being heard in italic grey after them (Cursor 5346); the field
// stays yours to type in. The box keeps this in one place in its tree, so the field never loses the keyboard.
import type { Ref } from "react";
import { Platform, Text, TextInput, type TextInputInstance } from "react-native";
import { sans, useTheme } from "../../theme";
import { BOX } from "./state";

const WEB = Platform.OS === "web";
/** The field's type: 17 on 22, the system face (DECISIONS.md: the field at 17, an ink caret). */
export const FIELD = { fontFamily: sans, fontSize: 17, lineHeight: BOX.line, fontWeight: "400" as const, letterSpacing: -0.2 };
/** How far the field's type follows Dynamic Type: half again, which still sits whole in the 56 pt box at rest. */
export const FIELD_SCALE = 1.5;

interface Props {
  input: Ref<TextInputInstance>;
  text: string;
  onText: (text: string) => void;
  /** Words being heard, not yet the draft's. */
  heard: string;
  placeholder: string;
  /** The card's field width, for the copy that measures. */
  width: number;
  /** How tall the words stand at that width. */
  onWords: (height: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** A hardware Enter (the web, an iPad's keyboard); Option held, it asks to queue. */
  onEnter: (alt: boolean) => void;
}

export function Field({ input, text, onText, heard, placeholder, width, onWords, onFocus, onBlur, onEnter }: Props) {
  const { c } = useTheme();
  return (
    <>
      <Text aria-hidden pointerEvents="none" maxFontSizeMultiplier={FIELD_SCALE} onLayout={(e) => onWords(Math.round(e.nativeEvent.layout.height))} style={[FIELD, { position: "absolute", top: 0, left: 0, width, color: "transparent" }]}>
        {text}
        {heard ? <Text style={{ color: c.subtle, fontStyle: "italic" }}>{text && !/\s$/.test(text) ? ` ${heard}` : heard}</Text> : null}
        {/* A trailing new line still takes its line. */}
        {"​"}
      </Text>
      <TextInput
        ref={input}
        maxFontSizeMultiplier={FIELD_SCALE}
        value={text}
        onChangeText={onText}
        placeholder={heard ? "" : placeholder}
        placeholderTextColor={c.subtle}
        multiline
        selectionColor={c.text}
        cursorColor={c.text}
        {...(WEB ? { rows: 1 } : null)}
        accessibilityLabel={placeholder}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyPress={(e) => {
          // Enter sends, Option+Enter queues while a turn runs, Shift+Enter is a new line.
          const key = e.nativeEvent as { key: string; shiftKey?: boolean; altKey?: boolean };
          if (WEB && key.key === "Enter" && !key.shiftKey) {
            e.preventDefault();
            onEnter(!!key.altKey);
          }
        }}
        style={[FIELD, { color: c.text, height: "100%", padding: 0, margin: 0, textAlignVertical: "top" }, WEB ? ({ outlineStyle: "none", caretColor: c.text, resize: "none" } as object) : null]}
      />
    </>
  );
}
