// The agent's ask for a secret, mounted with React DOM: an answer that does not reach the agent says so.
import { document, fire } from "../../testing/dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { AnsweredElsewhere } from "../../state/sync/sender.ts";
import { AskCard } from "../Transcript.tsx";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => void process.off("unhandledRejection", onUnhandled));

const ask = {
  kind: "ask",
  id: "ask-1",
  askKind: "secret",
  prompt: "To charge the test card",
  options: [],
  resolution: null,
  questions: [],
  round: null,
  answers: null,
  secret: { name: "STRIPE_SECRET_KEY", repo: { path: "/repo" } },
} as never;

/** The card, with secret.set storing the value and ask.respond (PaneFrame's answer) as `respond` has it. */
async function mount(respond: () => Promise<void>) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const calls: string[] = [];
  const client = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "secret.set") return {};
      throw new Error(`${method}: not in this fixture`);
    },
    on: () => () => undefined,
  };
  const onAnswer = () => {
    calls.push("ask.respond");
    return respond();
  };
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        RuntimeContext.Provider,
        { value: { status: "connected", client, connection: 1 } as unknown as RuntimeContextValue },
        createElement(AskCard, {
          ask,
          engine: "caveman",
          engineLabel: "Caveman",
          engineIsCaveman: true,
          onAnswer,
        }),
      ),
    ),
  );
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { host, calls, settle, unmount: () => act(() => root.unmount()) };
}

const refused = (e: Error) => () => Promise.reject(e);

test("a Decline that does not reach the agent says so", async () => {
  const card = await mount(refused(new Error("The relay dropped the call")));
  const decline = [...card.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Decline",
  )!;
  await act(async () => void fire(decline, "click"));
  await card.settle();
  expect(card.calls).toEqual(["ask.respond"]);
  expect(unhandled.map(String)).toEqual([]);
  expect(card.host.querySelector("[role=alert]")?.textContent).toBe(
    "Your answer didn't reach Caveman. Save or decline again.",
  );
  await card.unmount();
});

test("a saved secret whose answer does not reach the agent says so", async () => {
  const card = await mount(refused(new Error("The relay dropped the call")));
  const input = card.host.querySelector("input")!;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setValue.call(input, ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3"));
    fire(input, "input");
  });
  await act(async () => void fire(card.host.querySelector("form")!, "submit"));
  await card.settle();
  expect(card.calls).toEqual(["secret.set", "ask.respond"]);
  expect(unhandled.map(String)).toEqual([]);
  expect(card.host.querySelector("[role=alert]")?.textContent).toBe(
    "STRIPE_SECRET_KEY is saved, but your answer didn't reach Caveman. Send it again or decline.",
  );
  await card.unmount();
});

test("a saved secret whose answer does not reach the agent goes again without pasting the value again", async () => {
  let answers = 0;
  const card = await mount(() =>
    ++answers === 1
      ? Promise.reject(new Error("The relay dropped the call"))
      : new Promise<void>(() => undefined),
  );
  const input = card.host.querySelector("input")!;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setValue.call(input, ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3"));
    fire(input, "input");
  });
  await act(async () => void fire(card.host.querySelector("form")!, "submit"));
  await card.settle();
  // The value is in the repository and gone from the field: the card says so, and its button sends the answer alone.
  expect(input.value).toBe("");
  expect(card.host.querySelector("[role=alert]")?.textContent).toBe(
    "STRIPE_SECRET_KEY is saved, but your answer didn't reach Caveman. Send it again or decline.",
  );
  const again = card.host.querySelector<HTMLButtonElement>("button[type=submit]")!;
  expect(again.disabled, "the empty field leaves only Decline").toBe(false);
  expect(again.textContent).toBe("Send again");
  await act(async () => void fire(card.host.querySelector("form")!, "submit"));
  await card.settle();
  expect(card.calls).toEqual(["secret.set", "ask.respond", "ask.respond"]);
  expect(card.host.querySelector("[role=alert]")).toBeNull();
  await card.unmount();
});

test("a Decline someone already answered on another device says that, not try again", async () => {
  const card = await mount(refused(new AnsweredElsewhere()));
  const decline = [...card.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Decline",
  )!;
  await act(async () => void fire(decline, "click"));
  await card.settle();
  expect(unhandled.map(String)).toEqual([]);
  expect(card.host.querySelector("[role=status]")?.textContent).toBe("Answered on another device");
  expect(card.host.querySelector("[role=alert]")).toBeNull();
  await card.unmount();
});

test("while an answer is out, a second click on Decline sends nothing more", async () => {
  const card = await mount(() => new Promise<void>(() => undefined));
  const decline = [...card.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Decline",
  )!;
  await act(async () => void fire(decline, "click"));
  expect(decline.disabled).toBe(true);
  expect(card.calls).toEqual(["ask.respond"]);
  await card.unmount();
});
