// A server Claude Agent skips shows on its Plugins row as Skipped, with Retry and why (skipped-server.tsx).
import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { serverKey, skippedServer } from "./skipped-server.tsx";

const mark = (node: ReactElement) => renderToStaticMarkup(createElement(Fragment, null, node));

test("a skipped server's row says Skipped, its sheet says why, and Retry asks to try it again", () => {
  const onRetry = vi.fn();
  const parts = skippedServer("2026-11-11T15:41:34.000Z", "2026-11-12T15:41:34.000Z", onRetry);
  expect(mark(parts.tag)).toContain("Skipped");
  expect(mark(parts.note)).toContain("did not connect within 30 seconds when a chat started");
  // Until when, as the person's clock reads it, and that a check may bring it back sooner.
  const until = new Date("2026-11-12T15:41:34.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  expect(mark(parts.note)).toContain(`Claude Agent leaves it out of new chats until ${until}`);
  expect(mark(parts.note)).toContain("sooner if a check finds it answering");
  expect(mark(parts.retry)).toMatch(/<button[^>]*>Retry<\/button>/);
  // What a click runs: the row's mcp.retry for this server.
  (parts.retry.props as { onClick: () => void }).onClick();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("rows find their server by the key Claude Agent knows it by", () => {
  expect(serverKey("github")).toBe("github");
  expect(serverKey("my server.v2")).toBe("my_server_v2");
  expect(serverKey("unified-computer-use__cua_repl")).toBe("unified-computer-use__cua_repl");
  expect(serverKey(`${"acme tools"}__${"db"}`)).toBe("acme_tools__db");
});
