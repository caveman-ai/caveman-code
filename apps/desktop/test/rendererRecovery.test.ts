import { expect, test } from "vitest";
import { RECOVERY_MAX, RECOVERY_WINDOW_MS, RendererRecovery } from "../src/rendererRecovery.ts";

test("a crashed page reloads, a few times, then the person is asked", () => {
  const r = new RendererRecovery();
  for (let i = 0; i < RECOVERY_MAX; i++) expect(r.next("crashed", 1_000 + i)).toBe("reload");
  expect(r.next("oom", 2_000)).toBe("give-up");
  // Long after, a new crash reloads again.
  expect(r.next("crashed", 2_000 + RECOVERY_WINDOW_MS)).toBe("reload");
});

test("a page that was meant to go is left alone", () => {
  const r = new RendererRecovery();
  expect(r.next("clean-exit", 0)).toBe("ignore");
  expect(r.next("killed", 0)).toBe("reload");
  expect(r.next("abnormal-exit", 0)).toBe("reload");
});
