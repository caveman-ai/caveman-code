// Vercel's agent-desktop (Apache-2.0, github.com/vercel-labs/agent-desktop), the CLI that sees and uses macOS apps
// through their accessibility trees, in the background: no pointer movement, no focus change. The desktop app carries
// a pinned copy and its macOS helper in `bin/` beside the runtime (scripts/agentDesktopBinary.ts); AGENT_DESKTOP_BIN
// names another (development), else one on PATH. Each call is one process that prints one JSON envelope. It runs with
// its own state root under the runtime's state directory and none of the runtime's environment (keys, tokens), and
// macOS grants it what it grants the app that started the runtime: Caveman Code.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the desktop app carries the pinned binary: `bin/` beside the runtime bundle. */
const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin");
export const HELPER_NAME = "agent-desktop-macos-helper";

export interface AgentDesktopBinary {
  readonly bin: string;
  /** The macOS helper (clipboard, permission prompts, the cursor overlay), beside the binary. */
  readonly helper?: string;
}

const executable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The agent-desktop this runtime runs: AGENT_DESKTOP_BIN, else the bundled one, else one on PATH. */
export const findAgentDesktop = (env: NodeJS.ProcessEnv = process.env, bundledDir: string = BUNDLED_DIR): AgentDesktopBinary | undefined => {
  const override = env.AGENT_DESKTOP_BIN?.trim();
  const candidates = override
    ? [override]
    : [path.join(bundledDir, "agent-desktop"), ...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "agent-desktop"))];
  const bin = candidates.find((file) => path.isAbsolute(file) && executable(file));
  if (bin === undefined) return undefined;
  const helper = [path.join(path.dirname(bin), HELPER_NAME), path.join(path.dirname(fs.realpathSync(bin)), HELPER_NAME)].find(executable);
  return { bin, ...(helper ? { helper } : {}) };
};

/** One error as agent-desktop reports it. Branch on `code` and `disposition.retry`, never the message. */
export interface AgentDesktopError {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly details?: Record<string, unknown>;
  readonly disposition?: { readonly delivery?: string; readonly retry?: string };
}

export interface Envelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: AgentDesktopError;
}

/** What a run that printed no envelope reports instead. */
const broken = (command: string, message: string): Envelope => ({ ok: false, command, error: { code: "INTERNAL", message, disposition: { delivery: "unknown", retry: "unknown" } } });

const MAX_OUTPUT = 16 * 1024 * 1024;

export interface Runner {
  /** Runs agent-desktop with `args` and reads its envelope; never rejects. */
  readonly run: (args: ReadonlyArray<string>, options?: { readonly timeoutMs?: number }) => Promise<Envelope>;
  readonly binary: AgentDesktopBinary;
  readonly home: string;
}

/** agent-desktop with its state root at `home` (made 0700: it refuses one others can read). */
export const makeRunner = (binary: AgentDesktopBinary, home: string): Runner => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  // Only what it needs: never the runtime's keys and tokens.
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    USER: process.env.USER,
    AGENT_DESKTOP_HOME: home,
    ...(binary.helper ? { AGENT_DESKTOP_MACOS_HELPER_PATH: binary.helper } : {}),
  };
  const run = (args: ReadonlyArray<string>, options: { readonly timeoutMs?: number } = {}) =>
    new Promise<Envelope>((resolve) => {
      const command = args.find((arg) => !arg.startsWith("-")) ?? "agent-desktop";
      const child = spawn(binary.bin, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
      const out: Array<Buffer> = [];
      let size = 0;
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 60_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT) out.push(chunk);
        else child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2_000)));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(broken(command, `agent-desktop did not start: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const text = Buffer.concat(out).toString("utf8").trim();
        const line = text.slice(text.lastIndexOf("\n") + 1);
        try {
          const parsed = JSON.parse(line) as Envelope;
          if (typeof parsed.ok === "boolean") return resolve(parsed);
        } catch {
          // Below: a run that printed no envelope.
        }
        if (size > MAX_OUTPUT) return resolve(broken(command, "agent-desktop printed more than 16 MB; narrow the call (a --root drill, a smaller --max-depth)"));
        if (signal) return resolve(broken(command, `agent-desktop did not answer in time (${signal})`));
        resolve(broken(command, `agent-desktop exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
      });
    });
  return { run, binary, home };
};

const quiet = (file: string, args: ReadonlyArray<string>, timeoutMs = 10_000) =>
  new Promise<boolean>((resolve) => execFile(file, [...args], { timeout: timeoutMs }, (error) => resolve(error === null)));

/**
 * A PNG as JPEG at most `maxWidth` pixels wide (sips, macOS's own), for frames: a Retina window's PNG is megabytes.
 * Answers the JPEG and its size, or undefined when sips failed.
 */
export const toJpeg = async (png: string, maxWidth: number): Promise<{ readonly data: Buffer; readonly width: number; readonly height: number } | undefined> => {
  const jpeg = `${png.slice(0, -4)}.jpg`;
  try {
    const size = pngSize(await fs.promises.readFile(png));
    const resample = size !== undefined && size.width > maxWidth ? ["--resampleWidth", String(maxWidth)] : [];
    if (!(await quiet("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "72", ...resample, png, "--out", jpeg]))) return undefined;
    const data = await fs.promises.readFile(jpeg);
    const dims = jpegSize(data);
    return dims === undefined ? undefined : { data, ...dims };
  } finally {
    await fs.promises.rm(jpeg, { force: true });
  }
};

/** A PNG no larger than `maxEdge` on its long side (for an agent's screenshot: fewer image tokens). */
export const shrinkPng = async (png: string, maxEdge: number): Promise<{ readonly data: Buffer; readonly width: number; readonly height: number } | undefined> => {
  const before = pngSize(await fs.promises.readFile(png));
  if (before !== undefined && Math.max(before.width, before.height) > maxEdge) await quiet("/usr/bin/sips", ["-Z", String(maxEdge), png]);
  const data = await fs.promises.readFile(png);
  const size = pngSize(data);
  return size === undefined ? undefined : { data, ...size };
};

/** Width and height from a PNG's IHDR. */
export const pngSize = (data: Buffer): { width: number; height: number } | undefined =>
  data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : undefined;

/** Width and height from a JPEG's start-of-frame marker. */
export const jpegSize = (data: Buffer): { width: number; height: number } | undefined => {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1]!;
    const length = data.readUInt16BE(at + 2);
    // SOF0..SOF15, less DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  return undefined;
};
