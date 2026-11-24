// Moved by mistake (docs/, Install): a packaged Mac app started from the
// installer (the .dmg) or Downloads asks, before its window, to move itself into Applications, the one place it
// can update itself (Squirrel.Mac replaces the app where it is, which a read-only disk image refuses). Electron's
// app.moveToApplicationsFolder copies it there and reopens it. The record in <userData>/move-to-applications.json
// keeps where it ran from, so the reopened app can eject the installer it came from, and a "Not Now", so the
// question comes once per version. Electron-free: main passes in what Electron and hdiutil say.
import { readFileSync, rmSync } from "node:fs";
// macOS paths whatever the platform this is built or tested on: the move only ever runs on a Mac.
import { posix } from "node:path";
import { writeFileStaged } from "./stagedWrite.ts";

/** <userData>/move-to-applications.json. */
export interface MoveRecord {
  /** The app bundle that moved itself, as it was before the move. */
  readonly movedFrom?: string;
  /** The version whose question was answered Not Now. */
  readonly notNow?: string;
}

/** The question, as dialog.showMessageBox takes it (main adds the app's icon). */
export const MOVE_QUESTION = {
  type: "none",
  message: "Move Caveman Code to Applications?",
  detail: "It's running from the installer, where it can't update itself. Moving it takes a second, then it reopens.",
  buttons: ["Move and Reopen", "Not Now"],
  defaultId: 0,
  cancelId: 1,
} as const;

/** Ask before the window: a packaged Mac app outside Applications, not the smoke test, not declined for this version. */
export function shouldOfferMove(input: {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly smoke: boolean;
  readonly inApplications: boolean;
  readonly version: string;
  readonly record: MoveRecord;
}): boolean {
  return input.platform === "darwin" && input.packaged && !input.smoke && !input.inApplications && input.record.notNow !== input.version;
}

/** The .app bundle an executable runs from: <bundle>/Contents/MacOS/<name>. */
export const bundleOf = (execPath: string): string => posix.resolve(execPath, "../../..");

/** "/Volumes/Caveman Code" for anything on that volume; null off /Volumes. */
export function volumeOf(path: string): string | null {
  const parts = posix.resolve(path).split(posix.sep);
  return parts[1] === "Volumes" && parts[2] ? posix.join(posix.sep, "Volumes", parts[2]) : null;
}

/** The mount points of attached disk images, from `hdiutil info -plist`. */
export function diskImageMounts(plist: string): string[] {
  return [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => unescapeXml(m[1]!));
}

/** A key's string value in an Info.plist (XML, as electron-builder writes it); null when absent. */
export function plistString(xml: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match ? unescapeXml(match[1]!) : null;
}

const unescapeXml = (text: string): string =>
  text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name]!);

/**
 * The installer volume to eject on this launch, or null: this app now runs from Applications, the record says it
 * moved from a /Volumes path, that volume is still an attached disk image, and the app still on it is Caveman Code
 * (`bundleIdOnVolume`: the recorded bundle's CFBundleIdentifier, or null when it is gone).
 */
export function installerToEject(input: {
  readonly inApplications: boolean;
  readonly record: MoveRecord;
  readonly diskImageMounts: readonly string[];
  readonly bundleIdOnVolume: string | null;
  readonly bundleId: string;
}): string | null {
  const volume = input.record.movedFrom ? volumeOf(input.record.movedFrom) : null;
  if (!input.inApplications || volume === null) return null;
  return input.diskImageMounts.includes(volume) && input.bundleIdOnVolume === input.bundleId ? volume : null;
}

/** What to do when Applications already has a Caveman Code: replace it, unless it runs or is newer than this one. */
export type Conflict = "replace" | "running" | "newer";

export function conflictOf(type: "exists" | "existsAndRunning", existingVersion: string | null, version: string): Conflict {
  if (type === "existsAndRunning") return "running";
  return existingVersion !== null && compareVersions(existingVersion, version) > 0 ? "newer" : "replace";
}

/** What to say about a conflict that stops the move, as dialog.showMessageBoxSync takes it; null to go ahead. */
export function conflictMessage(conflict: Conflict, existingVersion: string | null, version: string): { message: string; detail: string } | null {
  if (conflict === "running") {
    return {
      message: "Caveman Code is already open from Applications.",
      detail: "Quit that one, then open this one again to replace it. This one keeps running from the installer for now.",
    };
  }
  if (conflict === "newer") {
    return {
      message: "A newer Caveman Code is already in Applications.",
      detail: `Applications has ${existingVersion}; this installer has ${version}. Open Caveman Code from Applications instead.`,
    };
  }
  return null;
}

/** Semver order (major.minor.patch, then a release above its prereleases); <0, 0 or >0. Unparsable sorts lowest. */
export function compareVersions(left: string, right: string): number {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const x = a[4].split(".");
  const y = b[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xn = /^\d+$/.test(x[i]!);
    const yn = /^\d+$/.test(y[i]!);
    if (xn && yn && Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

/** The record; empty when unset or unreadable. */
export function readMoveRecord(file: string): MoveRecord {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof raw.movedFrom === "string" ? { movedFrom: raw.movedFrom } : {}),
      ...(typeof raw.notNow === "string" ? { notNow: raw.notNow } : {}),
    };
  } catch {
    return {};
  }
}

/** Writes the record, or removes the file when nothing is left in it. */
export function writeMoveRecord(file: string, record: MoveRecord): void {
  if (record.movedFrom === undefined && record.notNow === undefined) {
    rmSync(file, { force: true });
    return;
  }
  writeFileStaged(file, `${JSON.stringify(record)}\n`);
}
