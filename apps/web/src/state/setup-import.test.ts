import { expect, it, vi } from "vitest";
import { bringingUnfinished } from "../routes/onboarding/model.ts";
import { bringingNow, forgetBringing, onBringingFinished, readKept, startBringing } from "./setup-import.ts";

const item = { from: "claude", kind: "plugin", name: "figma" } as const;

function client() {
  const answers: Array<(r: unknown) => void> = [];
  const call = vi.fn(() => new Promise((resolve) => answers.push(resolve)));
  return { client: { call } as never, call, answer: (r: unknown) => answers.shift()!(r) };
}

it("brings the setup over once: Back then Continue never starts a second import over the first", async () => {
  forgetBringing();
  const { client: c, call, answer } = client();
  const finished = vi.fn();
  const off = onBringingFinished(finished);
  expect(startBringing(c, [item], ["1 plugin"])).toBe(true);
  expect(bringingNow()).toEqual({ state: "running", parts: ["1 plugin"] });
  // Running: a second Continue starts nothing.
  expect(startBringing(c, [item], ["1 plugin"])).toBe(false);
  answer({ imported: 1, failed: [] });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
  expect(bringingNow()).toEqual({ state: "done", parts: ["1 plugin"], imported: 1, failed: [] });
  // Done: still nothing, unless Plugins brings the rest on purpose.
  expect(startBringing(c, [item], ["1 plugin"])).toBe(false);
  expect(call).toHaveBeenCalledTimes(1);
  off();
});

it("a run that didn't all come is offered again, and a retry starts a new one", async () => {
  forgetBringing();
  const { client: c, call, answer } = client();
  startBringing(c, [item], ["1 plugin"]);
  answer({ imported: 0, failed: [{ ref: item, reason: "offline" }] });
  await vi.waitFor(() => expect(bringingNow()?.state).toBe("done"));
  expect(bringingUnfinished(bringingNow())).toBe(true);
  expect(startBringing(c, [item], ["1 plugin"], true)).toBe(true);
  expect(call).toHaveBeenCalledTimes(2);
});

it("a run the app never saw answer (it quit, or the page reloaded) reads as interrupted", () => {
  expect(readKept(JSON.stringify({ state: "running", parts: ["20 MCP servers"] }))).toEqual({ state: "interrupted", parts: ["20 MCP servers"] });
  expect(bringingUnfinished(readKept(JSON.stringify({ state: "running", parts: [] })))).toBe(true);
  expect(readKept(null)).toBeNull();
  expect(readKept("not json")).toBeNull();
  expect(bringingUnfinished({ state: "done", parts: [], imported: 3, failed: [] })).toBe(false);
});
