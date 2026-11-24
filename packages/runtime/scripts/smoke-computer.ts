// `pnpm --filter @caveman-app/runtime smoke:computer [out.tgz] --image <computer image> [--name <prefix>]` runs a packed
// runtime (pack:computer's caveman-runtime.tgz) inside a real Caveman Cloud computer image, as Cloud's release start
// check does (Caveman Cloud scripts/deployment-images.mjs smoke computer): a thin image FROM the given one with the tgz
// unpacked over /opt/caveman/runtime, the way cloud/runner/code/Dockerfile unpacks it, started once with the image's
// `check` role. That role runs the runtime's self-check (the bundle and every native on the image's node and Wolfi's
// libc), then starts the runtime beside its exec channel until it answers. Exit 0 only when it prints "check passed".
//   --image   the computer image (CAVEMAN_COMPUTER_IMAGE); it must have the check role (Cloud after audit R1)
//   --name    prefix for what it starts: the container <prefix>-check, the image <prefix>-thin:<pid>
// The thin image is removed afterwards. A release owner's or a lab's command: app CI has no access to Cloud's image.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The computer image's tools user and computer group (cloud/runner/code/Dockerfile), the user its roles run as. */
const IMAGE_USER = "10002:10000";
const PASSED = /caveman-computer: check passed/;
const CHECK_SECONDS = 180;

export interface SmokeOptions {
  readonly tgz: string;
  readonly image: string;
  readonly name: string;
}

export function parseSmokeArgs(argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>> = process.env): SmokeOptions {
  const args = [...argv];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`smoke:computer: ${name} needs a value`);
    return args.splice(at, 2)[1];
  };
  const image = flag("--image") ?? env.CAVEMAN_COMPUTER_IMAGE;
  const name = flag("--name") ?? `caveman-runtime-smoke-${process.pid}`;
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown !== undefined) throw new Error(`smoke:computer: unknown option ${unknown}`);
  if (args.length > 1) throw new Error(`smoke:computer: one tgz at most, got ${args.join(" ")}`);
  if (!image) throw new Error("smoke:computer: name the Caveman Cloud computer image with --image <ref> or CAVEMAN_COMPUTER_IMAGE");
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`smoke:computer: --name ${name} is not a lowercase container name`);
  return { tgz: path.resolve(args[0] ?? path.join(runtimeDir, "dist-computer/caveman-runtime.tgz")), image, name };
}

/** The thin image: the tgz unpacked over the image's runtime with cloud/runner/code/Dockerfile's tar flags, as root, then back to its user. */
export const thinDockerfile = (image: string): string => `FROM ${image}
USER 0
RUN --mount=type=bind,source=caveman-runtime.tgz,target=/mnt/runtime/caveman-runtime.tgz \\
    rm -rf /opt/caveman/runtime && mkdir -p /opt/caveman/runtime \\
    && tar -xzf /mnt/runtime/caveman-runtime.tgz -C /opt/caveman/runtime --no-same-owner \\
    && test -x /opt/caveman/runtime/bin/caveman-runtime
USER ${IMAGE_USER}
`;

/** linux/arm64 or linux/amd64, from the platform the tgz's manifest says its natives were built for. */
export function dockerPlatform(tgz: string): string {
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "lib/manifest.json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { platform: string };
  const [osName, arch] = manifest.platform.split("-");
  if (osName !== "linux" || (arch !== "arm64" && arch !== "x64")) {
    throw new Error(`smoke:computer: ${tgz} was packed for ${manifest.platform}; a computer runs linux-arm64 or linux-x64 (pack it with pack:computer)`);
  }
  return `linux/${arch === "x64" ? "amd64" : arch}`;
}

/** Builds the thin image, runs its check role once, removes the image; returns the check's output, throws unless it passed. */
export function smokeComputer({ tgz, image, name }: SmokeOptions): string {
  if (!fs.existsSync(tgz)) throw new Error(`smoke:computer: no ${tgz} (pack:computer writes it)`);
  const platform = dockerPlatform(tgz);
  const thin = `${name}-thin:${process.pid}`;
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-runtime-smoke-"));
  try {
    fs.copyFileSync(tgz, path.join(context, "caveman-runtime.tgz"));
    execFileSync("docker", ["build", "--quiet", "--platform", platform, "--tag", thin, "--file", "-", context], {
      input: thinDockerfile(image),
      stdio: ["pipe", "ignore", "inherit"],
    });
    const run = spawnSync("docker", ["run", "--rm", "--name", `${name}-check`, "--platform", platform, thin, "check"], {
      encoding: "utf8",
      timeout: CHECK_SECONDS * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (run.error !== undefined) {
      spawnSync("docker", ["rm", "--force", `${name}-check`], { stdio: "ignore" });
      throw new Error(`smoke:computer: the check did not finish within ${CHECK_SECONDS} s (${run.error.message}):\n${output}`);
    }
    if (/usage: caveman-computer/.test(output)) {
      throw new Error(`smoke:computer: ${image} predates the check role (Caveman Cloud caveman-computer check); use a computer image built since:\n${output}`);
    }
    if (run.status !== 0 || !PASSED.test(output)) throw new Error(`smoke:computer: the check exited ${run.status ?? run.signal}:\n${output}`);
    return output;
  } finally {
    spawnSync("docker", ["image", "rm", "--force", thin], { stdio: "ignore" });
    fs.rmSync(context, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const started = Date.now();
  try {
    const options = parseSmokeArgs(process.argv.slice(2));
    const output = smokeComputer(options);
    process.stdout.write(output);
    console.log(`smoke:computer: ${path.basename(options.tgz)} passed the check in ${options.image} in ${Date.now() - started} ms`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
