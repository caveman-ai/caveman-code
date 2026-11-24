import { afterEach, expect, test, vi } from "vitest";
import { funnelStep, reportPageErrors } from "./desktop.ts";

afterEach(() => vi.unstubAllGlobals());

test("page errors reach the desktop by name only, and nothing happens in a browser", () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const telemetry = { step: vi.fn(), crash: vi.fn(), choice: vi.fn(), set: vi.fn() };
  vi.stubGlobal("window", { cavemanDesktop: { telemetry }, addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) });
  reportPageErrors();
  listeners.get("error")?.({ error: new TypeError("secret at /Users/me/code.ts") });
  listeners.get("unhandledrejection")?.({ reason: "a string, not an Error" });
  expect(telemetry.crash.mock.calls).toEqual([["TypeError"], ["NonError"]]);
  funnelStep("first_workspace");
  expect(telemetry.step).toHaveBeenCalledWith("first_workspace");

  vi.stubGlobal("window", { addEventListener: vi.fn() });
  reportPageErrors();
  funnelStep("welcome_shown");
  expect(vi.mocked(window.addEventListener)).not.toHaveBeenCalled();
});
