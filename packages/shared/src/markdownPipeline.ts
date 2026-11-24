// ), packages/shared/src/markdownPipeline.ts @ ab3a3cd1.
import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import type { Processor, Transformer } from "unified";
import { isWindowsAbsolutePath } from "./path.ts";
import type { PluggableList } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
} from "./codexMarkdownDirectives.ts";
import { isWindowsDrivePathHref } from "./markdownLinks.ts";
import { THREAD_LINK_PROTOCOL } from "./threadLinks.ts";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

function meaningfulHastChildren(node: MarkdownImageHastNode): MarkdownImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child as { value?: string }).value?.trim() === ""),
  );
}

/**
 * An image that is the only content of its block (optionally wrapped in a
 * link) is almost always a screenshot or figure, so it gets a reserved slot
 * while it loads. Images mixed with text or other images — badge rows, icons
 * in a sentence — stay inline at their natural size, since a placeholder taller
 * than the image would move the page more than the image itself does.
 */
/** Containers whose sole child image reads as a figure rather than part of a sentence. */
const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

function soleImageDescendant(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined {
  const children = meaningfulHastChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  // A link, emphasis, or similar inline wrapper around the image still counts
  // as long as nothing else shares the block.
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownImageHastNode) {
  // A raw `<img>` on its own line reaches the root without a paragraph.
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

/** Keep unmatched inline `<A>` placeholders from opening an HTML link over later blocks. */
function rehypePreserveBareAnchorPlaceholders() {
  return (tree: MarkdownImageHastNode) => {
    const anchors: Array<MarkdownImageHastNode | null> = [];
    let rawTextTag: string | undefined;
    const visit = (node: MarkdownImageHastNode) => {
      if (node.type === "raw" && typeof node.value === "string") {
        // Raw blocks can contain several tags. Consume whole tags, quoted attributes,
        // and comments so text resembling a closing anchor cannot pair a placeholder.
        const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        let offset = 0;
        while (rawTextTag !== "plaintext") {
          // Raw text ends at its closing tag even inside comment-looking text.
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, "gi") : tags;
          matcher.lastIndex = offset;
          const match = matcher.exec(node.value);
          if (!match) break;
          const [tag] = match;
          offset = matcher.lastIndex;
          if (rawTextTag) {
            rawTextTag = undefined;
            continue;
          }
          if (tag.startsWith("<!--")) continue;
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          ) {
            rawTextTag = opening;
          } else if (opening === "a") {
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
          } else if (closing === "a") {
            anchors.pop();
          }
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    for (const anchor of anchors) {
      if (anchor) anchor.type = "text";
    }
  };
}

/** Carries authored image source metadata through the sanitizer to the image renderer. */
function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    markStandaloneImages(tree);
  };
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // Fence languages plus the two math classes the web chat's math plugin emits.
    code: [
      ["className", /^language-./, "math-inline", "math-display"],
      "dataCodeMeta",
      "dataInlineCode",
    ],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    a: [...(defaultSchema.attributes?.a ?? []), "dataPullRequestAutolink"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataLocalSrc",
      "dataMarkdownTitle",
      "dataStandalone",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "file",
      "t3-citation",
      "t3-context",
      THREAD_LINK_PROTOCOL,
    ],
    src: [...(defaultSchema.protocols?.src ?? []), "file", "t3-context"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypePreserveBareAnchorPlaceholders,
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

const isImageNode = (node: PhrasingContent | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children.length === 1 &&
    isImageNode(node.children[0]));
const endsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /\n[ \t]*$/.test(node.value));
const startsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*\n/.test(node.value));

function breakLinesAroundImages(paragraph: Paragraph) {
  const children = paragraph.children;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  paragraph.children = children.flatMap((child, index): PhrasingContent[] => {
    if (child.type !== "text") return [child];
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage) return [child];
    const parts: PhrasingContent[] = [];
    let value = child.value;
    if (afterImage) {
      value = value.replace(/^[ \t]*\n/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = beforeImage && /\n[ \t]*$/.test(value);
    if (breakAfter) value = value.replace(/[ \t]*\n[ \t]*$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

/**
 * Agents label screenshots with a line like `**Palette**` right above the image. CommonMark
 * joins those lines into one paragraph, which puts the image inline beside its label. An
 * image alone on its source line keeps that line; prose and inline badges still wrap.
 */
export function remarkBreakAroundImageLines() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

export function remarkKeepAutolinkSuffixes(): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index];
        const next = node.children[index + 1];
        if (child?.type === "link" && /^https?:\/\//i.test(child.url) && next?.type === "text") {
          const suffix = /^[_~]+/.exec(next.value)?.[0];
          if (!suffix) continue;
          const label = child.children.length === 1 ? child.children[0] : undefined;
          if (label?.type !== "text") continue;
          if (label.value !== child.url && `http://${label.value}` !== child.url) continue;
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const bare =
            !child.position ||
            (start !== undefined &&
              end !== undefined &&
              source.slice(start, end) === label.value &&
              source.slice(end, end + suffix.length) === suffix);
          if (bare) {
            child.url += suffix;
            label.value += suffix;
            next.value = next.value.slice(suffix.length);
            if (child.position && end !== undefined) {
              const boundary = {
                ...child.position.end,
                column: child.position.end.column + suffix.length,
                offset: end + suffix.length,
              };
              child.position.end = boundary;
              if (label.position) label.position.end = boundary;
              if (next.position) next.position.start = boundary;
            }
            if (!next.value) node.children.splice(index + 1, 1);
          }
        }
        if (child) visit(child);
      }
    };
    visit(tree);
  };
}

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        /^[A-Za-z]:[\\/]/.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

interface DestinationCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string; url?: string }>;
  resume(): string;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathDestination(this: DestinationCompileContext, token: unknown) {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  // Character references still need decoding, so those destinations keep the parsed URL.
  if (node)
    node.url = isWindowsAbsolutePath(authored) && !authored.includes("&") ? authored : decoded;
}

// A drive path that has not reached whitespace yet: `C:`, `C:\Users\me`, `C:/work`.
const UNFINISHED_DRIVE_PATH = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/;

interface EscapeCompileContext {
  readonly stack: ReadonlyArray<{
    readonly type: string;
    children?: Array<{ type: string; value?: string }>;
  }>;
}

function keepWindowsPathEscape(this: EscapeCompileContext) {
  const text = this.stack.at(-1)?.children?.at(-1);
  if (text?.type !== "text" || text.value === undefined) return;
  const before = text.value.slice(0, -1);
  if (UNFINISHED_DRIVE_PATH.test(before)) text.value = `${before}\\${text.value.slice(-1)}`;
}

/**
 * CommonMark reads the `\.` in `C:\me\.t3\shot.png` as an escape. Every backslash in a
 * Windows path is a separator, so link, image, and definition destinations that are
 * Windows paths keep the text as written, and so do escapes inside drive paths in prose.
 * Prose paths end at whitespace: past that, nothing tells a path from a sentence, and
 * `C:\x and \*this\*` must still read `*this*`.
 */
export function remarkKeepWindowsPaths(this: Processor) {
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
      characterEscape: keepWindowsPathEscape,
    },
  });
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}
