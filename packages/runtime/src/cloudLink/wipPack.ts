// A moved chat's work in progress arrives as one git bundle per copied segment, each holding only what the one
// before it lacked (moves.ts `wip_bundle`). Fetching them one by one costs a handful of processes each in the tools
// container, which under gVisor on a loaded node is most of an adopt (K10). Each bundle is a header (its
// prerequisites and tips) and a thin pack, so their packs become one: every pack's entries in order under one header
// with their summed count and a fresh trailer. Offsets inside an entry stay relative to its own pack, and a delta
// on another pack's object names it by id, which `git index-pack --fix-thin` resolves inside the merged pack or from
// the repository. One index-pack then takes every bundle at once.
import { createHash } from "node:crypto";

export interface MergedWip {
  /** One pack holding every bundle's objects, for `git index-pack --stdin --fix-thin`. */
  readonly pack: Buffer;
  /**
   * The commits the bundles build on: once the pack is in, each must be in the repository (one another bundle
   * brought, or one origin had). A missing one is a commit only the source had (K9) or one origin has that this
   * checkout lacks.
   */
  readonly prerequisites: ReadonlyArray<string>;
  /** Every bundle's tips (the work-in-progress commits). */
  readonly tips: ReadonlyArray<string>;
}

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A bundle's header and pack, or undefined for anything but a v2 or v3 bundle with a plain pack. */
export function parseBundle(raw: Buffer) {
  let at = 0;
  const line = () => {
    const end = raw.indexOf(0x0a, at);
    if (end < 0) return undefined;
    const text = raw.subarray(at, end).toString("utf8");
    at = end + 1;
    return text;
  };
  const signature = line();
  if (signature !== "# v2 git bundle" && signature !== "# v3 git bundle") return undefined;
  let hash: "sha1" | "sha256" = "sha1";
  const prerequisites: Array<string> = [];
  const tips: Array<string> = [];
  for (let text = line(); text !== ""; text = line()) {
    if (text === undefined) return undefined;
    if (text.startsWith("@")) {
      // v3 capabilities: only the object format is understood; a filter (a partial bundle) is not.
      const [key, value] = text.slice(1).split("=", 2);
      if (key === "object-format" && (value === "sha1" || value === "sha256")) hash = value;
      else return undefined;
      continue;
    }
    const id = (text.startsWith("-") ? text.slice(1) : text).split(" ", 1)[0]!;
    if (!HEX.test(id) || id.length !== (hash === "sha1" ? 40 : 64)) return undefined;
    (text.startsWith("-") ? prerequisites : tips).push(id);
  }
  const pack = raw.subarray(at);
  const trailer = hash === "sha1" ? 20 : 32;
  if (pack.length < 12 + trailer || pack.toString("latin1", 0, 4) !== "PACK") return undefined;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return undefined;
  return { hash, prerequisites, tips, count: pack.readUInt32BE(8), entries: pack.subarray(12, pack.length - trailer) };
}

/** The bundles' packs as one (see above), or undefined when one of them is not a bundle this understands. */
export function mergeWipBundles(bundles: ReadonlyArray<Buffer>): MergedWip | undefined {
  const parsed = bundles.map(parseBundle);
  if (parsed.length === 0 || parsed.some((b) => b === undefined)) return undefined;
  const all = parsed as Array<NonNullable<ReturnType<typeof parseBundle>>>;
  const hash = all[0]!.hash;
  if (all.some((b) => b.hash !== hash)) return undefined;
  const count = all.reduce((sum, b) => sum + b.count, 0);
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...all.map((b) => b.entries)]);
  const pack = Buffer.concat([body, createHash(hash).update(body).digest()]);
  return { pack, prerequisites: [...new Set(all.flatMap((b) => b.prerequisites))], tips: all.flatMap((b) => b.tips) };
}
