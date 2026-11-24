import { cn } from "@caveman-app/ui/lib/cn";
import type { CSSProperties, ReactNode } from "react";

/**
 * A textarea over its own highlighted copy: the copy sets the height and shows the colours, the textarea on top
 * (its text transparent, its caret not) takes the typing. Same font, size, padding and wrapping, so they line up.
 */
export function MarkdownField({ value, label, onChange, onBlur, onSave }: { value: string; label: string; onChange: (value: string) => void; onBlur: () => void; onSave: () => void }) {
  const shared = "m-0 whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12.5px] leading-5 [tab-size:2]";
  return (
    <div className="relative min-h-[260px] bg-[hsl(var(--background)/0.35)]" style={MARKDOWN_TOKENS}>
      <pre aria-hidden className={cn(shared, "pointer-events-none min-h-[260px] text-foreground/90")}>
        {highlight(value)}
        {/* A last empty line still takes its height, so the caret never drops below the copy. */}
        {"\n"}
      </pre>
      <textarea
        value={value}
        aria-label={label}
        spellCheck={false}
        placeholder={"# Soul\n\n## Standing instructions\n- Anything it should always keep in mind."}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave();
          }
        }}
        className={cn(
          shared,
          "absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none",
          "selection:bg-foreground/15 placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--ring)/0.35)]",
        )}
      />
    </div>
  );
}

/** The code colours (ai/code-block.tsx CODE_THEME) a markdown line takes here: headings as keywords, marks as punctuation. */
const MARKDOWN_TOKENS = {
  "--md-heading": "hsl(var(--chart-4))",
  "--md-mark": "hsl(var(--muted-foreground))",
  "--md-code": "hsl(var(--chart-3))",
} as CSSProperties;

/** One line's spans: a heading in the keyword colour (its #s dimmer), list and quote marks grey, `code` as a string. */
export function highlight(text: string): ReactNode[] {
  return text.split("\n").flatMap((line, i) => {
    const out: ReactNode[] = i === 0 ? [] : ["\n"];
    const heading = /^(#{1,6})(\s.*)?$/.exec(line);
    if (heading) {
      out.push(
        <span key={i} style={{ color: "var(--md-heading)" }}>
          <span className="opacity-60">{heading[1]}</span>
          {heading[2] ?? ""}
        </span>,
      );
      return out;
    }
    const mark = /^(\s*(?:[-*+]|\d+[.)]|>)(?:\s|$))(.*)$/.exec(line);
    const rest = mark ? mark[2]! : line;
    if (mark)
      out.push(
        <span key={`${i}m`} style={{ color: "var(--md-mark)" }}>
          {mark[1]}
        </span>,
      );
    rest.split(/(`[^`\n]+`)/).forEach((part, j) =>
      out.push(
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <span key={`${i}c${j}`} style={{ color: "var(--md-code)" }}>
            {part}
          </span>
        ) : (
          part
        ),
      ),
    );
    return out;
  });
}
