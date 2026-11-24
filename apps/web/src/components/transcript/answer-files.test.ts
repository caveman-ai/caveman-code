// A file an answer names, in a code span or with `![]()`, is a chip that opens it: on Windows and in a folder with a
// space, as on a Mac.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

vi.mock("../../panes/drag.ts", () => ({}));
vi.mock("../../panes/store.ts", () => ({ panes: {} }));
vi.mock("../../panels/store.ts", async (real) => ({
  ...(await real<object>()),
  usePanel: () => ({ open: false, tabs: [] }),
}));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SessionModel } from "../../state/transcript.ts";
import { Transcript } from "../Transcript.tsx";

/** The chips a reply shows: where each opens, and the text it stands for. */
function chips(
  answer: string,
  root: string,
): ReadonlyArray<{ readonly opens: string; readonly names: string }> {
  const model = new SessionModel();
  model.apply({
    session_id: "s1",
    cursor: 1,
    at: "2026-11-07T10:00:00.000Z",
    type: "message.done",
    payload: { role: "assistant", text: answer },
    item_id: "m1",
  } as unknown as SessionEvent);
  const transcript = createElement(Transcript, {
    items: model.snapshot().items,
    engineLabel: "Claude Agent",
    engine: "claude-agent",
    engineIsCaveman: false,
    running: false,
    onAnswer: () => undefined,
    cavemanVersion: null,
    workspaceId: "W-1",
    root,
  });
  const runtime = {
    client: null,
    engines: [],
    workspaces: [],
    raw: new Map(),
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: runtime },
        createElement(TooltipProvider, null, transcript),
      ),
    ),
  );
  return [
    ...html.matchAll(/<button[^>]* title="([^"\n]*)[^"]*" data-markdown-copy="([^"]*)"/g),
  ].map((m) => ({ opens: m[1]!, names: m[2]! }));
}

const WINDOWS = "C:\\Users\\me\\proj";

test("a Windows path in a code span is the chip of the file in the chat's folder", () => {
  expect(
    chips("Changed `C:\\Users\\me\\proj\\src\\app.ts` and `src\\lib\\db.ts:12`.", WINDOWS),
  ).toEqual([
    { opens: "src/app.ts", names: "C:\\Users\\me\\proj\\src\\app.ts" },
    { opens: "src/lib/db.ts:12", names: "src\\lib\\db.ts:12" },
  ]);
});

test("a file an answer names with `![]()` is its chip, read as the answer wrote it, not as the renderer encodes it", () => {
  expect(chips("![spec](C:\\Users\\me\\proj\\docs\\spec.pdf)", WINDOWS)).toEqual([
    { opens: "docs/spec.pdf", names: "C:\\Users\\me\\proj\\docs\\spec.pdf" },
  ]);
  expect(chips("![spec](</Users/me/My Repo/docs/spec.pdf>)", "/Users/me/My Repo")).toEqual([
    { opens: "docs/spec.pdf", names: "/Users/me/My Repo/docs/spec.pdf" },
  ]);
  expect(chips("![notes](<docs/my notes.pdf>)", "/repo")).toEqual([
    { opens: "docs/my notes.pdf", names: "docs/my notes.pdf" },
  ]);
  expect(chips("![report](out/report.pdf)", "/repo")).toEqual([
    { opens: "out/report.pdf", names: "out/report.pdf" },
  ]);
  // Read as a link to it is, decoded once: `%25` is a `%` in its name.
  expect(chips("![a](docs/a%2541.pdf)", "/repo")).toEqual([
    { opens: "docs/a%41.pdf", names: "docs/a%41.pdf" },
  ]);
  expect(chips("![a](/Users/josé/proj/docs/a%2541.pdf)", "/Users/josé/proj")).toEqual([
    { opens: "docs/a%41.pdf", names: "/Users/josé/proj/docs/a%41.pdf" },
  ]);
});
