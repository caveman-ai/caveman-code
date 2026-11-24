// What a chat started on Cloud takes from the turn picked for it, through the #start link anyone can send: the model,
// effort, speed and mode, never permissions or a login, and a start that picked permissions is refused, not run on others.
import { expect, test } from "vitest";
import {
  adoptPendingStart,
  cloudStartOptions,
  confirmPendingStart,
  pendingStart,
  pendingStartParams,
  startLink,
} from "./cloud.ts";

const store = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});
const adopt = (start: Record<string, unknown>) => {
  const session = new Map<string, string>();
  adoptPendingStart({
    location: {
      hash: new URL(startLink("https://app.caveman.so/code/", start as never)).hash,
      pathname: "/code/",
      search: "",
    },
    history: { replaceState: () => undefined },
    sessionStorage: store(session),
    localStorage: store(new Map()),
  } as unknown as Parameters<typeof adoptPendingStart>[0]);
  return store(session);
};
const base = {
  computer_id: "c1",
  repo: "acme/app",
  engine: "claude-agent",
  task: "Fix the header",
};

test("a Cloud start takes the model, effort, speed and mode picked, and leaves this computer's login behind", () => {
  expect(
    cloudStartOptions({
      model: "claude-opus",
      effort: "high",
      speed: "fast",
      mode: "grill",
      account_id: "acct-work",
    } as never),
  ).toEqual({ model: "claude-opus", effort: "high", speed: "fast", mode: "grill" });
  expect(cloudStartOptions({})).toBeUndefined();
});

test("a Cloud start that picked permissions is refused, so the box keeps it", () => {
  expect(() => cloudStartOptions({ model: "claude-opus", access: "ask" })).toThrow(
    /Permissions picked here can't go with a chat started on Cloud/,
  );
});

test("a #start link keeps its picks through the person's Start and onto the chat it starts, and nothing a link may not set", () => {
  const session = adopt({
    ...base,
    options: {
      model: "claude-opus",
      effort: "high",
      access: "full",
      account_id: "acct",
      mode: "yolo",
      speed: 3,
    },
  });
  expect(pendingStart(session)?.options).toEqual({ model: "claude-opus", effort: "high" });
  confirmPendingStart(session);
  expect(pendingStartParams(pendingStart(session)!, "r1", true).options).toEqual({
    model: "claude-opus",
    effort: "high",
  });
  // A link without picks starts on the computer's defaults.
  expect(pendingStartParams(pendingStart(adopt(base))!, "r1", true)).not.toHaveProperty("options");
});
