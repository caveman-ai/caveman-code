import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script
import { merge } from "../scripts/merge-update-manifests.mjs";

const manifest = (arch: string, version = "0.1.0") => `version: ${version}
files:
  - url: Caveman Code-${version}-${arch}-mac.zip
    sha512: ${arch}zip
    size: 1
  - url: Caveman Code-${version}-${arch}.dmg
    sha512: ${arch}dmg
    size: 2
path: Caveman Code-${version}-${arch}-mac.zip
sha512: ${arch}zip
releaseDate: '2026-10-16T00:00:00.000Z'
`;

describe("merge-update-manifests", () => {
  it("lists every arch's files under the first manifest's version and path", () => {
    const merged: string = merge([manifest("arm64"), manifest("x64")]);
    expect(merged.match(/- url: /g)).toHaveLength(4);
    expect(merged).toContain("  - url: Caveman Code-0.1.0-x64-mac.zip\n    sha512: x64zip");
    expect(merged.startsWith("version: 0.1.0\nfiles:\n  - url: Caveman Code-0.1.0-arm64-mac.zip")).toBe(true);
    expect(merged.endsWith("path: Caveman Code-0.1.0-arm64-mac.zip\nsha512: arm64zip\nreleaseDate: '2026-10-16T00:00:00.000Z'\n")).toBe(true);
  });

  it("refuses manifests of different versions or another shape", () => {
    expect(() => merge([manifest("arm64"), manifest("x64", "0.1.1")])).toThrow(/versions differ/);
    expect(() => merge(["hello: world\n"])).toThrow(/not an electron-builder/);
  });
});
