import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, SquareIcon, BrowserIcon } from "@caveman-app/ui/icons/huge";
import { BarButton } from "../../../panels/chrome.tsx";
import { serverKey, serverMeta, type ChatServer } from "../../../state/chat-servers.ts";
import { Card } from "./Card.tsx";

/**
 * The Overview's Servers card (upstream #22542): the dev servers this chat's
 * terminals or its agent started, still running after the turn that started
 * them. A row opens its page beside the chat; Stop ends the server's job and
 * keeps the agent, the terminal and the runtime running. Hidden while none run.
 * Presentational: index.tsx feeds it from workspace.servers, the style page
 * from fixtures.
 */
export function ServersCard({
  servers,
  canStop,
  stopping,
  problem,
  onOpen,
  onStop,
}: {
  servers: ReadonlyArray<ChatServer>;
  canStop: boolean;
  /** serverKey of the one being stopped. */
  stopping: string | null;
  /** Why the last Stop failed, in the runtime's words. */
  problem: string | null;
  onOpen: (server: ChatServer) => void;
  onStop: (server: ChatServer) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <Card title="Servers" defaultOpen summary={<span className="text-[12px] tabular-nums text-muted-foreground">{servers.length}</span>}>
      <ul aria-label="Servers this chat started">
        {servers.map((server) => {
          const key = serverKey(server);
          const busy = stopping === key;
          const host = `localhost:${server.port}`;
          return (
            <li key={key} className="group/server relative flex h-8 items-center rounded-md">
              <button
                type="button"
                onClick={() => onOpen(server)}
                title={`Open ${host} beside the chat`}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-[13px] outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Icon icon={BrowserIcon} className="size-4 shrink-0" />
                <span className="shrink-0 font-mono text-[12.5px] text-foreground">{host}</span>
                <span
                  className={cn(
                    "ml-auto min-w-0 truncate pr-1 text-[12px] text-muted-foreground",
                    // The Stop button takes this place while it shows.
                    canStop && "transition-opacity duration-75 group-focus-within/server:opacity-0 group-hover/server:opacity-0 [@media(hover:none)]:opacity-0",
                    busy && "opacity-0",
                  )}
                >
                  {serverMeta(server)}
                </span>
              </button>
              {canStop ? (
                <span
                  className={cn(
                    "absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-75 group-focus-within/server:opacity-100 group-hover/server:opacity-100 [@media(hover:none)]:opacity-100",
                    busy && "opacity-100",
                  )}
                >
                  {busy ? <span className="text-[12px] text-muted-foreground">Stopping…</span> : null}
                  <BarButton size="sm" label={`Stop ${host}`} disabled={stopping !== null} onClick={() => onStop(server)} className="hover:text-destructive">
                    <Icon icon={SquareIcon} strokeWidth={2} className="!size-3" />
                  </BarButton>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem ? (
        <p role="alert" className="mx-1 mb-1 mt-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[12px] text-destructive">
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
