import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RotatingLog } from "../src/rotatingLog.ts";

test("turns over at the cap and keeps only the newest old files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-log-"));
  const log = new RotatingLog(dir, "desktop.log", 100, 2);
  for (let i = 0; i < 10; i++) log.write(`${String(i).repeat(39)}\n`); // 40 bytes each: two lines a file
  await log.close();
  expect(readdirSync(dir).sort()).toEqual(["desktop.1.log", "desktop.2.log", "desktop.log"]);
  expect(readFileSync(join(dir, "desktop.log"), "utf8")).toBe(`${"8".repeat(39)}\n${"9".repeat(39)}\n`);
  expect(readFileSync(join(dir, "desktop.1.log"), "utf8").startsWith("6")).toBe(true);
  expect(readFileSync(join(dir, "desktop.2.log"), "utf8").startsWith("4")).toBe(true);
});

test("a file already over the cap at launch turns over first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-log-"));
  writeFileSync(join(dir, "desktop.log"), "x".repeat(150));
  const log = new RotatingLog(dir, "desktop.log", 100, 3);
  log.write("fresh\n");
  await log.close();
  expect(readFileSync(join(dir, "desktop.log"), "utf8")).toBe("fresh\n");
  expect(readFileSync(join(dir, "desktop.1.log"), "utf8")).toBe("x".repeat(150));
});

const contents = (dir: string, ...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null]));

// Windows will not rename or delete a log file another process holds open (a log viewer, an antivirus scan): EBUSY or
// EPERM. A directory in an old file's place makes the turnover fail the same way on every platform.
test("keeps logging after a turnover that failed, and turns over once it can", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-log-"));
  const log = new RotatingLog(dir, "desktop.log", 100, 2);
  log.write(`${"a".repeat(59)}\n`);
  mkdirSync(join(dir, "desktop.2.log"));
  log.write(`${"b".repeat(59)}\n`); // over the cap: the turnover fails
  rmSync(join(dir, "desktop.2.log"), { recursive: true });
  log.write("runtime: exited code=1\n");
  log.write(`${"c".repeat(59)}\n`); // over the cap again: this turnover goes through
  await log.close();
  expect(contents(dir, "desktop.log", "desktop.1.log")).toEqual({
    "desktop.log": `${"c".repeat(59)}\n`,
    "desktop.1.log": `${"a".repeat(59)}\n${"b".repeat(59)}\nruntime: exited code=1\n`,
  });
});

test("a file over the cap at launch whose turnover fails still opens, and logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-log-"));
  writeFileSync(join(dir, "desktop.log"), "x".repeat(150));
  mkdirSync(join(dir, "desktop.3.log"));
  let log: RotatingLog | undefined;
  expect(() => (log = new RotatingLog(dir, "desktop.log", 100, 3))).not.toThrow();
  log!.write("fresh\n");
  await log!.close();
  expect(readFileSync(join(dir, "desktop.log"), "utf8")).toBe(`${"x".repeat(150)}fresh\n`);
});
