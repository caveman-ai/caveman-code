import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { publishTestRuntimeReady } from "./testRuntimeReady.ts";

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const readyFile = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-ready-"));
  roots.push(root);
  return path.join(root, "ready.json");
};

test("a polling parent cannot see an empty or partial readiness document", () => {
  const file = readyFile();
  const info = { url: "http://127.0.0.1:1234", token: "fixture-only", runtimeId: "mac" };
  const observations: Array<string | undefined> = [];
  const observe = () =>
    observations.push(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
  // Pause at both OS-visible write boundaries, as another process may run after open or a partial write.
  vi.spyOn(fs, "writeFileSync").mockImplementationOnce((target, data) => {
    if (typeof target === "number") throw new Error("expected a readiness path");
    const fd = fs.openSync(target, "w");
    try {
      observe();
      const text = String(data);
      fs.writeSync(fd, text.slice(0, 8));
      observe();
      fs.writeSync(fd, text.slice(8));
      observe();
    } finally {
      fs.closeSync(fd);
    }
  });
  publishTestRuntimeReady(file, info);
  expect(observations).toEqual([undefined, undefined, undefined]);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(info);
});

test("an interrupted write never signals that the runtime is ready", () => {
  const file = readyFile();
  vi.spyOn(fs, "writeFileSync").mockImplementationOnce((target) => {
    if (typeof target === "number") throw new Error("expected a readiness path");
    const fd = fs.openSync(target, "w");
    fs.closeSync(fd);
    throw new Error("injected write failure");
  });
  expect(() => publishTestRuntimeReady(file, { url: "fixture" })).toThrow("injected write failure");
  expect(fs.existsSync(file)).toBe(false);
});
