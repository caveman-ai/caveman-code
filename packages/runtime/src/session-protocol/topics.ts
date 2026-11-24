// Workspace.topic and Workspace.topic_icon: a chat's group in the sidebar by topic and the group's emoji. The engine
// thread keeps them (OrchestrationV2ThreadTopic, named by the title writer or set by the person), so the runtime reads
// them from there (daemon.ts followThread) and sends the person's changes as thread.metadata.update.
import type { Workspace } from "@caveman-app/session-protocol";

/**
 * The emoji a chat has after the person sets its topic to `name`: `icon` when given (null: none); left out, the one it
 * has while the name stays the same, none under a new name. No topic, no emoji (Orchestrator's personTopic).
 */
export function personTopicIcon(
  current: Pick<Workspace, "topic" | "topic_icon">,
  name: string | null,
  icon: string | null | undefined,
): string | undefined {
  if (name === null) return undefined;
  if (icon !== undefined) return icon ?? undefined;
  return current.topic === name ? current.topic_icon : undefined;
}

/** `workspace` in topic `name` with emoji `icon` (null: in no group, no emoji); the same object when neither changes. */
export function withTopic(
  workspace: Workspace,
  name: string | null,
  icon: string | undefined,
): Workspace {
  const topic = name ?? undefined;
  const topic_icon = topic === undefined ? undefined : icon;
  if (workspace.topic === topic && workspace.topic_icon === topic_icon) return workspace;
  const { topic: _, topic_icon: __, ...rest } = workspace;
  return {
    ...rest,
    ...(topic === undefined ? {} : { topic }),
    ...(topic_icon === undefined ? {} : { topic_icon }),
  };
}
