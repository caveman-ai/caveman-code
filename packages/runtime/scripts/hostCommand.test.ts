import { expect, it } from "vitest";

import { escapeCmdArg, hostCommand } from "./hostCommand.ts";

it("runs the command as is off Windows", () => {
  expect(hostCommand("pnpm", ["--filter", "@caveman-app/web", "build"], "linux")).toEqual({ file: "pnpm", args: ["--filter", "@caveman-app/web", "build"], shell: false });
});

it("hands cmd.exe one escaped line on Windows, so a .cmd shim runs without DEP0190", () => {
  expect(hostCommand("npm", ["pack", "--pack-destination", "C:\\Users\\A B\\out"], "win32")).toEqual({
    file: 'npm ^"pack^" ^"--pack-destination^" ^"C:\\Users\\A^ B\\out^"',
    args: [],
    shell: true,
  });
  // A trailing backslash must not escape the closing quote; cmd's metacharacters never act.
  expect(escapeCmdArg("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  expect(escapeCmdArg('a&b|c"d')).toBe('^"a^&b^|c\\^"d^"');
  // A path (Node itself, an .exe) runs directly.
  expect(hostCommand("C:\\node\\node.exe", ["x.mjs"], "win32")).toEqual({ file: "C:\\node\\node.exe", args: ["x.mjs"], shell: false });
  expect(() => hostCommand("pnpm & calc", [], "win32")).toThrow(/bare command/);
});
