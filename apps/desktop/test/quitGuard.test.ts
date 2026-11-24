import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { askBeforeQuit, onQuitSignal, quitQuestion, stopAsking, workingHere } from "../src/quitGuard.ts";

const here = (status: string) => ({ status, computer: { kind: "this_mac" } });

test("counts only chats whose engine runs on this Mac", () => {
  expect(workingHere([here("working"), here("starting"), here("waiting"), here("idle"), here("needs_input"), here("failed"), here("archived")])).toBe(3);
  expect(workingHere([{ status: "working", computer: { kind: "caveman_cloud" } }, { status: "working", computer: { kind: "pool" } }])).toBe(0);
  expect(workingHere([])).toBe(0);
});

test("says what quitting stops", () => {
  expect(quitQuestion(1).message).toBe("A chat is still working");
  expect(quitQuestion(1).detail).toContain("stops it on this Mac");
  expect(quitQuestion(3).message).toBe("3 chats are still working");
  expect(quitQuestion(3).detail).toContain("stops them");
});

test("asks until the person says not to, and a broken file means ask", () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-quit-")), "quit.json");
  expect(askBeforeQuit(file)).toBe(true);
  writeFileSync(file, "{");
  expect(askBeforeQuit(file)).toBe(true);
  stopAsking(file);
  expect(askBeforeQuit(file)).toBe(false);
});

test("SIGINT and SIGTERM quit once, without the question, and not on Windows", () => {
  const proc = new EventEmitter();
  const quits: string[] = [];
  onQuitSignal(proc, "darwin", (signal) => quits.push(signal));
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  expect(quits).toEqual(["SIGTERM"]);
  const ctrlC = new EventEmitter();
  const viaCtrlC: string[] = [];
  onQuitSignal(ctrlC, "linux", (signal) => viaCtrlC.push(signal));
  ctrlC.emit("SIGINT");
  expect(viaCtrlC).toEqual(["SIGINT"]);
  const windows = new EventEmitter();
  onQuitSignal(windows, "win32", () => quits.push("win32"));
  expect(windows.listenerCount("SIGTERM") + windows.listenerCount("SIGINT")).toBe(0);
});
