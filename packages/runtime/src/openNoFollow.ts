// Opening a file that must not be a symlink (a repo's pin or .env file, a session file, a skill or a rule, which could
// point outside where they belong).
import * as fs from "node:fs";

const refused = (file: string, why: string) => Object.assign(new Error(`${file} ${why}`), { code: "ELOOP" });

/**
 * fs.openSync that refuses a symlink at `file`: O_NOFOLLOW where the OS has it. Windows has no O_NOFOLLOW (the
 * constant is undefined, so OR-ing it in follows the link), so there `file` is lstat-ed first and the descriptor
 * opened must be that same file, which a link swapped in between the two would not be. Compared as bigints: NTFS file
 * ids pass 2^53, where two numbers can round to the same one.
 */
export function openNoFollowSync(file: string, flags: number): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow !== undefined) return fs.openSync(file, flags | noFollow);
  const named = fs.lstatSync(file, { bigint: true });
  if (named.isSymbolicLink()) throw refused(file, "is a symbolic link");
  const fd = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw refused(file, "changed while it was opened");
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

/** openNoFollowSync's promise form, for a FileHandle. */
export async function openNoFollow(file: string, flags: number): Promise<fs.promises.FileHandle> {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow !== undefined) return fs.promises.open(file, flags | noFollow);
  const named = await fs.promises.lstat(file, { bigint: true });
  if (named.isSymbolicLink()) throw refused(file, "is a symbolic link");
  const handle = await fs.promises.open(file, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw refused(file, "changed while it was opened");
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}
