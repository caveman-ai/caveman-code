import { buttons, click, container, submit, type } from "../../lib/dom.test-support.ts";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { BuildSecretForm, BuildSecrets } from "./parts.tsx";

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
  const value_ = () => form().querySelector<HTMLInputElement>("input[type='password']")!;
  const saved = () =>
    call.mock.calls
      .filter(([method]) => method === "environment.build_secret.set")
      .map(([, p]) => p as { name: string; value: string });
  return {
    ready,
    render,
    host,
    form,
    label,
    valueField: value_,
    saved,
    unmount: () => act(async () => root.unmount()),
  };
}

const list = (names: string[]) =>
  createElement(BuildSecrets, { projectId: "p1", names, onChange: () => undefined });

test("Replace on one build secret, then on another: Save stores the value under the one the form names", async () => {
  const s = mount(list(["NPM_TOKEN", "GITHUB_TOKEN"]));
  await s.ready;
  await click(buttons(s.host, "Replace")[0]);
  await type(s.valueField(), "npm_value_meant_for_npm");
  // The Replace buttons stay while the form is open; the person picks the other secret instead.
  await click(buttons(s.host, "Replace")[1]);
  expect(s.label()).toBe("GITHUB_TOKEN");
  // What was typed for NPM_TOKEN does not carry over to GITHUB_TOKEN.
  expect(s.valueField().value).toBe("");
  await type(s.valueField(), "ghp_github_token");
  await submit(s.form());
  expect(s.saved()).toEqual([
    expect.objectContaining({ name: "GITHUB_TOKEN", value: "ghp_github_token" }),
  ]);
  await s.unmount();
});

test("Add build secret with a typed name, then Replace on another: Save stores it under the replaced one", async () => {
  const s = mount(list(["NPM_TOKEN"]));
  await s.ready;
  await click(buttons(s.host, "Add build secret")[0]);
  await type(s.host.querySelector("input[aria-label='Build secret name']"), "FOO_TOKEN");
  await click(buttons(s.host, "Replace")[0]);
  expect(s.label()).toBe("NPM_TOKEN");
  await type(s.valueField(), "npm_value");
  await submit(s.form());
  expect(s.saved()).toEqual([expect.objectContaining({ name: "NPM_TOKEN", value: "npm_value" })]);
  await s.unmount();
});

test("a failed build's form that comes to ask for another secret saves under that one", async () => {
  const form = (name: string) =>
    createElement(BuildSecretForm, {
      projectId: "p1",
      name,
      onDone: () => undefined,
      onCancel: () => undefined,
    });
  const s = mount(form("NPM_TOKEN"));
  await s.ready;
  await s.render(form("GITHUB_TOKEN"));
  expect(s.label()).toBe("GITHUB_TOKEN");
  await type(s.valueField(), "ghp_github_token");
  await submit(s.form());
  expect(s.saved()).toEqual([
    expect.objectContaining({ name: "GITHUB_TOKEN", value: "ghp_github_token" }),
  ]);
  await s.unmount();
});
