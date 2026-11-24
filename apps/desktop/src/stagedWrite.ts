// A file written beside its target and renamed over it, so a crash mid-write leaves the last good copy. A write or
// rename that throws (a full disk; on Windows EPERM or EBUSY while antivirus or an indexer holds the target) takes its
// staging file with it instead of leaving `<file>.<pid>.tmp` behind, which for the device key held a sealed key.
// The intent ), whose settings writes remove their temp file the same way.
import { renameSync, rmSync, writeFileSync, type WriteFileOptions } from "node:fs";

export function writeFileStaged(
  file: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptions,
): void {
  const staging = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, data, options);
    renameSync(staging, file);
  } finally {
    // Gone already after a rename; never let the cleanup hide the write's own error.
    try {
      rmSync(staging, { force: true });
    } catch {}
  }
}
