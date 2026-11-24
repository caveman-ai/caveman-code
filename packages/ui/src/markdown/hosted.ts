/**
 * Text written on a code host (a pull request's description, a review comment) as the host draws it. Its HTML goes
 * through GitHub's own allow-list (hast-util-sanitize's default schema), so folds, sized screenshots, <kbd>, <sub> and
 * badges draw while no script, style, handler, frame or form survives; template comments (`<!-- … -->`) vanish.
 * An attachment link alone on its line is the image or video it points at, and the common `:shortcode:` emoji draw.
 */
import type { Options as SanitizeSchema } from "rehype-sanitize";
import { defaultSchema } from "rehype-sanitize";

export const HOSTED_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  // A <style> block's text would otherwise stay behind as a paragraph of CSS.
  strip: [...(defaultSchema.strip ?? []), "style"],
  tagNames: [...(defaultSchema.tagNames ?? []), "video"],
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    img: [...(defaultSchema.attributes?.img ?? []), "dataAttachment"],
    video: ["src"],
  },
};

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** An uploaded file on GitHub: today's user-attachments, the repository assets before them, and the old video links. */
const ATTACHMENT =
  /^https:\/\/(?:github\.com\/user-attachments\/assets\/[0-9a-f-]{36}|github\.com\/[\w.-]+\/[\w.-]+\/assets\/\d+\/[0-9a-f-]{36}|user-images\.githubusercontent\.com\/\d+\/[\w-]+\.(?:mp4|mov|webm))$/i;

const BLANK = /^[ \t]*$/;

/** Nothing but spaces between the node at `i` and the line's start (`step` -1) or end (`step` 1). */
function aloneToward(kids: MdNode[], i: number, step: 1 | -1): boolean {
  for (let j = i + step; j >= 0 && j < kids.length; j += step) {
    const k = kids[j]!;
    if (k.type === "break") return true;
    if (k.type !== "text") return false;
    const v = k.value ?? "";
    const nl = step < 0 ? v.lastIndexOf("\n") : v.indexOf("\n");
    if (nl >= 0) return BLANK.test(step < 0 ? v.slice(nl + 1) : v.slice(0, nl));
    if (!BLANK.test(v)) return false;
  }
  return true;
}

/** A bare attachment link on a line of its own becomes the media itself (an image that falls back to video). */
export function remarkAttachments() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      const kids = node.children;
      if (!kids) return;
      if (node.type === "paragraph")
        kids.forEach((k, i) => {
          const text = k.type === "link" && k.children?.length === 1 && k.children[0]!.type === "text" ? k.children[0]!.value : null;
          if (!text || text !== k.url || !ATTACHMENT.test(text) || !aloneToward(kids, i, -1) || !aloneToward(kids, i, 1)) return;
          kids[i] = { type: "image", url: text, alt: "", data: { hProperties: { dataAttachment: "" } } };
        });
      kids.forEach(visit);
    };
    visit(tree);
  };
}

// The shortcodes pull requests and their bots actually use (release-please opens with :robot:); others stay text.
const EMOJI: Record<string, string> = {
  "+1": "👍", "-1": "👎", thumbsup: "👍", thumbsdown: "👎", robot: "🤖", rocket: "🚀", tada: "🎉", sparkles: "✨",
  bug: "🐛", warning: "⚠️", rotating_light: "🚨", no_entry: "⛔", x: "❌", white_check_mark: "✅",
  heavy_check_mark: "✔️", ballot_box_with_check: "☑️", memo: "📝", pencil2: "✏️", books: "📚", book: "📖",
  wrench: "🔧", hammer: "🔨", hammer_and_wrench: "🛠️", gear: "⚙️", package: "📦", arrow_up: "⬆️", arrow_down: "⬇️",
  arrow_right: "➡️", lock: "🔒", unlock: "🔓", key: "🔑", zap: "⚡", fire: "🔥", boom: "💥", recycle: "♻️",
  construction: "🚧", art: "🎨", lipstick: "💄", bulb: "💡", mag: "🔍", eyes: "👀", link: "🔗", pushpin: "📌",
  information_source: "ℹ️", question: "❓", exclamation: "❗", heavy_plus_sign: "➕", heavy_minus_sign: "➖",
  test_tube: "🧪", broom: "🧹", truck: "🚚", globe_with_meridians: "🌐", chart_with_upwards_trend: "📈",
  checkered_flag: "🏁", star: "⭐", heart: "❤️", pray: "🙏", wave: "👋", rewind: "⏪", hourglass: "⌛",
  green_heart: "💚", red_circle: "🔴", green_circle: "🟢", yellow_circle: "🟡", white_circle: "⚪",
};
const SHORTCODE = /:([a-z0-9_+-]+):/g;

/** `:robot:` → 🤖 in text (never in code, which is not a text node). */
export function remarkEmojiShortcodes() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (node.type === "text" && node.value?.includes(":")) node.value = node.value.replace(SHORTCODE, (all, code: string) => EMOJI[code] ?? all);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
