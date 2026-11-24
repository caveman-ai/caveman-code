import { alerts, container, settle, type } from "../../lib/dom.test-support.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { Composer } from "../Composer.tsx";

const REPO = { path: "/Users/me/acme/app" };

async function mountComposer() {
  const stored: string[][] = [];
  const client = {
    call: async (method: string, params: { secrets?: ReadonlyArray<{ name: string }> }) => {
      if (method === "secret.list") return { repository: "acme/app", secrets: [] };
      if (method === "secret.set") {
        stored.push((params.secrets ?? []).map((s) => s.name));
        return {};
      }
      return {};
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [
      { id: "caveman", label: "Caveman", auth: { state: "api_key" }, capabilities: {}, models: [] },
    ],
    settings: null,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  const box = createElement(Composer, {
    running: false,
    engineId: "caveman",
    engineLabel: "Caveman",
    canSteer: false,
    repo: REPO,
    draftKey: "test",
    onSubmit: async () => undefined,
    onInterrupt: async () => undefined,
  });
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(MemoryRouter, null, createElement(RuntimeFixture, { value, children: box })),
      ),
    ),
  );
  await settle();
  const drop = async (files: File[]) => {
    await act(async () => {
      const e = new Event("drop", { bubbles: true, cancelable: true });
      Object.assign(e, { dataTransfer: { files, types: ["Files"] } });
      host.querySelector("[data-composer]")!.dispatchEvent(e);
    });
    // Each file is read before it is checked: let every read answer.
    for (let i = 0; i < files.length; i++) await settle();
  };
  const sheet = () => host.querySelector("[role='dialog'][aria-label='Store as secrets']");
  const shown = () =>
    [...(sheet()?.querySelectorAll<HTMLInputElement>("input[data-row]") ?? [])].map((i) => i.value);
  const save = async () => {
    await act(
      async () =>
        void sheet()!
          .querySelector<HTMLButtonElement>("[data-save]")!
          .dispatchEvent(new Event("click", { bubbles: true })),
    );
    await settle();
  };
  const mentioned = () =>
    host.querySelector("[aria-label='Secrets this message names']")?.textContent ?? "";
  return {
    host,
    stored,
    drop,
    sheet,
    shown,
    save,
    mentioned,
    unmount: () => act(async () => root.unmount()),
  };
}

const env = () =>
  new File(
    [
      ("DATABASE_URL=postgres://u:p4ssw0rd@db.internal:5432/app\nSTRIPE_SECRET_KEY=sk_" + "live_51HxQwErTyUiOp1234567890abcdef\n"),
    ],
    ".env",
    { type: "" },
  );
const envLocal = () =>
  new File([("OPENAI_API_KEY=sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd\n")], ".env.local", {
    type: "",
  });

test("dropping .env and .env.local together stores both files' keys, one sheet after the other", async () => {
  const box = await mountComposer();
  await box.drop([env(), envLocal()]);

  // Neither file is attached; the first file's keys are on the sheet, the second waits for it.
  expect(box.host.querySelector("[aria-label='Attachments']")).toBeNull();
  expect(box.shown()).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
  await box.save();
  expect(box.shown()).toEqual(["OPENAI_API_KEY"]);
  await box.save();

  expect(box.sheet()).toBeNull();
  expect(box.stored).toEqual([["DATABASE_URL", "STRIPE_SECRET_KEY"], ["OPENAI_API_KEY"]]);
  expect(box.mentioned()).toContain("OPENAI_API_KEY");
  expect(box.mentioned()).toContain("2 secrets");
  expect(alerts(box.host)).toEqual([]);
  await box.unmount();
});

test("Escape on the first caught file drops only its keys: the next file's sheet still comes", async () => {
  const box = await mountComposer();
  await box.drop([env(), envLocal()]);
  expect(box.shown()).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
  await act(
    async () =>
      void box.sheet()!.dispatchEvent(
        Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), {
          key: "Escape",
        }),
      ),
  );
  await settle();
  expect(box.shown()).toEqual(["OPENAI_API_KEY"]);
  await box.save();
  expect(box.stored).toEqual([["OPENAI_API_KEY"]]);
  await box.unmount();
});

test("sending the same draft again while its sheet waits asks about its keys once", async () => {
  const box = await mountComposer();
  const message = box.host.querySelector("textarea[aria-label='Message']");
  await type(message, ("deploy with sk_" + "live_51HxQwErTyUiOp1234567890abcdef please"));
  const enter = () =>
    act(
      async () =>
        void message!.dispatchEvent(
          Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), {
            key: "Enter",
          }),
        ),
    );
  await enter();
  await settle();
  expect(box.shown()).toEqual(["STRIPE_SECRET_KEY"]);
  await enter();
  await settle();
  await box.save();
  expect(box.sheet()).toBeNull();
  expect(box.stored).toEqual([["STRIPE_SECRET_KEY"]]);
  await box.unmount();
});

test("a file dropped while a caught draft's sheet is open waits: the draft still gets its $NAME back", async () => {
  const box = await mountComposer();
  const message = box.host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")!;
  await type(message, ("deploy with sk_" + "live_51HxQwErTyUiOp1234567890abcdef please"));
  await act(
    async () =>
      void message.dispatchEvent(
        Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }),
      ),
  );
  await settle();
  expect(box.shown()).toEqual(["STRIPE_SECRET_KEY"]);
  await box.drop([envLocal()]);

  expect(box.shown()).toEqual(["STRIPE_SECRET_KEY"]);
  await box.save();
  expect(message.value).toBe("deploy with $STRIPE_SECRET_KEY please");
  expect(box.shown()).toEqual(["OPENAI_API_KEY"]);
  await box.save();
  expect(box.stored).toEqual([["STRIPE_SECRET_KEY"], ["OPENAI_API_KEY"]]);
  await box.unmount();
});
