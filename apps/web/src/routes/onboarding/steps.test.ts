import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SetupStep } from "./SetupStep.tsx";

const engine = (id: string, label: string, state: EngineDescriptor["auth"]["state"], accounts: Array<{ label: string; kind: "login" | "api_key" }> = []) =>
  ({ id, label, version: "1.0", auth: { state, accounts: accounts.map((a, i) => ({ id: `${id}:${i}`, active: i === 0, ...a })) } }) as unknown as EngineDescriptor;

const render = (engines: ReadonlyArray<EngineDescriptor>) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines, settings: null, refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(SetupStep, { onBack: () => undefined, onNext: () => undefined, onUnlock: () => undefined, plans: 0 }),
      ),
    ),
  );

test("lists the logins found, offers the engines without one, and Continue goes on", () => {
  const html = render([engine("caveman", "Caveman", "signed_out"), engine("claude-agent", "Claude Agent", "signed_in", [{ label: "Claude Max 20x Subscription", kind: "login" }])]);
  expect(html).toContain("Here&#x27;s what you already have");
  expect(html).toMatch(/Claude Max 20x.*Runs Claude Agent.*Ready/s);
  expect(html).toContain("Not found: Caveman");
  expect(html).toMatch(/New chats start on.*Claude Agent/s);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
});

test("Your setup never asks about Cloud, for a plan login that could run there or one that could not", () => {
  const claude = { ...engine("claude-agent", "Claude Agent", "signed_in", [{ label: "Claude Max 20x Subscription", kind: "login" }]) } as EngineDescriptor;
  // Its own login on this Mac (the id the runtime gives it), where a plan can be connected: it used to get the Cloud tick.
  const offered = { ...claude, auth: { ...claude.auth, everywhere: "available", accounts: [{ ...claude.auth.accounts[0]!, id: "claudeAgent:default" }] } } as EngineDescriptor;
  for (const html of [render([offered]), render([claude])]) {
    expect(html).not.toContain("Use them in Cloud too");
    expect(html).not.toContain("to approve Claude");
    expect(html).toContain("Each one runs on your own login.");
    expect(html).not.toMatch(/its own app and login|never copies/);
  }
});

test("with nothing found, it shows the ways in, Continue waits, and Set up later is the way past", () => {
  const html = render([engine("caveman", "Caveman", "signed_out"), engine("claude-agent", "Claude Agent", "signed_out"), engine("codex", "Codex", "signed_out")]);
  expect(html).toContain("Nothing to run on yet");
  expect(html).toContain("Claude Pro or Max");
  expect(html).toContain("ChatGPT Plus or Pro");
  expect(html).toContain("An API key");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
  expect(html).toContain("Set up later");
  // A plan is offered only from the account's own offer (offersUnlock); none is read here.
  expect(html).not.toContain("a month, with up to");
});

test("while an engine is still answering, nothing is offered yet", () => {
  const html = render([engine("claude-agent", "Claude Agent", "checking")]);
  expect(html).toContain("Looking around");
  expect(html).toContain("Checking Claude Agent");
  expect(html).not.toContain("Not found");
  expect(html).not.toContain("Claude Pro or Max");
});

test("sign-in opens on a new account: GitHub, Google, email behind its own button, the Terms line, and the way to sign in instead", async () => {
  const { SignInStep } = await import("./SignInStep.tsx");
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines: [], settings: null, refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(SignInStep, { onNext: () => undefined }),
      ),
    ),
  );
  expect(html).toContain("Create your account");
  expect(html).toContain("Continue with GitHub");
  expect(html).toContain("Continue with Google");
  expect(html).toContain("Continue with email");
  expect(html).not.toContain('type="email"');
  expect(html).toContain("Already have an account?");
  expect(html).toContain("By creating an account, you agree to the");
  expect(html).toContain('href="https://app.caveman.so/terms"');
  expect(html).toContain('href="https://app.caveman.so/privacy"');
});

test("the project step can be skipped, and says how the setup coming over is going", async () => {
  const { ProjectStep } = await import("./ProjectStep.tsx");
  // The chooser reads the desktop's folder picker off window; a browser has none.
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        {
          value: {
            client: null,
            engines: [],
            settings: null,
            projects: [],
            workspaces: [],
            // The chooser names the computer it adds to (AddProject reads it), as the real runtime context always has it.
            identity: { orgName: "Caveman Code", computerName: "This Mac", computerWord: "this Mac", computerOnline: true, userName: "You", plan: null },
            refresh: async () => undefined,
          } as unknown as RuntimeContextValue,
        },
        createElement(ProjectStep, { onBack: () => undefined, onDone: () => undefined, onUnlock: () => undefined, plans: 0, bringing: { state: "running", parts: ["20 MCP servers", "43 plugins"] } }),
      ),
    ),
  );
  expect(html).toContain("Pick a project");
  expect(html).toContain("Skip for now");
  expect(html).toContain("Bringing over 20 MCP servers and 43 plugins…");
  vi.unstubAllGlobals();
});

test("Continue on Your setup never says Saving while the setup comes over", () => {
  const html = render([engine("claude-agent", "Claude Agent", "signed_in", [{ label: "Claude Max 20x Subscription", kind: "login" }])]);
  expect(html).not.toContain("Saving…");
});

test("Back to Your setup while the setup comes over shows how it goes instead of offering it again", () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines: [engine("claude-agent", "Claude Agent", "signed_in", [{ label: "Claude Max", kind: "login" }])], settings: null, refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(SetupStep, { onBack: () => undefined, onNext: () => undefined, onUnlock: () => undefined, plans: 0, bringing: { state: "running", parts: ["43 plugins"] } }),
      ),
    ),
  );
  expect(html).toContain("Bringing over 43 plugins…");
  expect(html).not.toContain("Bring your setup");
});
