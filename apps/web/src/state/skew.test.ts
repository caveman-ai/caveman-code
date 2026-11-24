import {
  LEGACY_RUNTIME,
  PROTOCOL_REVISION,
  type RuntimeHello,
} from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { firstSkewed, skewSentence } from "./skew.ts";

const at = (protocol_revision: number, min_client_revision = 0): RuntimeHello => ({
  version: "x",
  protocol_revision,
  min_client_revision,
  capabilities: [],
});

test("one sentence each: an older Cloud computer updates when it wakes or now, an older Mac updates itself", () => {
  expect(
    skewSentence({ skew: "runtime_older", name: "api-box", kind: "cloud", computerId: "c1" }, true),
  ).toBe(
    "api-box runs an older Caveman Code than this app needs; it updates the next time it wakes, or now.",
  );
  expect(skewSentence({ skew: "runtime_older", name: "api-box", kind: "cloud" }, false)).toBe(
    "api-box runs an older Caveman Code than this page needs; it updates the next time it wakes, or now.",
  );
  expect(
    skewSentence({ skew: "runtime_older", name: "Julius's MacBook", kind: "laptop" }, false),
  ).toBe(
    "Julius's MacBook runs an older Caveman Code than this page needs; update Caveman Code on it.",
  );
});

test("a newer runtime than this client: the app updates, a page reloads", () => {
  const nightlyMac = { skew: "client_older", name: "Julius's MacBook", kind: "laptop" } as const;
  expect(skewSentence(nightlyMac, true)).toBe(
    "Julius's MacBook runs a newer Caveman Code than this app; update the app to keep working with it.",
  );
  expect(skewSentence(nightlyMac, false)).toBe(
    "Julius's MacBook runs a newer Caveman Code than this page; reload it, or use the Caveman Code app.",
  );
});

test("the window's own runtime first, then the first other one whose answer does not fit; none that has not answered", () => {
  const fine = { hello: at(PROTOCOL_REVISION), name: "This Mac", kind: "laptop" } as const;
  const old = {
    hello: LEGACY_RUNTIME,
    name: "old box",
    kind: "cloud",
    computerId: "c-old",
  } as const;
  const silent = { hello: undefined, name: "asleep", kind: "cloud" } as const;
  const needsNewer = {
    hello: at(PROTOCOL_REVISION + 1, PROTOCOL_REVISION + 1),
    name: "nightly Mac",
    kind: "laptop",
    computerId: undefined,
  } as const;
  // Revision 0 runtimes work with this client (they keep their -32601 fallbacks): nothing to say.
  expect(firstSkewed([fine, old, silent])).toBeNull();
  expect(firstSkewed([fine, old, needsNewer])).toEqual({
    skew: "client_older",
    name: "nightly Mac",
    kind: "laptop",
  });
});
