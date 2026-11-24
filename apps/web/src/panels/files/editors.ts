// The editors on the runtime's computer (editor.list, upstream discovery), read
// once per connection and shared, and the one the user last opened a file in.
// Opening and revealing go through editor.open, workspace paths only.

import { useEffect, useSyncExternalStore } from "react";
import { REVEAL_LABEL } from "../../lib/platform.ts";
import { requestId, type RuntimeClientValue, useRuntimeClient } from "../../state/runtime.tsx";

type Client = NonNullable<RuntimeClientValue["client"]>;
export interface Editors {
  readonly editors: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** The computer can select a file in its file manager (Finder). */
  readonly reveal: boolean;
}

const NONE: Editors = { editors: [], reveal: false };
const PREFERRED = "caveman.files.editor";
let known: { client: Client; connection: number; editors: Editors } | null = null;
let pending: Client | null = null;
const listeners = new Set<() => void>();

function load(client: Client, connection: number): void {
  if (pending === client || (known?.client === client && known.connection === connection)) return;
  pending = client;
  client.call("editor.list", {}).then(
    (answer: Partial<Editors> | undefined) => {
      // Whatever part of the answer is missing offers nothing.
      known = { client, connection, editors: { editors: answer?.editors ?? [], reveal: answer?.reveal === true } };
      pending = null;
      for (const l of listeners) l();
    },
    () => {
      // An older runtime without editor.list: nothing to offer.
      known = { client, connection, editors: NONE };
      pending = null;
    },
  );
}

/** What this computer can open files in; nothing until the first answer (or on a runtime that can't). */
export function useEditors(): Editors {
  const { client, connection } = useRuntimeClient();
  useEffect(() => {
    if (client) load(client, connection);
  }, [client, connection]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (known && known.client === client ? known.editors : NONE),
    () => NONE,
  );
}

/** The editor files open in: the last one picked, else the first installed. */
export function preferredEditor(editors: Editors): { id: string; label: string } | null {
  const id = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFERRED);
  return editors.editors.find((e) => e.id === id) ?? editors.editors[0] ?? null;
}

export function openInEditor(client: Client | null, workspaceId: string, path: string, options: { line?: number | undefined; editor?: string | undefined } = {}): Promise<void> {
  if (options.editor) localStorage.setItem(PREFERRED, options.editor);
  if (!client) return Promise.resolve();
  return client
    .call("editor.open", { request_id: requestId(), workspace_id: workspaceId, path, ...(options.line ? { line: options.line } : {}), ...(options.editor ? { editor: options.editor } : {}) })
    .then(() => undefined);
}

export function revealFile(client: Client | null, workspaceId: string, path: string): Promise<void> {
  if (!client) return Promise.resolve();
  return client.call("editor.open", { request_id: requestId(), workspace_id: workspaceId, path, reveal: true }).then(() => undefined);
}

/** "Reveal in Finder" on a Mac, File Explorer on Windows, the file manager elsewhere. */
export const revealLabel = () => REVEAL_LABEL;
