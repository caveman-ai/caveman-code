import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileStaged } from "../src/stagedWrite.ts";
import { writeWindowState } from "../src/windowState.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-staged-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staged writes", () => {
  it("replace the file whole, with the mode asked for, and leave nothing beside it", () => {
    const dir = scratch();
    const file = join(dir, "state.json");
    writeFileSync(file, "old\n");
    writeFileStaged(file, "new\n", { mode: 0o600 });
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(readdirSync(dir)).toEqual(["state.json"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("take their staging file with them when the rename fails", () => {
    const dir = scratch();
    // A directory in the file's place: the write lands, the rename can't replace it (as Windows' EPERM/EBUSY can't).
    const file = join(dir, "state.json");
    mkdirSync(join(file, "occupied"), { recursive: true });
    expect(() => writeFileStaged(file, "new\n")).toThrow();
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("take their staging file with them when the write fails", () => {
    const dir = scratch();
    expect(() => writeFileStaged(join(dir, "missing", "state.json"), "new\n")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leave no staging file beside the window's state when saving it fails", () => {
    const dir = scratch();
    const file = join(dir, "window-state.json");
    mkdirSync(join(file, "occupied"), { recursive: true });
    expect(() =>
      writeWindowState(file, {
        bounds: { x: 20, y: 20, width: 1200, height: 800 },
        maximized: true,
      }),
    ).toThrow();
    expect(readdirSync(dir)).toEqual(["window-state.json"]);
  });
});
