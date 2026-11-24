// A thread named in a chat ("From @Lead" over another agent's message, "To @Fix checkout" under a thread_send): opens that
// thread the way its sidebar row does.
import { useNavigate } from "react-router";
import { panes } from "../../panes/store.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";

/**
 * The composer's pill, at rest: opens that thread the way its sidebar row
 * does. A sender with no workspace (a delegated child) is a quiet label; a
 * thread this runtime does not have is a quiet dashed one. Out of the
 * composer it takes a little side room (no textarea to line up with).
 */
export function ThreadPill({
  workspaceId,
  title,
}: {
  workspaceId?: string | undefined;
  title: string;
}) {
  const open = useOpenThread(workspaceId);
  if (!workspaceId) {
    return (
      <span className="thread-pill thread-pill-quiet mx-0.5">
        <span className="thread-pill-at">@</span>
        {title}
      </span>
    );
  }
  if (open === null) {
    return (
      <span
        className="thread-pill thread-pill-quiet thread-pill-missing mx-0.5"
        title="Not on this runtime"
      >
        <span className="thread-pill-at">@</span>
        {title}
        <span className="sr-only"> (not on this runtime)</span>
      </span>
    );
  }
  return (
    <a
      href={`#/w/${workspaceId}`}
      title={`Open ${title}`}
      onClick={(e) => {
        e.preventDefault();
        open();
      }}
      className="thread-pill mx-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="thread-pill-at">@</span>
      {title}
    </a>
  );
}

/** Opens a thread this runtime has, as its pill does; null for one it cannot open (no workspace, not on this runtime). */
export function useOpenThread(workspaceId: string | undefined): (() => void) | null {
  const known = useRuntimeSelector(
    (v) => workspaceId !== undefined && v.workspaces.some((w) => w.id === workspaceId),
  );
  const navigate = useNavigate();
  if (workspaceId === undefined || !known) return null;
  return () => {
    panes.show(workspaceId);
    navigate(`/w/${workspaceId}`);
  };
}
