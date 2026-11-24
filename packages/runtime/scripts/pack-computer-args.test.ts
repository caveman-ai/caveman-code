// pack:computer's command line, checked before Docker runs and with no pack (pack-computer.test.ts packs one): the
// image's two architectures by name (x64 is amd64, as Node calls it), anything else refused naming the fix, and the
// container's name settable so a lab can find what it started (and remove only that).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it } from "vitest";

import { compareVersions, launcher, packVersion, parsePackArgs, releasesIn, versionHere } from "./pack-computer.ts";

const defaults = { hostArch: "arm64", pid: 4242, outFile: "/repo/packages/runtime/dist-computer/caveman-runtime.tgz" };

it("takes arm64, amd64 and x64 as the image's architectures", () => {
  expect(parsePackArgs(["--arch", "arm64"], defaults).arch).toBe("arm64");
  expect(parsePackArgs(["--arch", "amd64"], defaults).arch).toBe("amd64");
  expect(parsePackArgs(["--arch", "x64"], defaults).arch).toBe("amd64");
});

it("refuses any other architecture, naming the fix", () => {
  for (const arch of ["x86_64", "arm", "riscv64", ""])
    expect(() => parsePackArgs(["--arch", arch], defaults), arch).toThrow("pass --arch arm64, amd64 or x64");
  expect(() => parsePackArgs(["--arch"], defaults)).toThrow("--arch needs a value");
  expect(() => parsePackArgs([], { ...defaults, hostArch: "ppc64" })).toThrow("pass --arch arm64, amd64 or x64");
});

it("passes --name through as the container's name, refusing one Docker would not take", () => {
  expect(parsePackArgs(["out.tgz", "--arch", "arm64", "--name", "g-image-pack-n"], defaults)).toEqual({
    outFile: "out.tgz",
    here: false,
    arch: "arm64",
    name: "g-image-pack-n",
  });
  for (const name of ["-x", "a b", "/etc", ""]) expect(() => parsePackArgs(["--name", name], defaults), name).toThrow("--name");
});

it("keeps today's defaults: the host's architecture, the pid-named container and the package's dist-computer", () => {
  expect(parsePackArgs([], defaults)).toEqual({ outFile: defaults.outFile, here: false, arch: "arm64", name: "caveman-runtime-pack-4242" });
  expect(parsePackArgs([], { ...defaults, hostArch: "x64" }).arch).toBe("amd64");
  expect(parsePackArgs(["/o.tgz", "--here", "--epoch", "1760000000"], defaults)).toEqual({
    outFile: "/o.tgz",
    here: true,
    epoch: 1_760_000_000,
    arch: "arm64",
    name: "caveman-runtime-pack-4242",
  });
});

// The pack's version (CONTRACT §5.4): what a Cloud computer's runtime tells Cloud in its heartbeat. A pack that says
// 0.0.0 reads as outdated on every computer the day Cloud sets a minimum.
it("takes the release's own version, as the desktop pack does, and refuses one that is none", () => {
  const releases = [{ version: "0.1.0", draft: false }];
  expect(packVersion({ named: "0.2.0", releases, packageVersion: "0.0.0" })).toBe("0.2.0");
  expect(packVersion({ named: " v0.2.0-beta.3 ", releases, packageVersion: "0.0.0" })).toBe("0.2.0-beta.3");
  for (const named of ["latest", "1.2", "1.2.3; rm", "$(id)"]) expect(() => packVersion({ named, releases, packageVersion: "0.0.0" }), named).toThrow("is not a version");
  // Unset or empty: not named.
  expect(packVersion({ named: "", releases, packageVersion: "0.0.0" })).toBe("0.1.0");
  expect(packVersion({ releases, packageVersion: "0.0.0" })).toBe("0.1.0");
});

it("without one, is the newest release whose notes are finished: a draft has not shipped", () => {
  const releases = [
    { version: "0.1.0-beta.1", draft: false },
    { version: "0.1.0-beta.10", draft: false },
    { version: "0.1.0-beta.2", draft: false },
    { version: "0.1.0", draft: true },
  ];
  expect(packVersion({ releases, packageVersion: "0.0.0" })).toBe("0.1.0-beta.10");
  expect(packVersion({ releases: releases.map((r) => ({ ...r, draft: false })), packageVersion: "0.0.0" })).toBe("0.1.0");
  expect(packVersion({ releases: [{ version: "0.9.0", draft: false }, { version: "0.10.0", draft: false }, { version: "0.2.0", draft: false }], packageVersion: "0.0.0" })).toBe("0.10.0");
  // No release yet, or drafts only: the package's own.
  expect(packVersion({ releases: [], packageVersion: "0.0.0" })).toBe("0.0.0");
  expect(packVersion({ releases: [{ version: "0.1.0", draft: true }], packageVersion: "0.0.7" })).toBe("0.0.7");
});

it("orders versions as semver does", () => {
  const sorted = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-beta.2", "0.1.0-beta.10", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"];
  expect([...sorted].reverse().sort(compareVersions)).toEqual(sorted);
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
});

it("reads the releases from their notes: the version each names, and whether it is still a draft", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-releases-"));
  try {
    fs.writeFileSync(path.join(dir, "README.md"), "# Release notes\n\n```markdown\n---\nversion: 0.2.0\n---\n```\n");
    fs.writeFileSync(path.join(dir, "0.1.0-beta.1.md"), "---\nversion: 0.1.0-beta.1\ndate: 2026-10-26\ntitle: Beta\n---\n\nNotes.\n");
    fs.writeFileSync(path.join(dir, "0.1.0.md"), "---\nversion: 0.1.0\ndate: 2026-10-25\ntitle: Here\nblog:\nx:\ndraft: true\n---\n");
    // A file whose notes name another version is no release of its name.
    fs.writeFileSync(path.join(dir, "0.3.0.md"), "---\nversion: 0.4.0\n---\n");
    expect([...releasesIn(dir)].sort((a, b) => compareVersions(a.version, b.version))).toEqual([
      { version: "0.1.0-beta.1", draft: false },
      { version: "0.1.0", draft: true },
    ]);
    expect(releasesIn(path.join(dir, "missing"))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("this checkout packs as its newest finished release, never as 0.0.0", () => {
  const version = versionHere({});
  const shipped = releasesIn(path.resolve(import.meta.dirname, "../../../releases")).filter((r) => !r.draft).map((r) => r.version).sort(compareVersions);
  expect(shipped.length).toBeGreaterThan(0);
  expect(version).toBe(shipped.at(-1));
  expect(version).not.toBe("0.0.0");
  expect(versionHere({ CAVEMAN_APP_VERSION: "v9.8.7" })).toBe("9.8.7");
});

it.skipIf(process.platform === "win32")("the launcher names the pack's version to the runtime it starts, unless what starts it names one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-launcher-"));
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "bin/caveman-runtime"), launcher("0.1.0-beta.1"), { mode: 0o755 });
    // In the runtime's place: says the version its environment names and the arguments it was started with.
    fs.writeFileSync(path.join(root, "lib/bin.mjs"), "console.log(JSON.stringify([process.env.CAVEMAN_APP_VERSION, process.argv.slice(2)]));\n");
    const { CAVEMAN_APP_VERSION: _unset, ...env } = process.env;
    const run = (extra: Record<string, string>) => spawnSync(path.join(root, "bin/caveman-runtime"), ["--port", "1"], { encoding: "utf8", env: { ...env, ...extra } });
    const stamped = run({});
    expect(stamped.stderr).toBe("");
    expect(JSON.parse(stamped.stdout)).toEqual(["0.1.0-beta.1", ["--port", "1"]]);
    // The image's own word wins; an empty one is none.
    expect(JSON.parse(run({ CAVEMAN_APP_VERSION: "2.0.0" }).stdout)).toEqual(["2.0.0", ["--port", "1"]]);
    expect(JSON.parse(run({ CAVEMAN_APP_VERSION: "" }).stdout)).toEqual(["0.1.0-beta.1", ["--port", "1"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
