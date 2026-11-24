// Starting a Cloud workspace asks to send the repository's secrets that are on this computer only. A value already
// sent to Cloud one by one (Add from this Mac, Add value) is on the Cloud computer: it is not one of them.
import { render, settle } from "../../routes/dom.test-support.ts";

import { act, createElement, type ReactNode } from "react";
import { expect, test } from "vitest";

import { thisComputer } from "../../lib/platform.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { useUseOnCloudPrompt } from "./trust.tsx";

const gadgets = { url: "https://github.com/acme/gadgets" };

/** The prompt on a runtime signed in to Cloud whose repository has `stored` values, `held` of them on Cloud by name. */
async function prompt(stored: string[], held: string[]) {
  const client = {
    on: () => () => undefined,
    call: async (method: string) => {
      if (method === "cloud.profile.status") return { state: "ok", items: [] };
      if (method === "secret.list")
        return {
          repository: "github.com/acme/gadgets",
          secrets: stored.map((name) => ({
            name,
            hidden: true,
            updated_at: "2026-11-01T00:00:00Z",
          })),
          ...(held.length > 0 ? { cloud_names: held } : {}),
        };
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
  let hook!: ReturnType<typeof useUseOnCloudPrompt>;
  const Probe = (): ReactNode => {
    hook = useUseOnCloudPrompt();
    return hook.dialog;
  };
  await render(createElement(RuntimeFixture, { value, children: createElement(Probe) }));
  await settle(2);
  let done = false;
  await act(async () => void hook.ask(gadgets).then(() => (done = true)));
  await settle(2);
  const dialog = document.querySelector('[role="dialog"]');
  return {
    done,
    title: dialog?.querySelector("h2")?.textContent ?? null,
    names: [...(dialog?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
  };
}

test("asks only about the values Cloud does not already hold", async () => {
  expect(await prompt(["AWS_SECRET", "STRIPE_KEY"], ["STRIPE_KEY"])).toEqual({
    done: false,
    title: `This repository has 1 secret on ${thisComputer}`,
    names: ["AWS_SECRET"],
  });
});

test("asks nothing when Cloud holds every value, sent one by one", async () => {
  expect(await prompt(["STRIPE_KEY"], ["STRIPE_KEY"])).toEqual({
    done: true,
    title: null,
    names: [],
  });
});

test("asks about every value when Cloud holds none", async () => {
  expect(await prompt(["AWS_SECRET", "STRIPE_KEY"], [])).toEqual({
    done: false,
    title: `This repository has 2 secrets on ${thisComputer}`,
    names: ["AWS_SECRET", "STRIPE_KEY"],
  });
});
