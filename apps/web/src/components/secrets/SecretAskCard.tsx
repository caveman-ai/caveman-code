import { Button } from "@caveman-app/ui/components/button";
import { textDirection } from "@caveman-app/ui/ai/text-direction";
import type { Repo } from "@caveman-app/session-protocol";
import { detectSecrets } from "@caveman-app/session-protocol/secrets";
import { Icon, Tick02Icon, LockPasswordIcon } from "@caveman-app/ui/icons/huge";
import { useState, type ReactNode } from "react";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";

/**
 * The agent asked for a secret (ask kind `secret`). The value goes to the
 * repository with secret.set; only then does ask.respond say `provided`, so the
 * value never rides in the answer or the session.
 */
export function SecretAskCard({
  name,
  repo,
  reason,
  resolution,
  sending,
  engineLabel,
  header,
  onProvided,
}: {
  name: string;
  repo: Repo;
  reason: string;
  resolution: string | null;
  /** The answer: "out" until the ask resolves, "failed" when ask.respond was refused, "elsewhere" when answered first there. */
  sending: "idle" | "out" | "failed" | "elsewhere";
  engineLabel: string;
  /** The engine mark, name and pager row the other asks show. */
  header: ReactNode;
  onProvided: (provided: boolean) => void;
}) {
  const { client } = useRuntimeClient();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // secret.set took the value: an answer that then didn't reach the agent goes again without it.
  const [stored, setStored] = useState(false);
  const resend = stored && sending === "failed" && !value.trim();

  const save = async () => {
    if (resend) return onProvided(true);
    // A pasted `NAME=value` line gives its value.
    const d = detectSecrets(value);
    const v = d.kind === "env" ? (d.entries.find((e) => e.name === name)?.value ?? d.entries[0]?.value ?? value) : value.trim();
    if (!client || !v) return;
    setBusy(true);
    setError(null);
    try {
      await client.call("secret.set", { request_id: requestId(), repo, secrets: [{ name, value: v }] });
      setValue("");
      setStored(true);
      onProvided(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2 rounded-xl border border-border bg-card p-4">
      {header}
      <div className="mb-1 flex items-center gap-2 text-[14px]">
        <Icon icon={LockPasswordIcon} className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-mono text-foreground">{name}</span>
      </div>
      {/* A long link in the reason wraps inside the card (whitespace-pre-wrap alone never breaks a URL), and can be selected. */}
      {reason ? <div dir={textDirection(reason)} className="mb-3 select-text whitespace-pre-wrap text-[14px] leading-[22px] text-muted-foreground [overflow-wrap:anywhere]">{reason}</div> : null}
      {resolution !== null ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Icon icon={Tick02Icon} className="size-3.5 text-success" />
          <span className="text-foreground">{resolution}</span>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-1.5"
        >
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste the value"
              aria-label={`Value for ${name}`}
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] placeholder:font-sans placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="submit"
              disabled={(!value.trim() && !resend) || busy || sending === "out"}
            >
              {busy ? "Saving…" : resend ? "Send again" : "Save secret"}
            </Button>
            <button
              type="button"
              disabled={sending === "out"}
              onClick={() => onProvided(false)}
              className="h-8 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              Decline
            </button>
          </div>
          <span className="text-[12px] text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : "Saved to this repository and set as an env var in new commands. The agent never sees the value."}
          </span>
          {sending === "elsewhere" ? (
            <div role="status" className="text-[13px] text-muted-foreground">
              Answered on another device
            </div>
          ) : sending === "failed" ? (
            <div role="alert" className="text-[13px] text-destructive">
              {stored ? `${name} is saved, but your answer didn't reach ${engineLabel}. Send it again or decline.` : `Your answer didn't reach ${engineLabel}. Save or decline again.`}
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}
