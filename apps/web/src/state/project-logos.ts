// Project logos by id (Project.logo.id, a hash of the image's bytes). project.list carries only the id; the image comes
// once per id from project.logo.read and is kept in memory and in localStorage, so a reload's first frame draws it.
import { useEffect, useSyncExternalStore } from "react";
import { useRuntimeClient } from "./runtime.tsx";

const KEY = "caveman.projectLogos";
/** Images kept, oldest first out. Each is at most 64 KiB (about 87 KB as a data: URL); a pick is a few. */
const MAX = 48;
/** A read that failed is asked again after this, on the next render that needs it. */
const RETRY_MS = 30_000;

/** Only an image the page draws inline: never an address the browser would fetch. */
const isImage = (url: unknown): url is string =>
  typeof url === "string" && url.startsWith("data:image/");

function load(): Map<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return new Map(
      Object.entries(stored && typeof stored === "object" ? stored : {}).filter(
        (entry): entry is [string, string] => isImage(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

let logos: Map<string, string> | null = null;
const kept = () => (logos ??= load());
const listeners = new Set<() => void>();
/** project.logo.read asked, by project and id, and when. */
const asked = new Map<string, number>();

/** Keeps `url` as the image of the logo `id`. */
export function rememberLogo(id: string, url: string): void {
  if (!isImage(url)) return;
  const map = kept();
  if (map.get(id) === url) return;
  map.delete(id);
  map.set(id, url);
  while (map.size > MAX) map.delete(map.keys().next().value!);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage full: memory keeps it for this window.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The image of a project's logo: kept already, at once; otherwise asked of the runtime once for that id. */
export function useProjectLogoUrl(
  projectId: string,
  logo: { readonly id: string } | undefined,
): string | undefined {
  const id = logo?.id;
  const url = useSyncExternalStore(subscribe, () =>
    id === undefined ? undefined : kept().get(id),
  );
  const { client } = useRuntimeClient();
  useEffect(() => {
    if (id === undefined || url !== undefined || !client) return;
    const key = `${projectId}\0${id}`;
    const at = asked.get(key);
    if (at !== undefined && Date.now() - at < RETRY_MS) return;
    asked.set(key, Date.now());
    client.call("project.logo.read", { project_id: projectId }).then(
      (answer) => rememberLogo(answer.id, answer.url),
      () => undefined,
    );
  }, [client, projectId, id, url]);
  return url;
}
