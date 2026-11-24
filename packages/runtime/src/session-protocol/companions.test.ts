import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { companionGuide } from "@caveman-app/shared/companion";
import { afterEach, expect, it } from "vitest";

import { listCompanions } from "./companions.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companions-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

it("makes the folder with the guide, and hands over its companion files as written", async () => {
  const folder = path.join(tempDir(), ".caveman", "companions");
  expect((await listCompanions(folder)).files).toEqual([]);
  expect(fs.readFileSync(path.join(folder, "README.md"), "utf8")).toBe(companionGuide(folder));

  fs.writeFileSync(path.join(folder, "rex.json"), '{"name":"Rex"}');
  fs.writeFileSync(path.join(folder, "notes.txt"), "not a companion");
  fs.writeFileSync(path.join(folder, "huge.json"), "x".repeat(70 * 1024));
  fs.symlinkSync("/etc/hosts", path.join(folder, "link.json"));
  fs.writeFileSync(path.join(folder, "README.md"), "edited by hand");
  const { files } = await listCompanions(folder);
  expect(files).toEqual([{ id: "huge", problem: expect.stringContaining("at most") }, { id: "rex", text: '{"name":"Rex"}' }]);
  expect(fs.readFileSync(path.join(folder, "README.md"), "utf8")).toBe(companionGuide(folder));
});
