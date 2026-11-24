// Settings > Held by Caveman: a removal or a sync the runtime refuses keeps saying why after the page reads the list
// again, as that read usually succeeds and the row is still there.
import { button, click, deferred, mount, settle } from "./browser.fixture.ts";

import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { OnCloudSettings } from "./OnCloud.tsx";

const holding = {
  kind: "repository_secrets",
  id: "github.com/acme/widgets",
  label: "acme/widgets",
  names: ["DATABASE_URL"],
} as const;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The page on a runtime that refuses `refused` with `why`; the list read after the click waits for `reread`. */
async function heldByCaveman(state: "ok" | "paused", refused: string, why: string) {
  const reread = deferred<void>();
  let reads = 0;
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === refused)
        throw new SessionProtocolError({ code: -32000, message: why } as never);
      if (method === "cloud.profile.status") return { state, items: [] };
      if (method === "cloud.holdings") {
        if (++reads > 1) await reread.promise;
        return { items: [holding] };
      }
      if (method === "cloud.access_log") return { entries: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  page = await mount(
    createElement(
      RuntimeContext.Provider,
      { value: { status: "connected", client, connection: 1 } as unknown as RuntimeContextValue },
      createElement(OnCloudSettings),
    ),
  );
  return { container: page.container, reread };
}

const alert = (el: Element) => el.querySelector('[role="alert"]')?.textContent ?? null;

test("Remove from Cloud that Cloud refuses still says why once the list is read again", async () => {
  const why = "Removed 0 from Caveman; still there: acme/widgets (Cloud answered 503)";
  const p = await heldByCaveman("ok", "cloud.holdings.remove", why);
  expect(alert(p.container)).toBeNull();
  await click(button(p.container, "Remove from Cloud"));
  p.reread.resolve();
  await settle();
  expect(p.container.textContent).toContain("acme/widgets");
  expect(alert(p.container)).toBe(why);
});

test("Sync again that the runtime refuses still says why once the list is read again", async () => {
  const why = "Only the person this computer belongs to can sync it";
  const p = await heldByCaveman("paused", "cloud.profile.sync", why);
  await click(button(p.container, "Sync again"));
  p.reread.resolve();
  await settle();
  expect(alert(p.container)).toBe(why);
});
