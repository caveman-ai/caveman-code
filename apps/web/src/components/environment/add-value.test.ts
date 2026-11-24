import { container, submit, type } from "../../lib/dom.test-support.ts";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { AddValue } from "./parts.tsx";

function mount(element: ReactElement) {
  const call = vi.fn(async (_method: string, _params: unknown) => ({}));
  const value = {
    client: { call },
    engines: [],
    workspaces: [],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  const render = (el: ReactElement) =>
    act(async () => root.render(createElement(RuntimeFixture, { value, children: el })));
  const ready = render(element);
  const form = () => host.querySelector("form")!;
  const label = () => form().querySelector("span")?.textContent;
  const valueField = () => form().querySelector<HTMLInputElement>("input[type='password']")!;
  const stored = () =>
    call.mock.calls
      .filter(([method]) => method === "secret.set")
      .flatMap(([, p]) => (p as { secrets: { name: string; value: string }[] }).secrets);
  const madeAvailable = () =>
    call.mock.calls
      .filter(([method]) => method === "cloud.secrets.set_available")
      .flatMap(([, p]) => (p as { names: string[] }).names);
  return {
    ready,
    render,
    form,
    label,
    valueField,
    stored,
    madeAvailable,
    unmount: () => act(async () => root.unmount()),
  };
}

const project = { path: "/Users/me/acme/app" };
const addValue = (name: string) => createElement(AddValue, { project, name });

test("a newer failed build that asks for another value gets an empty field: Save never stores the first value under the new name", async () => {
  const s = mount(addValue("STRIPE_KEY"));
  await s.ready;
  // Pasted for STRIPE_KEY, not saved yet.
  await type(s.valueField(), "sk_live_stripe");
  // A rebuild fails for DATABASE_URL, and the person presses that note's Add value: the same form now asks for it.
  await s.render(addValue("DATABASE_URL"));
  expect(s.label()).toBe("DATABASE_URL");
  expect(s.valueField().value).toBe("");
  await submit(s.form());
  expect(s.stored()).toEqual([]);

  await type(s.valueField(), "postgres://acme");
  await submit(s.form());
  expect(s.stored()).toEqual([{ name: "DATABASE_URL", value: "postgres://acme" }]);
  expect(s.madeAvailable()).toEqual(["DATABASE_URL"]);
  await s.unmount();
});
