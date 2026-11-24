import { expect, test } from "vitest";

import { otherRuntimes } from "./RuntimeTargets.tsx";

test("the new chat dialog offers every other online runtime of yours, Macs first, never the window's own twice", () => {
  const runtimes = [
    { runtime_id: "rt-cloud-b", computer_id: "pc-cloud-b", name: "widgets", kind: "cloud" as const, online: true },
    { runtime_id: "rt-mac", computer_id: "pc-mac", name: "Julius's MacBook", kind: "laptop" as const, online: true },
    { runtime_id: "rt-studio", computer_id: "pc-studio", name: "Studio", kind: "laptop" as const, online: false },
    { runtime_id: "rt-cloud-a", computer_id: "pc-cloud-a", name: "api", kind: "cloud" as const, online: true },
    { runtime_id: "rt-home", computer_id: "pc-home", name: "This one", kind: "laptop" as const, online: true },
    { runtime_id: "rt-own", computer_id: "pc-own", name: "", kind: "laptop" as const, online: true },
  ];
  expect(otherRuntimes(runtimes, ["rt-home", null]).map((t) => t.runtimeId)).toEqual(["rt-own", "rt-mac", "rt-cloud-a", "rt-cloud-b"]);
  expect(otherRuntimes(runtimes, ["rt-home", "rt-own"]).map((t) => t.name)).toEqual(["Julius's MacBook", "api", "widgets"]);
  expect(otherRuntimes(runtimes, [undefined]).find((t) => t.runtimeId === "rt-own")?.name).toBe("A Mac");
  expect(otherRuntimes([], [])).toEqual([]);
});

test("each other runtime carries its computer, the target a move names", () => {
  const runtimes = [
    { runtime_id: "rt-studio", computer_id: "pc-studio", name: "Studio", kind: "laptop" as const, online: true },
    { runtime_id: "rt-box", computer_id: "pc-box", name: "api", kind: "cloud" as const, online: true },
  ];
  expect(otherRuntimes(runtimes, []).map((t) => [t.runtimeId, t.computerId])).toEqual([
    ["rt-studio", "pc-studio"],
    ["rt-box", "pc-box"],
  ]);
});
