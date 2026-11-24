// How a chat that works in several sources shows them: the heading over one source's changed files, the names beside
// the chat's title, the lines at the top of its title menu. A chat in one source draws none of these.
import { workspaceSources, type WorkspaceSource } from "@caveman-app/session-protocol";
import { Folder01Icon, SourceCodeIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState } from "react";
import { useNavigate } from "react-router";
import { PrMark } from "../../routes/review/parts.tsx";
import { openPr } from "../../routes/review/surface.tsx";
import { chatSources, type ChatSources } from "../../state/sources.ts";
import { Icon } from "../transcript/marks.tsx";

/**
 * A chat's sources (state/sources.ts chatSources), the same object for as long as they read the same: a push about
 * the chat's status re-renders nothing that only reads its sources. Null for a chat in one source.
 */
export function useChatSources(workspace: ChatSources | undefined): ChatSources | null {
  const next = chatSources(workspace);
  const key = next ? JSON.stringify(next) : "";
  const [kept, setKept] = useState({ key, value: next });
  if (kept.key !== key) setKept({ key, value: next });
  return kept.key === key ? kept.value : next;
}

/**
 * One source's pull request, as the chat's own PrMark: a click reviews it beside the chat (`workspaceId`), else on the
 * Review page; without a project it only tells. Another repository's is read through the project by its owner/name.
 */
export function SourcePr({
  source,
  projectId,
  workspaceId,
  className,
}: {
  source: WorkspaceSource;
  projectId: string | null;
  workspaceId?: string | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();
  if (!source.pull_request) return null;
  return (
    <PrMark
      pr={source.pull_request}
      projectId={projectId}
      source={{
        name: source.name,
        ...(!source.primary && source.repository
          ? { repo: source.repository.full_name, host: source.repository.host }
          : {}),
      }}
      onOpen={(pr) => openPr(navigate, workspaceId, pr)}
      {...(className ? { className } : {})}
    />
  );
}

/**
 * The small heading over one source's changed files: its name, its pull request when it has one, and with `branch`
 * (the Changes tab, where there is room) the branch the chat works on there. The chat's sources share one branch
 * name, so the narrow lists (a turn's card, the file list) leave it to the foot of the chat's box, which says it once. A plain
 * folder has no branch and says what it is; `source` null: files in the chat's folder itself.
 */
export function SourceHeading({
  name,
  source,
  projectId,
  workspaceId,
  branch = false,
  className,
}: {
  name: string;
  source: WorkspaceSource | null;
  projectId: string | null;
  workspaceId?: string | null | undefined;
  branch?: boolean;
  className?: string;
}) {
  return (
    <div
      data-source-heading={name}
      className={cn("flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground", className)}
    >
      <span className="min-w-0 truncate font-medium text-foreground/80">
        {source ? name : "Chat's folder"}
      </span>
      {source?.folder ? (
        <span className="shrink-0 text-[11px]">Folder</span>
      ) : branch && source?.branch ? (
        <span
          className="min-w-0 truncate font-mono text-[11px]"
          title={`On ${source.branch}, from ${source.base_ref || "its checkout"}`}
        >
          {source.branch}
        </span>
      ) : null}
      {source ? <SourcePr source={source} projectId={projectId} workspaceId={workspaceId} /> : null}
    </div>
  );
}

/**
 * Beside the chat's title: the sources it works in by name, the primary first, each followed by its pull request.
 * The names give way before the title does (the header cuts its meta first).
 */
export function SourceNames({
  chat,
  projectId,
  workspaceId,
}: {
  chat: ChatSources;
  projectId: string | null;
  workspaceId: string;
}) {
  const sources = workspaceSources(chat);
  return (
    <span
      data-chat-sources
      className="flex min-w-0 items-center gap-2"
      title={`Works in ${sources.map((s) => s.name).join(", ")}`}
    >
      {sources.map((s) => (
        <span key={s.name} className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{s.name}</span>
          <SourcePr source={s} projectId={projectId} workspaceId={workspaceId} />
        </span>
      ))}
    </span>
  );
}

/** At the top of the title menu: one line per source, with its pull request. (The computer and the branch are the foot of the chat's box.) */
export function SourceLines({
  chat,
  projectId,
  workspaceId,
}: {
  chat: ChatSources;
  projectId: string | null;
  workspaceId: string;
}) {
  return workspaceSources(chat).map((s) => (
    <span key={s.name} data-chat-source={s.name} className="flex min-w-0 items-center gap-2">
      <Icon icon={s.folder ? Folder01Icon : SourceCodeIcon} />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      <SourcePr source={s} projectId={projectId} workspaceId={workspaceId} />
    </span>
  ));
}
