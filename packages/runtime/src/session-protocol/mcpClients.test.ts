// Settings > Caveman MCP's one-click install (mcpClients.ts): the TOML and JSON rewrites keep everything else in the
// person's config, detection reads a temp home, and Claude Code and VS Code get exactly the argv their CLIs take
// (fake binaries on a fake PATH record it). Nothing here touches the real home. The temp home is a Mac's on any POSIX
// runner and Windows' on Windows, where the fakes are `.cmd` files as npm's shims are; the Windows cases that need no
// Windows run everywhere with the platform set.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pickEnv } from "@caveman-app/shared/processEnv";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  detect,
  install,
  installFor,
  jsonHasServer,
  parseJsonc,
  spawnCommand,
  status,
  tomlHasServer,
  tomlServer,
  upsertJsonServer,
  upsertTomlServer,
  type Host,
  GROK_BOT_LINK,
} from "./mcpClients.ts";

const win = process.platform === "win32";

const COMMAND = ["/Users/Jane Doe/.caveman-code/bin/caveman-code", "mcp"];
const BLOCK = tomlServer(COMMAND);
const OURS = `[mcp_servers.caveman-code]\ncommand = "/Users/Jane Doe/.caveman-code/bin/caveman-code"\nargs = ["mcp"]\n`;

describe("the TOML rewrite", () => {
  test("a missing or empty config gets the table alone", () => {
    expect(upsertTomlServer("", "caveman-code", BLOCK)).toBe(OURS);
    expect(upsertTomlServer("\n\n", "caveman-code", BLOCK)).toBe(OURS);
  });

  test("the server's table is appended after what was there, which stays byte for byte", () => {
    const before = `# my codex\nmodel = "gpt-5.5"\n\n[mcp_servers.github]\ncommand = "gh-mcp" # inline comment\n`;
    expect(upsertTomlServer(before, "caveman-code", BLOCK)).toBe(`${before}\n${OURS}`);
    // No line break at the end: one is added before the blank line.
    expect(upsertTomlServer("model = 1", "caveman-code", BLOCK)).toBe(`model = 1\n\n${OURS}`);
  });

  test("an existing table is replaced, the tables around it untouched, and one blank line stays where it was", () => {
    const before = [
      `model = "o3"`,
      ``,
      `[mcp_servers.caveman-code]`,
      `command = "/old/caveman-code"`,
      `args = ["code", "mcp"]`,
      `startup_timeout_sec = 30`,
      ``,
      `# the GitHub server`,
      `[mcp_servers.github]`,
      `command = "gh-mcp"`,
      ``,
    ].join("\n");
    const after = upsertTomlServer(before, "caveman-code", BLOCK);
    expect(after).toBe([`model = "o3"`, ``, `# the GitHub server`, `[mcp_servers.github]`, `command = "gh-mcp"`, ``, OURS].join("\n"));
    // Twice is the same as once.
    expect(upsertTomlServer(after, "caveman-code", BLOCK)).toBe(after);
  });

  test("its subtables go with it, next to it or further down; a server whose name only starts the same stays", () => {
    const before = [
      `[mcp_servers.caveman-code]`,
      `command = "/old"`,
      `[mcp_servers.caveman-code.env]`,
      `TOKEN = "x"`,
      ``,
      `[mcp_servers.caveman-code-old]`,
      `command = "/older"`,
      ``,
      `[profiles.fast]`,
      `model = "o4-mini"`,
      ``,
      `[[mcp_servers.caveman-code.tools]]`,
      `name = "chat_start"`,
      ``,
      `[tui]`,
      `theme = "dark"`,
      ``,
    ].join("\n");
    expect(upsertTomlServer(before, "caveman-code", BLOCK)).toBe(
      [`[mcp_servers.caveman-code-old]`, `command = "/older"`, ``, `[profiles.fast]`, `model = "o4-mini"`, ``, `[tui]`, `theme = "dark"`, ``, OURS].join("\n"),
    );
  });

  test("a quoted or spaced header is the same table", () => {
    for (const header of [`[mcp_servers."caveman-code"]`, `[mcp_servers.'caveman-code']`, `[ mcp_servers . "caveman-code" ]  # ours`]) {
      const before = `[a]\nb = 1\n\n${header}\ncommand = "/old"\n`;
      expect(tomlHasServer(before, "caveman-code")).toBe(true);
      expect(upsertTomlServer(before, "caveman-code", BLOCK)).toBe(`[a]\nb = 1\n\n${OURS}`);
    }
  });

  test("a bracket inside a multi-line string or array is no header", () => {
    const before = [
      `instructions = """`,
      `[mcp_servers.caveman-code]`,
      `not a table"""`,
      `args = [`,
      `  ["mcp_servers"],`,
      `  ["nested"]`,
      `]`,
      `literal = '''`,
      `[mcp_servers.caveman-code]'''`,
      ``,
    ].join("\n");
    expect(tomlHasServer(before, "caveman-code")).toBe(false);
    expect(upsertTomlServer(before, "caveman-code", BLOCK)).toBe(`${before}\n${OURS}`);
  });

  test("Windows line breaks stay Windows line breaks", () => {
    expect(upsertTomlServer("[a]\r\nb = 1\r\n", "caveman-code", BLOCK)).toBe(`[a]\r\nb = 1\r\n\r\n${OURS.replaceAll("\n", "\r\n")}`);
  });

  test("a server defined another way, which a table would clash with, or a broken file is refused", () => {
    expect(() => upsertTomlServer(`[mcp_servers]\ncaveman-code = { command = "x" }\n`, "caveman-code", BLOCK)).toThrow(/already defines caveman-code another way/);
    expect(() => upsertTomlServer(`mcp_servers.caveman-code.command = "x"\n`, "caveman-code", BLOCK)).toThrow(/another way/);
    expect(() => upsertTomlServer(`mcp_servers = { github = { command = "gh" } }\n`, "caveman-code", BLOCK)).toThrow(/another way/);
    expect(() => upsertTomlServer(`a = """\nnever closed\n`, "caveman-code", BLOCK)).toThrow(/isn't valid TOML/);
    // Another server as dotted keys is no clash.
    expect(upsertTomlServer(`[mcp_servers]\ngithub.command = "gh"\n`, "caveman-code", BLOCK)).toBe(`[mcp_servers]\ngithub.command = "gh"\n\n${OURS}`);
  });

  test("the block: TOML strings for any path, Codex's approval mode", () => {
    expect(tomlServer([`/a "b"\\c\u007f`, "code", "mcp"], { default_tools_approval_mode: "approve" })).toEqual([
      `command = "/a \\"b\\"\\\\c\\u007F"`,
      `args = ["code", "mcp"]`,
      `default_tools_approval_mode = "approve"`,
    ]);
  });
});

describe("the JSON rewrite", () => {
  const entry = { command: COMMAND[0], args: ["mcp"] };

  test("a missing or empty config starts as an object with the server", () => {
    const expected = `{\n  "mcpServers": {\n    "caveman-code": {\n      "command": "/Users/Jane Doe/.caveman-code/bin/caveman-code",\n      "args": [\n        "mcp"\n      ]\n    }\n  }\n}\n`;
    expect(upsertJsonServer(undefined, "mcpServers", "caveman-code", entry)).toBe(expected);
    expect(upsertJsonServer("  \n", "mcpServers", "caveman-code", entry)).toBe(expected);
  });

  test("the entry is replaced in place, every other server and key kept, in the file's own indent", () => {
    const before = `{\n    "theme": "dark",\n    "mcpServers": {\n        "github": { "command": "gh" },\n        "caveman-code": { "command": "/old", "env": { "A": "1" } },\n        "linear": { "url": "https://mcp.linear.app" }\n    },\n    "zzz": 1\n}\n`;
    const after = JSON.parse(upsertJsonServer(before, "mcpServers", "caveman-code", entry)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(after)).toEqual(["theme", "mcpServers", "zzz"]);
    expect(Object.keys(after.mcpServers!)).toEqual(["github", "caveman-code", "linear"]);
    expect(after.mcpServers!["caveman-code"]).toEqual(entry);
    expect(after.mcpServers!.github).toEqual({ command: "gh" });
    expect(upsertJsonServer(before, "mcpServers", "caveman-code", entry)).toMatch(/^\{\n {4}"theme"/);
    expect(upsertJsonServer(`{\n\t"mcpServers": {}\n}`, "mcpServers", "caveman-code", entry)).toMatch(/^\{\n\t"mcpServers"/);
  });

  test("a config that isn't plain JSON, or holds the servers as something else, is refused", () => {
    expect(() => upsertJsonServer(`{ // mine\n "mcpServers": {} }`, "mcpServers", "caveman-code", entry)).toThrow(/isn't plain JSON/);
    expect(() => upsertJsonServer(`[]`, "mcpServers", "caveman-code", entry)).toThrow(/isn't a JSON object/);
    expect(() => upsertJsonServer(`{"mcpServers": []}`, "mcpServers", "caveman-code", entry)).toThrow(/"mcpServers" that isn't an object/);
  });

  test("detection reads comments and trailing commas (VS Code's mcp.json)", () => {
    const vscode = `// user servers\n{\n  "servers": {\n    /* ours */ "caveman-code": { "type": "stdio", "command": "x", },\n  },\n}\n`;
    expect(jsonHasServer(vscode, "servers", "caveman-code")).toBe(true);
    expect(jsonHasServer(vscode, "mcpServers", "caveman-code")).toBe(false);
    expect(jsonHasServer(`{"servers": {"a // b": {}}}`, "servers", "a // b")).toBe(true);
    expect(jsonHasServer("not json", "servers", "caveman-code")).toBe(false);
    expect(jsonHasServer(undefined, "servers", "caveman-code")).toBe(false);
    expect(parseJsonc(`{"a": "/* not a comment */"}`)).toEqual({ a: "/* not a comment */" });
  });
});

describe("on a temp home", () => {
  let root: string;
  let home: string;
  let bin: string;
  let apps: string;
  let log: string;
  let host: Host;

  /**
   * A fake CLI on the fake PATH: records its argv (one line each, then `--end--`), then runs `body`, JavaScript with
   * `fs`, `path` and `argv` (its arguments). It runs under this Node: started by a sh script, or on Windows a `.cmd`.
   */
  const fake = (name: string, body = "", dir = bin) => {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, `.${name}.cjs`);
    fs.writeFileSync(
      script,
      `const fs = require("node:fs");\nconst path = require("node:path");\nconst argv = process.argv.slice(2);\nfs.appendFileSync(process.env.ARGV_LOG, argv.map((a) => a + "\\n").join("") + "--end--\\n");\n${body}\n`,
    );
    const file = path.join(dir, win ? `${name}.cmd` : name);
    fs.writeFileSync(file, win ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return file;
  };
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("--end--\n")
          .filter((c) => c !== "")
          .map((c) => c.split("\n").filter((l) => l !== ""))
      : [];
  const read = (...parts: Array<string>) => fs.readFileSync(path.join(home, ...parts), "utf8");
  /** A file's POSIX mode; Windows has none to keep. */
  const mode = (...parts: Array<string>) => (win ? undefined : fs.statSync(path.join(home, ...parts)).mode & 0o777);
  const here = win ? "this computer" : "this Mac";

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-clients-")));
    home = path.join(root, "home");
    bin = path.join(root, "bin");
    apps = path.join(root, "Applications");
    log = path.join(root, "argv.log");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(apps);
    // A Windows child can't start without a few of the runner's own variables (SystemRoot, ComSpec, PATHEXT); the
    // profile's folders are the temp home's.
    const windows = win
      ? { ...pickEnv(process.env, []), USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") }
      : {};
    const PATH = win ? `${bin};${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")}` : `${bin}:/usr/bin:/bin`;
    host = { home, path: bin, env: { ...windows, PATH, HOME: home, ARGV_LOG: log }, applications: apps, platform: win ? "win32" : "darwin" };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("nothing installed: every client in order, none found", async () => {
    expect(await detect(host)).toEqual(["claude-code", "codex", "grok", "cursor", "vscode", "grok-bot"].map((id) => ({ id, found: false, installed: false })));
  });

  test("found: a CLI on the PATH, a config folder, an app; a grok that doesn't answer --version is someone else's", async () => {
    fake("claude");
    fake("codex");
    fake("code");
    fake("grok", "process.exit(3);");
    fs.mkdirSync(path.join(apps, "Cursor.app"));
    fs.mkdirSync(path.join(apps, "Grok Bot.app"));
    // The apps folder is a Mac's.
    const mac = host.platform === "darwin";
    expect((await detect(host)).map((s) => [s.id, s.found])).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["grok", false],
      ["cursor", mac],
      ["vscode", true],
      ["grok-bot", mac],
    ]);
    // ~/.grok is Grok Build's own folder.
    fs.mkdirSync(path.join(home, ".grok"));
    expect(await status("grok", host)).toEqual({ id: "grok", found: true, installed: false });
    // A grok that answers is found on its own (another binary: the answer is kept per binary).
    fs.rmSync(path.join(home, ".grok"), { recursive: true });
    const other = path.join(root, "bin2");
    fake("grok", "", other);
    expect(await status("grok", { ...host, path: other })).toEqual({ id: "grok", found: true, installed: false });
  });

  test("Codex: its config.toml gets the table, tools approved; the mode is 0600 when new and kept when not", async () => {
    expect(await install("codex", COMMAND, host)).toEqual({ id: "codex", found: true, installed: true });
    expect(read(".codex", "config.toml")).toBe(`${OURS}default_tools_approval_mode = "approve"\n`);
    expect(mode(".codex", "config.toml")).toBe(win ? undefined : 0o600);
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `model = "o3"\n`);
    fs.chmodSync(path.join(home, ".codex", "config.toml"), 0o644);
    await install("codex", COMMAND, host);
    expect(read(".codex", "config.toml")).toBe(`model = "o3"\n\n${OURS}default_tools_approval_mode = "approve"\n`);
    expect(mode(".codex", "config.toml")).toBe(win ? undefined : 0o644);
    // No temp file is left behind.
    expect(fs.readdirSync(path.join(home, ".codex"))).toEqual(["config.toml"]);
  });

  test("Codex at the CODEX_HOME the person set", async () => {
    const codexHome = path.join(root, "elsewhere", "codex");
    const at = { ...host, env: { ...host.env, CODEX_HOME: codexHome } };
    expect(await install("codex", COMMAND, at)).toEqual({ id: "codex", found: true, installed: true });
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.caveman-code]");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  test("Grok Build: ~/.grok/config.toml gets command and args", async () => {
    expect(await install("grok", COMMAND, host)).toEqual({ id: "grok", found: true, installed: true });
    expect(read(".grok", "config.toml")).toBe(OURS);
  });

  test("Cursor: ~/.cursor/mcp.json gets the server; one that isn't JSON is refused and left as it was", async () => {
    expect(await install("cursor", COMMAND, host)).toEqual({ id: "cursor", found: true, installed: true });
    expect(JSON.parse(read(".cursor", "mcp.json"))).toEqual({ mcpServers: { "caveman-code": { command: COMMAND[0], args: ["mcp"] } } });
    const broken = `{ "mcpServers": { "github": {} }, }`;
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), broken);
    await expect(install("cursor", COMMAND, host)).rejects.toThrow(`${path.join("~", ".cursor", "mcp.json")} isn't plain JSON (a comment, or a typo), so Caveman Code didn't change it.`);
    expect(read(".cursor", "mcp.json")).toBe(broken);
  });

  test("a config that is a link, or a folder that leads out of the home, is refused and nothing is written", async () => {
    const outside = path.join(root, "dotfiles");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "config.toml"), "kept = true\n");
    fs.mkdirSync(path.join(home, ".grok"));
    fs.symlinkSync(path.join(outside, "config.toml"), path.join(home, ".grok", "config.toml"));
    await expect(install("grok", COMMAND, host)).rejects.toThrow(`${path.join("~", ".grok", "config.toml")} is a link to another file, so Caveman Code didn't change it.`);
    fs.symlinkSync(outside, path.join(home, ".cursor"));
    await expect(install("cursor", COMMAND, host)).rejects.toThrow(`${path.join("~", ".cursor")} leads outside your home folder`);
    expect(fs.readdirSync(outside)).toEqual(["config.toml"]);
    expect(fs.readFileSync(path.join(outside, "config.toml"), "utf8")).toBe("kept = true\n");
  });

  // A Mac's alone, and its fake `open` a POSIX script.
  test.skipIf(win)("Grok Bot: its servers are in its account, so one click opens it where a custom MCP is added; nothing is written", async () => {
    const opener = fake("open");
    await expect(install("grok-bot", COMMAND, { ...host, opener })).rejects.toThrow("Grok Bot isn't on this Mac.");
    // Its own folder (~/.grokbot) or the app says it's here.
    fs.mkdirSync(path.join(home, ".grokbot"));
    expect(await install("grok-bot", COMMAND, { ...host, opener })).toEqual({ id: "grok-bot", found: true, installed: false });
    expect(calls()).toEqual([[GROK_BOT_LINK]]);
    expect(fs.readdirSync(path.join(home, ".grokbot"))).toEqual([]);
 // Elsewhere than a Mac there is no bot to open.
    await expect(install("grok-bot", COMMAND, { ...host, opener, platform: "linux" })).rejects.toThrow("Grok Bot isn't on");
  });

  /** Claude Code's `claude mcp add` writing ~/.claude.json, as the real one does. */
  const CLAUDE_ADDS = `if (argv[1] === "add") fs.writeFileSync(path.join(process.env.HOME, ".claude.json"), '{"mcpServers":{"caveman-code":{"type":"stdio"}}}');`;

  test("Claude Code: claude mcp remove, then add at user scope, with the command as its own arguments", async () => {
    // On Windows npm's `claude.cmd`, which only cmd.exe can start.
    fake("claude", CLAUDE_ADDS);
    expect(await install("claude-code", COMMAND, host)).toEqual({ id: "claude-code", found: true, installed: true });
    expect(calls()).toEqual([
      ["mcp", "remove", "--scope", "user", "caveman-code"],
      ["mcp", "add", "--scope", "user", "caveman-code", "--", "/Users/Jane Doe/.caveman-code/bin/caveman-code", "mcp"],
    ]);
  });

  test("Claude Code's failure says what its CLI said; without it, that it isn't on the PATH", async () => {
    await expect(install("claude-code", COMMAND, host)).rejects.toThrow(`Claude Code isn't on ${here}'s PATH.`);
    fake("claude", `if (argv[1] === "add") { process.stderr.write("\\u001b[31mError: config is locked\\u001b[0m\\nmore\\n"); process.exit(1); }`);
    await expect(install("claude-code", COMMAND, host)).rejects.toThrow("claude mcp add failed: Error: config is locked");
  });

  // A script can't pass for an .exe on Windows: there the PATH's claude.cmd above is the real proof.
  test.skipIf(win)("Claude Code's native install on Windows: ~\\.local\\bin\\claude.exe, found off the PATH and started directly", async () => {
    const windows: Host = { ...host, platform: "win32" };
    const local = path.join(home, ".local", "bin");
    // An extensionless `claude` is a sh script Windows can't start.
    fake("claude", CLAUDE_ADDS, local);
    expect(await status("claude-code", windows)).toEqual({ id: "claude-code", found: false, installed: false });
    await expect(install("claude-code", COMMAND, windows)).rejects.toThrow("Claude Code isn't on this computer's PATH.");
    fake("claude.exe", CLAUDE_ADDS, local);
    expect(await install("claude-code", COMMAND, windows)).toEqual({ id: "claude-code", found: true, installed: true });
    expect(calls().map((c) => c.slice(0, 2))).toEqual([
      ["mcp", "remove"],
      ["mcp", "add"],
    ]);
  });

  test("a Windows CLI starts as Windows can: an .exe directly, a .cmd through cmd.exe as one line, every argument escaped", async () => {
    const windows: Host = { ...host, platform: "win32" };
    const args = ["mcp", "add", "--", "C:\\Users\\Jane Doe\\.caveman-code\\bin\\caveman-code.exe", 'a "b" & c'];
    const exe = "C:\\Users\\Jane Doe\\.local\\bin\\claude.exe";
    expect(await spawnCommand(exe, args, windows)).toEqual({ command: exe, args, shell: false });
    expect(await spawnCommand("C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd", args, windows)).toEqual({
      command: [
        '^"C:\\Users\\Jane^ Doe\\AppData\\Roaming\\npm\\claude.cmd^"',
        '^"mcp^"',
        '^"add^"',
        '^"--^"',
        '^"C:\\Users\\Jane^ Doe\\.caveman-code\\bin\\caveman-code.exe^"',
        '^"a^ \\^"b\\^"^ ^&^ c^"',
      ].join(" "),
      args: [],
      shell: true,
    });
    // Elsewhere the argv as it is.
    expect(await spawnCommand("/usr/local/bin/claude", args, { ...host, platform: "darwin" })).toEqual({ command: "/usr/local/bin/claude", args, shell: false });
  });

  // npm's shim for a package whose bin is an .exe (Claude Code's): the .exe is started, no cmd.exe between.
  test.runIf(win)("Claude Code's npm claude.cmd that only starts its claude.exe: the claude.exe directly", async () => {
    const shim = path.join(bin, "claude.cmd");
    const exe = path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    const lines = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0"];
    fs.writeFileSync(shim, [...lines, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', ""].join("\r\n"));
    expect(await spawnCommand(shim, ["mcp", "list"], host)).toEqual({ command: exe, args: ["mcp", "list"], shell: false });
  });

  // Windows' is below.
  test.skipIf(win)("VS Code: code --add-mcp with the server as one JSON argument; the app's own code when none is on the PATH", async () => {
    await expect(install("vscode", COMMAND, host)).rejects.toThrow("VS Code isn't on this Mac.");
    const bundled = path.join(apps, "Visual Studio Code.app", "Contents", "Resources", "app", "bin");
    fake("code", "", bundled);
    expect(await status("vscode", host)).toEqual({ id: "vscode", found: true, installed: false });
    await install("vscode", COMMAND, host);
    expect(calls()).toEqual([["--add-mcp", '{"name":"caveman-code","type":"stdio","command":"/Users/Jane Doe/.caveman-code/bin/caveman-code","args":["mcp"]}']]);
    // Installed: VS Code's user mcp.json holds it.
    const user = path.join(home, "Library", "Application Support", "Code", "User");
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, "mcp.json"), `{\n  // mine\n  "servers": { "caveman-code": { "type": "stdio" }, },\n}\n`);
    expect(await status("vscode", host)).toEqual({ id: "vscode", found: true, installed: true });
  });

  test("VS Code on Windows: %APPDATA%\\Code\\User\\mcp.json gets the server as code --add-mcp writes it; code.cmd isn't run", async () => {
    const roaming = path.join(home, "AppData", "Roaming");
    const windows: Host = { ...host, platform: "win32", env: { ...host.env, APPDATA: roaming } };
    await expect(install("vscode", COMMAND, windows)).rejects.toThrow("VS Code isn't on this computer.");
    // Its folder says it's here, `code` on the PATH or not (here a Windows runner's PATH has it).
    fake("code");
    fs.mkdirSync(path.join(roaming, "Code"), { recursive: true });
    const server = { type: "stdio", command: COMMAND[0], args: ["mcp"] };
    expect(await install("vscode", COMMAND, windows)).toEqual({ id: "vscode", found: true, installed: true });
    expect(JSON.parse(read("AppData", "Roaming", "Code", "User", "mcp.json"))).toEqual({ servers: { "caveman-code": server } });
    // Every other server and key kept; a file with a comment refused, as it is everywhere Caveman Code writes.
    const mcp = path.join(roaming, "Code", "User", "mcp.json");
    fs.writeFileSync(mcp, `{\r\n  "servers": {\r\n    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }\r\n  },\r\n  "inputs": []\r\n}\r\n`);
    await install("vscode", COMMAND, windows);
    expect(JSON.parse(fs.readFileSync(mcp, "utf8"))).toEqual({ servers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/" }, "caveman-code": server }, inputs: [] });
    expect(fs.readFileSync(mcp, "utf8")).toContain("\r\n");
    fs.writeFileSync(mcp, `{\n  // mine\n  "servers": {}\n}\n`);
    await expect(install("vscode", COMMAND, windows)).rejects.toThrow(`${path.join("~", "AppData", "Roaming", "Code", "User", "mcp.json")} isn't plain JSON`);
    expect(calls()).toEqual([]);
  });

  test("only the person on this computer's own screen installs: Cloud and outside agents are refused, nothing written", async () => {
    const reason = (principal: string) =>
      Effect.runPromise(installFor(principal, "cursor", COMMAND, host).pipe(Effect.flip)).then((e) => ({ reason: e.reason, message: e.message }));
    for (const principal of ["cloud:owner", "agent:3f1c", "cloud:someone-else"]) {
      expect(await reason(principal)).toEqual({ reason: "forbidden", message: "MCP clients are set up only on this computer's own screen." });
    }
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
    // The person: done, or the reason as the page shows it.
    expect(await Effect.runPromise(installFor("local", "cursor", COMMAND, host))).toEqual({ id: "cursor", found: true, installed: true });
    expect(await Effect.runPromise(installFor("local", "claude-code", COMMAND, host).pipe(Effect.flip)).then((e) => [e.reason, e.message])).toEqual([
      "unavailable",
      `Claude Code isn't on ${here}'s PATH.`,
    ]);
  });
});
