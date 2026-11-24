// Where the app goes when a call shows work (VoiceCall.showing, runtime chief/voice/Call.ts `showItem`): the pull
// request's Review page, a chat with its changes open, or the chat itself. Pure, so the shell's hook stays small.
import type { VoiceShowing } from "@caveman-app/session-protocol";

export interface ShowingTarget {
  readonly path: string;
  /** For a chat's changes: the surface to open in that workspace once there. */
  readonly surface?: { readonly workspaceId: string; readonly kind: "diff"; readonly params: { readonly path?: string } };
}

export function showingTarget(s: VoiceShowing): ShowingTarget {
  if (s.kind === "pr" && s.project_id !== undefined && s.pr_number !== undefined) {
    return { path: `/review/${encodeURIComponent(s.project_id)}/${s.pr_number}${s.path ? `?file=${encodeURIComponent(s.path)}` : ""}` };
  }
  if (s.kind === "chat") return { path: `/w/${s.workspace_id}` };
  // Changes, or a pull request the runtime could not address: the chat's own diff.
  return { path: `/w/${s.workspace_id}`, surface: { workspaceId: s.workspace_id, kind: "diff", params: s.path ? { path: s.path } : {} } };
}

/** The same thing shown again is not opened again. */
export const showingKey = (s: VoiceShowing | undefined): string => (s ? `${s.kind}:${s.workspace_id}:${s.pr_number ?? ""}:${s.path ?? ""}` : "");
