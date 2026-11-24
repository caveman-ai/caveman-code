// A process's environment as another process of the same user reads it: /proc/<pid>/environ on Linux, `ps eww` on
// macOS, and on Windows the block its PEB points at, read with ReadProcessMemory (what Process Explorer shows).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// x64 offsets: PROCESS_BASIC_INFORMATION.PebBaseAddress 0x08, PEB.ProcessParameters 0x20,
// RTL_USER_PROCESS_PARAMETERS.Environment 0x80 and EnvironmentSize 0x3F0.
const PEB_READER = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PebEnvironment {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, byte[] info, int length, out int returned);
  static byte[] Read(IntPtr process, long address, long size) {
    var buffer = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(process, (IntPtr)address, buffer, (IntPtr)size, out read)) throw new Exception("ReadProcessMemory " + Marshal.GetLastWin32Error());
    return buffer;
  }
  public static string Of(int pid) {
    IntPtr process = OpenProcess(0x0410, false, pid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    try {
      var basic = new byte[48];
      int returned;
      int status = NtQueryInformationProcess(process, 0, basic, basic.Length, out returned);
      if (status != 0) throw new Exception("NtQueryInformationProcess " + status);
      long peb = BitConverter.ToInt64(basic, 8);
      long parameters = BitConverter.ToInt64(Read(process, peb + 0x20, 8), 0);
      long environment = BitConverter.ToInt64(Read(process, parameters + 0x80, 8), 0);
      long size = BitConverter.ToInt64(Read(process, parameters + 0x3F0, 8), 0);
      return Encoding.Unicode.GetString(Read(process, environment, size)).Replace('\\0', '\\n');
    } finally {
      CloseHandle(process);
    }
  }
}
'@
[Console]::Out.Write([PebEnvironment]::Of(__PID__))
`;

/** `pid`'s environment, one NAME=value a line (on macOS, ps's one line of command and environment). */
export function environmentOf(pid: number): string {
  if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
  if (process.platform !== "win32") return execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Encoded, so no quote or line of the script depends on how Windows splits a command line.
  const script = Buffer.from(PEB_READER.replace("__PID__", String(pid)), "utf16le").toString("base64");
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], { encoding: "utf8", windowsHide: true });
}
