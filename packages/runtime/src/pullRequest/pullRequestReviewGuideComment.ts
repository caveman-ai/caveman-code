/**
 * A review guide as one comment on its pull request (docs/).
 * The comment is Markdown a reviewer without Caveman Code reads on the host: the TL;DR, the calls the maintainer has
 * to make, the behaviour before and after, then the stops in reading order, each folded, with the lines that carry it
 * as a diff. The guide itself rides along in a hidden marker, so a teammate's Caveman Code reads it instead of
 * writing its own, and the runtime that posted it finds the comment again to keep it current.
 *
 * Everything a model wrote is made inert before it lands: no HTML, no links or images of its own, and no mentions,
 * since a comment notifies whoever it names and it is posted under the person's own account.
 *
 * @module pullRequest/pullRequestReviewGuideComment
 */
import { createHash } from "node:crypto";

import {
  PullRequestReviewGuide,
  type PullRequestReviewGuideAttention,
  type PullRequestReviewGuideExcerpt,
  type PullRequestReviewGuideStop,
  TrimmedNonEmptyString,
} from "@caveman-app/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { REVIEW_GUIDE_TIER_LABEL } from "./pullRequestReviewGuideLadder.ts";

/** Opens the hidden marker; the guide's JSON, when it fits, follows on the same line. */
export const GUIDE_COMMENT_MARKER = "<!-- caveman:review-guide";

/** The longest comment GitHub takes. */
export const GUIDE_COMMENT_LIMIT = 65_536;

const {
  modelSelection: _modelSelection,
  threadId: _threadId,
  posted: _posted,
  ...sharedFields
} = PullRequestReviewGuide.fields;

/**
 * What the marker carries: the guide without what only means something on the computer that wrote it (its model's
 * provider instance, which can name an account, and its chat), plus the writer as the footer names it.
 */
export const PostedReviewGuide = Schema.Struct({
  v: Schema.Literal(1),
  /** "Claude Haiku 5.5 · single pass". */
  label: Schema.optionalKey(TrimmedNonEmptyString),
  /** The model's id, for a reader that lists the same model. */
  model: Schema.optionalKey(TrimmedNonEmptyString),
  ...sharedFields,
});
export type PostedReviewGuide = typeof PostedReviewGuide.Type;

const encodePosted = Schema.encodeSync(Schema.fromJsonString(PostedReviewGuide));
const decodePosted = Schema.decodeUnknownOption(Schema.fromJsonString(PostedReviewGuide));

/**
 * Who wrote a guide and how: "Claude Haiku 5.5 · single pass", "No model · template", and for a TL;DR the chat
 * wrote, its model "· in the chat that opened it". `model` is the model's name as the person would say it.
 */
export const guideWriterLabel = (
  guide: PullRequestReviewGuide,
  model: string | undefined,
): string | undefined =>
  guide.posted !== undefined
    ? guide.posted.label
    : guide.writer === undefined
      ? model
      : guide.writer.tier === "template"
        ? `No model · ${REVIEW_GUIDE_TIER_LABEL.template}`
        : guide.writer.tier === "chat"
          ? model && `${model} · in the chat that opened it`
          : model && `${model} · ${REVIEW_GUIDE_TIER_LABEL[guide.writer.tier]}`;

/**
 * Whether a guide is worth a comment no one asked for: a tour, or a short change's TL;DR that carries a call. A
 * TL;DR alone says what the description already says, and a template is a bot's dependency bump.
 */
export const guideWorthPosting = (guide: PullRequestReviewGuide): boolean =>
  guide.writer?.tier !== "template" &&
  ((guide.depth ?? "tour") === "tour"
    ? guide.stops.some((stop) => !isSkim(stop))
    : guide.attention !== undefined);

/** Whether a comment is a guide comment, with or without the guide in its marker. */
export const isGuideComment = (body: string): boolean => body.includes(GUIDE_COMMENT_MARKER);

/** The guide a comment's marker carries, or null: none, cut, or not one this version reads. */
export function readGuideComment(body: string): PostedReviewGuide | null {
  const at = body.lastIndexOf(GUIDE_COMMENT_MARKER);
  if (at < 0) return null;
  const start = at + GUIDE_COMMENT_MARKER.length;
  const end = body.indexOf("-->", start);
  if (end < 0) return null;
  const json = body.slice(start, end).trim();
  return json === "" ? null : Option.getOrNull(decodePosted(json));
}

export interface GuideCommentContext {
  /** The pull request's page, `https://github.com/acme/app/pull/7`. */
  readonly url: string;
  /** Who wrote it, as `guideWriterLabel` says it. */
  readonly label?: string | undefined;
  /** Each changed file's section of the host's unified diff, by path, for the lines an excerpt shows. */
  readonly patches: ReadonlyMap<string, string>;
}

/**
 * The comment for `guide`: everything when it fits under GitHub's limit, then without the code (the links stay),
 * then without the guide in its marker, and last the TL;DR and the stops' titles.
 */
export function renderGuideComment(
  guide: PullRequestReviewGuide,
  context: GuideCommentContext,
): string {
  const payload = markerOf(guide, context);
  const bare = `${GUIDE_COMMENT_MARKER} -->`;
  for (const [code, marker] of [
    [true, payload],
    [false, payload],
    [false, bare],
  ] as const) {
    const body = `${render(guide, context, code)}\n\n${marker}\n`;
    if (body.length <= GUIDE_COMMENT_LIMIT) return body;
  }
  return `${renderTitles(guide, context)}\n\n${bare}\n`;
}

// ---------------------------------------------------------------- the comment

const CALL_WORD: Record<PullRequestReviewGuideAttention["kind"], string> = {
  tradeoff: "Trade-off",
  contract: "Contract",
  product: "Product call",
  risk: "Risk taken",
  accessibility: "Accessibility",
};

/** The closing stop the normalizer adds for files the tour does not otherwise cover. */
const isSkim = (stop: PullRequestReviewGuideStop) =>
  stop.excerpts.length === 0 && stop.notes.length === 0 && stop.attention === null;

function render(
  guide: PullRequestReviewGuide,
  context: GuideCommentContext,
  code: boolean,
): string {
  const tour = (guide.depth ?? "tour") === "tour";
  const parts = [head(guide)];
  if (!tour) {
    if (guide.attention)
      parts.push(
        alert(guide.attention.kind === "risk" ? "WARNING" : "IMPORTANT", callLine(guide.attention)),
      );
    parts.push(footer(guide, context));
    return parts.join("\n\n");
  }
  const calls = guide.stops.flatMap((stop, index) =>
    stop.attention ? [{ stop, index, attention: stop.attention }] : [],
  );
  if (calls.length === 1) {
    const { stop, index, attention } = calls[0]!;
    parts.push(
      alert(
        "IMPORTANT",
        `${callLine(attention)}\n<sub>Stop ${index + 1}, ${inert(stop.title)}</sub>`,
      ),
    );
  } else if (calls.length > 1) {
    parts.push(
      alert(
        "IMPORTANT",
        [
          `**${calls.length} calls for you**`,
          ...calls.map(
            ({ index, attention }) =>
              `- **${CALL_WORD[attention.kind]}** (stop ${index + 1}) · ${inert(flat(attention.note))}`,
          ),
        ].join("\n"),
      ),
    );
  }
  if (guide.beforeAfter && guide.beforeAfter.rows.length > 0) {
    const rows = guide.beforeAfter.rows.map(
      (row) => `${row.op} ${"  ".repeat(row.depth)}${flat(row.text)}`,
    );
    parts.push(
      `**Before → after** · ${inert(flat(guide.beforeAfter.title))}\n\n${fenced(rows.join("\n"), "diff")}`,
    );
  }
  const stops = guide.stops.map((stop, index) =>
    stopSection(stop, index, guide.stops.length, context, code),
  );
  if (stops.length > 0) {
    // Every stop is numbered but the closing skim stop, so the count says what the list shows.
    const counted = guide.stops.length - (isSkim(guide.stops.at(-1)!) ? 1 : 0);
    parts.push(
      `**Read it in this order** · ${counted} ${counted === 1 ? "stop" : "stops"}, each with only the lines that carry it\n\n${stops.join("\n")}`,
    );
  }
  if (!code && guide.stops.some((stop) => stop.excerpts.length > 0)) {
    parts.push(
      "<sub>The code is left out to fit the host's comment limit; each stop links to its lines.</sub>",
    );
  }
  parts.push(footer(guide, context));
  return parts.join("\n\n");
}

function head(guide: PullRequestReviewGuide): string {
  const lines = ["### Review guide"];
  if (guide.tldr) lines.push(`**${inert(flat(guide.tldr))}**`);
  if (guide.overview) lines.push(block(guide.overview));
  return lines.join("\n\n");
}

function callLine(attention: PullRequestReviewGuideAttention): string {
  return `**${CALL_WORD[attention.kind]}** · ${inert(flat(attention.note))}`;
}

function stopSection(
  stop: PullRequestReviewGuideStop,
  index: number,
  total: number,
  context: GuideCommentContext,
  code: boolean,
): string {
  const skim = isSkim(stop) && index === total - 1;
  const files = stop.files.length;
  const count = `${files} ${files === 1 ? "file" : "files"}`;
  const label = skim
    ? `<strong>${html(stop.title)}</strong> · ${count}`
    : `<strong>${index + 1}. ${html(stop.title)}</strong>${
        stop.attention
          ? ` · <em>${CALL_WORD[stop.attention.kind]}</em>`
          : stop.excerpts.length === 0 && files > 0
            ? ` · ${count}`
            : ""
      }`;
  const body: string[] = [];
  if (stop.summary.trim() && !skim) body.push(block(stop.summary));
  // GitHub draws an alert only at the top level, never inside a fold: here the call is a quote.
  if (stop.attention) body.push(`> ${callLine(stop.attention)}`);
  for (const excerpt of stop.excerpts) body.push(excerptSection(excerpt, stop, context, code));
  if (files > 0) {
    body.push(
      stop.files
        .map(
          (file) =>
            `- ${codeSpan(file.path)}${file.note?.trim() ? ` · ${inert(flat(file.note))}` : ""}`,
        )
        .join("\n"),
    );
  }
  return `<details>\n<summary>${label}</summary>\n\n${body.join("\n\n")}\n\n</details>`;
}

function excerptSection(
  excerpt: PullRequestReviewGuideExcerpt,
  stop: PullRequestReviewGuideStop,
  context: GuideCommentContext,
  code: boolean,
): string {
  const range =
    excerpt.start === excerpt.end ? `L${excerpt.start}` : `L${excerpt.start}–${excerpt.end}`;
  const where = linkTo(context, excerpt.path, excerpt.side, excerpt.start, excerpt.end, range);
  const caption = excerpt.caption.trim() ? ` · ${inert(flat(excerpt.caption))}` : "";
  const removed = excerpt.side === "old" ? " · removed lines" : "";
  const lines = [`${codeSpan(excerpt.path)} ${where}${removed}${caption}`];
  if (code) {
    const rows = excerptRows(
      context.patches.get(excerpt.path),
      excerpt.side,
      excerpt.start,
      excerpt.end,
    );
    // All new code reads better highlighted as its language than as a wall of green, as the app draws it.
    if (rows.length > 0 && rows.every((row) => row.startsWith("+"))) {
      lines.push(fenced(rows.map((row) => row.slice(1)).join("\n"), languageOf(excerpt.path)));
    } else if (rows.length > 0) {
      lines.push(fenced(rows.join("\n"), "diff"));
    }
  }
  const notes = stop.notes.filter(
    (note) => note.path === excerpt.path && excerpt.start <= note.line && note.line <= excerpt.end,
  );
  if (notes.length > 0) {
    lines.push(
      notes
        .map(
          (note) =>
            `- ${linkTo(context, note.path, excerpt.side, note.line, note.line, `L${note.line}`)} **${inert(flat(note.title))}**${note.body.trim() ? ` · ${inert(flat(note.body))}` : ""}`,
        )
        .join("\n"),
    );
  }
  return lines.join("\n\n");
}

function footer(guide: PullRequestReviewGuide, context: GuideCommentContext): string {
  const sha = guide.headSha.slice(0, 7);
  const commit = github(context.url)
    ? `[${codeSpan(sha)}](${repositoryOf(context.url)}/commit/${guide.headSha})`
    : codeSpan(sha);
  const by = context.label ? ` by ${inert(context.label)}` : "";
  return `<sub>Written for ${commit}${by} · Made with [Caveman Code](https://caveman.so)</sub>`;
}

function renderTitles(guide: PullRequestReviewGuide, context: GuideCommentContext): string {
  const stops = guide.stops.map((stop, index) => `${index + 1}. ${inert(flat(stop.title))}`);
  return [
    head(guide),
    ...(stops.length > 0 ? [stops.join("\n")] : []),
    footer(guide, context),
  ].join("\n\n");
}

function alert(kind: "IMPORTANT" | "WARNING", text: string): string {
  return [`> [!${kind}]`, ...text.split("\n").map((line) => `> ${line}`)].join("\n");
}

function markerOf(guide: PullRequestReviewGuide, context: GuideCommentContext): string {
  const { modelSelection, threadId: _thread, posted: _from, ...shared } = guide;
  let json: string;
  try {
    json = encodePosted({
      v: 1,
      ...(context.label ? { label: context.label } : {}),
      model: modelSelection.model,
      ...shared,
    });
  } catch {
    // A guide this version cannot carry still gets its comment, just not the copy a teammate would read.
    return `${GUIDE_COMMENT_MARKER} -->`;
  }
  // No `<`, `>` or `&` survives, so nothing in the guide can close the comment it rides in, and no `@`, so nothing
  // in it reads as a mention.
  return `${GUIDE_COMMENT_MARKER} ${json.replace(/[<>&@]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)} -->`;
}

// ---------------------------------------------------------------- links

const github = (url: string) => /^https:\/\/github\.com\//i.test(url);
const repositoryOf = (url: string) => url.replace(/\/pull\/\d+\/?$/, "");

/** `text` linked to those lines in the pull request's own diff, on GitHub; plain text on a host this does not know. */
function linkTo(
  context: GuideCommentContext,
  path: string,
  side: "new" | "old",
  start: number,
  end: number,
  text: string,
): string {
  if (!github(context.url)) return text;
  const letter = side === "new" ? "R" : "L";
  const anchor = `diff-${createHash("sha256").update(path).digest("hex")}${letter}${start}${end > start ? `-${letter}${end}` : ""}`;
  return `[${text}](${context.url.replace(/\/$/, "")}/files#${anchor})`;
}

// ---------------------------------------------------------------- the code

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The diff lines from the first whose number on `side` is in `start..end` to the last, each with its `+`, `-` or
 * space, as GitHub's diff highlighting reads them, with the change on the other side that sits against them (the
 * lines new code replaced, the lines that replaced removed code). Empty when the patch never reaches those lines.
 */
export function excerptRows(
  patch: string | undefined,
  side: "new" | "old",
  start: number,
  end: number,
): string[] {
  if (patch === undefined) return [];
  const rows: Array<{ readonly text: string; readonly no: number | null }> = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = raw[0];
      if (mark === "+") {
        rows.push({ text: raw, no: side === "new" ? newNo : null });
        (newNo++, newLeft--);
        continue;
      }
      if (mark === "-") {
        rows.push({ text: raw, no: side === "old" ? oldNo : null });
        (oldNo++, oldLeft--);
        continue;
      }
      if (mark === " " || raw === "") {
        rows.push({ text: raw === "" ? " " : raw, no: side === "new" ? newNo : oldNo });
        (oldNo++, newNo++, oldLeft--, newLeft--);
        continue;
      }
      if (mark === "\\") continue;
      oldLeft = newLeft = 0;
    }
    const header = HUNK.exec(raw);
    if (header === null) continue;
    oldNo = Number(header[1]);
    newNo = Number(header[3]);
    oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    newLeft = header[4] === undefined ? 1 : Number(header[4]);
  }
  const inRange = (row: (typeof rows)[number]) =>
    row.no !== null && start <= row.no && row.no <= end;
  let first = rows.findIndex(inRange);
  let last = rows.findLastIndex(inRange);
  if (first < 0) return [];
  // New lines read with the lines they replace, removed lines with what replaced them, as the diff shows them.
  if (side === "new") while (first > 0 && rows[first - 1]!.text.startsWith("-")) first--;
  else while (last < rows.length - 1 && rows[last + 1]!.text.startsWith("+")) last++;
  return rows.slice(first, last + 1).map((row) => row.text.trimEnd() || " ");
}

// ---------------------------------------------------------------- inert text

const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
const ZERO_WIDTH_SPACE = "​";

/** Prose a model wrote, on one line. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** Outside code spans: no HTML, no link or image syntax, no mentions. Code spans stay as written. */
function inert(text: string): string {
  return outsideCode(text, (plain) =>
    plain
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([[\]])/g, "\\$1")
      .replace(/@(?=[\w-])/g, `@${ZERO_WIDTH_SPACE}`),
  );
}

/** The labels a guide's lines lead with ("before: …", "why: …"), drawn bold. */
const LINE_LABEL = /^(what|why|how|before|after|risk|note)\s*:\s+/i;

/** A paragraph a model wrote: each line inert, and none read as a heading, quote, list or rule. */
function block(text: string): string {
  return text
    .trim()
    .split(/\n+/)
    .map((line) => {
      const label = LINE_LABEL.exec(line.trim());
      const rest = inert(line.trim().slice(label?.[0].length ?? 0)).replace(
        /^([#>*+=|-]|\d+[.)])/,
        "\\$1",
      );
      return label
        ? `**${label[1]![0]!.toUpperCase()}${label[1]!.slice(1).toLowerCase()}:** ${rest}`
        : rest;
    })
    .join("\n");
}

/** The fence language GitHub highlights a file by: its extension, which Linguist knows by that name. */
function languageOf(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension === undefined
    ? ""
    : (({ mjs: "js", cjs: "js", mts: "ts", cts: "ts", yml: "yaml" } as Record<string, string>)[
        extension
      ] ?? extension);
}

/** For HTML (a `<summary>`, where Markdown is not read): escaped, code spans drawn as `<code>`. */
function html(text: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  let out = "";
  let at = 0;
  const line = flat(text);
  for (const match of line.matchAll(CODE_SPAN)) {
    out += escape(line.slice(at, match.index)).replace(/@(?=[\w-])/g, `@${ZERO_WIDTH_SPACE}`);
    out += `<code>${escape(match[2]!.trim())}</code>`;
    at = match.index + match[0].length;
  }
  return out + escape(line.slice(at)).replace(/@(?=[\w-])/g, `@${ZERO_WIDTH_SPACE}`);
}

function outsideCode(text: string, transform: (plain: string) => string): string {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += transform(text.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + transform(text.slice(at));
}

const longestRun = (text: string) =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

function codeSpan(text: string): string {
  const ticks = "`".repeat(longestRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function fenced(text: string, language: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
