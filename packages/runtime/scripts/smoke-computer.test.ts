// smoke:computer runs a packed runtime in a real Caveman Cloud computer image's check role (audit R1). The arguments and
// the thin image's Dockerfile are checked here; the run itself needs Docker, the computer image (CAVEMAN_COMPUTER_SMOKE_IMAGE)
// and a Linux pack (CAVEMAN_COMPUTER_SMOKE_TGZ, default dist-computer/caveman-runtime.tgz), so it skips without them.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it } from "vitest";

import { dockerPlatform, parseSmokeArgs, smokeComputer, thinDockerfile } from "./smoke-computer.ts";

const runtimeDir = path.resolve(import.meta.dirname, "..");

it("takes one tgz, the computer image from --image or CAVEMAN_COMPUTER_IMAGE, and a name prefix", () => {
  expect(parseSmokeArgs(["out/runtime.tgz", "--image", "computer:good", "--name", "lab-smoke"], {})).toEqual({
    tgz: path.resolve("out/runtime.tgz"),
    image: "computer:good",
    name: "lab-smoke",
  });
  const fromEnv = parseSmokeArgs([], { CAVEMAN_COMPUTER_IMAGE: "ghcr.io/x/computer@sha256:abc" });
  expect(fromEnv.image).toBe("ghcr.io/x/computer@sha256:abc");
  expect(fromEnv.tgz).toBe(path.join(runtimeDir, "dist-computer/caveman-runtime.tgz"));
  expect(fromEnv.name).toBe(`caveman-runtime-smoke-${process.pid}`);
  expect(() => parseSmokeArgs(["a.tgz"], {})).toThrow(/--image <ref> or CAVEMAN_COMPUTER_IMAGE/);
  expect(() => parseSmokeArgs(["--image"], {})).toThrow(/--image needs a value/);
  expect(() => parseSmokeArgs(["--image", "--name", "x"], {})).toThrow(/--image needs a value/);
  expect(() => parseSmokeArgs(["a.tgz", "b.tgz", "--image", "i"], {})).toThrow(/one tgz at most/);
  expect(() => parseSmokeArgs(["--image", "i", "--arch", "arm64"], {})).toThrow(/unknown option --arch/);
  expect(() => parseSmokeArgs(["--image", "i", "--name", "Has Space"], {})).toThrow(/not a lowercase container name/);
});

it("unpacks the tgz over the image's runtime as cloud/runner/code/Dockerfile does, then returns to the image's user", () => {
  expect(thinDockerfile("ar-release-computer:good")).toBe(`FROM ar-release-computer:good
USER 0
RUN --mount=type=bind,source=caveman-runtime.tgz,target=/mnt/runtime/caveman-runtime.tgz \\
    rm -rf /opt/caveman/runtime && mkdir -p /opt/caveman/runtime \\
    && tar -xzf /mnt/runtime/caveman-runtime.tgz -C /opt/caveman/runtime --no-same-owner \\
    && test -x /opt/caveman/runtime/bin/caveman-runtime
USER 10002:10000
`);
});

it("picks the image platform from the pack's manifest and refuses a pack that is not Linux", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-smoke-args-"));
  try {
    const pack = (platform: string) => {
      fs.rmSync(path.join(dir, "lib"), { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "lib"));
      fs.writeFileSync(path.join(dir, "lib/manifest.json"), JSON.stringify({ schema: 1, platform }));
      const tgz = path.join(dir, `${platform}.tgz`);
      expect(spawnSync("tar", ["-czf", tgz, "-C", dir, "lib"]).status).toBe(0);
      return tgz;
    };
    expect(dockerPlatform(pack("linux-arm64"))).toBe("linux/arm64");
    expect(dockerPlatform(pack("linux-x64"))).toBe("linux/amd64");
    expect(() => dockerPlatform(pack("darwin-arm64"))).toThrow(/packed for darwin-arm64; a computer runs linux-arm64 or linux-x64/);
    expect(() => smokeComputer({ tgz: path.join(dir, "missing.tgz"), image: "i", name: "n" })).toThrow(/no .*missing\.tgz \(pack:computer writes it\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const image = process.env.CAVEMAN_COMPUTER_SMOKE_IMAGE;
const tgz = process.env.CAVEMAN_COMPUTER_SMOKE_TGZ ?? path.join(runtimeDir, "dist-computer/caveman-runtime.tgz");
const docker = image === undefined ? "set CAVEMAN_COMPUTER_SMOKE_IMAGE to a Caveman Cloud computer image with the check role" : !fs.existsSync(tgz) ? `no Linux pack at ${tgz} (pack:computer, or CAVEMAN_COMPUTER_SMOKE_TGZ)` : false;
it.skipIf(docker !== false)(`passes the packed runtime in the computer image's check role${docker === false ? "" : ` (skipped: ${docker})`}`, () => {
  const output = smokeComputer({ tgz, image: image!, name: `caveman-runtime-smoke-test-${process.pid}` });
  expect(output).toMatch(/caveman-runtime: self-check ok: node v24\.\S+ linux-(arm64|x64); natives node-pty, /);
  expect(output).toMatch(/caveman-computer: check passed: /);
}, 300_000);
