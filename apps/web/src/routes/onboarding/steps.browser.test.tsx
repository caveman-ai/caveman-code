// Your setup, in Chromium against the scripted runtime, with nothing signed in: the ways in each open in place. "An API
// key" shows a key field (the Caveman engine's own source picker), a harness engine.scan found shows its row, and a
// missing codex shows how to install it. docs/ "2. Your setup".
import type { EngineDescriptor, EngineProvider } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../../test/app.tsx";
import { ENGINE, runtimeFixture } from "../../../test/fixtures.ts";
import type { SessionPeer } from "../../../test/session-peer.ts";

const signedOut = (
  id: EngineDescriptor["id"],
  label: string,
  message?: string,
): EngineDescriptor => ({
  ...ENGINE,
  id,
  label,
  auth: { state: "signed_out", accounts: [], ...(message ? { message } : {}) },
});

const PROVIDERS: ReadonlyArray<EngineProvider> = [
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
    id: "anthropic",
    label: "Anthropic",
    group: "featured",
    section: "keys",
    auth: "key",
    key_url: "https://console.anthropic.com/settings/keys",
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
    id: "openrouter",
    label: "OpenRouter",
    group: "featured",
    section: "gateways",
    auth: "key",
    sign_in: true,
  },
  {
    id: "zai",
    label: "GLM Coding Plan",
    group: "featured",
    section: "plans",
    auth: "key",
    plan: true,
    key_label: "Z.ai API key",
  },
  {
    id: "ollama",
    label: "Ollama",
    group: "local",
    auth: "optional_key",
    base_url: "http://localhost:11434/v1",
  },
];

/** A first run on a computer with no chats and nothing signed in, stopped on Your setup. */
async function openSetup(
  over: {
    engines?: EngineDescriptor[];
    scan?: Array<{ engine: string; found: "ready" | "signed_out" | "not_found" }>;
    setup?: (peer: SessionPeer) => void;
  } = {},
) {
  const engines = over.engines ?? [
    signedOut("caveman", "Caveman"),
    signedOut("claude-agent", "Claude Agent"),
    signedOut("codex", "Codex"),
  ];
  const mounted = await mountApp(
    "/",
    runtimeFixture({ workspaces: [], engines }),
    { "caveman.firstRunDone": "0", "caveman.onboarding.step": "setup" },
    {
      setup: (peer) => {
        peer.on("engine.providers", (p) => ({
          providers:
            p.engine === "caveman"
              ? [...PROVIDERS]
              : [
                  {
                    id: "cursor",
                    label: "Cursor",
                    group: "featured",
                    auth: "cli",
                    key_label: "Cursor API key",
                  },
                ],
        }));
        peer.on("engine.scan", () => ({
          engines: (over.scan ?? []) as Array<{
            engine: never;
            found: "ready" | "signed_out" | "not_found";
          }>,
        }));
        over.setup?.(peer);
      },
    },
  );
  await expect
    .element(page.getByRole("heading", { level: 1, name: "Nothing to run on yet" }))
    .toBeVisible();
  return mounted;
}

test("Your setup scans this computer when it opens", async () => {
  const { peer } = await openSetup();
  await expect.poll(() => peer.callsOf("engine.scan").length).toBeGreaterThan(0);
});

test("An API key opens the Caveman engine's key field in place, and a key typed there is added to the Caveman engine", async () => {
  const added = Promise.withResolvers<Record<string, unknown>>();
  const { peer } = await openSetup({
    setup: (p) =>
      p.on("engine.account.add", (params) => {
        added.resolve(params as Record<string, unknown>);
        return { accounts: [] };
      }),
  });
  void peer;
  await userEvent.click(page.getByRole("button", { name: "Add key", exact: true }));
  const field = page.getByLabelText("Anthropic API key");
  await expect.element(field).toBeVisible();
  await userEvent.fill(field, ("sk-" + "ant-test-key"));
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  expect(await added.promise).toMatchObject({
    engine: "caveman",
    provider: "anthropic",
    key: ("sk-" + "ant-test-key"),
  });
});

test("An API key reaches every other provider, a coding plan and a local server through the picker", async () => {
  await openSetup();
  await userEvent.click(page.getByRole("button", { name: "Add key", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Another provider or server" }));
  await expect.element(page.getByRole("button", { name: "Ollama" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "GLM Coding Plan" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "OpenAI" }));
  await expect.element(page.getByLabelText("OpenAI API key")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Back to providers" }));
  await expect.element(page.getByLabelText("Search providers")).toBeVisible();
});

test("a Cursor the scan found on this computer shows a Cursor row, which opens Cursor's connect form", async () => {
  await openSetup({
    engines: [
      signedOut("caveman", "Caveman"),
      signedOut("claude-agent", "Claude Agent"),
      signedOut("codex", "Codex"),
      signedOut("cursor", "Cursor", "Connect Cursor in Settings > Models & keys."),
    ],
    scan: [{ engine: "cursor", found: "signed_out" }],
  });
  await expect.element(page.getByText("Found on this computer")).toBeVisible();
  const row = page.getByText("Cursor", { exact: true });
  await expect.element(row).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Sign in" }).nth(-1));
  await expect.element(page.getByLabelText("Cursor API key")).toBeVisible();
});

test("without a Cursor on the computer there is no Cursor row", async () => {
  await openSetup({
    engines: [
      signedOut("caveman", "Caveman"),
      signedOut("claude-agent", "Claude Agent"),
      signedOut("codex", "Codex"),
      signedOut("cursor", "Cursor"),
    ],
    scan: [{ engine: "cursor", found: "not_found" }],
  });
  await expect.element(page.getByText("An API key")).toBeVisible();
  await expect.element(page.getByText("Found on this computer")).not.toBeInTheDocument();
});

test("with no codex, ChatGPT signs in through the Caveman engine, and the codex install command shows with Copy and Check again", async () => {
  const signIn = Promise.withResolvers<Record<string, unknown>>();
  await openSetup({
    engines: [
      signedOut("caveman", "Caveman"),
      signedOut("claude-agent", "Claude Agent"),
      signedOut("codex", "Codex", "Codex CLI (`codex`) was not found."),
    ],
    scan: [{ engine: "codex", found: "not_found" }],
    setup: (p) =>
      p.on("engine.account.signin", (params) => {
        signIn.resolve(params as Record<string, unknown>);
        return { message: "Approve in your browser." } as never;
      }),
  });
  await expect.element(page.getByText("Runs the Caveman engine on your plan")).toBeVisible();
  await expect.element(page.getByText("npm install -g @openai/codex")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Sign in" }).nth(1));
  expect(await signIn.promise).toMatchObject({ engine: "caveman", provider: "openai" });
});

test("Check again scans once more, and says so when the codex command is still not on this computer", async () => {
  const { peer } = await openSetup({
    engines: [
      signedOut("caveman", "Caveman"),
      signedOut("claude-agent", "Claude Agent"),
      signedOut("codex", "Codex", "Codex CLI (`codex`) was not found."),
    ],
    scan: [{ engine: "codex", found: "not_found" }],
  });
  await expect.poll(() => peer.callsOf("engine.scan").length).toBeGreaterThan(0);
  const before = peer.callsOf("engine.scan").length;
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  await expect.element(page.getByText("Still not found on this computer.")).toBeVisible();
  expect(peer.callsOf("engine.scan").length).toBeGreaterThan(before);
});
