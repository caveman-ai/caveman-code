import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, expect, it } from "vitest";

import { openNoFollow, openNoFollowSync } from "./openNoFollow.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-nofollow-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "pin");
fs.writeFileSync(file, "pinned\n");

it("opens a file, synchronously or as a handle", async () => {
  const fd = openNoFollowSync(file, fs.constants.O_RDONLY);
  try {
    expect(fs.readFileSync(fd, "utf8")).toBe("pinned\n");
  } finally {
    fs.closeSync(fd);
  }
  const handle = await openNoFollow(file, fs.constants.O_RDONLY);
  try {
    expect(await handle.readFile("utf8")).toBe("pinned\n");
  } finally {
    await handle.close();
  }
});

// On Windows (no O_NOFOLLOW) through the lstat check, elsewhere through O_NOFOLLOW.
it("refuses a symbolic link", async () => {
  const link = path.join(dir, "link");
  fs.symlinkSync(file, link, "file");
  expect(() => openNoFollowSync(link, fs.constants.O_RDONLY)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  await expect(openNoFollow(link, fs.constants.O_RDONLY)).rejects.toMatchObject({ code: "ELOOP" });
});
