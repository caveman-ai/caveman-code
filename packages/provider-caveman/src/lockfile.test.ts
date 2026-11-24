// The engine's model library must load once, on a patched undici: a second pi-ai copy splits its
// provider registry from the engine SDK's, and undici 7 before 7.29.1 carries GHSA-w293-vg96-wgc3
// (TLS validation bypass) and GHSA-rfgv-xxqx-mfg5. Every undici line before 6.29.1, 7.30.1 and
// 8.12.2 carries GHSA-xjj6-f33q-929c, which the Cloud computer image's release scan refuses.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const lock = NodeFS.readFileSync(NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../../pnpm-lock.yaml"), "utf8");
const versions = (name: string) => [...new Set([...lock.matchAll(new RegExp(`^  '?${name}@([^:(']+)`, "gm"))].map((m) => m[1]!))];

/** The first patched minor.patch of each undici major the lockfile may carry. */
const PATCHED_UNDICI: Record<string, readonly [number, number]> = { "6": [29, 1], "7": [30, 1], "8": [12, 2] };

it("installs one pi-ai, and every undici at a patched version", () => {
  const piAi = [...new Set([...lock.matchAll(/^  '@earendil-works\/pi-ai@1\.3\.0\(([^']*)\)':$/gm)].map((m) => m[1]))];
  expect(piAi).toHaveLength(1);
  // Installed versions only: the overrides block names a range ("undici@7: ...").
  const undici = versions("undici").filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  expect(undici.some((v) => v.startsWith("7."))).toBe(true);
  for (const v of undici) {
    const [major, minor, patch] = v.split(".");
    const floor = PATCHED_UNDICI[major!];
    expect(floor, `undici ${v}: no known patched ${major}.x`).toBeDefined();
    expect(Number(minor) * 1000 + Number(patch) >= floor![0] * 1000 + floor![1], `undici ${v} is unpatched`).toBe(true);
  }
});
