// K2: a web window never makes a Chief on a Cloud computer it uses; it reads the person's Chief on a Mac of theirs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { chiefMac, useChief } from "./chief.ts";
import { chiefHere, RuntimeContext, type RuntimeContextValue } from "./runtime.tsx";
import { runtime } from "./sync/fakes.test-support.ts";

test("the Chief is read only where it belongs: the desktop's Mac, or a Mac a web window uses; never a Cloud computer, nor with no runtime", () => {
  expect(chiefHere(false, undefined)).toBe(true); // the desktop: This Mac
  expect(chiefHere(true, "laptop")).toBe(true); // a web window on the person's Mac
  expect(chiefHere(true, "cloud")).toBe(false); // on a Cloud computer, however it came to be there
  expect(chiefHere(true, undefined)).toBe(false); // every place asleep: nothing to ask
});

test("where the Chief is not, the page is told so and gets no client, so nothing asks chief.get", () => {
  const calls: string[] = [];
  const client = { call: async (method: string) => (calls.push(method), {}), on: () => () => undefined } as never;
  const seen: Array<{ status: string; client: unknown }> = [];
  const Probe = () => {
    const chief = useChief();
    seen.push({ status: chief.status, client: chief.client });
    return null;
  };
  const render = (chiefHereValue: boolean) =>
    renderToStaticMarkup(
      createElement(RuntimeContext.Provider, { value: { status: "connected", client, connection: 1, chiefHere: chiefHereValue } as unknown as RuntimeContextValue }, createElement(Probe)),
    );
  render(false);
  expect(seen.at(-1)).toEqual({ status: "elsewhere", client: null });
  render(true);
  expect(seen.at(-1)).toMatchObject({ status: "loading", client });
  expect(calls).toEqual([]);
});

test("the Chief's page points at the person's Mac, the one online first", () => {
  const mac = chiefMac([runtime("rt-alpha"), runtime("rt-old-mac", { kind: "laptop", online: false, name: "Old MacBook" }), runtime("rt-mac", { kind: "laptop", name: "MacBook Pro" })]);
  expect(mac).toMatchObject({ id: "rt-mac", name: "MacBook Pro", computer_driver: "local" });
  expect(chiefMac([runtime("rt-alpha")])).toBeNull();
});
