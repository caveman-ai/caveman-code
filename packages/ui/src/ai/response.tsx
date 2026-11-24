// Response: the engine's markdown, streamed. AI Elements renders it with
// Streamdown; this is the same job on what the app already ships
// (react-markdown + remark-gfm) with Shiki code blocks (code-block.tsx), GFM
// tables, task lists, images and links, styled with deck tokens and compact measure (14px prose on a 24px line,
// body text at 80% ink so bold and headings stand out at full ink, 22/18/15 headings, code and tables in one tinted
// shell). Like Streamdown it memoizes per block: while a reply streams, the
// parser's own block bounds (markdown-blocks.ts) keep every closed block as it
// is and only the open end re-parses, and that end draws only what will not
// reshape as the rest arrives (streaming-markdown.ts, like Streamdown's
// remend). A reply that was already whole when it mounted parses as one
// document. Math typesets through MarkdownMath, loaded on first use.
//
// Code blocks, tables and images are artifacts: each carries an open action
// that reports its 1-based source line (`onOpen`), the same key the app's
// artifact model uses (apps/web/src/state/transcript-artifacts.ts).
import { Icon, ArrowExpand01Icon, PlayIcon, TextWrapIcon, Tick02Icon } from "../icons/huge";
import * as React from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { artifactTemplateFromHastProperties, remarkCodexDirectives } from "@caveman-app/shared/codexMarkdownDirectives";
import { isWindowsDrivePathHref } from "@caveman-app/shared/markdownLinks";
import { mathKind, mayContainMath } from "@caveman-app/shared/markdownMath";
import { remarkBreakAroundImageLines, remarkKeepAutolinkSuffixes, remarkKeepWindowsPaths } from "@caveman-app/shared/markdownPipeline";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import type { CodexArtifactTemplate } from "@caveman-app/shared/codexArtifactTemplates";
import { ArtifactTemplateCard } from "./artifact-template.tsx";
import { rehypeChipPunctuation } from "./chip-punctuation.ts";
import { FileTypeIcon } from "../icons/file-type";
import { cn } from "../lib/cn";
import { copyText } from "../lib/copy-text";
import { copyMarkdownSource } from "../markdown/copy-source";
import { markdownRenderer } from "../markdown/render-cache";
import { MarkdownMath } from "../markdown/MarkdownMath";
import { Mermaid } from "../markdown/Mermaid";
import { CodeBlock, codeBlockActionClass, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockFooter, CodeBlockHeader, CodeBlockTitle } from "./code-block.tsx";
import { fenceTitle, languageName } from "./highlight.ts";
import { createMarkdownBlocks, type MarkdownBlock } from "./markdown-blocks.ts";
import { markdownImages, normalizeImageLinks, sourceKind } from "./markdown-images.ts";
import { stableStreamingTail } from "./streaming-markdown.ts";
import { rehypeTextDirection } from "./text-direction.ts";
import { createWordFade, resumeWordFades, settleWordFades, usePacedText, useWordFading, WORD_FADE_MS, type WordFade } from "./word-fade.ts";
import { PreviewContent } from "./disclosure.tsx";
import { useStreamView } from "./stream-view.tsx";

export type ResponseTargetKind = "code" | "table" | "image";
export interface ResponseTarget {
  readonly kind: ResponseTargetKind;
  /** 1-based line in the markdown source where the block starts. */
  readonly line: number;
}

export interface ResponseOptions {
  /** Suggest a template to this chat's composer; absent in passive readers. Never sends a turn. */
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly onOpen?: ((target: ResponseTarget) => void) | undefined;
  /** An inline code span drawn as something richer (a file chip); null keeps the code. Also draws a file `![]()` names, by its path, without `file`. */
  readonly inlineCode?: ((text: string) => React.ReactNode) | undefined;
  /**
   * A file `![]()` names that is no picture, audio or video (T3 #21363), drawn as the host's chip: its path as the answer
   * wrote it (spaces, a Windows `\`) to show, and its destination as a link's href is (`href`) to resolve, never a code span.
   */
  readonly file?: ((path: string, href: string) => React.ReactNode) | undefined;
  /** Audio or video `![]()` names, played in place (a file the host reads); without it only web addresses play. */
  readonly media?: ((src: string, kind: "audio" | "video", alt: string) => React.ReactNode) | undefined;
 /** Run a shell block's command in a terminal (upstream run-in-shell); no Run button without it. */
  readonly onRun?: ((command: string) => void) | undefined;
  /** The type badge (an artifact Hugeicon) for a code block, table or image. */
  readonly badge?: ((kind: ResponseTargetKind) => React.ReactNode) | undefined;
  /** The reply is still arriving: Beautiful UI's caret rides the end of the last line (pure CSS, beautifui/foundation.css). */
  readonly streaming?: boolean | undefined;
  /**
   * Let the reply out at the stream's pace, each word fading in as it shows (word-fade.ts), in place of the
   * caret: the chat's live answers. Off, text shows as it arrives.
   */
  readonly paced?: boolean | undefined;
  /** With `paced`: the reply arrived while the reader watched, so it plays in from its first word; one already there shows whole. */
  readonly revealOnMount?: boolean | undefined;
  /**
   * Every link click, first. Call `event.preventDefault()` to take it (the chat opens a file link in
   * the side panel). Otherwise http(s) and mailto links open in a new tab, `#id` links scroll this
   * reply (or the document's heading), and nothing else navigates: the app is one page, so a relative href would replace it.
   */
  readonly onLink?: ((href: string, event: React.MouseEvent<HTMLAnchorElement>) => void) | undefined;
  /**
   * The images show elsewhere (the transcript's gallery strip, built with
   * markdownImages): the text stops drawing exactly those, and any paragraph
   * or list that held nothing else. An image the strip can't see stays put.
   */
  readonly hideImages?: boolean | undefined;
}

/** The options every element reads; the side panel's Markdown provides it too. A ref, so callbacks never re-render blocks. */
export const ResponseOptionsContext = React.createContext<React.RefObject<ResponseOptions>>({ current: {} });
const Options = ResponseOptionsContext;
const Offset = React.createContext(0);
/** The last block's text while the reply streams into it; null in a finished block. */
const OpenTail = React.createContext<string | null>(null);
/** With hideImages: the images the strip shows, as imageKey(line, src). */
const Elsewhere = React.createContext<ReadonlySet<string> | null>(null);

/** A destination as the answer wrote it: the renderer percent-encodes sources (`C:%5Ca.pdf`, `my%20a.pdf`), markdown may not. */
const asWritten = (src: string) => {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
};

/** One image by its 1-based line and source. */
const imageKey = (line: number, src: string) => `${line}\0${asWritten(src)}`;

export function Response({ children, className, onOpen, badge, streaming, paced, revealOnMount, onLink, inlineCode, file, media, onRun, hideImages, onUseArtifactTemplate, ref, ...props }: Omit<React.ComponentProps<"div">, "children"> & ResponseOptions & { children: string }) {
  // Stable context: callbacks change identity on every parent render, blocks must not.
  const options = React.useRef<ResponseOptions>({});
  options.current = { onOpen, badge, onLink, inlineCode, file, media, onRun, onUseArtifactTemplate };
  // A running reply may already contain text when its chat opens. Seed only
  // those source positions as history; subsequent chunks still animate.
  const view = useStreamView();
  const [history, setHistory] = React.useState(() => ({ view, settled: revealOnMount === false ? normalizeImageLinks(children).length : 0 }));
  if (history.view !== view) setHistory({ view, settled: normalizeImageLinks(children).length });
  // Paced: the text as far as the reveal has got; its words fade while it streams or is let out, and a fade after.
  const reveal = usePacedText(children, Boolean(streaming), Boolean(revealOnMount), Boolean(paced));
  const fading = useWordFading(Boolean(paced) && (Boolean(streaming) || reveal.revealing));
  const writing = Boolean(streaming) || reveal.revealing;
  const root = React.useRef<HTMLDivElement>(null);
  const paintedView = React.useRef(view);
  React.useImperativeHandle(ref, () => root.current!, []);
  React.useLayoutEffect(() => {
    if (root.current) {
      if (paintedView.current !== view) settleWordFades(root.current);
      else if (fading) resumeWordFades(root.current);
    }
    paintedView.current = view;
  }, [reveal.text, fading, view]);
  const text = React.useMemo(() => normalizeImageLinks(reveal.text), [reveal.text]);
  // The reply's, not a block's: a definition arriving merges the blocks on screen into one, whose words keep their clocks.
  const [fade] = React.useState(() => createWordFade());
  fade.settle(fading ? history.settled : text.length);
 // Once a reply has grown here it keeps its blocks, so finishing re-renders nothing that already drew (upstream hasStreamed).
  const [live, setLive] = React.useState(writing);
  if (writing && !live) setLive(true);
  const splitter = React.useRef<ReturnType<typeof createMarkdownBlocks> | null>(null);
  // While it streams, the last block draws only what will not reshape as the rest arrives (streaming-markdown.ts).
  const blocks = React.useMemo(() => {
    const split: MarkdownBlock[] = live ? (splitter.current ??= createMarkdownBlocks())(text, writing) : [{ text, offset: 0 }];
    // Blocks are whole lines of the reply, found by their line: lines no block holds (blank ones before the first)
    // still count, so each word keeps its place in the source and its fade clock.
    const lineStarts = [0];
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lineStarts.push(at + 1);
    const all = split.map((b) => ({ ...b, start: lineStarts[b.offset] ?? 0 }));
    const last = all.at(-1);
    if (!writing || last === undefined) return all;
    const tail = stableStreamingTail(last.text);
    return tail === last.text ? all : [...all.slice(0, -1), { ...last, text: tail }];
  }, [text, live, writing]);
  // Keyed by the images it names, not the text: a streamed token that adds no image re-renders no paragraph.
  const imageKeys = React.useMemo(() => (hideImages ? markdownImages(text).map((m) => imageKey(m.line, m.src)).join("\u0001") : null), [hideImages, text]);
  const elsewhere = React.useMemo(() => (imageKeys === null ? null : new Set(imageKeys ? imageKeys.split("\u0001") : [])), [imageKeys]);
  return (
    <Options.Provider value={options}>
      <Elsewhere.Provider value={elsewhere}>
        {/* The fade replaces the caret: a solid bar ahead of a word still fading in marks its gap. The answer reads at
            full ink, never quieter than the person's own message above it (its bubble is 12:1; 80% ink was 9.7:1). */}
        <div ref={root} data-slot="response" data-streaming={(streaming && !paced) || undefined} onCopy={copyMarkdownSource} className={cn("min-w-0 text-[14px] leading-6 text-foreground [overflow-wrap:anywhere]", fading && "word-fading", className)} {...props}>
          {/* The newline a whole-document parse puts between top-level blocks: a reply drawn in blocks is the same DOM. */}
          {blocks.map((b, i) => (
            <React.Fragment key={b.offset}>
              {i > 0 ? "\n" : null}
              <Block text={b.text} offset={b.offset} start={b.start} fade={fade} fading={fading} open={writing && i === blocks.length - 1} />
            </React.Fragment>
          ))}
        </div>
      </Elsewhere.Provider>
    </Options.Provider>
  );
}

/** `offset`: lines before the block; `start`: characters before it, where its words sit in the reply's fade ledger. */
const Block = React.memo(function Block({ text, offset, start, fade, fading, open }: { text: string; offset: number; start: number; fade: WordFade; fading: boolean; open: boolean }) {
  // Source positions retain their age even when Markdown reparents a word (a
  // finished emphasis/link), so old text cannot flash on each new chunk.
  const plugins = React.useMemo((): PluggableList => [...REHYPE, [fade.plugin, start]], [fade, start]);
  // A block the reply has moved past keeps its word spans only until its last word has faded in, then draws plain, as
  // a finished reply does: a long answer streaming otherwise held a span and a style for every word it had said.
  // Written again (a definition regroups the reply into this block), it fades its new words as an open block does.
  const [faded, setFaded] = React.useState(false);
  React.useEffect(() => {
    if (open) return void setFaded(false);
    if (!fading) return;
    const timer = window.setTimeout(() => setFaded(true), WORD_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [open, fading]);
  const fades = fading && (open || !faded);
  const render = markdownRenderer({ remarkPlugins: mayContainMath(text) ? REMARK_MATH : REMARK, rehypePlugins: fades ? plugins : REHYPE, components, urlTransform });
  return (
    <Offset.Provider value={offset}>
      {/* A finished block is kept for its next mount (render-cache.ts); the streaming tail and fading words would only fill it with prefixes. */}
      <OpenTail.Provider value={open ? text : null}>{render(text, !open && !fades)}</OpenTail.Provider>
    </Offset.Provider>
  );
});

// upstream restricted directive parser restores invalid/incomplete directives as literal Markdown,
// and leaves escaped directives, inline code and fences untouched. A Windows path keeps its
// backslashes (`C:\me\.t3` is not an escaped dot), and an image alone on its line under a
// label (`**Palette**` then `![](…)`) keeps that line instead of sitting beside the label.
const REMARK = [remarkGfm, remarkKeepAutolinkSuffixes, remarkKeepWindowsPaths, remarkCodexDirectives, remarkBreakAroundImageLines];
/**
 * A block that may hold a formula (a `$`, `\(`, `\[` or a ```math fence) also reads LaTeX: the four delimiters
 * models write, with upstream tokenizer (llm-math, pnpm-workspace.yaml), so prices and `$HOME` stay prose. Typeset by
 * MarkdownMath, which loads KaTeX only once a formula shows.
 */
export const MATH: [typeof remarkMath, { singleDollarTextMath: boolean }] = [remarkMath, { singleDollarTextMath: true }];
const REMARK_MATH = [MATH, ...REMARK];
/**
 * Each block reads in its own words' direction: an Arabic or Hebrew reply right to left (text-direction.ts). A file
 * chip keeps the punctuation after it on its line (chip-punctuation.ts).
 */
const REHYPE = [rehypeTextDirection, rehypeChipPunctuation];

/**
 * A link's href kept for the click handler although react-markdown would drop it: a file:// URL or
 * "src/a.ts:12" (a file with a line), the ways engines point at a file. Neither ever navigates
 * (`linkAction`); the chat opens them in its file viewer.
 */
const FILE_HREF = /^(?:file:\/\/|(?:[^\s:#?]*\/)?[^\s:#?/]+\.[A-Za-z0-9]+:\d+(?::\d+)?$)/i;

/**
 * react-markdown's safe-URL rule, plus inline images (an engine's chart or screenshot as a data: URL), file links,
 * and Windows drive paths, which that rule reads as a `C:` scheme and empties (upstream isWindowsDrivePathHref).
 */
export const urlTransform = (url: string, key: string) =>
  (key === "src" && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(url)) || (key === "href" && FILE_HREF.test(url)) || isWindowsDrivePathHref(url) ? url : defaultUrlTransform(url);

/**
 * What a click on a link in engine markdown does when no handler took it: http(s) and mailto open
 * in a new tab ("external"), `#id` scrolls to that element ("anchor"), anything else is held
 * ("hold"): a relative href in this one-page app would navigate the app itself away.
 */
export function linkAction(href: string | undefined): "external" | "anchor" | "hold" {
  const h = (href ?? "").trim();
  if (/^(?:https?|mailto):/i.test(h)) return "external";
  return h.startsWith("#") && h.length > 1 ? "anchor" : "hold";
}

/**
 * A whole text's top-level blocks, at the markdown parser's own bounds (markdown-blocks.ts); a text with a link or
 * footnote definition, or a directive card, is one block. `offset` is the number of lines before the block.
 */
export function splitBlocks(md: string): MarkdownBlock[] {
  return createMarkdownBlocks()(md, false);
}

function useLine(node: { position?: { start: { line: number } } } | undefined): number {
  return React.useContext(Offset) + (node?.position?.start.line ?? 0);
}

type HastText = { type: "text"; value: string };
type HastElement = { type: "element"; tagName: string; properties?: Record<string, unknown>; children?: Array<HastElement | HastText>; data?: { meta?: string } };

/** Element styles for engine markdown; the side panel's Markdown spreads these and overrides a few. */
export const components: Components = {
  div: ({ node, ...props }) => <ResponseDiv node={node} {...props} />,
  p: ({ node, className, ...p }) => <Hideable as="p" node={node} className={cn("my-4 first:mt-0 last:mb-0", className)} {...p} />,
  h1: ({ node: _, ...p }) => <h1 className="mb-2 mt-7 text-[22px] font-semibold leading-7 tracking-[-0.015em] text-foreground first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h2 className="mb-2 mt-7 text-[18px] font-semibold leading-[26px] tracking-[-0.01em] text-foreground first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h3 className="mb-1.5 mt-6 text-[15px] font-semibold leading-6 text-foreground first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h4 className="mb-1 mt-5 text-[14px] font-semibold leading-6 text-foreground first:mt-0" {...p} />,
  ul: ({ node, className, ...p }) => (
    <Hideable
      as="ul"
      node={node}
      className={cn("my-4 list-disc ps-6 marker:text-[hsl(var(--subtle-foreground))] first:mt-0 last:mb-0 [&_ol]:my-1 [&_ul]:my-1", className?.includes("contains-task-list") && "list-none ps-0.5", className)}
      {...p}
    />
  ),
  ol: ({ node, className, ...p }) => <Hideable as="ol" node={node} className={cn("my-4 list-decimal ps-6 marker:text-[hsl(var(--subtle-foreground))] marker:tabular-nums first:mt-0 last:mb-0 [&_ol]:my-1 [&_ul]:my-1", className)} {...p} />,
  li: ({ node, className, ...p }) => <Hideable as="li" node={node} className={cn("my-1 ps-1", className?.includes("task-list-item") && "relative ps-6", className)} {...p} />,
  input: ({ node: _, checked, type }) =>
    type === "checkbox" ? (
      <span
        role="checkbox"
        aria-checked={Boolean(checked)}
        aria-disabled
        className={cn("absolute start-0.5 top-[5px] grid size-3.5 place-items-center rounded-[3px] border", checked ? "border-foreground bg-foreground text-background" : "border-input")}
      >
        {checked ? <Icon icon={Tick02Icon} strokeWidth={3} className="size-2.5" /> : null}
      </span>
    ) : null,
  a: ({ node: _, href, ...p }) => <ResponseLink href={href} {...p} />,
  // A quote steps back a tier: a soft 3px rule and the words at 60% ink; its own bold still lifts to full ink.
  blockquote: ({ node: _, ...p }) => <blockquote className="my-4 border-s-[3px] border-foreground/15 ps-4 text-foreground/60 first:mt-0 last:mb-0" {...p} />,
  hr: () => <hr className="my-6 border-foreground/10" />,
  strong: ({ node: _, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
  em: ({ node: _, ...p }) => <em className="text-foreground" {...p} />,
  code: ({ node: _, ...p }) => <InlineCode {...p} />,
  pre: ({ node }) => {
    const code = (node as HastElement | undefined)?.children?.[0] as HastElement | undefined;
    const cls = code?.properties?.className;
    const classes = (Array.isArray(cls) ? cls : []).map(String);
    const lang = classes.find((c) => c.startsWith("language-"))?.slice(9) ?? null;
    const text = (code?.children ?? []).map((c) => (c.type === "text" ? c.value : "")).join("").replace(/\n$/, "");
    return <ResponseCode code={text} language={lang} meta={code?.data?.meta ?? ""} node={node} formula={mathKind(classes.join(" ")) === "display"} />;
  },
  table: ({ node, ...p }) => <ResponseTable node={node} {...p} />,
  thead: ({ node: _, ...p }) => <thead {...p} />,
  th: ({ node: _, style, ...p }) => <th style={style} className="whitespace-nowrap border-b border-foreground/10 px-3 py-2 text-start align-bottom text-[12px] font-semibold leading-5 text-foreground" {...p} />,
  td: ({ node: _, style, ...p }) => <td style={style} className="border-b border-foreground/[0.06] px-3 py-2 align-top text-[12.5px] leading-5 tabular-nums" {...p} />,
  img: ({ node, src, alt }) => (typeof src === "string" && src ? <ResponseImage node={node} src={src} alt={alt ?? ""} /> : null),
};

function ResponseDiv({ node, ...props }: React.ComponentProps<"div"> & { node?: { properties?: Record<string, unknown> } | undefined }) {
  const options = React.useContext(Options);
  const template = artifactTemplateFromHastProperties(node?.properties);
  return template ? <ArtifactTemplateCard template={template} onUse={options.current.onUseArtifactTemplate} /> : <div {...props} />;
}

function ResponseLink({ href, children, ...p }: React.ComponentProps<"a">) {
  const options = React.useContext(Options);
  const action = linkAction(href);
  return (
    <a
      {...p}
      href={href}
      {...(action === "external" ? { target: "_blank", rel: "noreferrer" } : {})}
      className="text-foreground underline decoration-muted-foreground/50 underline-offset-[3px] transition-colors duration-75 hover:decoration-foreground"
      onClick={(event) => {
        options.current.onLink?.(href ?? "", event);
        if (event.defaultPrevented || action === "external") return;
        event.preventDefault();
        if (action !== "anchor") return;
        let id = href!.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // a malformed escape: look the raw id up
        }
        // A reader heading's id carries Markdown's md- prefix; hosted text's ids the sanitizer's user-content- (GitHub's).
        const root = event.currentTarget.closest("[data-slot=response],[data-slot=markdown]") ?? document;
        const ids = [id, `md-${id}`, `user-content-${id}`, `user-content-md-${id}`];
        root.querySelector(ids.map((i) => `[id="${CSS.escape(i)}"]`).join(","))?.scrollIntoView({ block: "start" });
      }}
    >
      {children}
    </a>
  );
}

export const inlineCodeClass = "rounded-[5px] bg-foreground/[0.08] px-[5px] py-px font-mono text-[0.86em] text-foreground";

/** Native word selection stops at hyphens and dots, so a double-click takes the whole span (T3 #26639). */
export function selectInlineCode(event: React.MouseEvent<HTMLElement>) {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

function InlineCode({ className, children, ...props }: React.ComponentProps<"code">) {
  const render = React.useContext(Options).current.inlineCode;
  const math = mathKind(className);
  if (math) return <MarkdownMath tex={String(children ?? "")} display={math === "display"} />;
  const rich = render && typeof children === "string" ? render(children) : null;
  return rich ?? <code className={cn(inlineCodeClass, className)} onDoubleClick={selectInlineCode} {...props}>{children}</code>;
}

const COLLAPSED_LINES = 14;

/** A file name whose mark is the fence language's, for the code block's header icon. */
const FENCE_EXTENSIONS: Record<string, string> = {
  typescript: "ts", javascript: "js", python: "py", rust: "rs", ruby: "rb", golang: "go", shell: "sh", bash: "sh", zsh: "sh", fish: "sh",
  console: "sh", shellsession: "sh", yaml: "yml", markdown: "md", kotlin: "kt", csharp: "cs", "c#": "cs", "c++": "cpp", objc: "m",
  "objective-c": "m", text: "txt", plaintext: "txt", plain: "txt", dockerfile: "Dockerfile", makefile: "Makefile",
};
export function fenceFileName(language: string | null): string {
  const lang = (language ?? "").toLowerCase();
  if (!lang) return "code.txt";
  const ext = FENCE_EXTENSIONS[lang] ?? lang;
  return /^[A-Z]/.test(ext) ? ext : `code.${ext}`;
}

function ResponseCode({ code, language, meta, node, formula = false }: { code: string; language: string | null; meta: string; node: unknown; formula?: boolean }) {
  // A streaming reply grows its fence a line at a time: it shows as code until its closing fence arrives, then
  // draws, while the rest of the reply still streams (T3 #18308). A `$$` formula shows its TeX until it parses.
  const tail = React.useContext(OpenTail);
  const closed = tail === null || closedFence(node as Positioned | undefined, tail, code);
  if (language === "mermaid" && closed) return <Mermaid source={code} />;
  if (language === "math" && (formula || closed)) return <MarkdownMath tex={code} display />;
  return <ResponseCodeBlock code={code} language={language} meta={meta} node={node} />;
}

/** Whether a fenced block's source (`text` at the node's offsets) ends in its closing fence. upstream isClosedCodeFence. */
export function closedFence(node: { position?: { start: { offset?: number }; end: { offset?: number } } } | undefined, text: string, code: string): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
  // One class for the blockquote prefix: nested quantifiers backtrack exponentially on lines of many `> ` markers.
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening[0] === closing[0] &&
    closing.length >= opening.length &&
    // Only a real closer is left out of the parsed code; a CRLF stream cut after CR is not an extra line.
    source.replace(/\r$/, "").split(/\r\n|\r|\n/).length > code.split(/\r\n|\r|\n/).length
  );
}

function ResponseCodeBlock({ code, language, meta, node }: { code: string; language: string | null; meta: string; node: unknown }) {
  const line = useLine(node as never);
  const options = React.useContext(Options).current;
  const [expanded, setExpanded] = React.useState(false);
  const [whole, setWhole] = React.useState(false);
  const contentId = React.useId();
  const [wrap, setWrap] = React.useState(false);
  const count = code ? code.replace(/\n$/, "").split("\n").length : 0;
  const file = fenceTitle(meta);
  const long = count > COLLAPSED_LINES + 2;
  const shown = long && !whole ? code.split("\n").slice(0, COLLAPSED_LINES).join("\n") : code;
  return (
    <CodeBlock className="my-3 first:mt-0 last:mb-0">
      <CodeBlockHeader>
 {/* compact header: the language's file mark and one quiet label (the fence's file, else its language). */}
        <CodeBlockTitle>
          <FileTypeIcon path={file ?? fenceFileName(language)} className="size-3.5" />
          <span className={cn("truncate", file && "font-mono text-[11.5px]")}>{file ?? languageName(language)}</span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
          <CodeBlockExtras code={code} language={language} wrap={wrap} onWrap={setWrap} />
          {options.onOpen ? (
            <button type="button" aria-label="Open in side panel" title="Open in side panel" className={codeBlockActionClass} onClick={() => options.onOpen?.({ kind: "code", line })}>
              <Icon icon={ArrowExpand01Icon} />
            </button>
          ) : null}
        </CodeBlockActions>
      </CodeBlockHeader>
      <PreviewContent id={contentId} collapsed={long && !expanded} collapsedRem={18.75} onCollapsed={() => setWhole(false)}>
        <CodeBlockContent
          language={language}
          lineNumbers={count > 3}
          wrap={wrap}
          className={cn(long && !expanded && "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}
        >
          {shown}
        </CodeBlockContent>
      </PreviewContent>
      {long ? (
        <CodeBlockFooter className="h-8 py-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => {
              if (!expanded) setWhole(true);
              setExpanded(!expanded);
            }}
            className="rounded-sm text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? "Show less" : `Show ${count - COLLAPSED_LINES} more lines`}
          </button>
        </CodeBlockFooter>
      ) : null}
    </CodeBlock>
  );
}

function ResponseTable({ node, className, ...props }: React.ComponentProps<"table"> & { node?: unknown }) {
  const line = useLine(node as never);
  const options = React.useContext(Options).current;
  const table = React.useRef<HTMLTableElement>(null);
  return (
    <div className="group/table relative my-4 first:mt-0 last:mb-0">
      <div className="overflow-x-auto rounded-xl border border-foreground/10 bg-foreground/[0.035]">
        <table ref={table} className={cn("w-full border-collapse text-[13px] [&_tbody_tr:last-child_td]:border-0", className)} {...props} />
      </div>
      <TableActions table={table}>
        {options.onOpen ? (
          <button type="button" onClick={() => options.onOpen?.({ kind: "table", line })} className={tableActionClass}>
            {options.badge ? <span className="[&_svg]:size-4">{options.badge("table")}</span> : null}
            Open
          </button>
        ) : null}
      </TableActions>
    </div>
  );
}

// ── Table and code block extras (upstream: copy a table as Markdown or CSV, wrap a block, run a shell block) ──

const tableActionClass =
  "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The cells as text, row by row (the header first), from the rendered table: what the reader sees. */
function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((row) => [...row.cells].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()));
}

export function tableToMarkdown(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const [head = [], ...body] = rows;
  const line = (cells: ReadonlyArray<string>) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
}

export function tableToCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((cells) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

/** Shown on hover or focus at the table's top right: copy it as Markdown or CSV, then the host's own actions. */
export function TableActions({ table, children }: { table: React.RefObject<HTMLTableElement | null>; children?: React.ReactNode }) {
  const [copied, setCopied] = React.useState<"md" | "csv" | null>(null);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (kind: "md" | "csv") => {
    if (!table.current) return;
    const rows = tableRows(table.current);
    copyText(kind === "md" ? tableToMarkdown(rows) : tableToCsv(rows))
      .then(() => setCopied(kind))
      .catch(() => {});
  };
  return (
    <div className="absolute right-1.5 top-1 flex items-center rounded-md bg-popover p-px opacity-0 shadow-[var(--shadow-overlay)] transition-opacity duration-150 focus-within:opacity-100 group-hover/table:opacity-100 touch:opacity-100">
      <button type="button" onClick={() => copy("md")} className={tableActionClass}>
        {copied === "md" ? <Icon icon={Tick02Icon} className="size-3.5 text-success" /> : null}
        {copied === "md" ? "Copied" : "Copy as Markdown"}
      </button>
      <button type="button" onClick={() => copy("csv")} className={tableActionClass}>
        {copied === "csv" ? <Icon icon={Tick02Icon} className="size-3.5 text-success" /> : null}
        {copied === "csv" ? "Copied" : "CSV"}
      </button>
      {children}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}

const SHELL = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "shellsession"]);

/** A block's command as a terminal runs it: a console transcript keeps only its `$ ` lines. */
export function runnable(code: string, language: string | null): string | null {
  if (!language || !SHELL.has(language.toLowerCase())) return null;
  const lines = code.split("\n");
  const prompted = lines.filter((l) => /^\s*\$ /.test(l));
  const command = (prompted.length ? prompted.map((l) => l.replace(/^\s*\$ /, "")) : lines).join("\n").trim();
  return command || null;
}

/** Wrap long lines, and Run a shell block in a terminal when the host offers one. */
export function CodeBlockExtras({ code, language, wrap, onWrap }: { code: string; language: string | null; wrap: boolean; onWrap: (wrap: boolean) => void }) {
  const run = React.useContext(Options).current.onRun;
  const command = run ? runnable(code, language) : null;
  return (
    <>
      <button type="button" aria-label={wrap ? "Don't wrap lines" : "Wrap lines"} title={wrap ? "Don't wrap lines" : "Wrap lines"} aria-pressed={wrap} className={cn(codeBlockActionClass, wrap && "text-foreground")} onClick={() => onWrap(!wrap)}>
        <Icon icon={TextWrapIcon} />
      </button>
      {command && run ? (
        <button type="button" aria-label="Run in a terminal" title="Run in a terminal" className={codeBlockActionClass} onClick={() => run(command)}>
          <Icon icon={PlayIcon} />
        </button>
      ) : null}
    </>
  );
}

type Positioned = HastElement & { position?: { start: { line: number; offset?: number }; end: { offset?: number } } };

/** A paragraph, list or item that only held images the strip shows says nothing once they are gone. */
function Hideable<T extends "p" | "ul" | "ol" | "li">({ as: Tag, node, ...props }: React.ComponentProps<T> & { as: T; node?: unknown }) {
  const elsewhere = React.useContext(Elsewhere);
  const offset = React.useContext(Offset);
  if (elsewhere && holds(node as Positioned | undefined, offset, elsewhere) === "images") return null;
  const Element = Tag as React.ElementType;
  return <Element {...props} />;
}

/** What a node holds once the strip's images leave: nothing, only those images, or something to read. */
function holds(node: Positioned | undefined, offset: number, elsewhere: ReadonlySet<string>): "nothing" | "images" | "content" {
  if (!node) return "content";
  if (node.tagName === "img") {
    const src = node.properties?.src;
    return typeof src === "string" && node.position && elsewhere.has(imageKey(offset + node.position.start.line, src)) ? "images" : "content";
  }
  if (node.tagName === "br") return "nothing";
  // While a reply fades in, each image sits in its own fade span (word-fade.ts), which holds only what it wraps.
  const fade = node.tagName === "span" && node.properties?.dataWordFade !== undefined;
  if (!fade && !["p", "ul", "ol", "li", "a"].includes(node.tagName)) return "content";
  let found: "nothing" | "images" = "nothing";
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      if (child.value.trim()) return "content";
      continue;
    }
    const inner = holds(child as Positioned, offset, elsewhere);
    if (inner === "content") return "content";
    if (inner === "images") found = "images";
  }
  return found;
}

function ResponseImage({ node, src, alt }: { node: unknown; src: string; alt: string }) {
  const line = useLine(node as never);
  const options = React.useContext(Options).current;
  const elsewhere = React.useContext(Elsewhere);
  const kind = sourceKind(src);
  if (kind !== "image") return <ResponseMedia src={src} kind={kind} alt={alt} />;
  if (elsewhere?.has(imageKey(line, src))) return null;
  const img = <img src={src} alt={alt} loading="lazy" decoding="async" className="block max-h-72 max-w-full rounded-[7px] object-contain" />;
  if (!options.onOpen) return img;
  return (
    <button
      type="button"
      aria-label={alt ? `Open image: ${alt}` : "Open image"}
      onClick={() => options.onOpen?.({ kind: "image", line })}
      className="my-1 inline-block max-w-full rounded-lg border border-border bg-card p-px align-top outline-none transition-colors duration-75 hover:border-input focus-visible:ring-2 focus-visible:ring-ring"
    >
      {img}
    </button>
  );
}

/**
 * Audio or video an answer puts in place with `![]()` plays there; any other file it names that way is its chip
 * (T3 #21363). The host reads files (media); a web address plays as it is.
 */
function ResponseMedia({ src, kind, alt }: { src: string; kind: "audio" | "video" | "file"; alt: string }) {
  const options = React.useContext(Options).current;
  const rich = kind === "file" ? (options.file ? options.file(asWritten(src), src) : options.inlineCode?.(asWritten(src))) : options.media?.(src, kind, alt);
  if (rich) return rich;
  if (kind === "audio" && /^https?:/i.test(src)) return <audio controls preload="metadata" src={src} aria-label={alt || "Audio"} className="my-1 block h-9 w-full max-w-md" />;
  if (kind === "video" && /^https?:/i.test(src)) return <video controls preload="metadata" src={src} aria-label={alt || "Video"} className="my-1 block max-h-80 w-full max-w-xl rounded-lg border border-border bg-black" />;
  return <span className="text-muted-foreground">{alt || asWritten(src)}</span>;
}
