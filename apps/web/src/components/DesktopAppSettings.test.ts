import { expect, test } from "vitest";

import type { UpdateState } from "../state/desktop.ts";
import { updateLine } from "./DesktopAppSettings.tsx";

const base: UpdateState = {
  status: "idle",
  version: "0.4.2",
  channel: "stable",
  buildChannel: "stable",
  next: null,
  message: null,
  percent: null,
  failed: null,
  notes: [],
  notApplied: null,
};

test("Settings > General says where the updater is in one sentence", () => {
  expect(
    updateLine({ ...base, status: "disabled", message: "Updates are off in development builds." }),
  ).toBe("Updates are off in development builds.");
  expect(updateLine({ ...base, status: "checking", channel: "nightly" })).toBe(
    "Checking for Nightly updates…",
  );
  expect(
    updateLine({ ...base, status: "downloading", next: "0.4.3-nightly.20261109.12", percent: 40 }),
  ).toBe("Downloading 0.4.3-nightly.20261109.12 (40%)…");
  expect(updateLine({ ...base, status: "ready", next: "0.4.3" })).toBe(
    "0.4.3 is ready. It installs when you quit, or now.",
  );
  expect(updateLine({ ...base, status: "error", failed: "check", message: "offline" })).toBe(
    "Couldn't check for updates: offline.",
  );
  expect(
    updateLine({
      ...base,
      status: "error",
      failed: "download",
      next: "0.4.3",
      message: "checksum",
    }),
  ).toBe("Couldn't download 0.4.3: checksum. It tries again at the next check.");
  expect(updateLine({ ...base, status: "current" })).toBe("Up to date.");
});

test("a Nightly build switched back to Stable says it stays until a newer Stable, never older", () => {
  expect(
    updateLine({
      ...base,
      status: "current",
      version: "0.4.3-nightly.20261109.12",
      buildChannel: "nightly",
    }),
  ).toBe("Up to date: this Nightly build stays until a Stable release newer than it is out.");
});

test("an older desktop's state, without channels, still reads", () => {
  expect(updateLine({ status: "ready", version: "0.1.0", next: "0.2.0" })).toBe(
    "0.2.0 is ready. It installs when you quit, or now.",
  );
  expect(updateLine({ status: "checking", version: "0.1.0" })).toBe("Checking for Stable updates…");
});
