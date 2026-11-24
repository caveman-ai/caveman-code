// Vercel's agent-desktop (Apache-2.0, github.com/vercel-labs/agent-desktop), which runs computer use on a Mac
// (src/session-protocol/macDesktop): the native CLI and its macOS helper for one arch, from the npm release pinned
// here by its tarball's sha256, each binary checked again against the .sha256 the release ships beside it, and the
// license pinned by its own. Checked at build time, on every build; nothing is downloaded at run time. The desktop
// app (apps/desktop/scripts/package.mjs) carries them in `bin/` beside the runtime bundle, where macDesktop/cli.ts
// looks for them: `agent-desktop`, `agent-desktop-macos-helper`, and `licenses/agent-desktop/`.
//
// Bump: the version, `shasum -a 256` of its npm tarball, and the license's when it changes.
//
//   node packages/runtime/scripts/agentDesktopBinary.ts <dir> [--arch arm64|x64]
// installs them into <dir>/bin, e.g. for AGENT_DESKTOP_BIN in development.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DESKTOP = {
  version: "1.2.0",
  tarball: "9e4b1a69d9d6be487873a1df8db61234a8b7a9c79aeced4e403a8126c0e0bcc0",
  license: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
} as const;

const TARBALL = `https://registry.npmjs.org/agent-desktop/-/agent-desktop-${AGENT_DESKTOP.version}.tgz`;
// The npm package carries no license file; the repository's at the release tag is the same Apache-2.0 text.
const LICENSE = `https://raw.githubusercontent.com/vercel-labs/agent-desktop/v${AGENT_DESKTOP.version}/LICENSE`;

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** `url` kept in `cacheDir` as `name`, checked against `want`; the download goes to a .partial file first. */
async function fetchPinned(url: string, name: string, want: string, cacheDir: string): Promise<string> {
  const file = path.join(cacheDir, `agent-desktop-${AGENT_DESKTOP.version}`, name);
  if (!fs.existsSync(file)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.partial`, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(`${file}.partial`, file);
  }
  const have = sha256(file);
  if (have !== want) throw new Error(`${file}: sha256 ${have}, pinned ${want} for agent-desktop ${AGENT_DESKTOP.version}; delete it to download again`);
  return file;
}

/**
 * Writes agent-desktop and its macOS helper for `arch` to `<dest>/bin` (mode 755) and the license to
 * `<dest>/bin/licenses/agent-desktop/`. Returns what it wrote.
 */
export async function installAgentDesktop(input: { readonly arch: "arm64" | "x64"; readonly dest: string; readonly cacheDir: string }): Promise<ReadonlyArray<string>> {
  const tarball = await fetchPinned(TARBALL, "agent-desktop.tgz", AGENT_DESKTOP.tarball, input.cacheDir);
  const license = await fetchPinned(LICENSE, "LICENSE", AGENT_DESKTOP.license, input.cacheDir);
  // The archive goes into a new empty directory of its own, and only the two named files are taken from it.
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desktop-"));
  try {
    const files = [`agent-desktop-darwin-${input.arch}`, `agent-desktop-macos-helper-darwin-${input.arch}`];
    execFileSync("tar", ["-xzf", tarball, "-C", unpacked, ...files.flatMap((file) => [`package/bin/${file}`, `package/bin/${file}.sha256`])]);
    const bin = path.join(input.dest, "bin");
    const licenses = path.join(bin, "licenses", "agent-desktop");
    fs.mkdirSync(licenses, { recursive: true });
    const written: Array<string> = [];
    for (const [file, target] of [
      [files[0]!, "agent-desktop"],
      [files[1]!, "agent-desktop-macos-helper"],
    ] as const) {
      const source = path.join(unpacked, "package", "bin", file);
      const want = fs.readFileSync(`${source}.sha256`, "utf8").trim().split(/\s+/)[0];
      const have = sha256(source);
      if (have !== want) throw new Error(`${file} in agent-desktop ${AGENT_DESKTOP.version}: sha256 ${have}, its .sha256 says ${want}`);
      fs.copyFileSync(source, path.join(bin, target));
      fs.chmodSync(path.join(bin, target), 0o755);
      written.push(path.join(bin, target));
    }
    fs.copyFileSync(license, path.join(licenses, "LICENSE"));
    fs.writeFileSync(path.join(licenses, "RELEASE"), `agent-desktop ${AGENT_DESKTOP.version} (npm, sha256 ${AGENT_DESKTOP.tarball})\n`);
    return written;
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--arch");
  const arch = (at < 0 ? process.arch : args.splice(at, 2)[1]) as "arm64" | "x64";
  if (arch !== "arm64" && arch !== "x64") throw new Error(`no agent-desktop for ${arch}`);
  const dest = path.resolve(args[0] ?? ".");
  const cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.cache/agent-desktop");
  const written = await installAgentDesktop({ arch, dest, cacheDir });
  console.log(`installed agent-desktop ${AGENT_DESKTOP.version} (darwin-${arch}): ${written.join(", ")}`);
}
