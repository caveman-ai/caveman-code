import { describe, expect, it } from "vitest";

import { assignAccountTags, defaultAccountTag, harnessEngineOf, harnessProvider, harnessProxies } from "./harnesses.ts";
import { engineIdForInstance, instanceForEngine } from "./projector.ts";

describe("harness engines", () => {
  it("map every instance of a harness driver to one engine", () => {
    expect(engineIdForInstance("cursor")).toBe("cursor");
    expect(engineIdForInstance("cursor-account-0a1b2c3d")).toBe("cursor");
    expect(harnessEngineOf("cursorish")).toBeUndefined();
    expect(engineIdForInstance("cursorish")).toBe("acp:cursorish");
    expect(instanceForEngine("cursor")).toBe("cursor");
  });

  it("offer the driver's own settings form: Cursor's optional key and its browser sign-in", () => {
    expect(harnessProvider("cursor")).toEqual({ id: "cursor", label: "Cursor", group: "featured", auth: "optional_key", key_label: "Cursor API key", sign_in: true });
    expect(harnessProvider("codex")).toEqual(undefined);
    // OpenCode signs in with its own CLI; its form is its settings schema's visible fields.
    expect(harnessProvider("opencode")).toMatchObject({
      auth: "cli",
      fields: [
        { name: "binaryPath", label: "Binary path", placeholder: "opencode", optional: true },
        { name: "serverUrl", label: "Server URL", optional: true },
        { name: "serverPassword", label: "Server password", optional: true },
      ],
    });
    expect(engineIdForInstance("opencode-account-1")).toBe("opencode");
    expect(harnessProvider("muse")).toMatchObject({ id: "muse", label: "Muse Code", auth: "cli", fields: [{ name: "binaryPath" }] });
  });

  it("make a two-letter tag from a label", () => {
    expect(defaultAccountTag("julius@caveman.so")).toBe("JU");
    expect(defaultAccountTag("OpenAI API key ...4f2a")).toBe("OA");
    expect(defaultAccountTag("x")).toBe("AC");
  });

  it("render a select setting as its choices, never free text (Antigravity's sign-in method)", () => {
    expect(harnessProvider("antigravity")?.fields?.find((f) => f.name === "authMethod")).toMatchObject({
      label: "Sign-in method",
      options: expect.arrayContaining([{ value: "oauth-personal", label: "Google account" }, { value: "gemini-api-key", label: "Gemini API key" }]),
    });
    expect(harnessProvider("opencode")?.fields?.every((f) => f.options === undefined)).toBe(true);
  });

  it("give each account of an engine its own tag, keeping the ones already given", () => {
    const accounts = [
      { id: "a", label: "john@a.com" },
      { id: "b", label: "john@b.com" },
      { id: "c", label: "Cursor" },
      { id: "d", label: "Cursor" },
    ];
    expect(assignAccountTags(accounts, {})).toEqual({ a: "JO", b: "JO2", c: "CU", d: "CU2" });
    // A kept tag never moves, even when its label would now give another; new ones go around it.
    expect(assignAccountTags(accounts, { a: "JO2", c: "WRK" })).toEqual({ b: "JO", d: "CU" });
    expect(assignAccountTags(accounts, { a: "JO", b: "JO2", c: "CU", d: "CU2" })).toEqual({});
  });

  it("route OpenCode through the caveman-proxy only on a version 2 server it starts, while the scrub is up", () => {
    const routed = { version: "2.0.22", config: {}, scrubUp: true };
    expect(harnessProxies("opencode", routed)).toBe(true);
    expect(harnessProxies("opencode", { ...routed, version: "v2.1.0" })).toBe(true);
    expect(harnessProxies("opencode", { ...routed, version: "1.14.3" })).toBe(false);
    expect(harnessProxies("opencode", { ...routed, version: undefined })).toBe(false);
    expect(harnessProxies("opencode", { ...routed, config: { serverUrl: "http://10.0.0.5:4096" } })).toBe(false);
    expect(harnessProxies("opencode", { ...routed, config: { serverUrl: "  " } })).toBe(true);
    expect(harnessProxies("opencode", { ...routed, scrubUp: false })).toBe(false);
    expect(harnessProxies("cursor", routed)).toBe(false);
  });
});
