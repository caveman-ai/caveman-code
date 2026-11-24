// Finish setting up: everything that waits on the person, done in one place, a kind of task at a time: sign in to each
// server, paste each key, connect each plugin, trust each plugin's hooks (after seeing what they run). A row turns into
// a check once done, read from the same lists the page shows, so the page's count drops as you go.
import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { Icon, SquareLock02Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import type { PluginSummary } from "./api.ts";
import { usePluginsData } from "./data.tsx";
import { type Need, pluginNeed, pluginPath, serverNeed, serverPath } from "./installed.ts";
import { containmentText, displayName, HOOK_EVENT_LABEL } from "./model.ts";
import { KeyField, SignInButton } from "./ServerSetup.tsx";
import { ErrorLine, focusDialog, message, useHere } from "./shared.tsx";

const LEAD: Record<Need["kind"], string> = {
  sign_in:
    "Each signs in through your browser. The runtime keeps the sign-in, never the engine, and renews it.",
  keys: "Paste each once. It is kept on this computer, given only to its server, and never shown again.",
  connect: "Each plugin signs in to its service on its own page.",
  hooks:
    "A hook runs a command on this computer around tool calls and sessions. Until you trust its plugin, none of its hooks run; any change to them asks again.",
};

/** `needs` as they were when it opened: a task's rows stay put and turn into checks as they get done. */
export function NeedsDialog({
  needs,
  onOpenChange,
}: {
  needs: ReadonlyArray<Need> | null;
  onOpenChange: (open: boolean) => void;
}) {
  const close = () => onOpenChange(false);
  return (
    <Dialog open={needs !== null} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        onOpenAutoFocus={focusDialog}
        className="flex flex-col outline-none focus-visible:ring-0"
      >
        {needs ? (
          <>
            <DialogHeader className="shrink-0">
              <DialogTitle className="text-[15px]">Finish setting up</DialogTitle>
              <DialogDescription>
                Each of these waits on you. Do them in any order, or leave some for later.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
              {needs.map((need) => (
                <section key={need.kind} aria-label={need.title}>
                  <h3 className="text-[13px] font-medium text-foreground">{need.title}</h3>
                  <p className="mb-2 mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">
                    {LEAD[need.kind]}
                  </p>
                  <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-card">
                    {need.rows.map((row) =>
                      need.kind === "sign_in" || need.kind === "keys" ? (
                        <ServerTask key={row.key} name={row.name} kind={need.kind} onOpen={close} />
                      ) : row.plugin ? (
                        <PluginTask
                          key={row.key}
                          id={row.plugin.id}
                          kind={need.kind}
                          onOpen={close}
                        />
                      ) : null,
                    )}
                  </div>
                </section>
              ))}
            </div>
            <DialogFooter className="shrink-0">
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One thing in a task: its name (opening its page) and what it reaches; `action` is one button at the right, `children` a form under it. */
function Task({
  name,
  to,
  done,
  onOpen,
  detail,
  action,
  children,
}: {
  name: string;
  to: string;
  done: boolean;
  onOpen: () => void;
  detail?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <Link
          to={to}
          onClick={onOpen}
          className="shrink-0 rounded-sm text-[13.5px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </Link>
        {detail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">
            {detail}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {done ? (
          <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-success">
            <Icon icon={Tick02Icon} className="size-3.5" /> Done
          </span>
        ) : (
          action
        )}
      </div>
      {done ? null : children}
    </div>
  );
}

function ServerTask({
  name,
  kind,
  onOpen,
}: {
  name: string;
  kind: "sign_in" | "keys";
  onOpen: () => void;
}) {
  const data = usePluginsData();
  const server = data.servers.data?.find((s) => s.name === name);
  if (!server) return null;
  const done = serverNeed(server)?.kind !== kind;
  return (
    <Task
      name={server.name}
      to={serverPath(server.name)}
      done={done}
      onOpen={onOpen}
      detail={server.url ?? server.command}
      action={
        kind === "sign_in" ? (
          <SignInButton server={server} onStarted={data.servers.reload} />
        ) : undefined
      }
    >
      {kind === "keys" ? (
        <div className="flex flex-col gap-2">
          {server.credentials
            .filter((c) => !c.granted)
            .map((c) => (
              <KeyField
                key={c.name}
                server={server.name}
                credential={c}
                onChanged={data.servers.reload}
              />
            ))}
        </div>
      ) : null}
    </Task>
  );
}

function PluginTask({
  id,
  kind,
  onOpen,
}: {
  id: string;
  kind: "connect" | "hooks";
  onOpen: () => void;
}) {
  const data = usePluginsData();
  const plugin = data.market.data?.plugins.find((p) => p.id === id);
  if (!plugin) return null;
  const done = pluginNeed(plugin)?.kind !== kind;
  return (
    <Task
      name={displayName(plugin)}
      to={pluginPath(plugin.id)}
      done={done}
      onOpen={onOpen}
      action={
        kind === "connect" ? (
          <Button size="sm" variant="secondary" asChild>
            <Link to={pluginPath(plugin.id)} onClick={onOpen}>
              Open to connect
            </Link>
          </Button>
        ) : undefined
      }
    >
      {kind === "hooks" ? <HookTrust plugin={plugin} /> : null}
    </Task>
  );
}

type HookLine = { event: string; command?: string; args?: ReadonlyArray<string>; prompt?: string };

/** What a hook runs, in one line: its command line, or a prompt hook's text. */
const run = (h: HookLine) =>
  h.command !== undefined ? [h.command, ...(h.args ?? [])].join(" ") : (h.prompt ?? "");

/** What a plugin's hooks run, how they are contained, and Trust. */
function HookTrust({ plugin }: { plugin: PluginSummary }) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const here = useHere();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contained = containmentText(plugin.containment);
  const entries: ReadonlyArray<HookLine> =
    plugin.hook_entries ?? plugin.hooks.map((event) => ({ event }));
  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      await client!.call("plugin.set_trusted", {
        request_id: requestId(),
        plugin_id: plugin.id,
        trusted: true,
        ...here,
      });
      await data.market.reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {entries.map((h, i) => (
          <li key={`${h.event}/${i}`} className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
            <span className="shrink-0 text-muted-foreground">
              {HOOK_EVENT_LABEL[h.event] ?? h.event}
            </span>
            <code
              className="min-w-0 truncate font-mono text-[11.5px] text-foreground/80"
              title={run(h)}
            >
              {run(h)}
            </code>
          </li>
        ))}
      </ul>
      <p
        className={cn(
          "flex items-start gap-1.5 text-[12px]",
          contained.strong ? "text-muted-foreground" : "text-warning",
        )}
        title={contained.label}
      >
        <Icon icon={SquareLock02Icon} className="mt-0.5 size-3.5 shrink-0" />
        <span className="line-clamp-1">
          {contained.strong
            ? "Contained: writes only to the workspace and its own folders"
            : contained.label}
        </span>
      </p>
      <span className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void trust()}>
          {busy ? "Trusting…" : "Trust its hooks"}
        </Button>
        <ErrorLine>{error}</ErrorLine>
      </span>
    </>
  );
}
