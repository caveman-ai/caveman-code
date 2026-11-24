import { detectSecrets, extractKnownSecrets, parseDotenv, SessionProtocolError, type Repo, type SecretEntry, type SecretInfo } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Textarea } from "@caveman-app/ui/components/textarea";
import { Icon, Delete02Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EnvImportSheet } from "../components/secrets/ComposerSecrets.tsx";
import { SecretSheet } from "../components/secrets/SecretSheet.tsx";
import { repoLabel } from "../components/secrets/useSecretCatch.ts";
import { relativeTime } from "../components/Transcript.tsx";
import { credentialsOutside } from "../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { recentRepos } from "../state/recent-repos.ts";
import { RepoCloudSecrets, repoOnCloud, type RepoOnCloud } from "../components/cloud/trust.tsx";
import { SettingRow, SettingsCard, SettingsCardBody } from "./settings/rows.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

type EnvFile = { readonly path: string; readonly names: ReadonlyArray<string> };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the card says where values are kept: in this computer's runtime. */
const KEPT_HERE =
  "Values stay in this computer's runtime, never shown again. Commands, setup scripts and engines get them as environment variables, scrubbed from what the agent and the transcript see.";
/**
 * The same on a Cloud computer that keeps nothing of its person's (state/engines.ts credentialsOutside): it stores no
 * secret and takes none, so the page lists the names and offers nothing that adds, replaces or deletes one.
 */
export const KEPT_OUTSIDE =
  "Secrets are added and deleted in Settings on your own device, never from inside a Cloud computer. Commands, setup scripts and engines here get them as environment variables, scrubbed from what the agent and the transcript see.";

/** Repositories this computer works on: its chats' and the recent ones this browser remembers (state/recent-repos.ts). */
function knownRepos(workspaceRepos: ReadonlyArray<Repo>): Repo[] {
  const recent = recentRepos().map((r): Repo => (r.startsWith("/") || r.startsWith("~") ? { path: r } : { url: r }));
  const seen = new Map<string, Repo>();
  for (const r of [...workspaceRepos, ...recent]) seen.set(JSON.stringify(r), r);
  return [...seen.values()];
}

/**
 * Settings -> Secrets: one repository at a time (a picker, not tabs). Names
 * and when they changed; values never come back. Add by pasting a .env or a
 * key, or store a git-ignored .env file the runtime reads itself.
 */
export function SecretsSettings({ repo: fixed }: { readonly repo?: Repo } = {}) {
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const repos = knownRepos(workspaces.map((w) => w.repoRef));
  const [picked, setPicked] = useState<string | null>(null);
  // Settings > Projects passes its project's checkout; on its own the page picks one.
  const repo = fixed ?? repos.find((r) => JSON.stringify(r) === picked) ?? repos[0] ?? null;
  if (repo === null)
    return (
      <SettingsCard title="Secrets">
        <SettingRow label="No repository yet" description="Start a workspace first: secrets belong to a repository." />
      </SettingsCard>
    );
  const repoKey = JSON.stringify(repo);
  const picker = fixed ? null : (
    <SettingRow label="Repository">
      <Select value={repoKey} onValueChange={setPicked}>
        <SelectTrigger aria-label="Repository" className="h-8 w-auto min-w-[200px] text-[13px]">
          <SelectValue placeholder="Repository" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((r) => (
            <SelectItem key={JSON.stringify(r)} value={JSON.stringify(r)}>
              {repoLabel(r)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
  // A page per repository (Settings > Projects keeps this row from one project to the next): what one read, has open
  // or still has running stays with it, and the next starts empty.
  return <RepoSecrets key={repoKey} repo={repo} picker={picker} />;
}

/** One repository's secrets: everything here belongs to `repo`, the repository every button acts on. */
function RepoSecrets({ repo, picker }: { readonly repo: Repo; readonly picker: ReactNode }) {
  const { client } = useRuntimeClient();
  const outside = credentialsOutside(useRuntimeSelector((v) => v.engines));
  const repoKey = JSON.stringify(repo);
  const [repository, setRepository] = useState<string | null>(null);
  /** keyOf refused: the checkout's origin no longer names the repository its secrets were pinned to. */
  const [originChanged, setOriginChanged] = useState(false);
  const [secrets, setSecrets] = useState<ReadonlyArray<SecretInfo> | null>(null);
  const [onCloud, setOnCloud] = useState<RepoOnCloud | null>(null);
  const [envFiles, setEnvFiles] = useState<ReadonlyArray<EnvFile>>([]);
  const [paste, setPaste] = useState("");
  const [caught, setCaught] = useState<ReadonlyArray<SecretEntry> | null>(null);
  const [reviewing, setReviewing] = useState<EnvFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    const repo = JSON.parse(repoKey) as Repo;
    try {
      const [list, files] = await Promise.all([client.call("secret.list", { repo }), client.call("secret.env_files", { repo })]);
      setRepository(list.repository);
      setOriginChanged(false);
      setSecrets(list.secrets);
      setOnCloud(repoOnCloud(list));
      setEnvFiles(files.files.filter((f) => f.names.length > 0));
      setError(null);
    } catch (e) {
      setSecrets([]);
      setOnCloud(null);
      setOriginChanged(e instanceof SessionProtocolError && e.error.data?.reason === "invalid_state");
      setError(message(e));
    }
  }, [client, repoKey]);
  useEffect(() => {
    setSecrets(null);
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const catchPaste = () => {
    const d = detectSecrets(paste);
    const { entries: assigned } = parseDotenv(paste);
    const single = paste.trim();
    // Here the user asked to store: plain assignments count too, and so does one value however plain it looks.
    const entries =
      d.kind === "env" || d.kind === "token"
        ? d.entries
        : d.kind === "embedded"
          ? extractKnownSecrets(paste).entries
          : assigned.length === 0 && /^\S+$/.test(single)
            ? [{ name: "", value: single }]
            : assigned.filter((e) => e.value !== "");
    if (entries.length === 0) return setError("Paste NAME=value lines or a single key.");
    setPaste("");
    setCaught(entries);
  };

  // A failed list leaves secrets empty: say nothing rather than "0 secrets".
  const unknown = secrets === null || (error !== null && secrets.length === 0);
  const count = unknown ? null : `${secrets.length} ${secrets.length === 1 ? "secret" : "secrets"}`;
  return (
    <SettingsCard
      title="Secrets"
      description={
        <>
          {count ? (
            <>
              {count}
              {repository ? (
                <>
                  {" "}for <span className="font-mono text-[12px]">{repository}</span>
                </>
              ) : null}
              .{" "}
            </>
          ) : null}
          {outside ? KEPT_OUTSIDE : KEPT_HERE}
        </>
      }
      // The paste sheet opens above the add row and may overhang the card.
      className="overflow-visible"
    >
      {picker}
      {originChanged ? (
        <SettingRow label="Origin changed" description="Secrets are held back until you confirm the new origin. Accept only if you changed it yourself.">
          <Button variant="outline" disabled={busy} onClick={() => void run(() => client!.call("secret.repin", { request_id: requestId(), repo }))}>
            Accept new origin
          </Button>
        </SettingRow>
      ) : null}
      {secrets !== null ? (
        // RepoCloudSecrets draws its own card; inside this one it is a row.
        <div className="empty:hidden [&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent">
          <RepoCloudSecrets repo={repo} names={secrets.map((s) => s.name)} onCloud={onCloud} reload={load} />
        </div>
      ) : null}
      {(outside ? [] : envFiles).map((f) =>
        reviewing?.path === f.path ? (
          <SettingsCardBody key={f.path}>
            <EnvImportSheet
              file={f}
              repoLabel={repository ?? repoLabel(repo)}
              busy={busy}
              error={error}
              onImport={(names) =>
                void run(() => client!.call("secret.import", { request_id: requestId(), repo, path: f.path, names })).then((ok) => ok && setReviewing(null))
              }
              onCancel={() => setReviewing(null)}
              className="shadow-none"
            />
          </SettingsCardBody>
        ) : (
          <SettingRow
            key={f.path}
            icon={<Glyph name="secret" className="text-muted-foreground" />}
            label={<span className="font-mono text-[12.5px]">{f.path}</span>}
            description={`${f.names.length} ${f.names.length === 1 ? "variable" : "variables"} not stored yet`}
          >
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setReviewing(f);
              }}
            >
              Review
            </Button>
          </SettingRow>
        ),
      )}
      {secrets && secrets.length > 0 ? (
        secrets.map((s) => (
          <SettingRow
            key={s.name}
            label={<span className="font-mono text-[12.5px]">{s.name}</span>}
            description={
              <>
                {s.hidden ? (
                  "Hidden from the agent"
                ) : (
                  <span className="text-warning" title="Too short or too plain to scrub from output: the agent can see it if a command prints it.">
                    Visible to the agent if printed
                  </span>
                )}
                {" · "}Updated {relativeTime(s.updated_at)}
              </>
            }
          >
            {outside ? null : (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => client!.call("secret.delete", { request_id: requestId(), repo, name: s.name }))}
                aria-label={`Delete ${s.name}`}
              >
                <Icon icon={Delete02Icon} className="size-3.5" />
              </Button>
            )}
          </SettingRow>
        ))
      ) : secrets === null ? (
        <SettingRow label="Loading…" />
      ) : unknown ? null : (
        <SettingRow label="No secrets yet" description={outside ? undefined : "Paste a .env into any chat, or below."} />
      )}
      <div className="relative">
        {caught ? (
          <SecretSheet
            entries={caught}
            existing={new Set(secrets?.map((s) => s.name) ?? [])}
            repoLabel={repository ?? repoLabel(repo)}
            mode="send"
            busy={busy}
            error={error}
            onSave={(entries) =>
              void run(() => client!.call("secret.set", { request_id: requestId(), repo, secrets: entries })).then((ok) => ok && setCaught(null))
            }
            onCancel={() => setCaught(null)}
          />
        ) : null}
        {error && caught === null && reviewing === null ? (
        <p role="alert" className="px-5 py-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
        {outside ? null : (
          <SettingRow id="secret-paste" label="Add secrets" description="Paste a .env file or a single key. Add a name again to replace it." stacked>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                catchPaste();
              }}
              className="flex flex-col gap-2"
            >
              <Textarea
                id="secret-paste"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={2}
                placeholder="Paste a .env file or a key"
                autoComplete="off"
                spellCheck={false}
                className="min-h-9 resize-y font-mono text-[12.5px] [-webkit-text-security:disc] placeholder:font-sans"
              />
              <div className="flex justify-end">
                <Button type="submit" variant="secondary" disabled={!paste.trim() || busy}>
                  Add
                </Button>
              </div>
            </form>
          </SettingRow>
        )}
      </div>
    </SettingsCard>
  );
}
