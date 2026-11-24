// Merges the latest-mac.yml each arch's build wrote into the one the updater
// reads: the first manifest with every manifest's `files` entries, so arm64 and
// x64 apps each find their own zip (electron-updater picks by arch in the name).
// Line-based on electron-builder's fixed layout; it refuses anything else.
//   node scripts/merge-update-manifests.mjs arm64/latest-mac.yml x64/latest-mac.yml > latest-mac.yml
import { readFileSync } from "node:fs";

/** Splits a manifest into the lines before its file entries, the entries, and the lines after. */
export function split(text) {
  const lines = text.trimEnd().split("\n");
  const start = lines.indexOf("files:");
  if (start < 0 || !/^version: /.test(lines[0] ?? "")) throw new Error("not an electron-builder update manifest");
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("  ")) end += 1;
  return { head: lines.slice(0, start + 1), files: lines.slice(start + 1, end), tail: lines.slice(end) };
}

export function merge(texts) {
  const [first, ...rest] = texts.map(split);
  for (const other of rest) if (other.head[0] !== first.head[0]) throw new Error(`versions differ: ${first.head[0]} and ${other.head[0]}`);
  return `${[...first.head, ...first.files, ...rest.flatMap((m) => m.files), ...first.tail].join("\n")}\n`;
}

if (import.meta.main) process.stdout.write(merge(process.argv.slice(2).map((file) => readFileSync(file, "utf8"))));
