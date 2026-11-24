// Parsed Markdown, kept for the next mount. A chat shown again (a tab or thread switch, rows scrolling back into
// the transcript's window) draws the same finished text with the same plugins: its React elements are immutable
// and read their options, offsets and the open tail from context when they render, so the elements made the
// first time stand in for parsing again. Parsing is most of what drawing Markdown costs. 
// markdownRenderer.ts (#27480, #27823), on react-markdown's own synchronous renderer, so nothing new ships.
import type { ReactElement } from "react";
import ReactMarkdown, { type Components, type Options, type UrlTransform } from "react-markdown";

type Plugins = NonNullable<Options["remarkPlugins"]>;

// An element and the syntax tree it keeps hold about 20 bytes per source character, so about 10 MB at most.
const MAX_CACHED_CHARS = 500_000;
// A short block still holds a whole element tree.
const ENTRY_OVERHEAD_CHARS = 200;
const rendered = new Map<string, ReactElement>();
let cachedChars = 0;
let nextRenderer = 0;

const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, element: ReactElement): void {
  // One huge document would otherwise push out everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, element);
  cachedChars += entrySize(key);
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    rendered.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

export interface MarkdownRendererOptions {
  readonly remarkPlugins: Plugins;
  readonly rehypePlugins: Plugins;
  readonly components: Components;
  readonly urlTransform: UrlTransform;
}

/** Draws Markdown as `<ReactMarkdown>` does with these options; `cache` keeps the result for the same text again. */
export type MarkdownRenderer = (text: string, cache: boolean) => ReactElement;

const renderers = new WeakMap<Plugins, WeakMap<Plugins, MarkdownRenderer>>();

/**
 * One renderer per plugin pair, so every block drawn with the same (module-level) lists shares its entries.
 * Pass the same `components` and `urlTransform` for a pair every time: they are not part of the key.
 */
export function markdownRenderer(options: MarkdownRendererOptions): MarkdownRenderer {
  let byRehype = renderers.get(options.remarkPlugins);
  if (!byRehype) renderers.set(options.remarkPlugins, (byRehype = new WeakMap()));
  let render = byRehype.get(options.rehypePlugins);
  if (!render) byRehype.set(options.rehypePlugins, (render = createRenderer(options)));
  return render;
}

function createRenderer({
  remarkPlugins,
  rehypePlugins,
  components,
  urlTransform,
}: MarkdownRendererOptions): MarkdownRenderer {
  const prefix = `${nextRenderer++}\u0000`;
  return (text, cache) => {
    const key = prefix + text;
    const hit = rendered.get(key);
    if (hit !== undefined) {
      // Most recently used goes last: the eviction order.
      rendered.delete(key);
      rendered.set(key, hit);
      return hit;
    }
    // react-markdown's default export is synchronous and uses no hooks: called, it returns the element tree it renders.
    const element = ReactMarkdown({
      children: text,
      remarkPlugins,
      rehypePlugins,
      components,
      urlTransform,
    });
    if (cache) remember(key, element);
    return element;
  };
}

/** Test seam: how many blocks are kept and their size in characters. */
export function markdownCacheSize(): { readonly entries: number; readonly chars: number } {
  return { entries: rendered.size, chars: cachedChars };
}
