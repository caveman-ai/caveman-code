import { describe, expect, it } from "vitest";

import { envKey, envValue, pickEnv, WINDOWS_ESSENTIAL_ENV } from "./processEnv.ts";

const windowsEnv = {
  Path: "C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm",
  SystemRoot: "C:\\Windows",
  windir: "C:\\Windows",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\me",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ANTHROPIC_API_KEY: "sk-secret",
  https_proxy: "http://proxy:3128",
};

describe("pickEnv", () => {
  it("keeps the named variables and drops the rest off Windows", () => {
    expect(pickEnv({ PATH: "/usr/bin", HOME: "/home/me", SECRET: "x", SystemRoot: "C:\\Windows" }, ["PATH", "HOME"], "linux")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
    });
  });

  it("matches names ignoring case on Windows, under the name the environment uses, and adds the essentials", () => {
    const picked = pickEnv(windowsEnv, ["PATH", "HOME", "HTTPS_PROXY", "https_proxy"], "win32");
    expect(picked.Path).toBe(windowsEnv.Path);
    expect(picked.PATH).toBeUndefined();
    expect(picked.https_proxy).toBe("http://proxy:3128");
    expect(Object.keys(picked).filter((key) => key.toUpperCase() === "HTTPS_PROXY")).toHaveLength(1);
    for (const name of WINDOWS_ESSENTIAL_ENV) expect(picked[name], name).toBe(windowsEnv[name]);
    expect(picked.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("reads one variable ignoring case only on Windows", () => {
    expect(envKey(windowsEnv, "PATH", "win32")).toBe("Path");
    expect(envValue(windowsEnv, "path", "win32")).toBe(windowsEnv.Path);
    expect(envKey(windowsEnv, "PATH", "darwin")).toBeUndefined();
  });
});
