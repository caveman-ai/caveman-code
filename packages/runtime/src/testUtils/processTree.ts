// Every process below a process, for tests that check nothing is left running: from ps, or on Windows (no ps there)
// from its process table through CIM. Windows never updates a process's parent id, so one whose parent has exited
// names a dead pid, which Windows may hand out again: winlogon.exe, whose smss.exe left at boot, then reads as a child
// of the test's node, with dwm.exe below it. A child is never older than its parent, so on Windows a process older
// than the one its parent id names now is not below it. Elsewhere an orphan's parent becomes init, and the id holds.
import { execFileSync } from "node:child_process";
import * as path from "node:path";

interface Row {
  readonly pid: number;
  readonly ppid: number;
  /** When it started, as a Windows file time; 0 off Windows, where no check needs it. */
  readonly created: bigint;
  readonly name: string;
}

function table(): Array<Row> {
  const text =
    process.platform === "win32"
      ? execFileSync(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.Name)" }',
          ],
          { encoding: "utf8", windowsHide: true },
        )
      : execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cells) => cells.length >= 2)
    .map((cells) => {
      const [pid, ppid, ...rest] = cells;
      const [created, ...name] = process.platform === "win32" ? rest : ["0", ...rest];
      return { pid: Number(pid), ppid: Number(ppid), created: /^\d+$/.test(created ?? "") ? BigInt(created!) : 0n, name: name.join(" ") };
    });
}

/** Every process below `root`, as `pid name` lines. */
export function descendantsOf(root: number): Array<string> {
  const rows = table();
  const started = new Map<number, bigint>([[root, rows.find((row) => row.pid === root)?.created ?? 0n]]);
  const out: Array<string> = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      const parent = started.get(row.ppid);
      if (started.has(row.pid) || parent === undefined || row.created < parent) continue;
      started.set(row.pid, row.created);
      out.push(`${row.pid} ${row.name}`);
      grew = true;
    }
  }
  return out;
}
