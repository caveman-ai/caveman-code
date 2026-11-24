// Permissions (Session Protocol AccessMode) are upstream runtime modes under
// shorter names: Supervised, Auto-accept edits, Auto, Full access.
import type { RuntimeMode } from "@caveman-app/protocol";
import type { AccessMode } from "@caveman-app/session-protocol";

export const ACCESS_TO_RUNTIME_MODE: Record<AccessMode, RuntimeMode> = {
  ask: "approval-required",
  auto: "auto-accept-edits",
  review: "auto",
  full: "full-access",
};

export const RUNTIME_MODE_TO_ACCESS: Record<RuntimeMode, AccessMode> = {
  "approval-required": "ask",
  "auto-accept-edits": "auto",
  auto: "review",
  "full-access": "full",
};

/** upstream initial default for new threads. */
export const DEFAULT_ACCESS: AccessMode = "full";
