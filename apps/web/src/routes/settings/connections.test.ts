// Settings > Models & keys, "sign in once", clicked through as a person would: what each agent's row says and offers,
// a plan's sign-in (one click, no sheet; how it waits; who may cancel it), and the page with no Mac app behind it,
// which signs in to nothing and writes to Cloud on the person's own session.
import { button, click, deferred, mount, rendered, settle, type } from "./browser.fixture.ts";

import type { EngineAccount, EngineDescriptor } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { act, createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
// Radix's dialog needs more of a browser than linkedom has (focus scope, scroll lock); what is inside it is what runs.
vi.mock("@caveman-app/ui/components/dialog", async () => {
  const { createElement: h } = await import("react");
  const pass = (tag: string) => (p: { children?: unknown }) => h(tag, null, p.children as never);
  return {
    Dialog: (p: { open: boolean; children?: unknown }) =>
      p.open ? h("div", { role: "dialog" }, p.children as never) : null,
    DialogContent: pass("div"),
    DialogHeader: pass("div"),
    DialogFooter: pass("div"),
    DialogTitle: pass("h2"),
    DialogDescription: pass("p"),
  };
});

// A menu opens on a pointer press Radix reads from a real browser: here its items are plain buttons, always there.
vi.mock("@caveman-app/ui/components/dropdown-menu", async () => {
  const { createElement: h, Fragment } = await import("react");
  const pass = (p: { children?: unknown }) => h(Fragment, null, p.children as never);
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: (p: { children?: unknown; onSelect?: () => void }) =>
      h(
        "button",
        { type: "button", role: "menuitem", onClick: () => p.onSelect?.() },
        p.children as never,
      ),
  };
});

import { THIS_COMPUTER as HERE, thisComputer as here } from "../../lib/platform.ts";
import {
  ConnectionsCloudContext,
  RuntimeFixture,
  type RuntimeContextValue,
} from "../../state/runtime.tsx";
import type { CloudConnection, CloudConnections } from "../../state/sync/model-connections.ts";
import { EngineAccounts } from "../EngineAccounts.tsx";
import { CavemanProviders } from "./CavemanProviders.tsx";
import { forgetConnects, TOOK_TOO_LONG } from "./Connections.tsx";
import { agentStatus } from "./connections-model.ts";
import { AgentRow } from "./ModelsAndKeys.tsx";

const DAY = 24 * 3_600_000;
const soon = (days: number) => new Date(Date.now() + days * DAY - 60_000).toISOString();

/** An account of a runtime that is not signed in to Caveman: it says nothing about where. */
const plain = (id: string, a: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  label: "julius@example.com",
  kind: "login",
  active: true,
  ...a,
});
const own = (id: string, a: Partial<EngineAccount> = {}): EngineAccount =>
  plain(id, { where: "this_mac", ...a });
const connection = (
  id: string,
  c: Partial<NonNullable<EngineAccount["connection"]>> = {},
  a: Partial<EngineAccount> = {},
): EngineAccount => ({
  id: `connection:${id}`,
  label: "Claude plan",
  kind: "login",
  active: false,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", ...c },
  ...a,
});
const engineOf = (
  id: string,
  label: string,
  accounts: ReadonlyArray<EngineAccount>,
  auth: Partial<EngineDescriptor["auth"]> = {},
): EngineDescriptor =>
  ({
    id,
    label,
    capabilities: {},
    models: [],
    auth: { state: accounts.length > 0 ? "signed_in" : "signed_out", accounts, ...auth },
  }) as unknown as EngineDescriptor;
const claude = (
  accounts: ReadonlyArray<EngineAccount>,
  auth: Partial<EngineDescriptor["auth"]> = { everywhere: "available" },
) => engineOf("claude-agent", "Claude Agent", accounts, auth);
const codex = (
  accounts: ReadonlyArray<EngineAccount>,
  auth: Partial<EngineDescriptor["auth"]> = { everywhere: "available" },
) => engineOf("codex", "Codex", accounts, auth);

type Call = { readonly method: string; readonly params: Record<string, unknown> };
/** A runtime that records every call and answers each method as the test says. */
function runtime(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  let refreshed = 0;
  const client = {
    on: () => () => undefined,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params);
    },
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    refresh: async () => void refreshed++,
    settings: null,
    engines: [],
    workspaces: [],
  } as unknown as RuntimeContextValue;
  return {
    value,
    calls,
    refreshed: () => refreshed,
    sent: (method: string) =>
      calls
        .filter((c) => c.method === method)
        .map(({ params: { request_id: _, ...rest } }) => rest),
  };
}

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
  forgetConnects();
  vi.restoreAllMocks();
});

const show = async (
  element: ReactElement,
  value: RuntimeContextValue,
  cloud: CloudConnections | null = null,
) => {
  const wrap = (el: ReactElement) =>
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(ConnectionsCloudContext.Provider, { value: cloud }, el),
      }),
    );
  page = await mount(wrap(element));
  return { body: page.container, rerender: (next: ReactElement) => page!.rerender(wrap(next)) };
};
const rows = (engine: EngineDescriptor) => createElement(EngineAccounts, { engine, rows: true });
const agent = (engine: EngineDescriptor) => createElement(AgentRow, { engine });
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");
/** What can be pressed: a button by its words, or by its name where it is an icon. */
const buttons = (el: Element) =>
  [...el.querySelectorAll("button")].map(
    (b) => b.textContent?.trim() || b.getAttribute("aria-label"),
  );
const dialog = (el: Element) => el.querySelector<HTMLElement>('[role="dialog"]');
/** Submits the form a field is in, as Enter or its button does. */
const submit = async (field: Element) => {
  await act(
    async () =>
      void field
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle();
};
const refusal = (reason: string, message: string) =>
  new SessionProtocolError({ code: -32000, message, data: { reason } } as ConstructorParameters<
    typeof SessionProtocolError
  >[0]);

const CONNECTING = `Connecting… approve in the browser on ${here}`;
const requestOf = (rt: ReturnType<typeof runtime>, method: string) =>
  rt.calls.find((c) => c.method === method)?.params.request_id as string;

test("not signed in to Caveman: the rows say nothing about where, and offer nothing to connect", async () => {
  const engine = claude(
    [plain("claudeAgent:default"), plain("claude-account-1", { active: false, label: "Work" })],
    {},
  );
  const { body } = await show(rows(engine), runtime().value);
  expect(text(body)).not.toMatch(/Everywhere|Cloud|Claude plan|Turned off/);
  expect(text(body)).not.toContain(HERE);
  expect(buttons(body)).not.toContain("Use everywhere");
  // What can be done to a login is in its row's one menu: no "Use first", no second and third row about one sign-in.
  expect(buttons(body)).toEqual([
    "julius@example.com options",
    "Switch account",
    "Add another account",
    "Work options",
    "Add another account",
    "Move to top",
    "Remove",
  ]);
  expect(text(body)).not.toMatch(/Claude login|Another Claude login|Use first/);
});

test("a plan only this computer has: the agent's row says so, and Use everywhere goes straight to the browser, with no sheet", async () => {
  const approved = deferred<{ accounts: EngineAccount[] }>();
  const rt = runtime({
    "engine.account.add": () => ({
      accounts: [],
      sign_in: { command: "", message: "", url: "https://claude.ai/oauth/authorize?x=1" },
    }),
    "engine.account.complete": () => approved.promise,
  });
  const { body } = await show(agent(claude([own("claudeAgent:default")])), rt.value);
  expect(text(body)).toContain(`Claude Agent${HERE} only`);
  expect(buttons(body)).toEqual(["Claude Agent", "Use everywhere"]);
  await click(button(body, "Use everywhere"));
  // One click: the runtime was asked at once and nothing was confirmed first. The one field is for a code Claude's
  // page shows when it cannot hand the sign-in back; approving in the tab claude opened needs nothing typed.
  expect(dialog(body)).toBeNull();
  expect(rt.sent("engine.account.add")).toEqual([{ engine: "claude-agent", everywhere: true }]);
  expect([...body.querySelectorAll("input")].map((i) => i.getAttribute("aria-label"))).toEqual([
    "Code from the sign-in page",
  ]);
  // The wait is the row's status, and the page stays a link for a browser that did not open by itself.
  expect(body.querySelector('[role="status"]')?.textContent).toContain(CONNECTING);
  const link = body.querySelector("a")!;
  expect([
    link.getAttribute("href"),
    link.textContent,
    link.getAttribute("target"),
    link.getAttribute("rel"),
  ]).toEqual([
    "https://claude.ai/oauth/authorize?x=1",
    "Open the sign-in page",
    "_blank",
    "noopener noreferrer",
  ]);
  // Its link takes the app's own focus ring, never the browser's.
  expect(link.className).toContain("focus-visible:ring-2 focus-visible:ring-ring");
  expect(buttons(body)).toEqual(["Claude Agent", "Finish", "Cancel"]);
  expect(rendered(button(body, "Finish")).disabled).toBe(true);
  expect(rt.sent("engine.account.complete")).toEqual([
    { engine: "claude-agent", account_id: "connecting", callback_url: "" },
  ]);
  approved.resolve({ accounts: [] });
  await settle();
  await settle();
  expect(body.querySelector('[role="status"]')).toBeNull();
  expect(body.querySelector("input")).toBeNull();
  expect(rt.refreshed()).toBeGreaterThan(0);
  // Connected: nothing was given up.
  expect(rt.sent("engine.account.remove")).toEqual([]);
});

test("Claude's page shows a code: pasted under the line it finishes the sign-in, and one the runtime refuses says why while it keeps waiting", async () => {
  const NOT_THE_CODE =
    "That is not the code the sign-in page shows. Copy the whole code and paste it again.";
  const approved = deferred<{ accounts: EngineAccount[] }>();
  const rt = runtime({
    "engine.account.add": () => ({
      accounts: [],
      // What `claude setup-token` prints for a browser that did not open: its page ends on a code, not on this Mac.
      sign_in: {
        command: "",
        message: "",
        url: "https://claude.com/cai/oauth/authorize?code=true",
      },
    }),
    "engine.account.complete": (p) => {
      if (p.callback_url === "") return approved.promise;
      if (!String(p.callback_url).includes("#")) throw refusal("invalid_params", NOT_THE_CODE);
      // The CLI took it: the sign-in's own wait hears it end.
      approved.resolve({ accounts: [] });
      return { accounts: [] };
    },
  });
  const { body } = await show(agent(claude([own("claudeAgent:default")])), rt.value);
  await click(button(body, "Use everywhere"));
  const field = body.querySelector<HTMLInputElement>(
    'input[aria-label="Code from the sign-in page"]',
  )!;
  expect(field.getAttribute("placeholder")).toBe("Page shows a code? Paste it here");
  // Kept from password managers, like the old card's code field.
  expect([rendered(field).autoComplete, rendered(field)["data-1p-ignore"]]).toEqual(["off", true]);
  await type(field, "half-a-code");
  await click(button(body, "Finish"));
  expect(body.querySelector('[role="alert"]')?.textContent).toBe(NOT_THE_CODE);
  // The field never keeps what was pasted, and the sign-in is still open.
  expect(rendered(field).value).toBe("");
  expect(text(body)).toContain(CONNECTING);
  // Enter sends it, as Finish does.
  await type(field, " abcDEF123456#state-7890 ");
  await act(async () => {
    // linkedom has no KeyboardEvent: a plain event with the key React reads.
    const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    field.dispatchEvent(enter);
  });
  await settle();
  await settle();
  expect(rt.sent("engine.account.complete")).toEqual([
    { engine: "claude-agent", account_id: "connecting", callback_url: "" },
    { engine: "claude-agent", account_id: "connecting", callback_url: "half-a-code" },
    { engine: "claude-agent", account_id: "connecting", callback_url: "abcDEF123456#state-7890" },
  ]);
  // Connected: the line and its field are gone, with nothing given up.
  expect(body.querySelector('[role="status"]')).toBeNull();
  expect(body.querySelector("input")).toBeNull();
  expect(rt.sent("engine.account.remove")).toEqual([]);
});

test("a pasted code claude does not take says why, never 'Signing in…' and back: the line links to the page claude started over on", async () => {
  const OLD_PAGE = "https://claude.com/cai/oauth/authorize?code=true&state=first";
  const NEW_PAGE = "https://claude.com/cai/oauth/authorize?code=true&state=again";
  // claude 2.1.322's own words for a code it did not take.
  const SAID =
    "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";
  const answers: Array<Record<string, unknown>> = [
    { accounts: [], waiting: true, refused: SAID, url: NEW_PAGE },
    // An older runtime, or a claude that said nothing while the wait lasted.
    { accounts: [], waiting: true },
  ];
  const rt = runtime({
    "engine.account.add": () => ({
      accounts: [],
      sign_in: { command: "", message: "", url: OLD_PAGE },
    }),
    "engine.account.complete": (p) =>
      p.callback_url === "" ? new Promise(() => undefined) : answers.shift(),
  });
  const { body } = await show(agent(claude([own("claudeAgent:default")])), rt.value);
  await click(button(body, "Use everywhere"));
  const field = body.querySelector<HTMLInputElement>(
    'input[aria-label="Code from the sign-in page"]',
  )!;
  const alert = () => body.querySelector('[role="alert"]')?.textContent;
  const page = () => body.querySelector("a")?.getAttribute("href");
  expect(page()).toBe(OLD_PAGE);
  await type(field, "abcdefgh#first-try");
  await click(button(body, "Finish"));
  expect(alert()).toBe(SAID);
  // The page before cannot give a code claude takes now: the link is the new page.
  expect(page()).toBe(NEW_PAGE);
  // Still open and waiting for a code, with nothing kept in the field.
  expect(text(body)).toContain(CONNECTING);
  expect(rendered(field).value).toBe("");
  expect(buttons(body)).toEqual(["Claude Agent", "Finish", "Cancel"]);
  await type(field, "abcdefgh#second-try");
  await click(button(body, "Finish"));
  expect(alert()).toBe(
    "Claude didn't take that code. Copy it again from the page you just signed in on.",
  );
  expect(page()).toBe(NEW_PAGE);
  expect(text(body)).toContain(CONNECTING);
});

test("while the person has not approved yet the row asks again, and a sign-in that ended says why on the row", async () => {
  expect(TOOK_TOO_LONG).toBe("The sign-in was not approved in time.");
  // Each wait the runtime answers takes as long as its own wait does.
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let waits = 0;
  const rt = runtime({
    "engine.account.add": () => ({ accounts: [], sign_in: { command: "", message: "" } }),
    "engine.account.complete": () => {
      clock += 45_000;
      waits += 1;
      if (waits < 3) return { accounts: [], waiting: true };
      throw refusal("invalid_state", "Claude closed the sign-in before it was approved.");
    },
  });
  const { body } = await show(agent(claude([own("claudeAgent:default")])), rt.value);
  await click(button(body, "Use everywhere"));
  await settle();
  await settle();
  expect(waits).toBe(3);
  expect(body.querySelector('[role="alert"]')?.textContent).toBe(
    "Claude closed the sign-in before it was approved.",
  );
  expect(buttons(body)).toEqual(["Claude Agent", "Try again"]);
  // No page was given: no link to a page that is not there.
  expect(body.querySelector("a")).toBeNull();
});

test("only Cancel ends a sign-in, and only the one this window started: leaving the page ends nothing", async () => {
  const rt = runtime({
    "engine.account.add": () => ({
      accounts: [],
      sign_in: { command: "", message: "", url: "https://claude.ai/oauth/authorize" },
    }),
    "engine.account.complete": () => new Promise(() => undefined),
    "engine.account.remove": () => ({ accounts: [] }),
  });
  const first = await show(agent(claude([own("claudeAgent:default")])), rt.value);
  await click(button(first.body, "Use everywhere"));
  const started = requestOf(rt, "engine.account.add");
  // The page is left while it waits (another section, Escape, the window's tab closed): the sign-in carries on.
  await page!.unmount();
  expect(rt.sent("engine.account.remove")).toEqual([]);
  // Back on the page, it is still this window's own: Cancel names the request that started it.
  const back = await show(
    agent(
      claude([own("claudeAgent:default")], {
        everywhere: "available",
        connecting: { request_id: started, since: new Date().toISOString() },
      }),
    ),
    rt.value,
  );
  expect(text(back.body)).toContain(CONNECTING);
  await click(button(back.body, "Cancel"));
  expect(rt.sent("engine.account.remove")).toEqual([
    { engine: "claude-agent", account_id: `connecting:${started}` },
  ]);
  expect(buttons(back.body)).not.toContain("Cancel");
});

test("a second window sees the wait and cannot end it: no Cancel, no link, and its buttons start nothing", async () => {
  const rt = runtime();
  const { body } = await show(
    agent(
      claude([own("claudeAgent:default")], {
        everywhere: "available",
        connecting: {
          request_id: "another-window",
          since: new Date(Date.now() - 8_000).toISOString(),
        },
      }),
    ),
    rt.value,
  );
  expect(body.querySelector('[role="status"]')?.textContent).toContain(CONNECTING);
  // How long it has waited, from the runtime's own clock.
  expect(body.querySelector(".tabular-nums")?.textContent).toMatch(/^[789]s$/);
  expect(buttons(body)).toEqual(["Claude Agent"]);
  expect(body.querySelector("a")).toBeNull();
  expect(rt.calls).toEqual([]);
});

test("ChatGPT: the same one click, and a code can stand in for the browser", async () => {
  const rt = runtime({
    "engine.account.add": (p) => ({
      accounts: [],
      sign_in: p.device_code
        ? {
            command: "",
            message: "",
            url: "https://auth.openai.com/codex/device",
            code: "ABCD-1234",
          }
        : { command: "", message: "", url: "https://auth.openai.com/oauth/authorize" },
    }),
    "engine.account.complete": () => new Promise(() => undefined),
    "engine.account.remove": () => ({ accounts: [] }),
  });
  const { body } = await show(agent(codex([own("codex-account-chatgpt")])), rt.value);
  await click(button(body, "Use everywhere"));
  expect(rt.sent("engine.account.add")).toEqual([
    { engine: "codex", everywhere: true, chatgpt: true },
  ]);
  const first = requestOf(rt, "engine.account.add");
  await click(button(body, "Use a code instead"));
  await settle();
  // Its own sign-in is started over with a code, in one call that names it: nothing is cancelled first.
  expect(rt.sent("engine.account.remove")).toEqual([]);
  expect(rt.sent("engine.account.add")).toEqual([
    { engine: "codex", everywhere: true, chatgpt: true },
    { engine: "codex", everywhere: true, chatgpt: true, device_code: true, connecting: first },
  ]);
  expect(body.querySelector('[role="status"]')?.textContent).toContain(
    "Enter ABCD-1234 on the sign-in page.",
  );
  expect(body.querySelector("a")?.getAttribute("href")).toBe(
    "https://auth.openai.com/codex/device",
  );
  expect(buttons(body)).not.toContain("Use a code instead");
});

test("an agent with nothing to run on signs in once, in the browser, from its own row", async () => {
  const rt = runtime({
    "engine.account.add": () => ({ accounts: [], sign_in: { command: "", message: "" } }),
    "engine.account.complete": () => new Promise(() => undefined),
  });
  const { body } = await show(
    agent(codex([], { everywhere: "available", state: "signed_out" })),
    rt.value,
  );
  expect(text(body)).toContain("CodexNot signed in");
  await click(button(body, "Sign in"));
  expect(rt.sent("engine.account.add")).toEqual([
    { engine: "codex", everywhere: true, chatgpt: true },
  ]);
});

test("connected everywhere: the open row lists plans and keys first, in the order they are tried, each with where it works", async () => {
  const rt = runtime({
    "engine.account.activate": () => ({ accounts: [] }),
    "engine.account.remove": () => ({ accounts: [] }),
  });
  const accounts = [
    connection("c1", {}, { active: true }),
    connection("k1", { kind: "api_key" }, { label: "Anthropic key", kind: "api_key" }),
    own("claudeAgent:default", { active: false }),
  ];
  const { body } = await show(rows(claude(accounts)), rt.value);
  const said = text(body);
  expect(said.indexOf("Claude plan")).toBeLessThan(said.indexOf("Anthropic key"));
  expect(said.indexOf("Anthropic key")).toBeLessThan(said.indexOf("julius@example.com"));
  expect(said).toContain("Claude planEverywhere");
  expect(said).toContain(`julius@example.com${HERE} only`);
  // "Ready" is never said, and nothing is "Use first": the order is changed by dragging, or from a row's menu.
  expect(said).not.toMatch(/Ready|Use first/);
  expect(body.querySelectorAll('[draggable="true"]').length).toBe(2);
  expect(buttons(body)).toEqual([
    "Claude plan options",
    "Remove…",
    "Anthropic key options",
    "Move to top",
    "Remove…",
    "julius@example.com options",
    "Switch account",
    "Add another account",
  ]);
  await click(button(body, "Move to top"));
  expect(rt.sent("engine.account.activate")).toEqual([
    { engine: "claude-agent", account_id: "connection:k1" },
  ]);
  // Removing a plan reaches every place it runs: that is asked first, in the one confirmation every screen uses.
  await click(
    buttons(body).indexOf("Remove…") >= 0
      ? [...body.querySelectorAll("button")].find((b) => b.textContent === "Remove…")!
      : body,
  );
  const sheet = dialog(body)!;
  expect(text(sheet)).toContain("Remove Claude plan everywhere?");
  expect(text(sheet)).toContain(`It stops running chats on ${here} and in Cloud.`);
  expect(buttons(sheet)).toEqual(["Cancel", "Remove everywhere"]);
  await click(button(sheet, "Remove everywhere"));
  expect(rt.sent("engine.account.remove")).toEqual([
    { engine: "claude-agent", account_id: "connection:c1" },
  ]);
});

test("used up, expiring, expired, turned off: each row says its state, and a plan that ends is reconnected from its menu", async () => {
  const approved = deferred<{ accounts: EngineAccount[] }>();
  const rt = runtime({
    "engine.account.add": () => ({ accounts: [], sign_in: { command: "", message: "" } }),
    "engine.account.complete": () => approved.promise,
    "engine.account.remove": () => ({ accounts: [] }),
  });
  const accounts = [
    connection("u", { status: "used_up" }, { label: "Used plan" }),
    connection("e", { expires_at: soon(5) }, { label: "Ending plan" }),
    connection("x", { status: "expired" }, { label: "Ended plan" }),
    connection("o", { off: true }, { label: "Off plan" }),
  ];
  const { body } = await show(
    rows(claude(accounts, { everywhere: "available", state: "signed_out" })),
    rt.value,
  );
  const said = text(body);
  expect(said).toContain("Used planEverywhere · Used up");
  expect(said).toContain("Ending planEverywhere · Expires in 5 days");
  expect(said).toContain("Ended planEverywhere · Expired");
  // A kind the admin turned off works nowhere: the row says only that.
  expect(said).toContain("Off planTurned off by your admin");
  expect(said).not.toContain("Everywhere · Turned off");
  expect(buttons(body).filter((b) => b === "Reconnect").length).toBe(2);
  // Reconnect is the same sign-in, at the click; the plan connected again takes the place of the one that ended.
  await click(
    [...body.querySelectorAll("button")].filter((b) => b.textContent === "Reconnect")[1]!,
  );
  expect(rt.sent("engine.account.add")).toEqual([{ engine: "claude-agent", everywhere: true }]);
  approved.resolve({ accounts: [] });
  await settle();
  await settle();
  expect(rt.sent("engine.account.remove")).toEqual([
    { engine: "claude-agent", account_id: "connection:x" },
  ]);
});

test("an agent's closed row says what needs the person and what runs now, and reconnects in one click", async () => {
  const rt = runtime({
    "engine.account.add": () => ({ accounts: [], sign_in: { command: "", message: "" } }),
    "engine.account.complete": () => new Promise(() => undefined),
  });
  const tonight = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const used = await show(
    agent(
      claude([
        connection("u", { status: "used_up", used_up_until: tonight }),
        connection(
          "k",
          { kind: "api_key" },
          { label: "Anthropic key", kind: "api_key", active: true },
        ),
      ]),
    ),
    rt.value,
  );
  expect(text(used.body)).toMatch(/Claude AgentUsed up until .+ · now on your Anthropic key/);
  expect(text(used.body)).not.toMatch(/Ready|and 1 more/);
  // Nothing to press: the row only opens.
  expect(buttons(used.body)).toEqual(["Claude Agent", "Open Claude Agent"]);
  await page!.unmount();
  const ended = connection("x", { status: "expired" });
  const { body } = await show(agent(claude([ended, own("claudeAgent:default")])), rt.value);
  expect(text(body)).toContain(`Claude AgentExpired · now on ${here}'s login`);
  expect(buttons(body)).toEqual(["Claude Agent", "Reconnect"]);
  await click(button(body, "Reconnect"));
  expect(dialog(body)).toBeNull();
  expect(rt.sent("engine.account.add")).toEqual([{ engine: "claude-agent", everywhere: true }]);
});

function cloudOf(start: ReadonlyArray<CloudConnection>) {
  let connections = [...start];
  const asked: Array<[string, string]> = [];
  const list = async () => ({ connections, kinds: {} });
  const api: CloudConnections = {
    list,
    addClaudePlan: async (token) => {
      asked.push(["add", token]);
      connections = [
        ...connections,
        {
          id: "new",
          kind: "claude_plan",
          provider: "anthropic",
          label: "",
          position: connections.length,
          status: "ready",
          serves: ["claude-agent"],
        },
      ];
      return list();
    },
    moveToTop: async (id) => {
      asked.push(["first", id]);
      connections = [
        connections.find((c) => c.id === id)!,
        ...connections.filter((c) => c.id !== id),
      ].map((c, position) => ({ ...c, position }));
      return list();
    },
    remove: async (id) => {
      asked.push(["remove", id]);
      connections = connections.filter((c) => c.id !== id);
      return list();
    },
  };
  return { api, asked };
}
const THERE = { everywhere: "manage", no_sign_in_here: true } as const;

test("with no Mac app behind the page: the Mac app is where a plan is connected, and the token is asked only under No Mac?", async () => {
  const rt = runtime();
  const cloud = cloudOf([]);
  const closed = await show(
    agent(claude([], { ...THERE, state: "signed_out" })),
    rt.value,
    cloud.api,
  );
  // The agent's status is the sentence: no "Set up" that opens onto one.
  expect(text(closed.body)).toContain("Claude AgentNot signed in · connect from the desktop app");
  expect(buttons(closed.body)).toEqual(["Claude Agent", "Open Claude Agent"]);
  await page!.unmount();
  const { body } = await show(
    rows(claude([], { ...THERE, state: "signed_out" })),
    rt.value,
    cloud.api,
  );
  expect(text(body)).toContain("Claude planConnect from the desktop app");
  expect(body.querySelector("input")).toBeNull();
  expect(buttons(body)).toEqual(["No Mac?"]);
  await click(button(body, "No Mac?"));
  expect(text(body)).toContain("Run claude setup-token on any computer and paste the token here.");
  expect(body.querySelector("code")?.textContent).toBe("claude setup-token");
  const field = body.querySelector('input[aria-label="Claude plan token"]') as HTMLInputElement;
  expect(field.getAttribute("type")).toBe("password");
  await type(field, "  the-pasted-token  ");
  await submit(field);
  // Cloud took it, trimmed, and the runtime was asked nothing (it refuses every write there).
  expect(cloud.asked).toEqual([["add", "the-pasted-token"]]);
  expect(rt.calls).toEqual([]);
  expect(body.innerHTML).not.toContain("the-pasted-token");
  // Cloud's answer shows at once; the plan is connected, so its token is asked for no more.
  expect(text(body)).toContain("Claude planEverywhere");
  expect(body.querySelector('input[aria-label="Claude plan token"]')).toBeNull();
  expect(rt.refreshed()).toBeGreaterThan(0);
});

test("a token Cloud refuses is said in Cloud's words, and the field is empty again", async () => {
  const cloud = cloudOf([]);
  cloud.api.addClaudePlan = async () =>
    Promise.reject(new Error("Anthropic did not accept that token."));
  const { body } = await show(
    rows(claude([], { ...THERE, state: "signed_out" })),
    runtime().value,
    cloud.api,
  );
  await click(button(body, "No Mac?"));
  const field = body.querySelector('input[aria-label="Claude plan token"]') as HTMLInputElement;
  await type(field, "the-pasted-token");
  await submit(field);
  expect(body.querySelector('[role="alert"]')?.textContent).toContain(
    "Anthropic did not accept that token.",
  );
  expect(rendered(body.querySelector('input[aria-label="Claude plan token"]')!).value).toBe("");
  expect(body.innerHTML).not.toContain("the-pasted-token");
});

test("with no Mac app but the person's Cloud session: the order and a removal go to Cloud, and ChatGPT says where it connects with nothing to press", async () => {
  const rt = runtime();
  const cloud = cloudOf([
    {
      id: "c1",
      kind: "claude_plan",
      provider: "anthropic",
      label: "",
      position: 0,
      status: "ready",
      serves: ["claude-agent"],
    },
    {
      id: "k1",
      kind: "api_key",
      provider: "anthropic",
      label: "",
      position: 1,
      status: "ready",
      serves: ["claude-agent"],
    },
  ]);
  const accounts = [
    connection("c1", {}, { active: true }),
    connection("k1", { kind: "api_key" }, { label: "Anthropic key", kind: "api_key" }),
  ];
  const { body } = await show(rows(claude(accounts, THERE)), rt.value, cloud.api);
  expect(buttons(body)).toEqual([
    "Claude plan options",
    "Remove…",
    "Anthropic key options",
    "Move to top",
    "Remove…",
  ]);
  await click(button(body, "Move to top"));
  expect(cloud.asked).toEqual([["first", "k1"]]);
  // Cloud's order shows at once, under the names the runtime gave.
  expect(text(body).indexOf("Anthropic key")).toBeLessThan(text(body).indexOf("Claude plan"));
  await click([...body.querySelectorAll("button")].filter((b) => b.textContent === "Remove…")[1]!);
  await click(button(dialog(body)!, "Remove everywhere"));
  expect(cloud.asked).toEqual([
    ["first", "k1"],
    ["remove", "c1"],
  ]);
  expect(rt.calls).toEqual([]);
  await page!.unmount();
  const chatgpt = await show(
    rows(codex([], { ...THERE, state: "signed_out" })),
    rt.value,
    cloud.api,
  );
  // With nothing to run on, the agent's own row says "Not signed in · connect from the desktop app": said once, so no row here.
  expect(text(chatgpt.body)).not.toContain("Connect from the desktop app");
  expect(agentStatus(codex([], { ...THERE, state: "signed_out" }), Date.now()).text).toBe(
    "Not signed in · connect from the desktop app",
  );
  expect(buttons(chatgpt.body)).toEqual([]);
});

test("with no Mac app and no Cloud session on this device: the rows are read-only, and nothing that would be refused is offered", async () => {
  const rt = runtime();
  const { body } = await show(
    rows(claude([connection("c1", { status: "expired" })], THERE)),
    rt.value,
    null,
  );
  expect(text(body)).toContain("Everywhere · Expired");
  // Where it is connected again is the agent's own status, said once: no second row for the same plan.
  expect(text(body)).not.toContain("from the desktop app");
  expect(
    agentStatus(claude([connection("c1", { status: "expired" })], THERE), Date.now()).text,
  ).toBe("Expired · reconnect from the desktop app");
  expect(buttons(body)).toEqual([]);
  expect(body.querySelector("input")).toBeNull();
});

test("the Caveman agent: a key that works in Cloud is a row of its own, and a Cloud computer offers no key field", async () => {
  const caveman = (
    accounts: ReadonlyArray<EngineAccount>,
    auth: Partial<EngineDescriptor["auth"]> = {},
  ) => engineOf("caveman", "Caveman", accounts, auth);
  const key = connection(
    "k1",
    { kind: "api_key" },
    { label: "Anthropic key", kind: "api_key", where: "cloud" },
  );
  const rt = runtime({ "engine.providers": () => ({ providers: [] }) });
  const mac = await show(
    createElement(CavemanProviders, {
      engine: caveman([
        key,
        own("caveman:openai", { label: "OpenAI API key ...4f2a", kind: "api_key" }),
      ]),
    }),
    rt.value,
  );
  expect(text(mac.body)).toContain("Anthropic keyCloud");
  expect(text(mac.body)).not.toMatch(/Cloud computers|Ready/);
  // This computer's own key is managed where it always was.
  expect(buttons(mac.body)).toEqual(["Anthropic key options", "Remove…", "Manage", "Add"]);
  await page!.unmount();
  const there = await show(
    createElement(CavemanProviders, { engine: caveman([key], { no_sign_in_here: true }) }),
    rt.value,
    null,
  );
  expect(text(there.body)).toContain("Anthropic key");
  expect(buttons(there.body)).toEqual([]);
  await page!.unmount();
  // Nothing connected for it there: no card that offers what the computer cannot take.
  const none = await show(
    createElement(CavemanProviders, {
      engine: caveman([], { no_sign_in_here: true, state: "signed_out" }),
    }),
    rt.value,
    null,
  );
  expect(none.body.innerHTML).toBe("");
  page = undefined;
});
