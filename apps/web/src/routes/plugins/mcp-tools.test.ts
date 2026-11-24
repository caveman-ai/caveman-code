// A plugin's server page (Plugins > Installed): "List its tools" on a server a plugin brings asks the runtime's hub for that plugin's server
// by the plugin's id and the server's own name (mcp.tools), never by a key the page builds, which the runtime reads as
// one of the person's own servers.
import { button, click, mount, settle } from "../settings/browser.fixture.ts";

import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { PluginsDataProvider } from "./data.tsx";
import { ServerPage } from "./ServerPage.tsx";

// The page's frame scrolls to its top and measures its width (ListFrame Page); linkedom does neither.
const proto = Object.getPrototypeOf(document.createElement("main")) as { scrollTo?: unknown };
proto.scrollTo ??= () => undefined;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

test("List its tools on a plugin's server asks for that plugin's server by its id and the server's name", async () => {
  const asked: unknown[] = [];
  const acme = {
    id: "acme@bird",
    name: "acme",
    enabled: true,
    installed: true,
    mcp_servers: ["api"],
    interface: {},
    scope: "me",
  };
  const client = {
    on: () => () => undefined,
    call: (method: string, params: unknown) => {
      if (method === "mcp.list") return Promise.resolve({ servers: [] });
      if (method === "plugin.list") return Promise.resolve({ plugins: [acme] });
      if (method === "marketplace.list") return Promise.resolve({ marketplaces: [] });
      if (method === "mcp.tools") {
        asked.push(params);
        return Promise.resolve({ tools: [{ name: "theirs" }], idle_tokens_estimate: 12 });
      }
      return new Promise(() => undefined);
    },
  };
  const value = {
    client,
    connection: 1,
    status: "connected",
    projects: [],
    workspaces: [],
    engines: [],
    settings: null,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        TooltipProvider,
        null,
        createElement(RuntimeFixture, {
          value,
          children: createElement(
            PluginsDataProvider,
            null,
            createElement(ServerPage, { name: "api", pluginId: "acme@bird" }),
          ),
        }),
      ),
    ),
  );
  await settle();
  await click(button(document.body, "List its tools"));
  expect(asked).toEqual([{ plugin: "acme@bird", server: "api" }]);
  expect(document.body.textContent).toContain("Tools 1List againtheirs");
});
