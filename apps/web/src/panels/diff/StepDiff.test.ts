// One edit step's diff in a chat on a Cloud computer: the step's absolute paths read relative to the chat's folder on
// that computer, and its file opens there. Mounted with its effects running (linkedom); the chat's computer answers
// tool.diff as a Cloud computer's runtime does.
import { document as doc } from "../../testing/dom.ts";
import type { Result, Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("./FileDiff.tsx", async (real) => {
  const { createElement } = await import("react");
  return {
    ...(await real<object>()),
    FileDiff: ({ file, onOpen }: { file: { path: string }; onOpen: (path: string) => void }) =>
      createElement("button", { "data-diff-path": file.path, onClick: () => onOpen(file.path) }),
  };
});

const { TooltipProvider } = await import("@caveman-app/ui/components/tooltip");
const { RuntimeFixture } = await import("../../state/runtime.tsx");
const { PanelWorkspace } = await import("../workspace.ts");
const { getPanel, resetPanels } = await import("../store.ts");
const { StepDiff } = await import("./StepDiff.tsx");

// chatWorkspace (sync/chats-view.ts): a chat Cloud's list shows on a Cloud computer carries no root_path.
const chat = {
  id: "W-cloud",
  session_id: "S-cloud",
  title: "Chat",
  status: "idle",
  engine: "claude-agent",
  repo: { url: "" },
  base_ref: "",
  branch: "",
  created_at: "",
  updated_at: "",
  computer: { id: "cc-1", kind: "caveman_cloud", label: "Cloud computer", status: "online" },
} as Workspace;
const FOLDER = "/home/caveman/work/acme-api";
// Claude Agent's Edit, as its tool result records it: the file by its absolute path on that computer.
const EDIT = JSON.stringify({
  filePath: `${FOLDER}/src/price.ts`,
  structuredPatch: [
    {
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 1,
      lines: ["-export const price = 10;", "+export const price = 12;"],
    },
  ],
});
const recorded: Result<"tool.diff"> = {
  root_path: FOLDER,
  path: `${FOLDER}/src/price.ts`,
  diff: EDIT,
};
const client = {
  call: async (method: string) =>
    method === "tool.diff" ? recorded : new Promise(() => undefined),
  on: () => () => undefined,
  subscribe: () => () => undefined,
};
const runtime = {
  status: "connected",
  error: null,
  client,
  identity: {},
  connection: 1,
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
};

let unmount = async () => undefined;
afterEach(async () => {
  await unmount();
  resetPanels();
});

test("an edit step in a chat on a Cloud computer names its file in the chat's folder, and Open file opens it there", async () => {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => {
    unmount = async () => undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  const step = createElement(StepDiff, { workspaceId: chat.id, item: "edit-1" });
  await act(async () =>
    root.render(
      createElement(RuntimeFixture, {
        value: runtime as never,
        children: createElement(
          TooltipProvider,
          null,
          createElement(PanelWorkspace.Provider, { value: chat }, step),
        ),
      }),
    ),
  );
  // tool.diff answers at once: its answer lands once the render's effects and their promise settle.
  await act(async () => undefined);
  const shown = host.querySelector<HTMLButtonElement>("[data-diff-path]");
  expect({
    header: host.querySelector(".font-mono")?.textContent,
    file: shown?.getAttribute("data-diff-path"),
  }).toEqual({ header: "src/price.ts", file: "src/price.ts" });
  await act(async () => shown!.click());
  expect(getPanel(chat.id).tabs.map((t) => ({ kind: t.kind, params: t.params }))).toContainEqual({
    kind: "file",
    params: { path: "src/price.ts" },
  });
});
