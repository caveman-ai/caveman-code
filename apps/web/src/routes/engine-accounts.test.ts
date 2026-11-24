import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../panes/drag.ts", () => ({}));
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import { EngineAccounts, HarnessField, SignInSteps } from "./EngineAccounts.tsx";
import { CursorKeychainUsage } from "./settings/Usage.tsx";

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeContext.Provider, { value: { client: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, element),
    ),
  );

test("a sign-in's message shows on its own: Antigravity's download note is never dropped", () => {
  const html = render(createElement(SignInSteps, { steps: { command: "", message: "Downloading Google's Antigravity runtime." } }));
  expect(html).toContain("Downloading Google&#x27;s Antigravity runtime.");
  expect(html).not.toContain("<code");
});

test("a sign-in page is a link, never a window opened after a wait, with a field for its redirect", () => {
  const html = render(createElement(SignInSteps, { steps: { url: "https://cursor.com/loginDeepControl?x=1", engine: "cursor", account: "cursor" } }));
  expect(html).toMatch(/<a href="https:\/\/cursor.com\/loginDeepControl\?x=1" target="_blank" rel="noopener noreferrer"/);
  expect(html).toContain('aria-label="Address the sign-in page ended on"');
  // Without an account to finish there is nothing to paste into.
  expect(render(createElement(SignInSteps, { steps: { url: "https://example.test/" } }))).not.toContain("Address the sign-in page ended on");
});

test("a signed-out harness account has a Sign in on its row; a signed-in one does not", () => {
  const engine = {
    id: "cursor",
    label: "Cursor",
    capabilities: {},
    models: [],
    auth: {
      state: "signed_out",
      accounts: [
        { id: "cursor", label: "Cursor", kind: "login", active: true, health: { state: "failing", message: "Signed out.", checked_at: "" } },
        { id: "cursor-account-1", label: "Work", kind: "login", active: false },
      ],
    },
  } as unknown as EngineDescriptor;
  const html = render(createElement(EngineAccounts, { engine }));
  expect(html.match(/>Sign in<\/button>/g)).toHaveLength(1);
});

test("a setting with choices is a select, not free text", () => {
  const field = { name: "authMethod", label: "Sign-in method", optional: true, options: [{ value: "oauth-personal", label: "Google account" }] };
  const html = render(createElement(HarnessField, { field, value: "", onChange: () => undefined }));
  expect(html).toContain('aria-label="Sign-in method"');
  expect(html).not.toContain("<input");
  expect(render(createElement(HarnessField, { field: { name: "binaryPath", label: "Binary path", optional: true }, value: "", onChange: () => undefined }))).toContain("<input");
});

test("Settings > Usage offers Cursor's Keychain switch on a Mac runtime once Cursor is connected", () => {
  const cursor = { id: "cursor", label: "Cursor", auth: { state: "signed_in", accounts: [{ id: "cursor", label: "Cursor", kind: "login", active: true }] } } as unknown as EngineDescriptor;
  const usage = (settings: object | null, engines: ReadonlyArray<EngineDescriptor>) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeContext.Provider, { value: { client: null, engines, settings, workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, createElement(CursorKeychainUsage)),
      ),
    );
  expect(usage({ cursor_keychain_usage: false }, [cursor])).toContain("Show Cursor&#x27;s plan limits");
  expect(usage({ cursor_keychain_usage: true }, [cursor])).toContain('aria-checked="true"');
  // Not a Mac (the runtime reports no such setting), or no Cursor account: nothing to switch.
  expect(usage({}, [cursor])).toBe("");
  expect(usage({ cursor_keychain_usage: false }, [])).toBe("");
});
