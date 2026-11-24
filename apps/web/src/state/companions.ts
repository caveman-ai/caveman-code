// The companions people made (Settings > Appearance > Companion): the runtime's companions
// folder, read on every (re)connect, each file checked and drawn here and handed to the
// mascot's cast (@caveman-app/ui/mascot/cast). A file that cannot be used is kept with
// what is wrong, for Settings to show. Create starts a New chat with the image attached
// and a message pointing at the folder's README, the one place the drawing guide lives,
// so no chat carries it unless it is making a companion.
import { readCompanion } from "@caveman-app/shared/companion";
import type { Client } from "@caveman-app/session-protocol/client";
import { setMadeCompanions } from "@caveman-app/ui/mascot/cast";
import { useEffect, useSyncExternalStore } from "react";
import { useRuntimeClient } from "./runtime.tsx";

export type CompanionsFolder = { readonly folder: string; readonly problems: ReadonlyArray<{ readonly id: string; readonly problem: string }> };

let current: CompanionsFolder | null = null;
const listeners = new Set<() => void>();

/** What `companion.list` answered, checked: the drawn companions go to the cast, the rest come back as problems. */
export function takeCompanionList(list: { folder: string; files: ReadonlyArray<{ id: string; text?: string; problem?: string }> }): CompanionsFolder {
  const drawn = [];
  const problems = [];
  for (const f of list.files) {
    const read = f.text === undefined ? { problem: f.problem ?? "it could not be read" } : readCompanion(f.id, f.text);
    if ("companion" in read) drawn.push(read.companion);
    else problems.push({ id: f.id, problem: read.problem });
  }
  setMadeCompanions(drawn);
  return { folder: list.folder, problems };
}

/** Reads the folder again; a runtime from before companion.list has none, so a made pick falls back to the caveman. */
export function loadCompanions(client: Client): Promise<void> {
  return client.call("companion.list", {}).then(
    (list) => {
      current = takeCompanionList(list);
      listeners.forEach((l) => l());
    },
    () => setMadeCompanions([]),
  );
}

export function useCompanionsFolder(): CompanionsFolder | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Mounted once: the made companions on every (re)connect. */
export function CompanionsSync(): null {
  const { client, connection } = useRuntimeClient();
  useEffect(() => {
    if (client) void loadCompanions(client);
  }, [client, connection]);
  return null;
}

/** The message Create puts in New chat's box, beside the image. */
export const companionPrompt = (folder: string) =>
  `Make me a companion from this image. Read ${folder}/README.md first and follow it exactly: draw it in the Caveman cast's style, with every face, and save it as ${folder}/<id>.json.`;
