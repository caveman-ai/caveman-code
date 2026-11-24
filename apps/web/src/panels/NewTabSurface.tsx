// A fresh tab: one field that opens a file, a URL or a tool, the tools as a
// grid (Codex's new tab), and the workspace's local servers. Whatever opens
// takes this tab's place.

import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, RadioTowerIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState } from "react";
import { useRuntimeClient } from "../state/runtime.tsx";
import { formatChord, Keycap, SectionHeader } from "./chrome.tsx";
import { LaunchList } from "./launcher.tsx";
import { launcherSurfaces, type SurfaceProps } from "./registry.ts";
import { openSurface } from "./store.ts";
import { usePanelWorkspace } from "./workspace.ts";

const row = "flex h-10 w-full items-center gap-2.5 rounded-lg bg-secondary/50 px-3 text-left text-[13px] text-foreground outline-none transition-colors duration-75 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export default function NewTabSurface({ workspaceId, tab }: SurfaceProps<"new">) {
  const servers = useLocalServers(workspaceId);
  const tools = launcherSurfaces().filter((d) => d.kind !== "new");

  const idle = (
    <div className="mt-8 space-y-8">
      <section>
        <SectionHeader>Tools</SectionHeader>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {tools.map((d) => {
            const SurfaceIcon = d.icon;
            return (
              <button key={d.kind} type="button" className={row} onClick={() => openSurface(workspaceId, d.kind, {} as never, { replace: tab.id })}>
                <SurfaceIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{d.label}</span>
                {d.chord ? <Keycap className="ml-auto">{formatChord(d.chord)}</Keycap> : null}
              </button>
            );
          })}
        </div>
      </section>
      {servers.length > 0 ? (
        <section>
          <SectionHeader>Local servers</SectionHeader>
          <div className="overflow-hidden rounded-lg border border-border">
            {servers.map((server, i) => (
              <button
                key={server.url}
                type="button"
                onClick={() => openSurface(workspaceId, "browser", { url: server.url }, { replace: tab.id })}
                className={cn("flex h-12 w-full items-center gap-3 px-3 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent", i > 0 && "border-t border-border")}
              >
                <Icon icon={RadioTowerIcon} className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-foreground">{server.name}</span>
                  <span className="block font-mono text-[12px] text-muted-foreground">{server.url.replace(/^https?:\/\//, "")}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-6 pb-10 pt-8">
        <LaunchList
          workspaceId={workspaceId}
          replace={tab.id}
          autoFocus
          placeholder="Search or enter a URL, file or tool"
          fieldClassName="h-10 rounded-full border border-border bg-secondary/50 px-4 focus-within:border-input"
          listClassName="mt-2 rounded-lg border border-border"
          idle={idle}
        />
      </div>
    </div>
  );
}

/** What is listening on the workspace's computer (workspace.servers); the configured ports until the runtime can say. */
export function useLocalServers(workspaceId: string): ReadonlyArray<{ name: string; url: string }> {
  const { client } = useRuntimeClient();
  const ports = usePanelWorkspace()?.ports;
  const [listening, setListening] = useState<ReadonlyArray<{ name: string; url: string }> | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    client.call("workspace.servers", { workspace_id: workspaceId }).then(
      (r) => live && setListening(r.servers.map((s) => ({ name: s.process_name ?? "Listening", url: s.url }))),
      () => live && setListening(null),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return listening ?? Object.entries(ports ?? {}).map(([name, port]) => ({ name, url: `http://localhost:${port}` }));
}
