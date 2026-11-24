import type {
  ChiefBoard,
  ChiefChangeSet,
  ChiefProfile,
  Result,
} from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { workDocs, workGroups } from "../routes/chief/work-model.ts";
import { moveItem, queueItems, type ChiefItem } from "./chief-model.ts";
import { useChief } from "./chief.ts";
import { mount } from "./dom.test-support.ts";
import { RuntimeContext, type RuntimeContextValue } from "./runtime.tsx";

afterEach(() => vi.useRealTimers());

const at = "2026-11-06T10:00:00.000Z";
const home: ChiefProfile = {
  id: "ch-home",
  name: "Chief",
  avatar: { character: "caveman", tone: "medium" },
  model: null,
  access: null,
  project_ids: [],
  soul: "",
  home: true,
  created_at: at,
  updated_at: at,
};
const item = (id: string, over: Partial<ChiefItem> = {}): ChiefItem => ({
  id,
  chief_id: home.id,
  text: id,
  state: "queued",
  rank: 1,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: [],
  created_at: at,
  updated_at: at,
  ...over,
});
const answer = (board: ChiefBoard) =>
  ({
    workspace: { id: "ws-chief" },
    chief: home,
    availability: "ready",
    board,
    picker: [],
    model: null,
  }) as unknown as Result<"chief.get">;

/** The Chief's page on a runtime whose chief.get answers come from `get`; `notify` delivers a chief.board.updated. */
async function chiefPage(get: () => Promise<Result<"chief.get">>) {
  const handlers = new Map<string, (params: never) => void>();
  const client = {
    call: (method: string) => (method === "chief.get" ? get() : Promise.resolve({})),
    on: (method: string, handler: (params: never) => void) => (
      handlers.set(method, handler),
      () => handlers.delete(method)
    ),
  } as never;
  let chief!: ReturnType<typeof useChief>;
  const Page = () => {
    chief = useChief();
    return null;
  };
  const page = await mount(
    createElement(
      RuntimeContext.Provider,
      {
        value: {
          status: "connected",
          client,
          connection: 1,
          chiefHere: true,
        } as unknown as RuntimeContextValue,
      },
      createElement(Page),
    ),
  );
  await page.settle();
  return {
    page,
    chief: () => chief,
    notify: (board: ChiefBoard) =>
      act(async () => handlers.get("chief.board.updated")!(board as never)),
  };
}

test("a Chief read on connect shows its change sets, as a board update does", async () => {
  const changeSet: ChiefChangeSet = {
    id: "cs-1",
    title: "Rename the billing API",
    project_ids: ["p-api", "p-web"],
    contract: "## Contract\nGET /v2/bill",
    merge_order: ["p-api", "p-web"],
    state: "open",
    created_at: at,
    updated_at: at,
  };
  const board: ChiefBoard = {
    items: [
      item("it-1", { state: "started", project_ids: ["p-api", "p-web"], change_set_id: "cs-1" }),
    ],
    change_sets: [changeSet],
  };
  const { chief } = await chiefPage(async () => answer(board));
  expect(chief().status).toBe("ready");
  expect(chief().changeSets).toEqual([changeSet]);
  // The Work tab names the change set on its item, and the Library keeps its contract.
  const groups = workGroups(chief().items, [], chief().changeSets, "CH");
  expect(groups.flatMap((g) => g.work).map((w) => w.changeSet?.id ?? null)).toEqual(["cs-1"]);
  expect(workDocs(groups).flatMap((d) => d.docs.map((doc) => doc.key))).toEqual(["contract:cs-1"]);
});

test("a chief.get answer read before the latest board update does not put the older board back", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const before: ChiefBoard = {
    items: [item("a", { rank: 1 }), item("b", { rank: 2 })],
    change_sets: [],
  };
  const gets: Array<(r: Result<"chief.get">) => void> = [];
  const { page, chief, notify } = await chiefPage(
    () => new Promise((resolve) => gets.push(resolve)),
  );
  gets[0]!(answer(before));
  await page.settle();
  expect(queueItems(chief().items).map((i) => i.id)).toEqual(["a", "b"]);

  // The 30 s recheck: the runtime reads the board, then waits on the model picker and voice before it answers.
  vi.advanceTimersByTime(30_000);
  expect(gets).toHaveLength(2);
  // Meanwhile the person drags b above a: shown at once, then the runtime's board after the reorder.
  const moved = moveItem(chief().items, "b", "a");
  await act(async () => chief().setItems(moved));
  await notify({ items: moved, change_sets: [] });
  expect(queueItems(chief().items).map((i) => i.id)).toEqual(["b", "a"]);

  gets[1]!(answer(before));
  await page.settle();
  expect(queueItems(chief().items).map((i) => i.id)).toEqual(["b", "a"]);
  expect(chief().allItems.find((i) => i.id === "b")?.pinned).toBe(true);

  // The next answer with no board update while it was out is the board again.
  vi.advanceTimersByTime(30_000);
  gets[2]!(answer(before));
  await page.settle();
  expect(queueItems(chief().items).map((i) => i.id)).toEqual(["a", "b"]);
});
