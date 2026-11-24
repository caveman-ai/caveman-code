import type { Repo } from "@caveman-app/session-protocol";
import { containsKnownSecret, detectSecrets, extractKnownSecrets, isHiddenSecret, secretsNotice, type SecretEntry } from "@caveman-app/session-protocol/secrets";
import { useEffect, useRef, useState } from "react";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import type { Mention } from "./ComposerSecrets.tsx";

type Pending = {
  /** Which catch this is: the sheet's key, so the next one opens fresh rather than in the last one's rows. */
  readonly id: number;
  readonly entries: ReadonlyArray<SecretEntry>;
  readonly mode: "paste" | "send";
  /** The caught text as it was, for "paste as text". */
  readonly original: string;
  /** What goes in its place once saved: "" for a whole env file, `$NAME`s for keys inside prose. */
  readonly replacement: string;
  /** Puts text back where the catch happened; `saved` is what was stored (empty for "paste as text"). */
  readonly place: (text: string, saved: ReadonlyArray<SecretEntry>) => void;
};

/**
 * The text that goes back once the sheet saved: a `$NAME` follows a rename,
 * and an entry left out (not a secret after all) gets its value back.
 */
export function settle(replacement: string, caught: ReadonlyArray<SecretEntry>, saved: ReadonlyArray<SecretEntry>): string {
  let out = replacement;
  for (const before of caught) {
    const after = saved.find((e) => e.value === before.value);
    if (after?.name === before.name) continue;
    // Names are [A-Za-z0-9_], so `$NAME` must not match the front of `$NAME_2`.
    out = out.replace(new RegExp(`\\$${before.name}(?![A-Za-z0-9_])`, "g"), () => (after ? `$${after.name}` : before.value));
  }
  return out;
}

/** What a person calls a repository before the runtime names its key: the folder or owner/name. */
export const repoLabel = (repo: Repo): string =>
  "path" in repo ? (repo.path.split("/").filter(Boolean).pop() ?? repo.path) : repo.url.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?\/?$/, "$1");

/**
 * The composer's secret catch. A paste (or a draft about to be sent) that
 * holds a .env, a key, or a key inside prose opens the sheet instead of
 * becoming text; saved values go straight to the runtime with secret.set
 * and live only in this hook's state until then. The message then carries
 * `secretsNotice(names)`: names, never values. It never brings up a .env
 * file on disk by itself: a Cloud start asks for those when it needs them.
 */
export function useSecretCatch(repo: Repo | null) {
  const { client } = useRuntimeClient();
  // Catches wait their turn: two .env files dropped together, or a drop while a paste's sheet is open, each keep
  // their entries and their `place` until the sheet before them is saved or dropped.
  const [queue, setQueue] = useState<ReadonlyArray<Pending>>([]);
  const pending = queue[0] ?? null;
  const caught = useRef(0);
  const [existing, setExisting] = useState<ReadonlySet<string>>(new Set());
  const [repository, setRepository] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReadonlyArray<Mention>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Text the user chose to paste as text: a send does not catch it again. */
  const allowed = useRef(new Set<string>());
  const repoKey = repo === null ? null : JSON.stringify(repo);

  const refresh = () => {
    if (!client || repo === null) return;
    client.call("secret.list", { repo }).then(
      (r) => {
        setRepository(r.repository);
        setExisting(new Set(r.secrets.map((s) => s.name)));
      },
      // A runtime before secrets answers method_not_found.
      () => setExisting(new Set()),
    );
  };

  useEffect(() => {
    setRepository(null);
    setExisting(new Set());
    refresh();
    // repoKey stands for repo: a new object naming the same repository changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, repoKey]);

  const open = (p: Omit<Pending, "id" | "entries">, entries: ReadonlyArray<SecretEntry>) => {
    const next = { ...p, id: ++caught.current, entries };
    // The same draft sent again (or the same file dropped again) while its catch waits is that catch, not another.
    setQueue((q) => (p.mode === "send" && q.some((x) => x.mode === "send" && x.original === p.original) ? q : [...q, next]));
    refresh();
  };
  const done = (p: Pending) => {
    setQueue((q) => q.filter((x) => x !== p));
    setError(null);
  };

  /**
   * Checks text before it lands (a paste) or leaves (a send). True when it
   * held secrets: the caller must drop the default action; `place` later
   * puts the safe text (or, for "paste as text", the original) back.
   */
  const intercept = (text: string, mode: Pending["mode"], place: Pending["place"]): boolean => {
    let probe = text;
    for (const a of allowed.current) probe = probe.split(a).join(" ");
    const d = detectSecrets(probe);
    if (d.kind === "none") return false;
    if (d.kind === "embedded") {
      // Allowed text holds no known credential (pasteAsText), so the full text extracts the same keys.
      const x = extractKnownSecrets(text);
      open({ mode, original: text, replacement: x.text, place }, x.entries);
    } else {
      open({ mode, original: text, replacement: "", place }, d.entries);
    }
    return true;
  };

  const save = async (entries: SecretEntry[]) => {
    if (!client || repo === null || !pending) return;
    setBusy(true);
    setError(null);
    try {
      await client.call("secret.set", { request_id: requestId(), repo, secrets: entries });
      pending.place(settle(pending.replacement, pending.entries, entries), entries);
      const names = [...new Set(entries.map((e) => e.name))];
      const plain = entries.filter((e) => !isHiddenSecret(e.name, e.value)).map((e) => e.name);
      setSaved((s) => [...s, { label: names.length === 1 ? null : "Pasted", names, plain }]);
      done(pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** A file about to be attached: true when it held secrets and went to the sheet instead. */
  const interceptFile = async (file: File): Promise<boolean> => {
    const texty = /^\.env/i.test(file.name) || file.type === "" || file.type.startsWith("text/") || /json|yaml|toml|xml/.test(file.type);
    if (!texty || file.size > 1024 * 1024) return false;
    return intercept(await file.text(), "send", () => undefined);
  };

  return {
    pending,
    existing,
    saved,
    busy,
    error,
    /** Where saved secrets go, for the sheet: the runtime's key once known; null without a repository. */
    repoLabel: repo === null ? null : (repository ?? repoLabel(repo)),
    intercept,
    interceptFile,
    save,
    cancel: () => pending && done(pending),
    /** Only for text with no known credential in it: those can never be sent as chat text. */
    pasteAsText:
      pending?.mode === "paste" && !containsKnownSecret(pending.original)
        ? () => {
            allowed.current.add(pending.original.trim());
            pending.place(pending.original, []);
            done(pending);
          }
        : undefined,
    /** Takes one save off this message (it stays stored). */
    unmention: (index: number) => setSaved((s) => s.filter((_, i) => i !== index)),
    /** What the message adds for the secrets saved while writing it. */
    notice: saved.length ? secretsNotice([...new Set(saved.flatMap((m) => m.names))]) : "",
    sent: () => setSaved([]),
  };
}
