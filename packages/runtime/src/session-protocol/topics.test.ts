// Workspace.topic_icon: a topic's emoji lives on the engine thread with its topic, and reaches the workspace in
// workspace.topic's answer and through the projector (daemon.ts followThread).
import * as fs from "node:fs";

import { CommandId, ThreadId } from "@caveman-app/protocol";
import { connect, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import * as ServerSettings from "../serverSettings.ts";
import {
  makeConfig,
  makeRepo,
  MODEL,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";
import { personTopicIcon, withTopic } from "./topics.ts";

describe("topics", () => {
  const base = { id: "w", title: "Chat" } as Workspace;

  test("the person's emoji: given, kept under the same name, none under a new one or with no topic", () => {
    const current = { topic: "Sidebar Grouping", topic_icon: "🧭" };
    expect(personTopicIcon(current, "Sidebar Grouping", undefined)).toBe("🧭");
    expect(personTopicIcon(current, "Sidebar Grouping", "🗂️")).toBe("🗂️");
    expect(personTopicIcon(current, "Sidebar Grouping", null)).toBeUndefined();
    expect(personTopicIcon(current, "Sidebar Layout", undefined)).toBeUndefined();
    expect(personTopicIcon(current, "Sidebar Layout", "🧭")).toBe("🧭");
    expect(personTopicIcon(current, null, "🧭")).toBeUndefined();
  });

  test("a workspace's topic and emoji, none without a topic, the same object when nothing changes", () => {
    const grouped = withTopic(base, "Sidebar Grouping", "🧭");
    expect(grouped).toMatchObject({ topic: "Sidebar Grouping", topic_icon: "🧭" });
    expect(withTopic(grouped, "Sidebar Grouping", "🧭")).toBe(grouped);
    expect(withTopic(grouped, "Sidebar Grouping", undefined)).not.toHaveProperty("topic_icon");
    const loose = withTopic(grouped, null, "🧭");
    expect(loose).not.toHaveProperty("topic");
    expect(loose).not.toHaveProperty("topic_icon");
  });
});

describe("workspace.topic", () => {
  let root: string;
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;

  beforeAll(async () => {
    root = tempRoot("sp-topics-");
    config = await makeConfig();
    runtime = await startRuntime(config, "fake-claude", undefined, {
      provide: ServerSettings.layerTest().pipe(Layer.orDie),
    });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const threadTopic = (workspaceId: string) =>
    Effect.runPromise(
      orchestratorOf(runtime).getThreadRecords(ThreadId.make(`caveman:${workspaceId}`), []),
    ).then((records) => records.thread.topic);

  test("sets, keeps and clears a chat's emoji on the workspace and its engine thread", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await client.call("workspace.create", {
      request_id: "topic-icon",
      repo: { path: repo },
      engine: "claude-agent",
      options: { model: MODEL },
      title: "Group the sidebar",
    });
    let n = 0;
    const set = (topic: string | null, icon?: string | null) =>
      client.call("workspace.topic", {
        request_id: `topic-icon-${n++}`,
        workspace_id: w.id,
        topic,
        ...(icon === undefined ? {} : { icon }),
      });

    const grouped = await set("Sidebar Grouping", " 🧭 ");
    expect(grouped).toMatchObject({ topic: "Sidebar Grouping", topic_icon: "🧭" });
    expect(await threadTopic(w.id)).toEqual({ name: "Sidebar Grouping", by: "person", icon: "🧭" });

    // The same name with no icon given keeps it; a new name has none.
    expect(await set("Sidebar Grouping")).toMatchObject({
      topic: "Sidebar Grouping",
      topic_icon: "🧭",
    });
    const renamed = await set("Sidebar Layout");
    expect(renamed.topic).toBe("Sidebar Layout");
    expect(renamed).not.toHaveProperty("topic_icon");
    expect(await threadTopic(w.id)).toEqual({ name: "Sidebar Layout", by: "person" });

    // Picked again, then cleared with null.
    expect(await set("Sidebar Layout", "🗂️")).toMatchObject({ topic_icon: "🗂️" });
    expect(await set("Sidebar Layout", null)).not.toHaveProperty("topic_icon");

    // Out of every group: no topic and no emoji.
    await set("Sidebar Layout", "🗂️");
    const loose = await set(null);
    expect(loose).not.toHaveProperty("topic");
    expect(loose).not.toHaveProperty("topic_icon");
    expect((await client.call("workspace.get", { workspace_id: w.id })).topic_icon).toBeUndefined();

    // Only one emoji is an emoji: not text, not two, not blank.
    await expect(set("Sidebar Layout", "ab")).rejects.toMatchObject({
      error: { data: { reason: "invalid_params" } },
    });
    await expect(set("Sidebar Layout", "🧭🧭")).rejects.toMatchObject({
      error: { data: { reason: "invalid_params" } },
    });
    await expect(set("Sidebar Layout", "🧭 x")).rejects.toMatchObject({
      error: { data: { reason: "invalid_params" } },
    });
    await expect(set("Sidebar Layout", "  ")).rejects.toMatchObject({
      error: { data: { reason: "invalid_params" } },
    });
  });

  test("an emoji changed on the engine thread alone reaches the workspace", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await client.call("workspace.create", {
      request_id: "topic-follow",
      repo: { path: repo },
      engine: "claude-agent",
      options: { model: MODEL },
      title: "Relay drops",
    });
    await client.call("workspace.topic", {
      request_id: "topic-follow-1",
      workspace_id: w.id,
      topic: "Relay Reliability",
    });
    const before = await client.call("workspace.get", { workspace_id: w.id });
    expect(before.topic_icon).toBeUndefined();

    const dispatch = (n: number, topicIcon: string | null) =>
      Effect.runPromise(
        orchestratorOf(runtime).dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`topic-follow-thread-${n}`),
          threadId: ThreadId.make(`caveman:${w.id}`),
          topic: "Relay Reliability",
          topicIcon,
        }),
      );
    await dispatch(1, "📡");
    await until(
      async () => (await client.call("workspace.get", { workspace_id: w.id })).topic_icon === "📡",
    );
    const followed = await client.call("workspace.get", { workspace_id: w.id });
    expect(followed).toMatchObject({ topic: "Relay Reliability", topic_icon: "📡" });
    // Its group's mark changed, not its place in the list.
    expect(followed.updated_at).toBe(before.updated_at);

    await dispatch(2, null);
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: w.id })).topic_icon === undefined,
    );
    expect((await client.call("workspace.get", { workspace_id: w.id })).topic).toBe(
      "Relay Reliability",
    );
  });
});
