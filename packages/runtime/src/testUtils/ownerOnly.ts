// A file or folder only its person may open, as each platform keeps it. Off Windows that is its mode: the runtime
// sets 0600 or 0700 itself. Windows has no mode bits (every file reads 0666, read-only 0444); there what the runtime
// writes under its state dir inherits the state dir's DACL, which is this user's alone: the profile's own, or the one
// makeStateDirPrivate sets on a home outside it (stateDirAcl.ts).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WIN = process.platform === "win32";
const system32 = (exe: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);

/** SYSTEM and Administrators, as SDDL names them or by SID: they can open any file anyway. */
const TRUSTED = new Set(["SY", "S-1-5-18", "BA", "S-1-5-32-544"]);

let me: string | undefined;
/** This user's SID, and SDDL's name for it when it is the built-in Administrator (RID 500, a CI runner's account). */
function mine(): ReadonlySet<string> {
  me ??= /S-1-5-[\d-]+/.exec(execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }))![0];
  return new Set(me.endsWith("-500") ? [me, "LA"] : [me]);
}

/** `target`'s DACL in SDDL, as icacls saves it (UTF-16: its name, then the SDDL). */
function sddlOf(target: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "owner-only-"));
  try {
    const file = path.join(scratch, "acl");
    execFileSync(system32("icacls.exe"), [target, "/save", file, "/q"], { windowsHide: true });
    return fs.readFileSync(file, "utf16le").split(/\r?\n/)[1] ?? "";
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Who may open `target`. Off Windows: its permission bits. On Windows: "owner only" when every entry of its DACL that
 * allows anything (and applies to it, not only to what it holds) names this user, SYSTEM or Administrators;
 * otherwise the DACL itself, so a failure says who else may.
 */
export function accessOf(target: string): number | string {
  if (!WIN) return fs.statSync(target).mode & 0o777;
  const sddl = sddlOf(target);
  const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl)?.[1];
  if (!dacl) return sddl;
  const allowed = new Set([...TRUSTED, ...mine()]);
  for (const ace of dacl.slice(1, -1).split(")(")) {
    const [type, flags = "", , , , sid = ""] = ace.split(";");
    if (type === "A" && !flags.includes("IO") && !allowed.has(sid)) return sddl;
  }
  return "owner only";
}

/** What accessOf reads for a target the runtime keeps to its person: `mode` off Windows, "owner only" on Windows. */
export const ownerOnly = (mode: number): number | string => (WIN ? "owner only" : mode);
