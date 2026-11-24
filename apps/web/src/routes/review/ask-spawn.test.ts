// Ask and Fix on This Mac name the repository the pull request is in, beside its number: the runtime reads the number in
// the checkout `repo` names, and refuses one of another repository (reviews.test.ts, "starts on the pull request of the
// repository it names") rather than check out the unrelated pull request of that number there.
import type { PrDetail } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { id: "w-1", title: String(params.title ?? "") };
    },
  };
  const view = {
    projects: [
      {
        id: "widgets",
        path: "/code/widgets",
        repository: { host: "github.com", full_name: "acme/widgets" },
      },
    ],
    engines: [{ id: "claude-agent", auth: { state: "signed_in" } }],
    settings: { default_engine: "claude-agent" },
    adopt: () => undefined,
    refresh: async () => undefined,
  };
  return { calls, client, view };
});

vi.mock("../../state/runtime.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/runtime.tsx")>()),
  useRuntimeClient: () => ({ client: h.client }),
  useSyncHub: () => null,
  useComputersCloud: () => null,
  useRuntimeSelector: (select: (v: unknown) => unknown) => select(h.view),
}));
vi.mock("../../components/cloud/trust.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/cloud/trust.tsx")>()),
  useUseOnCloudPrompt: () => ({ ask: async () => undefined, dialog: null }),
}));

import { selectionPlaceholder, useSpawnAgent, type AskChat } from "./Ask.tsx";
import { ASK_HERE } from "./askWhere.ts";
import { prFromUrl } from "./model.ts";

const detailOf = (over: Partial<PrDetail>): PrDetail =>
  ({
    project_id: "widgets",
    repo: "acme/widgets",
    host: "github.com",
    number: 123,
    title: "Bump the parser",
    url: "https://github.com/acme/widgets/pull/123",
    head_branch: "bump-parser",
    base_branch: "main",
    ...over,
  }) as PrDetail;

async function fixOnThisMac(detail: PrDetail) {
  let spawn: ReturnType<typeof useSpawnAgent>["spawn"] | undefined;
  function Probe() {
    spawn = useSpawnAgent(detail).spawn;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  await spawn!("fix", "Tighten the check");
  return h.calls.find((c) => c.method === "workspace.create")?.params;
}

beforeEach(() => {
  h.calls.length = 0;
});

test("Fix on This Mac for the project's own pull request starts on the project's checkout, naming its repository", async () => {
  expect(await fixOnThisMac(detailOf({}))).toMatchObject({
    repo: { path: "/code/widgets" },
    pull_request: { number: 123, repo: "acme/widgets" },
  });
});

test("Fix on This Mac for another repository's pull request names that repository, so the project's own #123 is never checked out", async () => {
  // A link to other/lib's pull request opens through the project on the same host.
  const address = prFromUrl("https://github.com/other/lib/pull/123", h.view.projects)!;
  expect(address).toEqual({
    project_id: "widgets",
    number: 123,
    repo: "other/lib",
    host: "github.com",
  });
  const detail = detailOf({
    repo: "other/lib",
    url: "https://github.com/other/lib/pull/123",
    head_branch: "lib-fix",
  });
  const params = await fixOnThisMac(detail);
  expect(params).toMatchObject({
    repo: { path: "/code/widgets" },
    pull_request: { number: 123, repo: "other/lib" },
  });
  expect((params!.task as { text: string }).text).toContain("other/lib");
});

/** Ask from a chat's own pull request tab, on a computer that does not hold the pull request's project. */
async function askInChat(detail: PrDetail, chat: AskChat | null) {
  const projects = h.view.projects;
  h.view.projects = [];
  try {
    let spawn: ReturnType<typeof useSpawnAgent>["spawn"] | undefined;
    function Probe() {
      spawn = useSpawnAgent(detail, ASK_HERE, chat).spawn;
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    return await spawn!("ask", "Why does the gate block red CI?", {
      where: "src/gate.ts:12",
      quote: "if (red) block()",
    });
  } finally {
    h.view.projects = projects;
  }
}

test("Ask from a Cloud chat's pull request tab on the desktop goes to that chat as a message; the project need not be on this Mac", async () => {
  const detail = detailOf({});
  // Without the chat (as the tab did): the pull request's project lives only in Cloud, so it was refused here.
  await expect(askInChat(detail, null)).rejects.toThrow(
    "This pull request's project isn't on this computer.",
  );
  // With it: one message to the chat, which wakes it if it sleeps; no new chat, no project looked up.
  expect(await askInChat(detail, { sessionId: "s-cloud", running: false })).toBeNull();
  expect(h.calls.map((c) => c.method)).toEqual(["turn.submit"]);
  const sent = h.calls[0]!.params as { session_id: string; kind: string; input: { text: string } };
  expect(sent).toMatchObject({ session_id: "s-cloud", kind: "followup" });
  expect(sent.input.text).toContain(
    "About pull request #123 “Bump the parser” (https://github.com/acme/widgets/pull/123):",
  );
  expect(sent.input.text).toContain("From src/gate.ts:12:\n> if (red) block()");
  expect(sent.input.text.endsWith("Why does the gate block red CI?")).toBe(true);
  // While a turn runs, the message waits behind it.
  h.calls.length = 0;
  await askInChat(detail, { sessionId: "s-cloud", running: true });
  expect(h.calls[0]!.params).toMatchObject({ kind: "queue" });
});

test("in a chat's own tab nobody is told an agent starts: what is asked goes to the chat", () => {
  expect(selectionPlaceholder("ask", true)).toBe("Ask about this. Enter sends it to this chat");
  expect(selectionPlaceholder("fix", true)).toBe("What should change? Enter sends it to this chat");
  expect(selectionPlaceholder("ask", false)).toBe("Ask about this. Enter starts an agent");
  expect(selectionPlaceholder("comment", true)).toBe("Comment on this line");
});
