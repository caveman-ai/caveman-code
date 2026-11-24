import { describe, expect, it } from "vitest";

import { HARNESSES, harnessProvider } from "./harnesses.ts";
import { engineIdForInstance } from "./projector.ts";

// Grok, Pi and Antigravity as harness engines (harnesses.ts): their accounts, forms and sign-in.
describe("CLI harness engines", () => {
  it("Grok: one engine for every Grok instance, an optional xAI key, sign-in with its own CLI", () => {
    expect(engineIdForInstance("grok")).toBe("grok");
    expect(engineIdForInstance("grok-account-0a1b2c3d")).toBe("grok");
    expect(harnessProvider("grok")).toEqual({
      id: "grok",
      label: "Grok",
      group: "featured",
      auth: "optional_key",
      key_label: "xAI API key",
      fields: [{ name: "binaryPath", label: "Binary path", placeholder: "grok", optional: true }],
    });
    expect(HARNESSES.get("grok")).toMatchObject({ cliSignIn: { command: "grok login" }, proxy: false });
  });

  it("Pi: the stock Pi agent as an engine of its own, signed in with its own CLI", () => {
    expect(engineIdForInstance("pi")).toBe("pi");
    expect(engineIdForInstance("pi-account-0a1b2c3d")).toBe("pi");
    expect(harnessProvider("pi")).toEqual({
      id: "pi",
      label: "Pi",
      group: "featured",
      auth: "cli",
      fields: [
        { name: "binaryPath", label: "Binary path", placeholder: "pi", optional: true },
        { name: "launchArgs", label: "Launch arguments", optional: true },
      ],
    });
    expect(HARNESSES.get("pi")).toMatchObject({ cliSignIn: { command: "pi" }, proxy: false });
  });

  it("Antigravity: signs in with Google in the browser, its settings form from AntigravitySettings", () => {
    expect(engineIdForInstance("antigravity")).toBe("antigravity");
    expect(engineIdForInstance("antigravity-account-0a1b2c3d")).toBe("antigravity");
    const provider = harnessProvider("antigravity");
    expect(provider).toMatchObject({ id: "antigravity", label: "Antigravity", auth: "cli", sign_in: true });
    expect(provider?.fields?.map((f) => f.name)).toEqual(["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"]);
    expect(HARNESSES.get("antigravity")?.proxy).toBe(false);
  });
});
