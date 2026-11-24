// Getting started in a browser window with no computer behind it (shell/GettingStarted.tsx MacSteps): the download is a
// step on a Mac only. Any other computer has no such row, so nothing offers a Mac download it cannot use. Off a Mac with
// no Mac of theirs the card is the web app's own steps ("Getting started"); with a Mac signed in it keeps the Mac steps.
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import "../styles.css";
import {
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import { runtime } from "../state/sync/fakes.test-support.ts";
import { chatPlaces, macHere, webWindow } from "../state/sync/web-window.ts";
import type { RuntimeState } from "../state/sync/wire.ts";
import { GettingStarted } from "./GettingStarted.tsx";

const HOSTS = {
  mac: {
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    hint: { platform: "macOS" },
  },
  windows: {
    platform: "Win32",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    hint: { platform: "Windows" },
  },
} as const;

const KEYS = ["platform", "userAgent", "userAgentData", "maxTouchPoints"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
function host(os: keyof typeof HOSTS) {
  const h = HOSTS[os];
  const values = {
    platform: h.platform,
    userAgent: h.userAgent,
    userAgentData: h.hint,
    maxTouchPoints: 0,
  };
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, Object.getOwnPropertyDescriptor(navigator, k));
    Object.defineProperty(navigator, k, { get: () => values[k], configurable: true });
  }
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const k of KEYS) {
    const was = saved.get(k);
    if (was) Object.defineProperty(navigator, k, was);
    else delete (navigator as unknown as Record<string, unknown>)[k];
  }
  saved.clear();
  localStorage.clear();
});

const value = {
  status: "unconfigured",
  error: null,
  client: null,
  connection: 0,
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
} as unknown as RuntimeContextValue;

/** A Mac of the person's, signed in: `online` false is the app closed or asleep. */
const MAC_OF_THEIRS = (online: boolean): RuntimeState =>
  runtime("ada-mac", { kind: "laptop", name: "Ada's MacBook", online });

async function mount({
  title = "Connect your Mac",
  macs = [],
  width = 1000,
  height = 700,
  allowed = true,
}: {
  title?: string;
  macs?: RuntimeState[];
  width?: number;
  height?: number;
  allowed?: boolean;
} = {}) {
  await page.viewport(width, height);
  const runtimes = new Map(macs.map((r) => [r.runtime_id, r]));
  const web: WebWindowValue = {
    window: webWindow(true, { status: "live", ready: true, chats: { size: 0 } }),
    places: chatPlaces({ runtimes }, true),
    home: null,
    mac: macHere(
      { runtimes },
      () => undefined,
      () => allowed,
    ),
    usePlace: () => undefined,
  };
  const el = document.createElement("div");
  el.style.width = "280px";
  document.body.append(el);
  const root = createRoot(el);
  root.render(
    <RuntimeFixture value={value}>
      <WebWindowFixture value={web}>
        <TooltipProvider>
          <MemoryRouter>
            <GettingStarted />
          </MemoryRouter>
        </TooltipProvider>
      </WebWindowFixture>
    </RuntimeFixture>,
  );
  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  return () => {
    root.unmount();
    el.remove();
  };
}

test("on a Mac the first step is a button that opens the download, in three steps", async () => {
  host("mac");
  const done = await mount();
  await expect.element(page.getByText("0 of 3", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Download Caveman Code for Mac" }))
    .toBeVisible();
  done();
});

test("on any other computer with no Mac of theirs the card is the web app's own steps, and says nothing of a Mac", async () => {
  host("windows");
  const done = await mount({ title: "Getting started" });
  await expect.element(page.getByText("Start a chat in Cloud", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Connect your Mac")).not.toBeInTheDocument();
  await expect.element(page.getByText("Open it and turn on sync")).not.toBeInTheDocument();
  await expect.element(page.getByText("Allow this browser")).not.toBeInTheDocument();
  await expect.element(page.getByText(/Mac/)).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Download Caveman Code for Mac" }))
    .not.toBeInTheDocument();
  await page.viewport(1440, 900);
  await commands.saveProof("cav105-windows-nomac-after-1440");
  done();
  // A phone opens the card folded; the proof shows the steps.
  localStorage.setItem("caveman.macSteps", "open");
  const phone = await mount({ title: "Getting started", width: 390, height: 844 });
  await commands.saveProof("cav105-windows-nomac-after-390");
  phone();
});

test("on any other computer with a Mac of theirs signed in, the Mac steps stay, as that is true", async () => {
  host("windows");
  const done = await mount({ macs: [MAC_OF_THEIRS(true)], allowed: false });
  await expect.element(page.getByText("Open it and turn on sync")).toBeVisible();
  await expect.element(page.getByText("Allow this browser", { exact: true })).toBeVisible();
  // The Mac is signed in, so the first step shows ticked: the download is never offered to press here.
  await expect.element(page.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Download Caveman Code for Mac" }))
    .not.toBeInTheDocument();
  await page.viewport(1440, 900);
  await commands.saveProof("cav105-windows-withmac-after-1440");
  done();
  // A phone opens the card folded; the proof shows the steps.
  localStorage.setItem("caveman.macSteps", "open");
  const phone = await mount({
    macs: [MAC_OF_THEIRS(true)],
    allowed: false,
    width: 390,
    height: 844,
  });
  await commands.saveProof("cav105-windows-withmac-after-390");
  phone();
});

test("on a Mac the card is unchanged", async () => {
  host("mac");
  const done = await mount();
  await expect.element(page.getByText("0 of 3", { exact: true })).toBeVisible();
  await page.viewport(1440, 900);
  await commands.saveProof("cav105-mac-after-1440");
  done();
  // A phone opens the card folded; the proof shows the steps.
  localStorage.setItem("caveman.macSteps", "open");
  const phone = await mount({ width: 390, height: 844 });
  await commands.saveProof("cav105-mac-after-390");
  phone();
});
