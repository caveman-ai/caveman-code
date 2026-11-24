// Code, logs and a command's output, as the desktop's code block draws them (packages/ui/src/ai/code-block.tsx, after
// compact fences): one tinted shell (ink at 3.5% inside a 10% edge, rounded 12), mono on a 20pt line, line numbers
// at 30% ink once there are more than three lines. A fence gets a header with its language or file and Copy, which
// the desktop shows on hover and a touch screen shows from the start, the language's own mark beside it. Long ones fold to their first lines with
// "Show N more lines". Lines never wrap; the block scrolls sideways, so the chat never does.
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { alpha, mono, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { Squish } from "../Squish";
import { FileTypeMark } from "./FileTypeMark";

/** Lines shown before a long block folds (response.tsx COLLAPSED_LINES). */
const SHOWN_LINES = 14;

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TSX", typescript: "TypeScript", js: "JavaScript", jsx: "JSX", javascript: "JavaScript", go: "Go", golang: "Go",
  py: "Python", python: "Python", rs: "Rust", rust: "Rust", rb: "Ruby", ruby: "Ruby", sh: "Shell", bash: "Bash", zsh: "Shell", shell: "Shell",
  console: "Console", json: "JSON", yaml: "YAML", yml: "YAML", md: "Markdown", markdown: "Markdown", sql: "SQL", css: "CSS", html: "HTML",
  swift: "Swift", kotlin: "Kotlin", diff: "Diff", toml: "TOML", text: "Text", txt: "Text",
};

/** "go" reads "Go", an unknown fence its own name, none "Code". */
export function languageName(language: string | null): string {
  if (!language) return "Code";
  return LANGUAGES[language.toLowerCase()] ?? language;
}

/** The tinted shell every block sits in; `destructive` for a failed command's output. */
export function CodeShell({ children, destructive = false }: { children: ReactNode; destructive?: boolean }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: destructive ? alpha(c.destructive, 0.4) : alpha(c.text, 0.1),
        backgroundColor: destructive ? alpha(c.destructive, 0.04) : alpha(c.text, 0.035),
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

/** Copy, with the desktop's check for a moment after. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const { c } = useTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Squish
      label={copied ? "Copied" : label}
      depth={0.88}
      hitSlop={4}
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => setCopied(true));
      }}
      style={{ width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name={copied ? "check" : "copy"} size={16} stroke={copied ? 2 : 1.75} color={copied ? c.success : c.subtle} />
    </Squish>
  );
}

/** Mono lines, numbered when there are more than three, scrolling sideways rather than wrapping. */
export function CodeLines({ code, muted = false, numbers }: { code: string; muted?: boolean; numbers?: boolean }) {
  const { c, t } = useTheme();
  // A tab is four columns, as the desktop's fences set it (markdown.css tab-size).
  const lines = code.replace(/\n$/, "").replace(/\t/g, "    ").split("\n");
  const numbered = numbers ?? lines.length > 3;
  const ink = muted ? c.muted : alpha(c.text, 0.9);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}>
      <View>
        {lines.map((line, i) => (
          // Lines never reorder: the text is cut the same way every time.
          <View key={i} style={{ flexDirection: "row" }}>
            {numbered ? <Text style={[t.code, { color: alpha(c.text, 0.3), width: String(lines.length).length * 8 + 14, textAlign: "right", paddingRight: 14 }]}>{i + 1}</Text> : null}
            <Text selectable style={[t.code, { color: ink }]}>
              {line || " "}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** A fenced block in an answer: its language or file and Copy across the top, the code, a fold when it runs long. */
export function CodeBlock({ code, language, file }: { code: string; language: string | null; file?: string | null }) {
  const { c, t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const count = code.replace(/\n$/, "").split("\n").length;
  const long = count > SHOWN_LINES + 2;
  const shown = long && !expanded ? code.split("\n").slice(0, SHOWN_LINES).join("\n") : code;
  return (
    <CodeShell>
      <View style={{ flexDirection: "row", alignItems: "center", height: 40, paddingLeft: 12, paddingRight: 2, borderBottomWidth: 1, borderBottomColor: alpha(c.text, 0.08) }}>
        <FileTypeMark path={file ?? language ?? ""} size={14} />
        <Text numberOfLines={1} style={[file ? { fontFamily: mono, fontSize: 12.5 } : [t.small, { fontWeight: "500" }], { flex: 1, marginLeft: 8, color: alpha(c.text, 0.65) }]}>
          {file ?? languageName(language)}
        </Text>
        <CopyButton value={code} />
      </View>
      <CodeLines code={shown} numbers={count > 3} />
      {long ? (
        <Squish
          label={expanded ? "Show less" : `Show ${count - SHOWN_LINES} more lines`}
          depth={0.98}
          onPress={() => setExpanded(!expanded)}
          style={{ height: 40, justifyContent: "center", paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: alpha(c.text, 0.08) }}
        >
          <Text style={t.small}>{expanded ? "Show less" : `Show ${count - SHOWN_LINES} more lines`}</Text>
        </Squish>
      ) : null}
    </CodeShell>
  );
}
