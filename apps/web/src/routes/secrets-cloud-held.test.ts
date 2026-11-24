// Settings > Secrets for a repository added to Cloud one value at a time (Add from this Mac, Add value): its switch
// stays off and says which values Caveman keeps. Cloud follows what is stored here: a value deleted on the page is
// deleted from Cloud, and one stored again goes back up. The caption says what Cloud holds after each change.
import { button, click, mount, settle, type } from "./settings/browser.fixture.ts";

import { act, createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { thisComputer } from "../lib/platform.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { SecretsSettings } from "./Secrets.tsx";

const gadgets = { path: "/repos/gadgets" };
// As Settings > Projects renders it, for one project's checkout.
const ProjectSecrets: (props: {
  readonly repo: typeof gadgets;
}) => ReturnType<typeof SecretsSettings> = SecretsSettings;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** A runtime signed in to Cloud whose repository has `stored` values: all on Cloud (`whole`), or `byName` of them sent one by one. */
async function secretsPage(stored: string[], byName: string[], whole = false) {
  const names = new Set(stored);
  const client = {
    on: () => () => undefined,
    call: async (
      method: string,
      params: { name?: string; secrets?: Array<{ name: string }>; available?: boolean },
    ) => {
      if (method === "cloud.profile.status") return { state: "ok", items: [] };
      if (method === "secret.env_files") return { files: [] };
      if (method === "secret.delete") return void names.delete(params.name!);
      if (method === "secret.set") return void params.secrets!.forEach((s) => names.add(s.name));
      if (method === "cloud.secrets.set_available") {
        // Either answer clears the names sent one by one: folded into the whole repository, or deleted from Cloud.
        whole = params.available === true;
        byName = [];
        return {
          repository: "github.com/acme/gadgets",
          available: whole,
          names: whole ? [...names] : [],
        };
      }
      if (method === "secret.list") {
        // As the runtime answers (cloudAvailability): the opted-in names Cloud holds now, which are the ones stored here.
        const held = [...names].filter((n) => byName.includes(n));
        const onCloud = whole
          ? { cloud_available: true }
          : held.length > 0
            ? { cloud_names: held }
            : {};
        return {
          repository: "github.com/acme/gadgets",
          secrets: [...names].map((name) => ({
            name,
            hidden: true,
            updated_at: "2026-11-01T00:00:00Z",
          })),
          ...onCloud,
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const value = {
    client,
    workspaces: [],
    projects: [],
    engines: [],
    settings: null,
    status: "connected",
    connection: 1,
  } as unknown as RuntimeContextValue;
  page = await mount(
    createElement(RuntimeFixture, {
      value,
      children: createElement(ProjectSecrets, { repo: gadgets }),
    }),
  );
  await settle();
  return page.container;
}

const caption = (container: HTMLElement) => {
  const toggle = container.querySelector('[role="switch"]');
  if (!toggle) throw new Error(`no Cloud switch in: ${container.textContent}`);
  return {
    on: toggle.getAttribute("aria-checked") === "true",
    text: toggle.parentElement?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  };
};

/** Add secrets: the paste, its sheet, and Save. */
async function paste(container: HTMLElement, text: string) {
  await type(container.querySelector<HTMLTextAreaElement>("#secret-paste")!, text);
  await act(
    async () =>
      void container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await click(button(container, /^Save secret/));
}

test("the switch names what Cloud holds after a value sent one by one is deleted on the page and stored again", async () => {
  const container = await secretsPage(["AWS_SECRET", "STRIPE_KEY"], ["STRIPE_KEY"]);
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      "Caveman keeps an encrypted copy of STRIPE_KEY, added one by one.",
    ),
  });
  expect(caption(container).text).toContain(`The other values stay on ${thisComputer}.`);

  // Deleted here, so deleted from Cloud: nothing of this repository is on Cloud now.
  await click(button(container, "Delete STRIPE_KEY"));
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      `Off: the values stay on ${thisComputer}. Cloud computers start without them.`,
    ),
  });
  expect(caption(container).text).not.toContain("STRIPE_KEY");

  // Stored again, it goes back to Cloud: it is still opted in.
  await paste(container, ("STRIPE_KEY=sk_" + "live_51HxAbCdEfGhIjKlMnOpQrStUv"));
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      "Caveman keeps an encrypted copy of STRIPE_KEY, added one by one.",
    ),
  });
});

test("a value sent one by one and deleted before the page opened is named once it is stored again", async () => {
  const container = await secretsPage(["AWS_SECRET"], ["STRIPE_KEY"]);
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(`Off: the values stay on ${thisComputer}.`),
  });
  await paste(container, ("STRIPE_KEY=sk_" + "live_51HxAbCdEfGhIjKlMnOpQrStUv"));
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      "Caveman keeps an encrypted copy of STRIPE_KEY, added one by one.",
    ),
  });
  expect(caption(container).text).toContain(`The other values stay on ${thisComputer}.`);
});

test("the switch says the values stay on this computer when Cloud holds none of them", async () => {
  const container = await secretsPage(["AWS_SECRET", "STRIPE_KEY"], []);
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      `Off: the values stay on ${thisComputer}. Cloud computers start without them.`,
    ),
  });
});

test("turning the switch off shows what the runtime then answers", async () => {
  const container = await secretsPage(["AWS_SECRET", "STRIPE_KEY"], [], true);
  expect(caption(container)).toEqual({
    on: true,
    text: expect.stringContaining(
      "Caveman keeps an encrypted copy of AWS_SECRET, STRIPE_KEY. Only your own Cloud computers read it",
    ),
  });
  await click(container.querySelector('[role="switch"]')!);
  expect(caption(container)).toEqual({
    on: false,
    text: expect.stringContaining(
      `Off: the values stay on ${thisComputer}. Cloud computers start without them.`,
    ),
  });
});
