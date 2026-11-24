// The artifacts each mounted transcript has seen, by session, so the side
// panel can list and open them without attaching to the session a second
// time. The transcript publishes; the panel reads. Same array in, no notify.
import { useSyncExternalStore } from "react";
import type { Artifact } from "../../state/transcript-model.ts";

const EMPTY: ReadonlyArray<Artifact> = [];
const bySession = new Map<string, ReadonlyArray<Artifact>>();
const listeners = new Set<() => void>();

export function publishArtifacts(sessionId: string, artifacts: ReadonlyArray<Artifact>): void {
  if (bySession.get(sessionId) === artifacts) return;
  bySession.set(sessionId, artifacts);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useArtifacts(sessionId: string | null): ReadonlyArray<Artifact> {
  return useSyncExternalStore(subscribe, () => (sessionId ? (bySession.get(sessionId) ?? EMPTY) : EMPTY));
}

/** The artifact a markdown open action points at: `<itemId>:<kind>:<line>`, or for images the first on that line. */
export function findArtifact(artifacts: ReadonlyArray<Artifact>, itemId: string, kind: string, line: number): Artifact | undefined {
  const prefix = `${itemId}:${kind}:${line}`;
  return artifacts.find((a) => a.id === prefix || a.id.startsWith(`${prefix}:`));
}
