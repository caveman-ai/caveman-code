import { expect, it, vi } from "vitest";
import { fileBox, takeFilesIn, watchFileBoxes, type FileBox } from "./compose-event.ts";

const box = (): FileBox => ({ take: async () => null, focus: () => undefined });

it("a box on screen takes pictures for its name, until it goes", () => {
  const a = box();
  expect(fileBox("chat")).toBeNull();
  const gone = takeFilesIn("chat", a);
  expect(fileBox("chat")).toBe(a);
  expect(fileBox("other")).toBeNull();
  expect(fileBox(null)).toBeNull();
  gone();
  expect(fileBox("chat")).toBeNull();
});

it("the same chat in two panes: the later box takes them, and the first still does once the later goes", () => {
  const first = box();
  const later = box();
  const firstGone = takeFilesIn("chat", first);
  const laterGone = takeFilesIn("chat", later);
  expect(fileBox("chat")).toBe(later);
  laterGone();
  expect(fileBox("chat")).toBe(first);
  firstGone();
  expect(fileBox("chat")).toBeNull();
});

it("the first of two going leaves the later one", () => {
  const first = box();
  const later = box();
  const firstGone = takeFilesIn("chat", first);
  const laterGone = takeFilesIn("chat", later);
  firstGone();
  expect(fileBox("chat")).toBe(later);
  laterGone();
});

it("says so whenever a box comes or goes", () => {
  const watcher = vi.fn();
  const stop = watchFileBoxes(watcher);
  const gone = takeFilesIn("chat", box());
  gone();
  expect(watcher).toHaveBeenCalledTimes(2);
  stop();
  takeFilesIn("chat", box())();
  expect(watcher).toHaveBeenCalledTimes(2);
});
