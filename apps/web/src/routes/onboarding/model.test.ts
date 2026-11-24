import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { describe, expect, it, test } from "vitest";
import { PLANS } from "../settings/connections-model.ts";
import { andList, bringingLine, cloudToo, firstRunPath, foundLogins, importRefs, importSummary, notFound, planName, readDraft, resumeStep, showsFirstRun, tomlArray, type ImportSource } from "./model.ts";

const engine = (id: string, label: string, state: EngineDescriptor["auth"]["state"], accounts: Array<{ label: string; kind: "login" | "api_key" }> = []) =>
  ({ id, label, auth: { state, accounts: accounts.map((a, i) => ({ id: `${id}:${i}`, active: i === 0, ...a })) } }) as unknown as EngineDescriptor;

describe("your setup", () => {
  test("a plan name loses its Subscription suffix, a bare label stays", () => {
    expect(planName("Claude Max 20x Subscription")).toBe("Claude Max 20x");
    expect(planName("Claude subscription")).toBe("Claude subscription");
    expect(planName("OpenAI API key …4f2a")).toBe("OpenAI API key …4f2a");
  });

  test("offers Cloud too for each agent on this Mac's own plan login that one approval would carry there", () => {
    const own = (id: string, label: string, everywhere?: "available" | "manage") =>
      ({ id, label, auth: { state: "signed_in", ...(everywhere ? { everywhere } : {}), accounts: [{ id: PLANS[id as keyof typeof PLANS].own, active: true, label: "Plan", kind: "login" }] } }) as unknown as EngineDescriptor;
    expect(cloudToo([own("claude-agent", "Claude Agent", "available"), own("codex", "Codex", "available"), engine("caveman", "Caveman", "signed_out")], 0)).toEqual([
      { engine: "claude-agent", approve: "Claude" },
      { engine: "codex", approve: "ChatGPT" },
    ]);
    // Not signed in to Caveman (nothing says the plan can go further), or a page that cannot connect one: no row.
    expect(cloudToo([own("claude-agent", "Claude Agent"), own("codex", "Codex", "manage")], 0)).toEqual([]);
    // Already everywhere: nothing to approve.
    const everywhere = { ...own("claude-agent", "Claude Agent", "available") } as EngineDescriptor;
    const connected = { ...everywhere, auth: { ...everywhere.auth, accounts: [{ id: "connection:1", active: true, label: "Claude plan", kind: "login", where: "everywhere", connection: { kind: "claude_plan", state: "ready" } }] } } as unknown as EngineDescriptor;
    expect(cloudToo([connected], 0)).toEqual([]);
  });

  test("lists each login and key of every ready engine, and names the rest as not found", () => {
    const engines = [
      engine("caveman", "Caveman", "signed_out"),
      engine("claude-agent", "Claude Agent", "signed_in", [{ label: "Claude Max 20x Subscription", kind: "login" }]),
      engine("codex", "Codex", "api_key", [{ label: "OpenAI API key …4f2a", kind: "api_key" }]),
      engine("cursor", "Cursor", "checking"),
      engine("grok", "Grok", "signed_out"),
    ];
    expect(foundLogins(engines)).toEqual([
      { engine: "claude-agent", label: "Claude Max 20x", detail: "Runs Claude Agent" },
      { engine: "codex", label: "OpenAI API key …4f2a", detail: "Runs Codex" },
    ]);
    // Cursor is still checking: neither found nor missing yet.
    expect(notFound(engines)).toEqual(["Caveman", "Grok"]);
  });

  test("counts what importing brings, leaving out what is read in place or can't come", () => {
    const item = (from: "claude" | "codex", kind: string, name: string, action: string) => ({ from, kind, name, action, detail: "" });
    const sources = [
      { from: "claude", found: true, items: [item("claude", "skill", "a", "import"), item("claude", "skill", "b", "import"), item("claude", "mcp_server", "linear", "import"), item("claude", "instructions", "CLAUDE.md", "available")] },
      { from: "codex", found: true, items: [item("codex", "mcp_server", "x", "skip")] },
      { from: "cursor", found: false, items: [] },
    ] as unknown as ImportSource[];
    expect(importSummary(sources)).toEqual({ count: 3, parts: ["2 skills", "1 MCP server"], from: ["Claude Code"] });
    expect(andList(["Claude Code", "Codex", "Cursor"])).toBe("Claude Code, Codex and Cursor");
    expect(andList(["Codex"])).toBe("Codex");
  });
});

describe("setting a project up", () => {
  // environment.draft for caveman-code on a real runtime, 2026-10-25.
  const draft = {
    config: '# Drafted by Caveman; edit freely.\n[setup]\nrun = [\n  "mise use -g node@24",\n  "mise use -g pnpm@10.14.0",\n  "pnpm install --frozen-lockfile",\n]\ncheck = ["pnpm typecheck", "pnpm test"]\ninputs = ["package.json", "pnpm-lock.yaml"]\n',
    evidence: [
      { note: "Node 24 from ci.yml" },
      { note: "pnpm 10.14.0 from package.json packageManager" },
      { note: "pnpm-lock.yaml: pnpm install --frozen-lockfile" },
      { note: "The code reads 9 more secret-looking names no .env file sets" },
      { note: "Checks from package.json: pnpm typecheck · pnpm test" },
    ],
    secret_names: ["OPENAI_API_KEY"],
  };

  test("reads the install, the checks, the tool versions and the secrets", () => {
    expect(readDraft(draft)).toEqual({ stack: ["Node 24", "pnpm 10.14.0"], install: "pnpm install --frozen-lockfile", checks: ["pnpm typecheck", "pnpm test"], secrets: ["OPENAI_API_KEY"], moreSecrets: 9 });
  });

  test("a TOML array on one line or several, and a missing key", () => {
    expect(tomlArray('check = ["a b", "c"]', "check")).toEqual(["a b", "c"]);
    expect(tomlArray("run = [\n  \"x\",\n]", "run")).toEqual(["x"]);
    expect(tomlArray("[setup]", "run")).toEqual([]);
  });
});

describe("whether the first run shows", () => {
  const at = (over: Partial<Parameters<typeof showsFirstRun>[0]>) => showsFirstRun({ status: "connecting", desktop: true, chats: 0, begun: false, done: false, ...over });

  test("a fresh desktop install opens on it from the first paint, while its runtime starts or fails to", () => {
    // The Windows report: the empty shell showed until a slow runtime answered.
    expect(at({ status: "connecting" })).toBe(true);
    expect(at({ status: "error" })).toBe(true);
    expect(at({ status: "connected" })).toBe(true);
  });

  test("a desktop that kept chats from its last launch paints the shell, and the runtime's answer decides after", () => {
    expect(at({ status: "connecting", chats: 3 })).toBe(false);
    expect(at({ status: "connected", chats: 3 })).toBe(false);
  });

  test("a browser waits for its runtime, and a link-less page never shows it", () => {
    expect(at({ desktop: false, status: "connecting" })).toBe(false);
    expect(at({ desktop: false, status: "connected" })).toBe(true);
    expect(at({ status: "unconfigured" })).toBe(false);
  });

  test("once begun it runs to its end, whatever the link does; once done, never again", () => {
    expect(at({ begun: true, status: "error", chats: 1 })).toBe(true);
    expect(at({ done: true, status: "connected" })).toBe(false);
    expect(at({ done: true, begun: true })).toBe(false);
  });
});

describe("bringing the setup over in the background", () => {
  it("takes back only what Bring your setup counts", () => {
    const sources = [
      { from: "claude", items: [
        { from: "claude", kind: "plugin", name: "a", action: "install" },
        { from: "claude", kind: "skill", name: "b", action: "available" },
        { from: "claude", kind: "mcp_server", name: "c", action: "skip" },
      ] },
    ] as unknown as ImportSource[];
    expect(importRefs(sources)).toEqual([{ from: "claude", kind: "plugin", name: "a" }]);
  });

  it("says what is coming, then what came and what didn't", () => {
    const parts = ["20 MCP servers", "43 plugins"];
    expect(bringingLine({ state: "running", parts })).toBe("Bringing over 20 MCP servers and 43 plugins…");
    expect(bringingLine({ state: "done", parts, imported: 63, failed: [] })).toBe("Brought over 20 MCP servers and 43 plugins");
    expect(bringingLine({ state: "done", parts, imported: 60, failed: ["figma", "linear", "notion"] })).toBe("Brought over 60; figma, linear and 1 more couldn't come. Try again from Plugins.");
    expect(bringingLine({ state: "failed", error: "timed out" })).toBe("Your setup didn't come over (timed out). Bring it from Plugins any time.");
  });
});

describe("resumeStep", () => {
  it("goes back to the step a reload left, else the first", () => {
    const steps = ["signin", "setup", "project"] as const;
    expect(resumeStep("project", steps)).toBe("project");
    expect(resumeStep(null, steps)).toBe("signin");
    // A web client served by Cloud has no sign-in step: a saved one starts at its first.
    expect(resumeStep("signin", ["setup", "project"] as const)).toBe("setup");
  });
});

test("a first run opens on its chat, else its project's Chief, else New chat when no project was added", () => {
  expect(firstRunPath({ chat: "ws-1" })).toBe("/w/ws-1");
  expect(firstRunPath({ project: "p-app" }, "/chief/c-1")).toBe("/chief/c-1");
  // The runtime gave no Chief (too old, or it failed): the Chief page finds one itself.
  expect(firstRunPath({ project: "p-app" })).toBe("/chief");
  // Skip for now: no project, so no Chief to open.
  expect(firstRunPath(null)).toBe("/new");
});
