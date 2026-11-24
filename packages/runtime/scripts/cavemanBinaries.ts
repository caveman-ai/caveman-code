// The caveman v4 binaries the app runs as its own: caveman-proxy and caveman-mcp, its proxies and their way back
// (src/router/proxyLauncher.ts), and caveman-engine, the Caveman engine's levers (provider-caveman engineConfig.ts),
// from one `bin-v*` release of the open-source caveman repository (Apache-2.0), pinned by its tag
// and the sha256 of the release's checksums.txt, which in turn pins every asset. Checked at build time, on
// every build; nothing is downloaded at run time. The desktop app (apps/desktop/scripts/package.mjs), the npm
// platform packages (pack-npm.ts) and a Cloud computer's runtime (pack-computer.ts) carry them in `bin/` beside
// the runtime bundle: `caveman-proxy.exe` and so on on win32, where proxyLauncher.ts and levers.ts look for them.
//
// Bump: the release tag and `shasum -a 256` of its checksums.txt.
//
//   node packages/runtime/scripts/cavemanBinaries.ts <dir> [--platform darwin|linux|win32] [--arch arm64|x64]
// installs them into <dir>/bin, e.g. for CAVEMAN_PROXY_BIN, CAVEMAN_MCP_BIN and CAVEMAN_ENGINE_BIN in development.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CAVEMAN_BINARIES = { tag: "bin-v4.1.0", checksums: "8e725571d31b074228b015280de76d3e43b4b13c6499f9b19e7c8c329e35b43a" } as const;

const RELEASES = "https://github.com/JuliusBrussee/caveman/releases/download";
/** The same release through GitHub's API, whose asset downloads sign a fresh storage URL (releaseAssetUrl). */
const RELEASE_API = "https://api.github.com/repos/JuliusBrussee/caveman/releases";
const BINARIES = ["caveman-proxy", "caveman-mcp", "caveman-engine"] as const;
/**
 * What the binaries' license asks to travel with them: Apache-2.0 and the NOTICE (with the MIT text it keeps,
 * and the font and pixel notices it names), and the license texts of the Go modules they link. Linux builds
 * are linked with Zig against musl, Windows builds with Zig against the mingw-w64 runtime (LICENSING.md).
 */
const LICENSES = ["LICENSE", "LICENSE-MIT", "NOTICE", "NOTICE.engine-pixel", "SPLEEN_LICENSE.txt", "UNIFONT_LICENSE.txt", "LICENSING.md", "THIRD_PARTY_GO_LICENSES.tar.gz"];

export type CavemanPlatform = "darwin" | "linux" | "win32";

const PLATFORM_LICENSES: Record<CavemanPlatform, ReadonlyArray<string>> = {
  darwin: [],
  linux: ["COPYRIGHT.musl", "LICENSE.zig"],
  win32: ["COPYING.mingw-w64", "LICENSE.zig"],
};

/** The file name a binary has on `platform`. */
export const binaryFile = (name: string, platform: CavemanPlatform): string => (platform === "win32" ? `${name}.exe` : name);

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A token when one is set (CI's GITHUB_TOKEN): the API's unauthenticated limit is per address. */
const githubAuth = (): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
};

let releaseAssets: Promise<ReadonlyArray<{ readonly name: string; readonly url: string }>> | undefined;
/** `name`'s download through GitHub's API, or undefined when the pinned release has no such asset. */
async function releaseAssetUrl(name: string): Promise<string | undefined> {
  releaseAssets ??= fetchRetrying(`${RELEASE_API}/tags/${CAVEMAN_BINARIES.tag}`, { accept: "application/vnd.github+json", ...githubAuth() }).then(async (response) => {
    if (!response.ok) throw new Error(`release ${CAVEMAN_BINARIES.tag}: HTTP ${response.status}`);
    return ((await response.json()) as { assets: Array<{ name: string; url: string }> }).assets;
  });
  return (await releaseAssets.catch((error: unknown) => {
    releaseAssets = undefined;
    throw error;
  })).find((asset) => asset.name === name)?.url;
}

/**
 * GitHub's release CDN answers a 5xx or 429 now and then (a 504 failed a packaging run): those, and a dropped
 * connection, are asked again with backoff, up to four tries. Anything else is the answer. The pin checks the bytes.
 */
async function fetchRetrying(url: string, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === 4;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
      if (last || (response.status < 500 && response.status !== 429)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (last) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** (attempt - 1)));
  }
}

/** `name` from the pinned release, kept in `cacheDir`; the download goes to a .partial file first. */
async function fetchAsset(name: string, cacheDir: string): Promise<string> {
  const file = path.join(cacheDir, CAVEMAN_BINARIES.tag, name);
  if (fs.existsSync(file)) return file;
  const url = `${RELEASES}/${CAVEMAN_BINARIES.tag}/${name}`;
  let response = await fetchRetrying(url);
  // An edge can keep answering one asset with a cached 504 for a while (seen for caveman-proxy_linux_amd64 while
  // every other asset downloaded): the API's asset download goes around it. The checksums still check the bytes.
  if (response.status >= 500) {
    const viaApi = await releaseAssetUrl(name).catch(() => undefined);
    if (viaApi !== undefined) response = await fetchRetrying(viaApi, { accept: "application/octet-stream", ...githubAuth() });
  }
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(`${file}.partial`, file);
  return file;
}

/**
 * Writes caveman-proxy, caveman-mcp and caveman-engine for `platform`/`arch` to `<dest>/bin` (mode 755; `.exe` on
 * win32) and their license files to `<dest>/bin/licenses`, each checked against the pin. Returns what it wrote.
 */
export async function installCavemanBinaries(input: {
  readonly platform: CavemanPlatform;
  readonly arch: "arm64" | "x64" | "amd64";
  readonly dest: string;
  readonly cacheDir: string;
}): Promise<ReadonlyArray<string>> {
  const checksums = await fetchAsset("checksums.txt", input.cacheDir);
  const got = sha256(checksums);
  if (got !== CAVEMAN_BINARIES.checksums) {
    throw new Error(`${checksums}: sha256 ${got}, pinned ${CAVEMAN_BINARIES.checksums} for ${CAVEMAN_BINARIES.tag}; delete it to download again`);
  }
  const expected = new Map(
    fs.readFileSync(checksums, "utf8").split("\n").flatMap((line) => {
      const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
      return match ? [[match[2]!, match[1]!] as const] : [];
    }),
  );
  const arch = input.arch === "x64" ? "amd64" : input.arch;
  const bin = path.join(input.dest, "bin");
  fs.mkdirSync(path.join(bin, "licenses"), { recursive: true });
  const written: Array<string> = [];
  const place = async (asset: string, target: string, mode: number) => {
    const file = await fetchAsset(asset, input.cacheDir);
    const want = expected.get(asset);
    const have = sha256(file);
    if (want === undefined || have !== want) throw new Error(`${file}: sha256 ${have}, ${CAVEMAN_BINARIES.tag}'s checksums.txt says ${want ?? "nothing"}; delete it to download again`);
    fs.copyFileSync(file, target);
    fs.chmodSync(target, mode);
    written.push(target);
  };
  for (const name of BINARIES) await place(`${name}_${input.platform}_${arch}`, path.join(bin, binaryFile(name, input.platform)), 0o755);
  for (const name of [...LICENSES, ...PLATFORM_LICENSES[input.platform]]) await place(name, path.join(bin, "licenses", name), 0o644);
  fs.writeFileSync(path.join(bin, "licenses", "RELEASE"), `${CAVEMAN_BINARIES.tag}\n`);
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const platform = (flag("--platform") ?? process.platform) as CavemanPlatform;
  if (!(platform in PLATFORM_LICENSES)) throw new Error(`no caveman binaries for ${platform}`);
  const arch = (flag("--arch") ?? process.arch) as "arm64" | "x64";
  const dest = path.resolve(args[0] ?? ".");
  const cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.cache/caveman-binaries");
  const written = await installCavemanBinaries({ platform, arch, dest, cacheDir });
  console.log(`installed ${CAVEMAN_BINARIES.tag} (${platform}-${arch}): ${written.filter((file) => path.basename(path.dirname(file)) !== "licenses").join(", ")}`);
}
