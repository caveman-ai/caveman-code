// desktop.log with a size cap: the runtime's every stdout and stderr line
// lands here, so an append-only file grew without end over weeks of use. It
// now turns over at 10 MB and keeps three old files (desktop.1.log is the
// newest), 
// (app/DesktopObservability.ts, MIT, 13aa882c22). Electron-free.
//
// Appends are synchronous, so a turnover only renames files nothing is still
// writing: with a stream's writes in flight across the renames, Windows CI saw
// lines land in the wrong file.
import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;

export class RotatingLog {
  private fd: number | undefined;
  private closed = false;
  /** Bytes appended since desktop.log last turned over, or last tried to. */
  private size: number;
  private readonly file: string;
  private readonly dir: string;
  private readonly name: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(dir: string, name = "desktop.log", maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
    this.dir = dir;
    this.name = name;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.file = join(dir, name);
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
    if (this.size >= maxBytes) this.turnOver();
  }

  private old(n: number): string {
    return join(this.dir, this.name.replace(/\.log$/, `.${n}.log`));
  }

  /** desktop.log -> desktop.1.log -> ... -> desktop.<keep>.log, the oldest dropped. */
  private shift(): void {
    rmSync(this.old(this.keep), { force: true });
    for (let n = this.keep - 1; n >= 1; n--) if (existsSync(this.old(n))) renameSync(this.old(n), this.old(n + 1));
    if (existsSync(this.file)) renameSync(this.file, this.old(1));
    this.size = 0;
  }

  private turnOver(): void {
    try {
      this.shift();
    } catch {
      // A log file held open (Windows will not rename or delete it under a log viewer or a scan): keep appending to
      // this one and try again a cap's worth later. Trying at every line would drop an old file each time.
      this.size = 0;
    }
  }

  write(line: string): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(line);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        if (this.fd !== undefined) closeSync(this.fd);
        this.fd = undefined;
        this.turnOver();
      }
      this.fd ??= openSync(this.file, "a");
      writeSync(this.fd, line);
      this.size += bytes;
    } catch {
      // A full disk or a log folder gone: the app keeps running without its log rather than crash for it.
    }
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    return Promise.resolve();
  }
}
