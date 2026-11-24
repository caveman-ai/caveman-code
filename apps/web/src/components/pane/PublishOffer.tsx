// The strip on a chat's box once the chat wrote an agent file (`.caveman/agents/*.md`) and its turn is over: publish it
// to Caveman Cloud, as the chat's copy has it (by its absolute path), or not now. It shows only where this runtime
// reaches Cloud; a dismissal holds for that chat and file. Publishing is the Agents page's Publish (agent.publish).
import { Button } from "@caveman-app/ui/components/button";
import { Icon, LinkSquare02Icon, CloudIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type ReactNode } from "react";
import { CONSOLE, consoleUrl, notServed } from "../../routes/automations/cloud.ts";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { HOSTED_CLOUD } from "../../state/cloud.ts";
import { requestId, useRuntimeSelector } from "../../state/runtime.tsx";

const KEY = "caveman.publish-offer.dismissed";
const dismissedKey = (workspaceId: string, path: string) => `${workspaceId}\n${path}`;

function readDismissed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-200) : []);
  } catch {
    return new Set();
  }
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

export type OfferState = { readonly kind: "offer" } | { readonly kind: "busy" } | { readonly kind: "done"; readonly version: number; readonly href: string } | { readonly kind: "failed"; readonly message: string };

/** The strip itself, drawn from its state (tested by rendering). */
export function PublishOfferView({ path, state, onPublish, onDismiss }: { path: string; state: OfferState; onPublish: () => void; onDismiss: () => void }) {
  const name = nameOf(path);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 px-1 animate-in fade-in-0 motion-reduce:animate-none">
      <Icon icon={CloudIcon} className="size-4 shrink-0 text-muted-foreground" />
      {state.kind === "done" ? (
        <span className="min-w-0 flex-1 truncate text-foreground">
          Published <span className="font-mono">{name}</span> as v{state.version}.
        </span>
      ) : state.kind === "failed" ? (
        <span role="alert" className="min-w-0 flex-1 truncate text-destructive" title={state.message}>
          Couldn't publish {name}: {state.message}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono text-foreground">{path.slice(path.lastIndexOf("/") + 1)}</span>
          <span className="text-[hsl(var(--subtle-foreground))]"> is written. Publish it so Cloud can run it on its own.</span>
        </span>
      )}
      {state.kind === "done" ? (
        <Button size="sm" variant="ghost" className="h-7" onClick={() => openExternal(state.href)}>
          Open in Platform
          <Icon icon={LinkSquare02Icon} className="size-3" />
        </Button>
      ) : (
        <Button size="sm" className="h-7" disabled={state.kind === "busy"} onClick={onPublish}>
          {state.kind === "busy" ? "Publishing…" : state.kind === "failed" ? "Try again" : "Publish to Cloud"}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-7" onClick={onDismiss}>
        {state.kind === "done" ? "Done" : "Not now"}
      </Button>
    </span>
  );
}

/**
 * The strip for a chat, or null: the first agent file it wrote that was not dismissed, once Cloud is reachable here.
 * A hook, so the box draws its strip only when there is one.
 */
export function usePublishOffer(workspaceId: string, projectId: string | null, root: string | null, paths: ReadonlyArray<string>): ReactNode {
  const client = useRuntimeSelector((v) => v.client);
  const base = useRuntimeSelector((v) => v.settings?.cloud_url) ?? HOSTED_CLOUD;
  const [reach, setReach] = useState<"unknown" | "ok" | "no">("unknown");
  const [dismissed, setDismissed] = useState(readDismissed);
  const [state, setState] = useState<OfferState>({ kind: "offer" });
  const path = paths.find((p) => !dismissed.has(dismissedKey(workspaceId, p)));
  // One read tells whether this runtime publishes at all; a signed-out answer still offers (Publish then says why).
  useEffect(() => {
    if (!client || !path || reach !== "unknown") return;
    client.call("agent.published", {}).then(
      () => setReach("ok"),
      (e: unknown) => setReach(notServed(e) ? "no" : "ok"),
    );
  }, [client, path, reach]);
  if (!path || !projectId || reach !== "ok") return null;
  const dismiss = () => {
    const next = new Set(dismissed).add(dismissedKey(workspaceId, path));
    localStorage.setItem(KEY, JSON.stringify([...next]));
    setDismissed(next);
    setState({ kind: "offer" });
  };
  const publish = () => {
    if (!client) return;
    setState({ kind: "busy" });
    // The chat's own copy (its folder), where it wrote the file; the project's checkout when it works there.
    const file = root ? `${root.replace(/\/+$/, "")}/${path}` : path;
    client.call("agent.publish", { request_id: requestId(), project_id: projectId, path: file }).then(
      (r) => setState({ kind: "done", version: r.version, href: consoleUrl(base, CONSOLE.agent(r.agent_id)) }),
      (e: unknown) => setState({ kind: "failed", message: (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e)) }),
    );
  };
  return <PublishOfferView path={path} state={state} onPublish={publish} onDismiss={dismiss} />;
}
