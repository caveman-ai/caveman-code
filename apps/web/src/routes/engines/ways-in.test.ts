import type { EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { cliMissing, setupHereMessage, type ScanFound } from "../../state/engines.ts";
import { claudeInstall, codexInstall } from "./install-commands.ts";
import { waysIn } from "./ways-in.ts";

const engine = (
  id: string,
  label: string,
  state: EngineDescriptor["auth"]["state"] = "signed_out",
  message?: string,
) =>
  ({
    id,
    label,
    version: "1.0",
    auth: { state, accounts: [], ...(message ? { message } : {}) },
  }) as unknown as EngineDescriptor;

const providers: ReadonlyArray<EngineProvider> = [
  { id: "anthropic", label: "Anthropic", group: "featured", section: "keys", auth: "key" },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    group: "featured",
    auth: "key",
    sign_in: true,
    sign_in_only: true,
    sign_in_plan: "GitHub Copilot",
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "featured",
    section: "keys",
    auth: "key",
    sign_in: true,
    sign_in_plan: "ChatGPT",
  },
  {
    id: "xai",
    label: "xAI",
    group: "featured",
    section: "keys",
    auth: "key",
    sign_in: true,
    sign_in_plan: "SuperGrok",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "featured",
    section: "gateways",
    auth: "key",
    sign_in: true,
  },
];
const found = (entries: Array<[string, ScanFound]>) => new Map(entries);
const labels = (
  engines: ReadonlyArray<EngineDescriptor>,
  scan: ReadonlyMap<string, ScanFound> | null,
  p = providers,
) => waysIn(engines, scan, p).map((w) => w.label);

const base = [
  engine("caveman", "Caveman"),
  engine("claude-agent", "Claude Agent"),
  engine("codex", "Codex"),
  engine("cursor", "Cursor"),
];

test("before a scan: Claude, ChatGPT through Codex, the Caveman sign-ins, and the key picker, no harness", () => {
  expect(labels(base, null, [])).toEqual([
    "Claude Pro or Max",
    "ChatGPT Plus or Pro",
    "An API key",
  ]);
  expect(waysIn(base, null, []).find((w) => w.label === "ChatGPT Plus or Pro")).toMatchObject({
    kind: "agent",
    engine: "codex",
    desc: "Runs Codex on your ChatGPT sign-in",
  });
  expect(labels(base, null)).toEqual([
    "Claude Pro or Max",
    "ChatGPT Plus or Pro",
    "GitHub Copilot",
    "SuperGrok",
    "OpenRouter",
    "An API key",
  ]);
});

test("a harness the scan found, not yet signed in, gets a row that opens its connect form; one it did not find gets none", () => {
  const rows = waysIn(base, found([["cursor", "signed_out"]]), providers);
  expect(rows.find((w) => w.label === "Cursor")).toMatchObject({
    kind: "agent",
    engine: "cursor",
    desc: "Found on this computer",
  });
  expect(labels(base, found([["cursor", "not_found"]]))).not.toContain("Cursor");
  // Turned on already: it is among the logins found, not a way in.
  expect(
    labels(
      [...base.slice(0, 3), engine("cursor", "Cursor", "signed_in")],
      found([["cursor", "ready"]]),
    ),
  ).not.toContain("Cursor");
});

test("with no codex, ChatGPT leads with the Caveman engine's own sign-in and the codex install line goes under it", () => {
  const rows = waysIn(
    base,
    found([
      ["codex", "not_found"],
      ["claude-agent", "signed_out"],
    ]),
    providers,
  );
  expect(rows.find((w) => w.label === "ChatGPT Plus or Pro")).toMatchObject({
    kind: "sign_in",
    provider: "openai",
    desc: "Runs the Caveman engine on your plan",
    installCodex: true,
  });
  // The runtime's own line says so too, before any scan.
  const missing = [
    engine("caveman", "Caveman"),
    engine(
      "codex",
      "Codex",
      "signed_out",
      "Codex CLI (`codex`) was not found. Install it with: npm install -g @openai/codex",
    ),
  ];
  expect(
    waysIn(missing, null, providers).find((w) => w.label === "ChatGPT Plus or Pro"),
  ).toMatchObject({ kind: "sign_in", installCodex: true });
});

test("a sign-in the Caveman engine does not offer is not a row", () => {
  expect(
    labels(
      base,
      null,
      providers.filter((p) => p.id !== "xai"),
    ),
  ).not.toContain("SuperGrok");
  // Without the Caveman engine there is nothing to sign in to or add a key to.
  expect(labels([engine("claude-agent", "Claude Agent")], null)).toEqual(["Claude Pro or Max"]);
});

test("a missing claude says to install it first", () => {
  expect(waysIn(base, found([["claude-agent", "not_found"]]), providers)[0]).toMatchObject({
    label: "Claude Pro or Max",
    desc: "Install claude, then sign in",
  });
});

test("cliMissing: the scan decides, else the runtime's line; only Claude Agent and Codex, only while not ready", () => {
  const claude = engine(
    "claude-agent",
    "Claude Agent",
    "signed_out",
    "Claude Agent CLI (`claude`) was not found on PATH.",
  );
  expect(cliMissing(claude)).toBe(true);
  expect(cliMissing(claude, "signed_out")).toBe(false);
  expect(cliMissing(engine("claude-agent", "Claude Agent", "signed_out"), "not_found")).toBe(true);
  expect(cliMissing(engine("claude-agent", "Claude Agent", "signed_in", "was not found"))).toBe(
    false,
  );
  expect(cliMissing(engine("cursor", "Cursor", "signed_out", "was not found"), "not_found")).toBe(
    false,
  );
  expect(cliMissing(undefined)).toBe(false);
});

test("a status line keeps its pointer to Settings where the page has no way to act on it", () => {
  const line = "Add a key or a sign-in in Settings > Models & keys to use the Caveman engine.";
  expect(setupHereMessage(line)).toBe("Add a key or a sign-in to use the Caveman engine.");
  expect(setupHereMessage(line, false)).toBe(line);
});

test("each computer gets one install command per engine, and npm's says it needs Node.js", () => {
  expect(claudeInstall("mac").command).toMatch(/^curl .*install\.sh \| bash$/);
  expect(claudeInstall("mac").command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(claudeInstall("linux").command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(claudeInstall("windows")).toMatchObject({
    command: "irm https://claude.ai/install.ps1 | iex",
    needs: "Run it in PowerShell.",
  });
  expect(claudeInstall("other")).toMatchObject({
    command: "npm install -g @anthropic-ai/claude-code@latest",
    needs: "Needs Node.js.",
  });
  expect(codexInstall("mac").command).toBe("npm install -g @openai/codex");
});

test("with codex missing, ChatGPT waits for the Caveman engine's answer, then shows once as its sign-in", () => {
  const missing = [
    engine("caveman", "Caveman"),
    engine(
      "codex",
      "Codex",
      "signed_out",
      "Codex CLI (`codex`) was not found. Install it with: npm install -g @openai/codex",
    ),
  ];
  // Still asking: no Codex row that would turn into a sign-in.
  expect(
    waysIn(missing, null, null).find((w) => w.label === "ChatGPT Plus or Pro"),
  ).toBeUndefined();
  expect(
    waysIn(missing, null, providers).find((w) => w.label === "ChatGPT Plus or Pro"),
  ).toMatchObject({
    kind: "sign_in",
    key: "openai",
  });
  // With codex here, Codex's row shows at once.
  expect(waysIn(base, null, null).find((w) => w.label === "ChatGPT Plus or Pro")).toMatchObject({
    kind: "agent",
    key: "codex",
  });
});
