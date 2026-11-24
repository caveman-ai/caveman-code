import { expect, it } from "vitest";

import { linkEndpoint, linkNotice, linkTurnedDown, probeUrl, submittedMessageId, takeLinkEndpoint } from "./runtime.tsx";

const ws = "ws://127.0.0.1:4100/session/v1";
const link = `http://127.0.0.1:4100/?runtime=${encodeURIComponent(ws)}#token=t0ken`;

it("reads the runtime from the query and the token from the fragment (or an older link's query)", () => {
  expect(linkEndpoint(link)).toEqual({ url: ws, token: "t0ken" });
  expect(linkEndpoint(`http://127.0.0.1:4100/?runtime=${encodeURIComponent(ws)}&token=old`)).toEqual({ url: ws, token: "old" });
  expect(linkEndpoint("http://127.0.0.1:4100/#/inbox")).toBeNull();
});

it("stores the endpoint and leaves no token in the address", () => {
  const stored = new Map<string, string>();
  let address = "";
  const url = new URL(`${link.replace("/?", "/?keep=1&")}`);
  takeLinkEndpoint({
    location: url as unknown as Location,
    history: { replaceState: (_state: unknown, _title: string, next: string) => (address = next) } as unknown as History,
    localStorage: { setItem: (k: string, v: string) => stored.set(k, v) } as unknown as Storage,
  });
  expect(JSON.parse(stored.get("caveman.runtime")!)).toEqual({ url: ws, token: "t0ken" });
  expect(address).toBe("/?keep=1");
});

it("says when the runtime is out of reach, never while the link is open", () => {
  // Nothing answers yet: the client keeps trying.
  expect(linkNotice({ open: false, openedOnce: false })).toBe("Can't reach the runtime on this computer. Reconnecting…");
  // The runtime answers but turns the socket down (it restarted with a new link): said as that, not "can't reach".
  expect(linkNotice({ open: false, openedOnce: false, refused: true })).toBe("This link was turned down: the runtime started again with a new one.");
  // The runtime stopped under an open app: the screen keeps what it showed, and says so.
  expect(linkNotice({ open: false, openedOnce: true })).toBe("Lost the runtime on this computer. Reconnecting…");
  expect(linkNotice({ open: true, openedOnce: true })).toBeNull();
  // The desktop app starts its runtime beside the window: before the first open it is starting, not unreachable.
  expect(linkNotice({ open: false, openedOnce: false }, true)).toBe("Starting Caveman Code's runtime…");
  expect(linkNotice({ open: false, openedOnce: true }, true)).toBe("Lost the runtime on this computer. Reconnecting…");
});

it("the echo's id is the runtime's id for the message turn.submit sends", async () => {
  const { createHash } = await import("node:crypto");
  // packages/runtime session-protocol/store.ts submittedMessageId
  const runtime = `sp-msg:${createHash("sha256").update("s-1\0req-1").digest("hex").slice(0, 24)}`;
  expect(await submittedMessageId("s-1", "req-1")).toBe(runtime);
});

it("probes the runtime's own address, and calls a link turned down only after repeated failures while it answers", () => {
  expect(probeUrl("ws://127.0.0.1:3773/session/v1")).toBe("http://127.0.0.1:3773/");
  expect(probeUrl("wss://box.example/session/v1?x=1")).toBe("https://box.example/");
  // A runtime that is starting answers before its socket is ready: one or two failures are not a refusal.
  expect(linkTurnedDown(1)).toBe(false);
  expect(linkTurnedDown(2)).toBe(false);
  expect(linkTurnedDown(3)).toBe(true);
});
