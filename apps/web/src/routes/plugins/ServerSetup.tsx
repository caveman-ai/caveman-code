// What a server of yours needs before it works, and the one control for each: Sign in for one that signs in through
// the runtime (OAuth), a paste field for each key it needs. The server's page shows it, and so does the end of an
// import, so a server brought in is set up without going looking for it.
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useState, type FormEvent } from "react";
import { openSoon } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { credentialLabel, type Server } from "./installed.ts";
import {
  CONNECT_ELSEWHERE,
  ErrorLine,
  KEY_ELSEWHERE,
  message,
  SIGN_IN_UNFINISHED,
  useConnectsElsewhere,
} from "./shared.tsx";

/** Sign in, or sign in again: opens the service's page in the browser; the list polls while it is signing in. */
export function SignInButton({
  server,
  onStarted,
  size = "sm",
}: {
  server: Server;
  onStarted: () => Promise<void>;
  size?: "sm" | "default";
}) {
  const { client } = useRuntimeClient();
  const elsewhere = useConnectsElsewhere();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Called from the click: the service's page opens in a tab that click opened (a browser blocks a later one).
  const start = async () => {
    const go = openSoon();
    setBusy(true);
    setError(null);
    try {
      const r = await client!.call("connector.connect", {
        request_id: requestId(),
        id: server.name,
      });
      // A refusal comes as an answer, not a failure (a Cloud computer that takes no sign-in): it is said as it came.
      if (r.status === "error") {
        go(null);
        setError(r.problem ?? SIGN_IN_UNFINISHED);
        return;
      }
      go(r.authorization_url);
      await onStarted();
    } catch (e) {
      go(null);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (elsewhere)
    return <span className="text-[12.5px] text-muted-foreground">{CONNECT_ELSEWHERE}</span>;
  return (
    <span className="flex shrink-0 items-center gap-2">
      <ErrorLine>{error}</ErrorLine>
      <Button
        size={size}
        disabled={busy || server.status === "signing_in"}
        onClick={() => void start()}
      >
        {busy
          ? "Checking…"
          : server.status === "signing_in"
            ? "Waiting for the browser…"
            : server.status === "needs_sign_in" && server.problem
              ? "Sign in again"
              : "Sign in"}
      </Button>
    </span>
  );
}

/** One key a server needs: pasted once, kept by the runtime, never shown again. */
export function KeyField({
  server,
  credential,
  onChanged,
}: {
  server: string;
  credential: Server["credentials"][number];
  onChanged: () => Promise<void>;
}) {
  const { client } = useRuntimeClient();
  // A Cloud computer that keeps nothing of its person's takes no key: no field and no Replace, and the line says
  // where. One an earlier version kept there can still be removed.
  const elsewhere = useConnectsElsewhere();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = credentialLabel(credential);
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      setValue("");
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError(message(e));
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (value !== "")
      void run(() =>
        client!.call("credential.grant", {
          request_id: requestId(),
          marketplace: "personal",
          name: credential.name,
          value,
        }),
      );
  };
  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        className="min-w-0 shrink-0 font-mono text-[12.5px] text-foreground"
        title={
          credential.header
            ? `Sent as the ${credential.header} header`
            : `Set as ${credential.name}`
        }
      >
        {label}
      </span>
      {credential.granted && !editing ? (
        <span className="ml-auto flex items-center gap-1">
          <span className="inline-flex items-center gap-1 pr-1 text-[12.5px] text-success">
            <Icon icon={Tick02Icon} className="size-3.5" /> Stored on this computer
          </span>
          {elsewhere ? null : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Replace
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void run(() =>
                client!.call("credential.revoke", {
                  request_id: requestId(),
                  marketplace: "personal",
                  name: credential.name,
                }),
              )
            }
          >
            Remove
          </Button>
        </span>
      ) : elsewhere ? (
        <span className="ml-auto text-[12.5px] text-muted-foreground">{KEY_ELSEWHERE}</span>
      ) : (
        <span className="ml-auto flex min-w-[240px] flex-1 items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label={`${label} for ${server}`}
            placeholder={`Paste ${label}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 min-w-0 flex-1 font-mono"
          />
          <Button type="submit" size="sm" disabled={value === ""}>
            Save
          </Button>
        </span>
      )}
      <ErrorLine>{error}</ErrorLine>
    </form>
  );
}

/** Everything a server needs, stacked: its sign-in, then its keys. Nothing when it needs nothing. */
export function ServerSetup({
  server,
  onChanged,
}: {
  server: Server;
  onChanged: () => Promise<void>;
}) {
  const signsIn = server.auth === "oauth" && server.status !== "connected";
  if (!signsIn && server.credentials.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {signsIn ? (
        <span className="self-start">
          <SignInButton server={server} onStarted={onChanged} />
        </span>
      ) : null}
      {server.credentials.map((c) => (
        <KeyField key={c.name} server={server.name} credential={c} onChanged={onChanged} />
      ))}
    </div>
  );
}
