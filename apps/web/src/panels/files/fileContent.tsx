// fs.read for the file viewer and the chat's doc cards, with the last few
// reads cached so coming back to a tab paints at once. Its own module so the
// transcript can read a doc's title without loading the Files panel.

import type { Result } from "@caveman-app/session-protocol";
import { useEffect, useState, type ReactNode } from "react";
import { requestId, useRuntimeClient, useSession } from "../../state/runtime.tsx";
import { fileKind } from "./tree.ts";

export type Read = Result<"fs.read">;
export type FileState = { readonly status: "loading" } | { readonly status: "ready"; readonly file: Read } | { readonly status: "error"; readonly message: string };

export const IMAGE_MAX = 16 << 20;
/** The read cache holds at most this much content, and no single read over CACHE_ONE. */
const CACHE_BYTES = 32 << 20;
const CACHE_ONE = 4 << 20;
const cache = new Map<string, Read>();
let cached = 0;

function forget(key: string) {
  const old = cache.get(key);
  if (old) cached -= old.content.length;
  cache.delete(key);
}

/** Least recently used goes first. Sizes are content lengths (base64 or UTF-16 units), close enough to bytes for a cap. */
function remember(key: string, file: Read) {
  forget(key);
  if (file.content.length > CACHE_ONE) return;
  cache.set(key, file);
  cached += file.content.length;
  for (const k of cache.keys()) {
    if (cached <= CACHE_BYTES) break;
    forget(k);
  }
}

const initial = (key: string): FileState => {
  const file = cache.get(key);
  if (!file) return { status: "loading" };
  cache.delete(key); // most recently used again
  cache.set(key, file);
  return { status: "ready", file };
};

/** fs.read, re-run when `version` (agent edits; null: wait for it) changes; a re-read with the same bytes keeps the same object, so nothing re-renders. */
export function useFileContent(workspaceId: string, path: string, gitRef: string | undefined, version: number | null): { state: FileState; retry: () => void; replace: (content: string) => void; more: (() => void) | null } {
  const { client } = useRuntimeClient();
  const key = `${workspaceId}\0${gitRef ?? ""}\0${path}`;
  const [current, setCurrent] = useState(() => ({ key, state: initial(key) }));
  const [attempt, setAttempt] = useState(0);
  let shown = current;
  if (current.key !== key) {
    shown = { key, state: initial(key) };
    setCurrent(shown);
  }

  useEffect(() => {
    if (!client || version === null) return;
    let live = true;
    // Images read whole (up to the runtime's 16 MB clamp); text keeps the default 1 MB.
    // Pictures, audio, video and fonts are read whole (up to the clamp): a part of one shows nothing.
    const whole = ["image", "media", "font"].includes(fileKind(path));
    client.call("fs.read", { workspace_id: workspaceId, path, ...(gitRef ? { ref: gitRef } : {}), ...(whole ? { max_bytes: IMAGE_MAX } : {}) }).then(
      (file) => {
        if (!live) return;
        setCurrent((prev) => {
          const old = prev.key === key && prev.state.status === "ready" ? prev.state.file : null;
          if (old && old.content === file.content && old.size === file.size && old.truncated === file.truncated) return prev;
          remember(key, file);
          return { key, state: { status: "ready", file } };
        });
      },
      (e: unknown) => {
        if (!live) return;
        forget(key);
        setCurrent({ key, state: { status: "error", message: e instanceof Error ? e.message : String(e) } });
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, path, gitRef, key, version, attempt]);

  return {
    state: shown.state,
    retry: () => {
      setCurrent({ key, state: { status: "loading" } });
      setAttempt((a) => a + 1);
    },
    // A large text file's next window, after what shows (T3 #21466): read from where it ends, appended.
    more:
      client && shown.state.status === "ready" && shown.state.file.truncated && shown.state.file.encoding === "utf8"
        ? () => {
            const shownFile = shown.state.status === "ready" ? shown.state.file : null;
            if (!shownFile) return;
            const offset = new TextEncoder().encode(shownFile.content).length;
            void client.call("fs.read", { workspace_id: workspaceId, path, offset, ...(gitRef ? { ref: gitRef } : {}) }).then(
              (next) =>
                setCurrent((prev) => {
                  // Only onto the read it continues: a re-read since (an agent's edit) starts over.
                  if (prev.key !== key || prev.state.status !== "ready" || prev.state.file !== shownFile || next.encoding !== "utf8") return prev;
                  const file = { ...shownFile, content: shownFile.content + next.content, size: next.size, truncated: next.truncated };
                  remember(key, file);
                  return { key, state: { status: "ready", file } };
                }),
              () => {},
            );
          }
        : null,
    // What this client just wrote: shown (and cached) without a read.
    replace: (content: string) =>
      setCurrent((prev) => {
        if (prev.key !== key || prev.state.status !== "ready") return prev;
        const file = { ...prev.state.file, content, size: new TextEncoder().encode(content).length };
        remember(key, file);
        return { key, state: { status: "ready", file } };
      }),
  };
}

/**
 * Writes a file the viewer shows (a ticked checkbox), only over the content it read: a file the agent
 * changed meanwhile is read again instead. Null when it can't be written: not text, cut short, or at a ref.
 */
export function useFileWriter(workspaceId: string, path: string, gitRef: string | undefined, read: ReturnType<typeof useFileContent>): ((content: string) => void) | null {
  const { client } = useRuntimeClient();
  const file = read.state.status === "ready" ? read.state.file : null;
  if (!client || !file || gitRef || file.truncated || file.encoding !== "utf8") return null;
  return (content) => {
    void sha256(file.content)
      .then((if_match) => client.call("fs.write", { request_id: requestId(), workspace_id: workspaceId, path, content, if_match }))
      .then(() => read.replace(content), () => read.retry());
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What a file read re-runs on: agent edits plus reconnects (files may have changed while the socket was
 * down); both only grow. Null until the session's count is read: nothing refreshes (or reads twice) on
 * mount. Render `watch`.
 */
export function useFilesVersion(sessionId: string | null, connection: number): { version: number | null; watch: ReactNode } {
  const [edits, setEdits] = useState<number | null>(null);
  return {
    version: !sessionId ? connection : edits === null ? null : edits + connection,
    watch: sessionId ? <EditCount sessionId={sessionId} onChange={setEdits} /> : null,
  };
}

/**
 * The session's diffVersion (it bumps when the agent changes files), passed up only when it changes.
 * Its own component so a streaming reply re-renders this and not the tree. The session store is the
 * pane's, shared and ref-counted: no second attach.
 */
function EditCount({ sessionId, onChange }: { sessionId: string; onChange: (version: number) => void }) {
  const version = useSession(sessionId).view?.diffVersion;
  useEffect(() => {
    if (version !== undefined) onChange(version);
  }, [version, onChange]);
  return null;
}
