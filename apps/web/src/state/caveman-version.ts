/**
 * Caveman versions this window already has, per chat and message. A rewrite is a paid model call: toggling back to it,
 * or a row the transcript window unmounts and mounts again, reads this instead of asking twice. Two asks for the same
 * message while the first is out share it. A failed ask is forgotten, so "try again" really asks again.
 */
const versions = new Map<string, Promise<string>>();
const KEEP = 200;

export function cavemanVersionOnce(sessionId: string, itemId: string, ask: () => Promise<string>): Promise<string> {
  const key = `${sessionId}\0${itemId}`;
  const kept = versions.get(key);
  if (kept) return kept;
  const asked = ask();
  versions.set(key, asked);
  if (versions.size > KEEP) versions.delete(versions.keys().next().value!);
  asked.catch(() => {
    if (versions.get(key) === asked) versions.delete(key);
  });
  return asked;
}

