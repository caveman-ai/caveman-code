// Deleting a folder a process just ran in: an engine CLI's home, which was also its working directory. On Windows a
// process that was just stopped (or an antivirus scan of what it wrote) holds a handle there for a moment after it is
// gone, and the delete fails with EBUSY or EPERM; there it is tried again for up to 2 s, as fs.rm's maxRetries would.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";

export const removeTree = (fs: FileSystem.FileSystem, dir: string) =>
  fs.remove(dir, { recursive: true, force: true }).pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 20, while: () => process.platform === "win32" }),
  );
