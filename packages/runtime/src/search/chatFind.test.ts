// chat.find: what the model reads (the search's chats, then recent ones), who answers (the guide models, a plan
// first), and a writer that fails falling to the next.
import type { ChatFindInput } from "@caveman-app/engine-core/server/textGeneration";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ServerProvider,
} from "@caveman-app/protocol";
import type { ChatSearchHit, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import {
  chatFindCandidates,
  chatFindWriters,
  day,
  describeChat,
  findChats,
  type ChatFindDeps,
} from "./chatFind.ts";

const workspace = (id: string, title: string, updated: string, extra: Partial<Workspace> = {}) =>
  ({
    id,
    session_id: `s-${id}`,
    title,
    status: "idle",
    engine: "claude-agent",
    repo: { path: `/code/${id}-repo` },
    created_at: updated,
    updated_at: updated,
    ...extra,
  }) as unknown as Workspace;

const hit = (w: Workspace, text?: string): ChatSearchHit => ({
  workspace: w,
  passages:
    text === undefined
      ? []
      : [
          {
            kind: "user",
            cursor: 3,
            at: w.updated_at,
            text,
            marks: [],
            by: "words",
            item_id: "m1",
          },
        ],
  more: 0,
});

const provider = (driver: string, models: ReadonlyArray<string>, type = "max"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", type, label: driver },
  checkedAt: "2026-11-05T00:00:00.000Z",
  models: models.map((slug) => ({
    slug,
    name: slug === "claude-haiku-5-5" ? "Claude Haiku 5.5" : slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

const stripe = workspace("a", "Billing page", "2026-11-03T10:00:00.000Z", { project_id: "p1" });
const sidebar = workspace("b", "Sidebar flicker", "2026-11-04T10:00:00.000Z");
const old = workspace("c", "Old archived", "2026-11-05T09:00:00.000Z", { status: "archived" });
const setup = workspace("d", "Set up the repo", "2026-11-05T09:30:00.000Z", { kind: "setup" });

describe("chat.find", () => {
  test("reads the search's chats first, then the most recent of the rest, leaving out archived, setup and twice-seen ones", () => {
    const chats = chatFindCandidates(
      [hit(stripe, "set up the stripe webhook")],
      [stripe, sidebar, old, setup],
    );
    expect(chats.map((c) => c.workspace.id)).toEqual(["a", "b"]);
  });

  test("describes a chat by its project, engine and day, and its places by who said them", () => {
    const described = describeChat(hit(stripe, "set up the stripe webhook"), (id) =>
      id === "p1" ? "cloud" : undefined,
    );
    expect(described.title).toBe("Billing page");
    expect(described.about).toBe(
      `cloud, claude-agent, last active ${day(new Date(stripe.updated_at))}`,
    );
    expect(described.places).toEqual(["You: set up the stripe webhook"]);
    expect(
      describeChat(hit(sidebar), () => undefined).about.startsWith("b-repo, claude-agent"),
    ).toBe(true);
  });

  test("asks the guide models, a plan before a key, and falls back to the writer for titles when there are none", () => {
    const writers = chatFindWriters(DEFAULT_SERVER_SETTINGS, [
      provider("codex", ["gpt-6-luna"], "apiKey"),
      provider("claudeAgent", ["claude-sonnet-5-5", "claude-haiku-5-5"]),
    ]);
    expect(writers.map((w) => w.model)).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
    expect(chatFindWriters(DEFAULT_SERVER_SETTINGS, [])).toEqual([
      DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    ]);
  });

  test("a writer that fails falls to the next; the picks come back as the chats, with why and the model's name", async () => {
    const asked: Array<ChatFindInput> = [];
    const deps: ChatFindDeps = {
      search: () => Effect.succeed({ chats: [hit(stripe, "set up the stripe webhook")] }),
      workspaces: Effect.succeed([stripe, sidebar]),
      projects: Effect.succeed([{ id: "p1", name: "cloud" }]),
      settings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      providers: Effect.succeed([
        provider("codex", ["gpt-6-luna"]),
        provider("claudeAgent", ["claude-haiku-5-5"], "apiKey"),
      ]),
      generate: (input) => {
        asked.push(input);
        return input.modelSelection.model === "gpt-6-luna"
          ? Effect.fail(
              new TextGenerationError({ operation: "findChats", detail: "Codex is signed out." }),
            )
          : Effect.succeed({ picks: [{ index: 1, why: "You chased the flicker here yesterday" }] });
      },
      cwd: "/state",
    };
    const found = await Effect.runPromise(
      findChats(deps, "the flicker thing from yesterday", new Date(2026, 10, 5, 12)),
    );
    expect(asked.map((a) => a.modelSelection.model)).toEqual(["gpt-6-luna", "claude-haiku-5-5"]);
    expect(asked[0]!.today).toBe("Thu 2026-11-05");
    expect(asked[0]!.chats.map((c) => c.title)).toEqual(["Billing page", "Sidebar flicker"]);
    expect(found).toEqual({
      chats: [{ ...hit(sidebar), why: "You chased the flicker here yesterday" }],
      model: "Claude Haiku 5.5",
      read: 2,
    });
  });

  test("says why when every writer fails, and asks nothing when there are no chats", async () => {
    const deps: ChatFindDeps = {
      search: () => Effect.succeed({ chats: [] }),
      workspaces: Effect.succeed([sidebar]),
      projects: Effect.succeed([]),
      settings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      providers: Effect.succeed([provider("claudeAgent", ["claude-haiku-5-5"])]),
      generate: () =>
        Effect.fail(
          new TextGenerationError({ operation: "findChats", detail: "Claude is rate limited." }),
        ),
      cwd: "/state",
    };
    const failed = await Effect.runPromise(Effect.flip(findChats(deps, "flicker")));
    expect(failed.detail).toBe("Claude is rate limited.");
    const none = await Effect.runPromise(
      findChats({ ...deps, workspaces: Effect.succeed([]) }, "flicker"),
    );
    expect(none).toEqual({ chats: [], model: "", read: 0 });
  });
});
