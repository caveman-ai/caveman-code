// One MCP server: yours (added, imported or a connector) or one an installed plugin brings (?plugin=<id>). The bar holds
// its switch and More; the page what it reaches, what it still needs (its sign-in, its keys) and its tools; the rail
// its facts. A plugin's server turns on and off with its plugin, and the switch says so.
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Icon, MoreHorizontalIcon } from "@caveman-app/ui/icons/huge";
import type { Result } from "@caveman-app/session-protocol";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bar, Page, PageEmpty, Pane, RailRow, RailSection } from "../../components/ListFrame.tsx";
import {
  CloudBadge,
  cloudOn,
  ConnectorCloudBadge,
  ConnectorCloudNote,
  ServerCloudKeys,
  useProfileStatus,
} from "../../components/cloud/trust.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { usePluginsData } from "./data.tsx";
import { pluginPath, type Server, serverNeeds, SOURCE_WORD } from "./installed.ts";
import {
  ALL_ENGINES,
  displayName,
  pluginScope,
  serverEngines,
  signInTag,
  tokenLabel,
} from "./model.ts";
import { ServerSetup } from "./ServerSetup.tsx";
import {
  EngineMarks,
  ErrorLine,
  message,
  OnOff,
  PaneSection,
  ScopeWord,
  useCall,
  useSwitchHere,
} from "./shared.tsx";
import { serverKey, skippedServer } from "./skipped-server.tsx";

const HOME = { label: "Plugins", to: "/plugins" };

export function ServerPage({ name, pluginId }: { name: string; pluginId: string | null }) {
  const data = usePluginsData();
  if (pluginId !== null) {
    const plugin = data.market.data?.plugins.find((p) => p.id === pluginId);
    if (data.market.data === null)
      return <Page bar={<Bar crumbs={[HOME, { label: name }]} />}>{null}</Page>;
    if (plugin === undefined || !plugin.mcp_servers.includes(name)) return <Missing name={name} />;
    return <PluginServerPage name={name} plugin={plugin} />;
  }
  const server = data.servers.data?.find((s) => s.name === name);
  if (data.servers.data === null)
    return <Page bar={<Bar crumbs={[HOME, { label: name }]} />}>{null}</Page>;
  if (server === undefined) return <Missing name={name} />;
  return <YourServerPage server={server} />;
}

function Missing({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <Page bar={<Bar crumbs={[HOME, { label: name }]} />}>
      <PageEmpty
        icon="tool-mcp"
        title={`No server named ${name}`}
        actions={
          <Button variant="secondary" onClick={() => navigate("/plugins")}>
            Back to Plugins
          </Button>
        }
      >
        It was removed, or its plugin was.
      </PageEmpty>
    </Page>
  );
}

/** What a server reaches, as people read it: its URL, or its command line. */
const target = (s: Pick<Server, "url" | "command" | "args">) =>
  s.url ?? [s.command, ...(s.args ?? [])].join(" ");

function YourServerPage({ server: s }: { server: Server }) {
  const { client } = useRuntimeClient();
  const switchHere = useSwitchHere();
  const data = usePluginsData();
  const cloud = cloudOn(useProfileStatus());
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Runs it and reloads; true when it worked, so a page only leaves after what it asked for happened. */
  const act = async (f: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      await data.servers.reload();
    }
  };
  const skippedList = useCall((c) => c.call("mcp.skipped", {}).then((r) => r.servers));
  const stalled = skippedList.data?.find((x) => x.server === serverKey(s.name));
  const skipping =
    stalled === undefined
      ? null
      : skippedServer(stalled.at, stalled.until, () =>
          void act(() => client!.call("mcp.retry", { request_id: requestId(), server: serverKey(s.name) })).then(() => skippedList.reload()),
        );
  const needs = serverNeeds(s);
  const signsIn = s.auth === "oauth" || s.auth === "github";
  const status = !s.enabled
    ? "Off"
    : s.auth === "oauth" && s.status
      ? signInTag({ status: s.status, problem: s.problem }).label
      : (needs ?? (s.auth === "github" ? "Uses this computer's GitHub login" : "On"));
  return (
    <Page
      bar={
        <Bar
          crumbs={[HOME, { label: s.name }]}
          actions={
            <>
              <OnOff
                checked={s.enabled}
                label={s.name}
                onChange={(enabled) =>
                  void act(() =>
                    client!.call("mcp.set_enabled", {
                      request_id: requestId(),
                      name: s.name,
                      enabled,
                      ...switchHere,
                    }),
                  )
                }
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More">
                    <Icon icon={MoreHorizontalIcon} className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(target(s))}>
                    {s.url ? "Copy URL" : "Copy command"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                    Remove…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
      }
      rail={
        <>
          <RailSection title="Status" className="pt-4">
            <RailRow label="Status">
              <span className={needs && s.enabled ? "text-warning" : undefined}>{status}</span>
            </RailRow>
            <RailRow label="From">{SOURCE_WORD[s.source].replace(/^From /, "")}</RailRow>
            <RailRow
              label="Whose"
              title="Yours, on this computer: every project's chats can use it"
            >
              <ScopeWord scope="me" />
            </RailRow>
          </RailSection>
          <RailSection title="Reach">
            <RailRow label="Engines">
              <EngineMarks engines={ALL_ENGINES} />
            </RailRow>
            <RailRow
              label="Idle cost"
              title="Its tool list, read into every request; estimated from bytes, 4 per token"
            >
              {tokenLabel(s.idle_tokens_estimate) ?? (
                <span className="text-muted-foreground">Once listed</span>
              )}
            </RailRow>
            {cloud ? (
              <RailRow label="Cloud">
                {s.auth ? (
                  <ConnectorCloudBadge {...s} id={s.name} onChanged={data.servers.reload} />
                ) : (
                  <CloudBadge
                    kind="server"
                    ids={[s.name]}
                    keysOff={s.credentials.some((c) => c.granted) && s.cloud_available !== true}
                  />
                )}
              </RailRow>
            ) : null}
          </RailSection>
        </>
      }
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">
          {s.name}
        </h1>
        <p className="mt-1 break-all font-mono text-[12.5px] leading-5 text-muted-foreground">
          {target(s)}
        </p>
        <ErrorLine>{error}</ErrorLine>
        {(signsIn && s.auth === "oauth") || s.credentials.length > 0 ? (
          <PaneSection
            title={
              needs && s.enabled
                ? "Finish setting up"
                : s.credentials.length > 0
                  ? "Keys"
                  : "Sign-in"
            }
            warn={needs !== undefined && s.enabled}
          >
            {s.auth === "oauth" && s.status === "connected" ? (
              <p className="mb-3 text-[13px] text-muted-foreground">
                Signed in. The runtime holds the sign-in and renews it.
              </p>
            ) : null}
            {s.auth === "oauth" && needs && s.status !== "connected" ? (
              <p className="mb-3 text-[13px] text-muted-foreground">
                {s.problem ??
                  "It signs in through your browser; the runtime keeps the sign-in, never the engine."}
              </p>
            ) : null}
            {s.credentials.length > 0 && !s.credentials.every((c) => c.granted) ? (
              <p className="mb-3 text-[13px] text-muted-foreground">
                Paste each once. It is kept on this computer, given only to this server, and never
                shown again.
              </p>
            ) : null}
            <ServerSetup server={s} onChanged={data.servers.reload} />
            <div className="mt-3 empty:hidden">
              <ServerCloudKeys server={s} onChanged={data.servers.reload} />
            </div>
            <ConnectorCloudNote reason={s.held_reason} />
          </PaneSection>
        ) : null}
        {skipping ? (
          <div className="mt-4 flex items-start gap-2">
            {skipping.tag}
            <div className="flex-1">{skipping.note}</div>
            {skipping.retry}
          </div>
        ) : null}
        {s.problem && s.status !== "connected" && s.auth !== "oauth" ? (
          <p className="mt-4 text-[12.5px] text-warning">{s.problem}</p>
        ) : null}
        <Tools server={s.name} listed={s.tools} onListed={data.servers.reload} />
      </Pane>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${s.name}?`}
        description="Chats stop reaching it, and the keys you gave it are deleted from this computer."
        confirmLabel="Remove"
        destructive
        onConfirm={() =>
          void act(() =>
            client!.call("mcp.remove", { request_id: requestId(), name: s.name }),
          ).then((ok) => ok && navigate("/plugins"))
        }
      />
    </Page>
  );
}

function PluginServerPage({
  name,
  plugin,
}: {
  name: string;
  plugin: NonNullable<ReturnType<typeof usePluginsData>["market"]["data"]>["plugins"][number];
}) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const switchHere = useSwitchHere();
  const [error, setError] = useState<string | null>(null);
  const sse = (plugin.sse_servers ?? []).includes(name);
  const toggle = (enabled: boolean) =>
    client!
      .call("plugin.set_enabled", {
        request_id: requestId(),
        plugin_id: plugin.id,
        enabled,
        ...switchHere,
      })
      .then(
        () => data.market.reload(),
        (e) => setError(message(e)),
      );
  return (
    <Page
      bar={
        <Bar
          crumbs={[
            HOME,
            { label: displayName(plugin), to: pluginPath(plugin.id) },
            { label: name },
          ]}
          actions={
            plugin.required ? undefined : (
              <OnOff
                checked={plugin.enabled}
                label={`${displayName(plugin)} (brings ${name})`}
                title={`Comes with ${displayName(plugin)}: this turns the whole plugin on or off`}
                onChange={(on) => void toggle(on)}
              />
            )
          }
        />
      }
      rail={
        <>
          <RailSection title="Status" className="pt-4">
            <RailRow label="Status">{plugin.enabled ? "On" : "Off"}</RailRow>
            <RailRow label="From">
              <Link
                to={pluginPath(plugin.id)}
                className="truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {displayName(plugin)}
              </Link>
            </RailRow>
            <RailRow label="Whose">
              <ScopeWord scope={pluginScope(plugin)} />
            </RailRow>
          </RailSection>
          <RailSection title="Reach">
            <RailRow
              label="Engines"
              title={
                sse ? "An SSE server: Codex and the Caveman engine have no SSE client" : undefined
              }
            >
              <EngineMarks engines={serverEngines(plugin, name)} />
            </RailRow>
            <RailRow
              label="Idle cost"
              title="Its tool list, read into every request; estimated from bytes, 4 per token"
            >
              {tokenLabel(plugin.server_idle_tokens_estimate?.[name]) ?? (
                <span className="text-muted-foreground">Once listed</span>
              )}
            </RailRow>
          </RailSection>
        </>
      }
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">
          {name}
        </h1>
        <p className="mt-1 text-[13.5px] leading-[21px] text-muted-foreground">
          Comes with{" "}
          <Link
            to={pluginPath(plugin.id)}
            className="rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {displayName(plugin)}
          </Link>
          , and is on while it is. {plugin.needs_connect ? "Sign in on the plugin's page." : ""}
        </p>
        <ErrorLine>{error}</ErrorLine>
        <Tools server={name} plugin={plugin.id} onListed={data.market.reload} />
      </Pane>
    </Page>
  );
}

type ToolList = Result<"mcp.tools">["tools"];

/**
 * Its tools, as last listed; List asks the server now, through the runtime's hub, which starts it if it isn't running.
 * `plugin`: the id of the plugin whose server it is, by the name its .mcp.json gives it (never a key the page builds,
 * which the runtime reads as one of the person's own servers).
 */
function Tools({
  server,
  plugin,
  listed,
  onListed,
}: {
  server: string;
  plugin?: string;
  listed?: ReadonlyArray<string> | undefined;
  onListed?: () => Promise<void>;
}) {
  const { client } = useRuntimeClient();
  const [tools, setTools] = useState<ToolList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = async () => {
    setBusy(true);
    setError(null);
    try {
      setTools(
        (await client!.call("mcp.tools", plugin === undefined ? { server } : { plugin, server }))
          .tools,
      );
      await onListed?.();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const shown =
    tools ?? listed?.map((name) => ({ name, description: undefined as string | undefined }));
  return (
    <PaneSection
      title={shown ? `Tools ${shown.length}` : "Tools"}
      action={
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void list()}>
          {busy ? "Asking…" : shown ? "List again" : "List its tools"}
        </Button>
      }
    >
      {shown && shown.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
          {shown.map((t) => (
            <li key={t.name} className="flex min-w-0 items-baseline gap-3 px-4 py-2 text-[13px]">
              <span className="shrink-0 font-mono text-[12.5px] text-foreground">{t.name}</span>
              {t.description ? (
                <span className="min-w-0 truncate text-muted-foreground" title={t.description}>
                  {t.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : shown ? (
        <p className="text-[13px] text-muted-foreground">It lists no tools.</p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Not listed yet. Listing starts the server once and shows what each tool does and what it
          costs per request.
        </p>
      )}
      <ErrorLine>{error}</ErrorLine>
    </PaneSection>
  );
}
