import { Children, createContext, isValidElement, memo, useContext, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode, type RefObject } from "react";
import { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { PluggableList } from "unified";
import { unified } from "unified";
import { mayContainMath } from "@caveman-app/shared/markdownMath";
import { remarkBreakAroundImageLines, remarkKeepAutolinkSuffixes, remarkKeepWindowsPaths } from "@caveman-app/shared/markdownPipeline";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "../ai/code-block";
import { fenceTitle, languageName } from "../ai/highlight";
import { CodeBlockExtras, components as RESPONSE_COMPONENTS, MATH, ResponseOptionsContext, TableActions, urlTransform, type ResponseOptions } from "../ai/response";
import { Icon, ArrowRight01Icon, ImageNotFound01Icon } from "../icons/huge";
import { cn } from "../lib/cn";
import { rehypeChipPunctuation } from "../ai/chip-punctuation";
import { createMarkdownBlocks } from "../ai/markdown-blocks";
import { rehypeTextDirection } from "../ai/text-direction";
import { remarkGithubAlerts } from "./githubAlerts";
import { HOSTED_SCHEMA, remarkAttachments, remarkEmojiShortcodes } from "./hosted";
import { copyMarkdownSource } from "./copy-source";
import { markdownRenderer } from "./render-cache";
import { MarkdownMath } from "./MarkdownMath";
import { Mermaid } from "./Mermaid";

// The rich reader for side-panel documents: the chat's Response, plus heading
// ids (markdownOutline), GitHub alerts, mermaid diagrams and images from the
// workspace. Elements start from ai/response.tsx's (links and inline code go
// through the same options), so both read the same; fences render with
// ui-chat's CodeBlock, tokenized by ai/highlight.ts. Raw HTML is rendered
// only for `hosted` text, through GitHub's allow-list (hosted.ts); elsewhere
// react-markdown shows it as text. Alert colours and the document scale
// (`.md-doc`, MarkdownDocument): markdown.css.

export interface MarkdownProps {
  readonly source: string;
  /** Re-render only the last top-level block per delta; completed blocks are memoized. */
  readonly streaming?: boolean | undefined;
  /** Share the rendered document's headings with a following markdownOutline reader, without retaining its syntax tree. */
  readonly cacheOutline?: boolean | undefined;
  /**
   * Every link click, first. Call `event.preventDefault()` to take it (e.g.
   * open a relative file link in a tab). Otherwise http(s) and mailto links
   * open in a new tab, `#heading` links scroll this document, and nothing
   * else navigates: other schemes render without an href.
   */
  readonly onLink?: ((href: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  /** An inline code span drawn as something richer (a file chip); null keeps the code. */
  readonly inlineCode?: ((text: string) => ReactNode) | undefined;
  /** An image whose source is a path (`./diagram.png`), drawn by the host; without it only http(s) and data: images show. */
  readonly image?: ((src: string, alt: string) => ReactNode) | undefined;
  /** Run a shell block in a terminal; no Run button without it. */
  readonly onRun?: ((command: string) => void) | undefined;
  /** Ticking a task-list box: its index among the document's tasks (setTaskChecked). Without it the boxes are read-only. */
  readonly onToggleTask?: ((index: number, checked: boolean) => void) | undefined;
  /**
   * Text written on a code host (a pull request's description, a review comment), drawn as the host draws it
   * (hosted.ts): its HTML sanitized to GitHub's allow-list, attachment links as their media, `:shortcode:` emoji.
   * `breaks`: every newline is a line break, GitHub's rule for issues, pull requests and comments. Tasks stay read-only.
   */
  readonly hosted?: { readonly breaks: boolean } | undefined;
  readonly className?: string | undefined;
}

export interface OutlineEntry {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  /** The rendered heading's DOM id. */
  readonly id: string;
}

export function Markdown({ source, streaming = false, cacheOutline = false, onLink, inlineCode, onRun, image, onToggleTask, hosted, className }: MarkdownProps) {
  // The chat's elements read their options from this ref: callbacks never re-render blocks.
  const options = useRef<ResponseOptions>({});
  options.current = { onLink, inlineCode, onRun };
  const doc = useRef<DocumentOptions>({});
  doc.current = { image, onToggleTask };
  const flavor: Flavor = hosted ? (hosted.breaks ? "hosted-breaks" : "hosted") : "document";
  const splitter = useRef<ReturnType<typeof createMarkdownBlocks> | null>(null);
  const blocks = useMemo(() => (streaming ? (splitter.current ??= createMarkdownBlocks())(source, true) : null), [source, streaming]);
  return (
    <ResponseOptionsContext.Provider value={options}>
    <DocumentContext.Provider value={doc}>
      <div data-slot="markdown" onCopy={copyMarkdownSource} className={cn("min-w-0 text-[14px] leading-[1.6] text-foreground [overflow-wrap:anywhere]", className)}>
        {/* Streaming splits like Response; a finished document parses whole, so ids and link references are document-wide. */}
        {blocks ? blocks.map((b, i, all) => <Block key={b.offset} source={b.text} flavor={flavor} open={i === all.length - 1} />) : <Block source={source} flavor={flavor} cacheOutline={cacheOutline} />}
      </div>
    </DocumentContext.Provider>
    </ResponseOptionsContext.Provider>
  );
}

/** Headings in document order, with the same ids `Markdown` renders. */
export function markdownOutline(source: string): OutlineEntry[] {
  const hit = outlines.get(source);
  if (hit) {
    outlines.delete(source);
    outlines.set(source, hit);
    return hit.entries.map((entry) => ({ ...entry }));
  }
  const outline: OutlineEntry[] = [];
  eachHeading(outlineParser.parse(source) as MdNode, (heading, id, text) => {
    outline.push({ depth: (heading.depth ?? 1) as OutlineEntry["depth"], text, id });
  });
  rememberOutline(source, outline);
  return outline;
}

function rememberOutline(source: string, outline: OutlineEntry[]): void {
  // File tabs remount when revisited. Keep only their derived outline, never the much larger syntax tree.
  // Include both the source key and heading strings in the estimate; huge files still parse normally, uncached.
  const bytes = 96 + source.length * 2 + outline.reduce((n, entry) => n + 64 + (entry.text.length + entry.id.length) * 2, 0);
  if (bytes <= OUTLINE_BYTES) {
    for (const [key, old] of outlines) {
      if (outlines.size < OUTLINE_COUNT && outlineBytes + bytes <= OUTLINE_BYTES) break;
      outlines.delete(key);
      outlineBytes -= old.bytes;
    }
    // Callers have always received their own mutable array. Keep the cached entries private as well.
    outlines.set(source, { entries: outline.map((entry) => ({ ...entry })), bytes });
    outlineBytes += bytes;
  }
}
const OUTLINE_COUNT = 32;
const OUTLINE_BYTES = 1 << 20;
const outlines = new Map<string, { entries: OutlineEntry[]; bytes: number }>();
let outlineBytes = 0;

/** The first paragraph's plain text (a line to stand for the whole), past headings, HTML and code; "" when there is none. */
export function markdownLead(source: string): string {
  let lead = "";
  const walk = (node: MdNode): boolean => {
    if (node.type === "paragraph") {
      lead = plainText(node).replace(/\s+/g, " ").trim();
      if (lead) return true;
    }
    return node.type !== "heading" && node.type !== "code" && (node.children?.some(walk) ?? false);
  };
  walk(outlineParser.parse(source) as MdNode);
  return lead;
}

type Flavor = "document" | "hosted" | "hosted-breaks";

const Block = memo(function Block({ source, flavor, cacheOutline = false, open = false }: { source: string; flavor: Flavor; cacheOutline?: boolean; open?: boolean }) {
  const outline = cacheOutline && flavor === "document";
  const document = outline ? DOCUMENT_OUTLINE_PLUGINS : PLUGINS[flavor];
  // A document that may hold a formula also reads LaTeX, as the chat does (response.tsx MATH); hosted text keeps its host's rules.
  const remark = flavor === "document" && mayContainMath(source) ? withMath(document.remark) : document.remark;
  const render = markdownRenderer({ remarkPlugins: remark, rehypePlugins: document.rehype, components: COMPONENTS, urlTransform });
  // Text that will not change is kept for its next mount (render-cache.ts): a pull request's description and comments,
  // a reply's result. A file tab keeps only its outline, never its tree (rememberOutline), and a streaming tail would
  // only fill the cache with prefixes.
  return render(source, !outline && !open);
});

/** A plugin list with LaTeX first, the same list each time, so the blocks it draws share their cache. */
function withMath(remark: PluggableList): PluggableList {
  let list = MATH_LISTS.get(remark);
  if (!list) MATH_LISTS.set(remark, (list = [MATH, ...remark]));
  return list;
}
const MATH_LISTS = new WeakMap<PluggableList, PluggableList>();

// ── Headings ──────────────────────────────────────────────────────────────

interface MdNode {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  checked?: boolean | null;
  position?: { start: { offset?: number } };
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const outlineParser = unified().use(remarkParse).use(remarkGfm);

function plainText(node: MdNode): string {
  return node.value ?? node.alt ?? node.children?.map(plainText).join("") ?? "";
}

/** GitHub-style slugs (github-slugger's rules), prefixed so a heading never takes an app id like `root`. */
function eachHeading(tree: MdNode, visit: (heading: MdNode, id: string, text: string) => void): void {
  const seen = new Map<string, number>();
  const walk = (node: MdNode) => {
    if (node.type !== "heading") return node.children?.forEach(walk);
    const text = plainText(node).trim();
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
    let slug = base;
    while (seen.has(slug)) {
      const n = seen.get(base)! + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    visit(node, `md-${slug}`, text);
  };
  walk(tree);
}

function remarkHeadingIds(options: { cacheOutline?: boolean } = {}) {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = typeof file.value === "string" ? file.value : null;
    const outline: OutlineEntry[] | null = options.cacheOutline && source !== null && !outlines.has(source) ? [] : null;
    eachHeading(tree, (heading, id, text) => {
      heading.data = { ...heading.data, hProperties: { ...heading.data?.hProperties, id } };
      outline?.push({ depth: (heading.depth ?? 1) as OutlineEntry["depth"], text, id });
    });
    if (outline && source !== null) rememberOutline(source, outline);
  };
}

// ── Task lists ────────────────────────────────────────────────────────────

/** Every task-list item, in document order: the index the reader's checkboxes report. */
function eachTask(tree: MdNode, visit: (item: MdNode, index: number) => void): void {
  let i = 0;
  const walk = (node: MdNode) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") visit(node, i++);
    node.children?.forEach(walk);
  };
  walk(tree);
}

function remarkTaskIndex() {
  return (tree: MdNode) =>
    eachTask(tree, (item, index) => {
      item.data = { ...item.data, hProperties: { ...item.data?.hProperties, "data-task": index } };
    });
}

const TASK_MARK = /^((?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/;

/** The source with task `index` (in document order) ticked or not; null when there is no such task. Same parse as the renderer, so a code block's `- [ ]` never counts. */
export function setTaskChecked(source: string, index: number, checked: boolean): string | null {
  let at: number | null = null;
  eachTask(outlineParser.parse(source) as MdNode, (item, i) => {
    if (i === index) at = item.position?.start.offset ?? null;
  });
  if (at === null) return null;
  // The item starts at its own bullet, past any indent, `>` or parent bullet on its line.
  const start: number = at;
  const m = TASK_MARK.exec(source.slice(start));
  if (!m) return null;
  const mark = start + m[1]!.length + 1;
  return source.slice(0, mark) + (checked ? "x" : " ") + source.slice(mark + 1);
}

// Windows paths keep their backslashes and an image alone on its line keeps it, as in the chat (response.tsx).
// Each block reads in its own words' direction, and a file chip keeps the punctuation after it, as in the chat.
const REHYPE_PLUGINS: PluggableList = [rehypeTextDirection, rehypeChipPunctuation];
const REMARK_PLUGINS = [remarkGfm, remarkKeepAutolinkSuffixes, remarkKeepWindowsPaths, remarkGithubAlerts, remarkHeadingIds, remarkTaskIndex, remarkBreakAroundImageLines];
const DOCUMENT_OUTLINE_PLUGINS: { remark: PluggableList; rehype: PluggableList } = {
  remark: [remarkGfm, remarkKeepAutolinkSuffixes, remarkKeepWindowsPaths, remarkGithubAlerts, [remarkHeadingIds, { cacheOutline: true }], remarkTaskIndex, remarkBreakAroundImageLines],
  rehype: REHYPE_PLUGINS,
};
// Hosted text: raw HTML parsed, then held to the allow-list (which prefixes ids `user-content-`, as GitHub does).
const HOSTED_REMARK = [remarkGfm, remarkKeepAutolinkSuffixes, remarkGithubAlerts, remarkHeadingIds, remarkEmojiShortcodes];
const HOSTED_REHYPE: PluggableList = [rehypeRaw, [rehypeSanitize, HOSTED_SCHEMA], rehypeTextDirection];
const PLUGINS: Record<Flavor, { remark: PluggableList; rehype: PluggableList }> = {
  document: { remark: REMARK_PLUGINS, rehype: REHYPE_PLUGINS },
  hosted: { remark: [...HOSTED_REMARK, remarkAttachments], rehype: HOSTED_REHYPE },
  "hosted-breaks": { remark: [...HOSTED_REMARK, remarkBreaks, remarkAttachments], rehype: HOSTED_REHYPE },
};

// ── Elements ──────────────────────────────────────────────────────────────

const IMAGE_SRC = /^(?:https?:|data:image\/)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
interface DocumentOptions {
  readonly image?: MarkdownProps["image"];
  readonly onToggleTask?: MarkdownProps["onToggleTask"];
}
const DocumentContext = createContext<RefObject<DocumentOptions>>({ current: {} });
const TaskIndex = createContext<number | null>(null);
const ResponseLi = RESPONSE_COMPONENTS.li as (props: Record<string, unknown>) => ReactNode;

const ALERT_LABELS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

const COMPONENTS: Components = {
  ...RESPONSE_COMPONENTS,
  h1: ({ node: _, ...p }) => <h1 className="mb-2 mt-6 scroll-mt-4 text-[20px] font-semibold leading-tight tracking-[-0.01em] first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h2 className="mb-2 mt-5 scroll-mt-4 text-[16px] font-semibold leading-snug first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h3 className="mb-1.5 mt-4 scroll-mt-4 text-[14px] font-semibold first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h4 className="mb-1 mt-3 scroll-mt-4 text-[14px] font-medium text-muted-foreground first:mt-0" {...p} />,
  h5: ({ node: _, ...p }) => <h5 className="mb-1 mt-3 scroll-mt-4 text-[13px] font-medium text-muted-foreground first:mt-0" {...p} />,
  h6: ({ node: _, ...p }) => <h6 className="mb-1 mt-3 scroll-mt-4 text-[13px] font-medium text-muted-foreground first:mt-0" {...p} />,
  li({ node, ...props }) {
    const task = (props as Record<string, unknown>)["data-task"];
    const item = <ResponseLi node={node} {...props} />;
    return task === undefined ? item : <TaskIndex.Provider value={Number(task)}>{item}</TaskIndex.Provider>;
  },
  // A real checkbox, so a screen reader hears its state; markdown.css draws it like Response's. Live when the host can write the file.
  input({ node: _, checked, type }) {
    const toggle = useContext(DocumentContext).current.onToggleTask;
    const index = useContext(TaskIndex);
    if (type !== "checkbox") return null;
    if (!toggle || index === null) return <input type="checkbox" checked={Boolean(checked)} disabled readOnly className="md-check" />;
    return <input type="checkbox" checked={Boolean(checked)} onChange={() => toggle(index, !checked)} className="md-check md-check-live" />;
  },
  blockquote({ node: _, children, ...props }) {
    const kind = String((props as Record<string, unknown>)["data-alert"] ?? "");
    const label = ALERT_LABELS[kind];
    const dir = (props as { dir?: string }).dir;
    if (!label) return <blockquote dir={dir} className="my-3 border-s-2 border-border ps-3 text-muted-foreground first:mt-0 last:mb-0">{children}</blockquote>;
    return (
      <div role="note" dir={dir} data-alert={kind} className="md-alert my-3 border-s-2 ps-3 first:mt-0 last:mb-0 [&>:nth-child(2)]:mt-0">
        <p className="md-alert-label text-[13px] font-semibold">{label}</p>
        {children}
      </div>
    );
  },
  del: ({ node: _, ...p }) => <del className="text-muted-foreground" {...p} />,
  pre({ node, children }) {
    const code = node?.children.find((child) => child.type === "element");
    // Hosted HTML can hold a bare <pre>: kept as preformatted text.
    if (code?.type !== "element" || code.tagName !== "code")
      return <pre className="my-3 overflow-x-auto rounded-lg bg-foreground/[0.04] px-3 py-2 font-mono text-[12.5px] leading-5 first:mt-0 last:mb-0">{children}</pre>;
    const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
    // A fence names its language in a class; hosted HTML on the <pre> (`<pre lang="sh">`, Dependabot's).
    const lang = node?.properties.lang;
    const language = classes.map(String).find((c) => c.startsWith("language-"))?.slice("language-".length) ?? (typeof lang === "string" && lang ? lang : null);
    const text = hastText(code).replace(/\n$/, "");
    const meta = (code.data as { meta?: string } | undefined)?.meta ?? "";
    return <Fence code={text} language={language} meta={meta} />;
  },
  table: ({ node: _, className, ...p }) => <DocTable className={className} {...p} />,
  img({ node: _, src, alt, width, height, ...rest }) {
    const local = useContext(DocumentContext).current.image;
    if (typeof src === "string" && src && !SCHEME.test(src) && !src.startsWith("//") && local) return local(src, alt ?? "");
    if (typeof src !== "string" || !IMAGE_SRC.test(src)) return alt ? <span className="text-muted-foreground">{alt}</span> : null;
    const attachment = (rest as Record<string, unknown>)["data-attachment"] !== undefined;
    return <Picture src={src} alt={alt ?? ""} width={Number(width) || null} height={Number(height) || null} attachment={attachment} />;
  },
  // Hosted HTML only (hosted.ts): a fold, its summary, a video, a key.
  details({ node: _, children, open }) {
    const kids = Children.toArray(children).filter((c) => typeof c !== "string" || c.trim());
    const first = kids[0];
    const named = isValidElement<{ node?: { tagName?: string } }>(first) && first.props.node?.tagName === "summary";
    return (
      <details open={open} className="md-details group/details my-2 first:mt-0 last:mb-0">
        {named ? first : <Summary>Details</Summary>}
        <div className="ms-[6.5px] mt-1 border-s border-border pb-1 ps-[17px] [&>:first-child]:mt-0">{named ? kids.slice(1) : kids}</div>
      </details>
    );
  },
  summary: ({ node: _, children }) => <Summary>{children}</Summary>,
  video: ({ node: _, src }) => (typeof src === "string" && IMAGE_SRC.test(src) ? <Video src={src} /> : null),
  kbd: ({ node: _, ...p }) => <kbd className="rounded-[4px] border border-b-2 border-border bg-foreground/[0.04] px-1 py-px font-mono text-[11.5px] text-foreground" {...p} />,
};

function hastText(node: { type: string; value?: string; children?: ReadonlyArray<unknown> }): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map((c) => hastText(c as Parameters<typeof hastText>[0])).join("");
}

/** A fold's handle: the chevron turns as it opens. The marker is drawn here, so the browser's is hidden. */
function Summary({ children }: { children: ReactNode }) {
  return (
    <summary className="-ms-1 flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 ps-0.5 pe-1.5 text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-open/details:text-foreground [&::-webkit-details-marker]:hidden [&_p]:inline">
      <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 transition-transform duration-150 group-open/details:rotate-90 motion-reduce:transition-none" />
      <span className="min-w-0">{children}</span>
    </summary>
  );
}

/** Pictures big enough to be a screenshot get a hairline frame; badges and icons stay bare in the line. */
const FIGURE = (w: number, h: number) => w >= 160 && h >= 80;

/**
 * An image as the host sized it: its width and height (GitHub writes both on an upload) hold its box before it
 * loads, so nothing below jumps, and keep a tall screenshot under 640px. An attachment link that is not an image
 * is tried as a video; one that cannot load here (a private repository's) becomes a link to open it.
 */
function Picture({ src, alt, width, height, attachment }: { src: string; alt: string; width: number | null; height: number | null; attachment: boolean }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  if (failed && attachment) return <Video src={src} />;
  if (failed) return <Unshown src={src} what={alt && !/^(image|screenshot|img)$/i.test(alt) ? alt : "Image"} />;
  const sized = width && height ? { width: `min(100%, ${width}px, ${Math.round((640 * width) / height)}px)`, aspectRatio: `${width} / ${height}` } : width ? { width: `min(100%, ${width}px)` } : undefined;
  const size = width && height ? { w: width, h: height } : loaded;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      style={sized}
      onLoad={(e) => setLoaded({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      onError={() => setFailed(true)}
      className={cn("inline-block h-auto max-w-full align-middle", !sized && "max-h-[640px]", (attachment || (size && FIGURE(size.w, size.h))) && "my-1 rounded-[7px] align-top ring-1 ring-border")}
    />
  );
}

function Video({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Unshown src={src} what="Attachment" />;
  return <video src={src} controls preload="metadata" playsInline onError={() => setFailed(true)} className="my-1 block max-h-[480px] max-w-full rounded-[7px] bg-black ring-1 ring-border" />;
}

/** What could not be drawn here (a private repository's upload needs the host's sign-in): a link to open it there. */
function Unshown({ src, what }: { src: string; what: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 align-middle text-[12.5px] text-muted-foreground no-underline ring-1 ring-inset ring-border transition-colors duration-75 hover:text-foreground">
      <Icon icon={ImageNotFound01Icon} className="size-3.5 shrink-0" />
      <span className="truncate">{what} can't be shown here. Open it</span>
    </a>
  );
}

/** A fenced block, drawn like the chat's: ui-chat's CodeBlock with its title, line count and copy. A mermaid fence is its diagram. */
function Fence({ code, language, meta }: { code: string; language: string | null; meta: string }) {
  const [wrap, setWrap] = useState(false);
  if (language === "mermaid") return <Mermaid source={code} />;
  if (language === "math") return <MarkdownMath tex={code} display />;
  const count = code ? code.split("\n").length : 0;
  const file = fenceTitle(meta);
  return (
    <CodeBlock className="my-3 first:mt-0 last:mb-0">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <span className="truncate text-[12.5px] text-foreground">{file ?? languageName(language)}</span>
          <span className="shrink-0 tabular-nums">
            {file ? `${languageName(language)}, ` : ""}
            {count} {count === 1 ? "line" : "lines"}
          </span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
          <CodeBlockExtras code={code} language={language} wrap={wrap} onWrap={setWrap} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent language={language} lineNumbers={count > 3} wrap={wrap}>
        {code}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** A table with hairlines, scrolling sideways in a narrow panel; copy it as Markdown or CSV from its corner. */
function DocTable({ className, ...p }: ComponentProps<"table">) {
  const table = useRef<HTMLTableElement>(null);
  return (
    <div className="group/table relative my-3 first:mt-0 last:mb-0">
      <div className="overflow-x-auto rounded-lg border border-border">
        {/* Cells keep a readable minimum and code stays whole: a narrow panel scrolls the table instead of breaking words. */}
        <table ref={table} className={cn("w-full border-collapse text-[13px] [&_code]:whitespace-nowrap [&_tbody_tr:last-child_td]:border-0 [&_td]:min-w-[9rem]", className)} {...p} />
      </div>
      <TableActions table={table} />
    </div>
  );
}
