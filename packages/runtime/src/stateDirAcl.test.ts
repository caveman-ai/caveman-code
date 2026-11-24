import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { makeStateDirPrivate, privateSddl, type Run, sddlIsPrivate } from "./stateDirAcl.ts";

const ME = "S-1-5-21-1-2-3-1001";
const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\me" };

describe("sddlIsPrivate", () => {
  it("takes a protected DACL of this user, SYSTEM and Administrators, and nothing else", () => {
    expect(sddlIsPrivate(privateSddl(ME), ME)).toBe(true);
    expect(sddlIsPrivate(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})(D;;FA;;;WD)`, ME)).toBe(true);
    // Not protected, inherited from above, or open to another account, Users, Authenticated Users or Everyone.
    expect(sddlIsPrivate(`D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`, ME)).toBe(false);
    expect(sddlIsPrivate(`D:PAI(A;OICIID;FA;;;SY)(A;OICI;FA;;;${ME})`, ME)).toBe(false);
    for (const other of ["S-1-5-21-1-2-3-1002", "BU", "AU", "WD"]) expect(sddlIsPrivate(`D:PAI(A;OICI;FA;;;${ME})(A;OICI;0x1200a9;;;${other})`, ME)).toBe(false);
    expect(sddlIsPrivate("", ME)).toBe(false);
    // SDDL names the built-in Administrator (RID 500, a CI runner's account) LA.
    expect(sddlIsPrivate("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)", "S-1-5-21-1-2-3-500")).toBe(true);
    expect(sddlIsPrivate("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)", ME)).toBe(false);
  });
});

describe("makeStateDirPrivate", () => {
  it("leaves alone a home off Windows or inside the profile", () => {
    const run: Run = () => {
      throw new Error("ran");
    };
    expect(makeStateDirPrivate("/home/me/.caveman-code/userdata", { platform: "linux", env, run })).toBe("not-windows");
    expect(makeStateDirPrivate("c:\\users\\ME\\.caveman-code\\userdata", { platform: "win32", env, run })).toBe("in-profile");
  });

  it("outside it, sets the DACL whole by System32's icacls, with this user's SID, once", () => {
    const calls: Array<string> = [];
    let sddl = `D:AI(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;OICIID;FA;;;${ME})`;
    const run: Run = (file, args) => {
      calls.push([file, ...args.filter((arg) => !arg.includes("caveman-acl-"))].join(" "));
      if (file.endsWith("whoami.exe")) return { status: 0, stdout: `"pc\\me","${ME}"\r\n` };
      if (args[1] === "/save") fs.writeFileSync(args[2]!, `userdata\r\n${sddl}\r\n`, "utf16le");
      if (args[1] === "/restore") sddl = fs.readFileSync(args[2]!, "utf16le").split("\r\n")[1]!;
      return { status: 0, stdout: "" };
    };
    expect(makeStateDirPrivate("D:\\cave\\userdata", { platform: "win32", env, run })).toBe("made-private");
    expect(calls).toEqual([
      "C:\\Windows\\System32\\whoami.exe /user /fo csv /nh",
      "C:\\Windows\\System32\\icacls.exe D:\\cave\\userdata /save /q",
      "C:\\Windows\\System32\\icacls.exe D:\\cave /restore /q",
    ]);
    expect(sddl).toBe(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`);
    expect(makeStateDirPrivate("D:\\cave\\userdata", { platform: "win32", env, run })).toBe("private");
    expect(calls).toHaveLength(5);
  });

  // Windows only: the ACL as Windows reads it back, by SID.
  it.runIf(process.platform === "win32")("on Windows leaves a state dir outside the profile to this user and SYSTEM", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-acl-"));
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    try {
      fs.writeFileSync(path.join(dir, "session-protocol.token"), "t0ken");
      // The test's USERPROFILE is a scratch folder, so the temp dir is outside it, as D:\ would be.
      const outside = { ...process.env, USERPROFILE: path.join(os.tmpdir(), "elsewhere") };
      expect(makeStateDirPrivate(dir, { env: outside })).toBe("made-private");
      const read = (target: string) =>
        execFileSync(
          path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$a = Get-Acl -LiteralPath '${target.replace(/'/g, "''")}'; "protected=$($a.AreAccessRulesProtected)"; $a.Access | ForEach-Object { "$($_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) $($_.AccessControlType) $($_.FileSystemRights) inherited=$($_.IsInherited)" }`,
          ],
          { encoding: "utf8", windowsHide: true },
        )
          .trim()
          .split(/\r?\n/);
      const me = /S-1-5-[\d-]+/.exec(execFileSync(path.join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }))![0];
      // Exactly the two the runtime sets: no entry another tool or the folder above added survives.
      expect(read(dir).sort()).toEqual([`${me} Allow FullControl inherited=False`, "S-1-5-18 Allow FullControl inherited=False", "protected=True"].sort());
      // What it holds inherits the same two, and nothing else.
      expect(read(path.join(dir, "session-protocol.token")).filter((line) => !line.startsWith("protected=")).sort()).toEqual(
        [`${me} Allow FullControl inherited=True`, "S-1-5-18 Allow FullControl inherited=True"].sort(),
      );
      // Read back as icacls lists it, the way the next start checks it.
      const saved = path.join(os.tmpdir(), `caveman-acl-${process.pid}.txt`);
      execFileSync(path.join(systemRoot, "System32", "icacls.exe"), [dir, "/save", saved, "/q"]);
      const sddl = fs.readFileSync(saved, "utf16le").split(/\r?\n/)[1]!;
      fs.rmSync(saved, { force: true });
      expect(sddlIsPrivate(sddl, me), sddl).toBe(true);
      expect(makeStateDirPrivate(dir, { env: outside })).toBe("private");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
