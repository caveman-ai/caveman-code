// Adapted from shadcn/ui Code Block (registry/base-nova/ui/code-block.tsx,
// MIT, 2026-10 AI Elements): code, logs and diffs. Tailwind 3.4 + deck tokens
// (STYLE.md section 11), drawn using compact styling: one tinted shell (ink at 3.5%, a 10% hairline, 10px
// radius), mono 12px on a 20px line, line numbers at 30% ink, +/- lines tinted 7% in the diff inks with a
// marker so the change never depends on colour. Highlighting: Shiki (highlight.ts), deck-token theme.
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/cn";
import { copyText } from "../lib/copy-text";
import { useHighlightedCode } from "./highlight.ts";

/** Shiki's css-variables theme mapped onto deck tokens: no new hex. */
/** Token colours for highlighted code (ai/highlight.ts emits var(--shiki-token-*)); spread on any code container. */
export const CODE_THEME = {
  "--shiki-foreground": "hsl(var(--foreground) / 0.9)",
  "--shiki-background": "transparent",
  "--shiki-token-constant": "hsl(var(--chart-2))",
  "--shiki-token-string": "hsl(var(--chart-3))",
  "--shiki-token-string-expression": "hsl(var(--chart-3))",
  "--shiki-token-comment": "hsl(var(--muted-foreground))",
  "--shiki-token-keyword": "hsl(var(--chart-4))",
  "--shiki-token-parameter": "hsl(var(--foreground) / 0.9)",
  "--shiki-token-function": "hsl(var(--chart-line, var(--info)))",
  "--shiki-token-punctuation": "hsl(var(--muted-foreground))",
  "--shiki-token-link": "hsl(var(--chart-tone-2, var(--info)))",
  "--shiki-token-inserted": "hsl(var(--success))",
  "--shiki-token-deleted": "hsl(var(--destructive))",
  "--shiki-token-changed": "hsl(var(--warning))",
} as React.CSSProperties;

const codeBlockVariants = cva(
  "group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl border text-[12px] has-[>[data-slot=code-block-content]:focus-visible]:ring-2 has-[>[data-slot=code-block-content]:focus-visible]:ring-ring",
  {
    variants: {
      variant: {
        default: "border-foreground/10 bg-foreground/[0.035] text-foreground",
        destructive: "border-destructive/40 bg-destructive/[0.04] text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function CodeBlock({
  className,
  variant = "default",
  size = "default",
  style,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof codeBlockVariants> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="code-block"
      dir="ltr"
      data-variant={variant}
      data-size={size}
      style={{ ...CODE_THEME, ...style }}
      className={cn(codeBlockVariants({ variant }), size === "sm" && "text-[12px]", className)}
      {...props}
    />
  );
}

export function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn("flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-foreground/[0.08] pl-3 pr-1.5 text-foreground/65", className)}
      {...props}
    />
  );
}

export function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-title" className={cn("flex min-w-0 items-center gap-2 truncate font-sans text-[12px] font-medium text-foreground/65", className)} {...props} />;
}

/** Header actions; as a direct child of CodeBlock they float in on hover/focus. */
export function CodeBlockActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        "ml-auto flex shrink-0 items-center gap-0.5",
        "[[data-slot=code-block]>&]:absolute [[data-slot=code-block]>&]:right-1.5 [[data-slot=code-block]>&]:top-1.5 [[data-slot=code-block]>&]:z-10 [[data-slot=code-block]>&]:opacity-0 [[data-slot=code-block]>&]:transition-opacity [[data-slot=code-block]>&]:duration-150",
        "group-hover/code-block:[[data-slot=code-block]>&]:opacity-100 group-focus-within/code-block:[[data-slot=code-block]>&]:opacity-100 touch:[[data-slot=code-block]>&]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export const codeBlockActionClass =
  "grid size-6 place-items-center rounded-md text-[hsl(var(--subtle-foreground))] outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5";

export function CodeBlockCopyButton({ value, className, onClick, ...props }: React.ComponentProps<"button"> & { value: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        className={cn(codeBlockActionClass, className)}
        onClick={(e) => {
          onClick?.(e);
          copyText(value)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        {...props}
      >
 {/* compact copy mark: the two pages turn and shrink away while a check draws itself in (markdown.css). */}
        <svg viewBox="0 0 20 20" aria-hidden className="copy-morph" data-copied={copied || undefined}>
          <g className="copy-morph-pages">
            <path d="M12 4H6a2 2 0 0 0-2 2v6" />
            <rect x="7" y="7" width="9" height="9" rx="1.5" />
          </g>
          <path className="copy-morph-check" d="M4.5 10.5 8.2 14 15.5 6.5" />
        </svg>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/**
 * The scrollable `pre`. A string child is split into lines (and highlighted
 * when `language` is known); diff lines get their variant from `+`/`-`.
 */
export function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  language,
  diff = false,
  ...props
}: React.ComponentProps<"pre"> & { wrap?: boolean; lineNumbers?: boolean; startLine?: number; language?: string | null; diff?: boolean }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      tabIndex={0}
      style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={cn(
        "group/code min-h-0 min-w-0 overflow-auto overscroll-x-contain py-2.5 text-left font-mono leading-5 outline-none",
        wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    >
      <code data-slot="code-block-code" className={cn("grid min-w-max content-start", lineNumbers && "grid-cols-[auto_1fr]", wrap && "min-w-0")}>
        {typeof children === "string" ? <Lines code={children} language={language} diff={diff} /> : children}
      </code>
    </pre>
  );
}

function Lines({ code, language, diff }: { code: string; language: string | null | undefined; diff: boolean }) {
  const lines = useHighlightedCode(code, diff ? null : language);
  const raw = diff ? code.replace(/\n$/, "").split("\n") : null;
  return (
    <>
      {lines.map((line, i) => {
        const r = raw?.[i];
        const variant = r === undefined ? "default" : r.startsWith("+") && !r.startsWith("+++") ? "added" : r.startsWith("-") && !r.startsWith("---") ? "removed" : r.startsWith("@@") ? "hunk" : "default";
        return (
          <StableLine key={i} variant={variant}>
            {raw && variant !== "default" && variant !== "hunk" ? r!.slice(1) : line}
          </StableLine>
        );
      })}
    </>
  );
}

const codeBlockLineVariants = cva(
  [
    "relative block min-h-5 pl-3 pr-4",
    // Line numbers: a CSS counter, excluded from copy and from screen readers.
    "group-data-[numbered]/code:col-span-2 group-data-[numbered]/code:grid group-data-[numbered]/code:grid-cols-subgrid group-data-[numbered]/code:gap-x-3.5 group-data-[numbered]/code:[counter-increment:line]",
    "before:min-w-5 before:select-none before:text-right before:text-[10.5px] before:text-[hsl(var(--subtle-foreground))] group-data-[numbered]/code:before:content-[counter(line)]",
    "after:absolute after:left-1 after:top-0 after:select-none",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "",
        added: "bg-diff-add-ink/[0.07] text-foreground after:text-diff-add-ink after:content-['+']",
        removed: "bg-diff-del-ink/[0.07] text-foreground after:text-diff-del-ink after:content-['−']",
        highlighted: "bg-accent",
        hunk: "text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function CodeBlockLine({ className, variant = "default", children, ...props }: React.ComponentProps<"span"> & VariantProps<typeof codeBlockLineVariants>) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty = children === undefined || children === null || children === "" || (Array.isArray(children) && children.length === 0);
  return (
    <span data-slot="code-block-line" data-variant={variant} className={cn(codeBlockLineVariants({ variant }), className)} {...props}>
      <span className="min-w-0">{empty ? "\n" : children}</span>
    </span>
  );
}

/**
 * A finished line keeps its tokens (useHighlightedCode tokenizes it once), so a block that grows a line at a time
 * re-renders only its last line, not every line above it (upstream HighlightedCodeLines).
 */
const StableLine = React.memo(CodeBlockLine);

export function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-footer" className={cn("flex min-w-0 shrink-0 items-center gap-2 border-t border-foreground/[0.08] px-3 py-1.5 text-muted-foreground", className)} {...props} />;
}
