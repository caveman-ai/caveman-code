// The runtime's state dir (userdata) holds its Session Protocol token, secrets, logs and traces. Off Windows the
// home is chmod 0700 (ServerConfig.ensureServerDirectories). On Windows that is a no-op, and the default home under
// %USERPROFILE% is already this user's alone; CAVEMAN_CODE_HOME can put it anywhere, though, D:\ among them, whose
// default ACL lets every signed-in user read and add. There the state dir gets an ACL of its own.
import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type Run = (file: string, args: ReadonlyArray<string>) => { readonly status: number | null; readonly stdout: string };

const runSync: Run = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "" };
};

/** Windows' own tool by full path: a bare name is looked for in the current directory first. */
const system32 = (env: NodeJS.ProcessEnv, exe: string) => NodePath.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", exe);

/** A path's long form where it exists: Windows hands out 8.3 short names (C:\Users\RUNNER~1) for some folders. */
const longForm = (path: string): string => {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return path;
  }
};

/** Whether `dir` is `root` or inside it, as Windows compares paths: by long name, case-insensitively. */
function isInside(dir: string, root: string): boolean {
  const relative = NodePath.win32.relative(longForm(root).toLowerCase(), longForm(dir).toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !NodePath.win32.isAbsolute(relative));
}

/** SYSTEM and the Administrators group, as SDDL names them or by SID. Administrators can take any file anyway. */
const TRUSTED = new Set(["SY", "S-1-5-18", "BA", "S-1-5-32-544"]);

/** SDDL's name for a few accounts' SIDs: the built-in Administrator (RID 500, a CI runner's account) and Guest. */
const alias = (sid: string) => (sid.endsWith("-500") ? "LA" : sid.endsWith("-501") ? "LG" : sid);

/**
 * Whether a DACL in SDDL (`D:PAI(A;OICI;FA;;;SY)…`) is private to `user` (a SID): protected from inheritance, and
 * nothing in it allows anyone but the user, SYSTEM or Administrators, nor came from above (ID).
 */
export function sddlIsPrivate(sddl: string, user: string): boolean {
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl || !dacl[1]!.includes("P")) return false;
  for (const ace of dacl[2]!.slice(1, -1).split(")(")) {
    const [type, flags = "", , , , sid = ""] = ace.split(";");
    if (flags.includes("ID")) return false;
    if (type === "A" && sid !== user && sid !== alias(user) && !TRUSTED.has(sid)) return false;
  }
  return true;
}

/** The state dir's DACL: this user's and SYSTEM's, full control, inherited by all it holds, protected from above. */
export const privateSddl = (user: string) => `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`;

export type StateDirAcl = "not-windows" | "in-profile" | "private" | "made-private" | "failed";

/**
 * On Windows, outside %USERPROFILE%: `dir`'s DACL becomes privateSddl, set whole through `icacls /restore` (so no
 * entry another tool added survives, as one would `/grant`). Read first (`icacls /save`), so a start that finds it
 * private changes nothing: a change walks every file it holds. Never throws: the caller logs "failed".
 */
export function makeStateDirPrivate(
  dir: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly run?: Run } = {},
): StateDirAcl {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return "not-windows";
  const profile = env.USERPROFILE;
  if (profile && NodePath.win32.isAbsolute(profile) && isInside(dir, profile)) return "in-profile";
  const run = options.run ?? runSync;
  // This user's SID: by name, another account that shares it could be the one granted.
  const user = /S-1-5-[\d-]+/.exec(run(system32(env, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]).stdout)?.[0];
  if (user === undefined) return "failed";
  const icacls = system32(env, "icacls.exe");
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-acl-"));
  try {
    // `/save` writes the name and the DACL as UTF-16 lines; `/restore` reads the same from the folder above.
    const file = NodePath.join(scratch, "acl");
    if (run(icacls, [dir, "/save", file, "/q"]).status !== 0) return "failed";
    const saved = NodeFS.readFileSync(file, "utf16le");
    const lines = saved.split(/\r?\n/);
    if (sddlIsPrivate(lines[1] ?? "", user)) return "private";
    NodeFS.writeFileSync(file, `${lines[0]}\r\n${privateSddl(user)}\r\n`, "utf16le");
    return run(icacls, [NodePath.win32.dirname(dir), "/restore", file, "/q"]).status === 0 ? "made-private" : "failed";
  } catch {
    return "failed";
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}
