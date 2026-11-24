// A plugin's page: the bar holds its switch, Install or More; the page says what it does, what to try, what still
// needs you (a sign-in, hooks to trust) and what it includes; the rail its facts (whose, engines, idle cost, source,
// links). Opened from Browse (?in=browse) its bar leads back there.
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Tag } from "@caveman-app/ui/components/tag";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowRight01Icon, LinkSquare02Icon, MoreHorizontalIcon, SquareLock02Icon } from "@caveman-app/ui/icons/huge";
import { useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Bar, Page, Pane, RailRow, RailSection } from "../../components/ListFrame.tsx";
import { ConnectMark, type ConnectState, useLanded } from "../../components/ConnectMark.tsx";
import { CloudBadge, cloudOn, useProfileStatus } from "../../components/cloud/trust.tsx";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { type PluginDetail } from "./api.ts";
import { CAVEMAN, sourceOf, sourcePath } from "./browse-model.ts";
import { useAccount, usePluginsData, useTryInChat } from "./data.tsx";
import { useInstall } from "./InstallDialog.tsx";
import { connectedLine, containmentText, displayName, type EngineKey, HOOK_EVENT_LABEL, includesLine, pluginScope, runsOutside, sharedByLine, tokenLabel } from "./model.ts";
import { PluginLogo } from "./PluginLogo.tsx";
import { CONNECT_ELSEWHERE, EngineMarks, ErrorLine, message, OnOff, PaneSection, ScopeWord, useCall, useConnectsElsewhere, useHere, useSwitchHere } from "./shared.tsx";
import { useSignIn } from "./signIn.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const STATUS_WORD = { me: "Installed for you", project: "Installed for a project", team: "Installed for your team" } as const;

export function DetailPage({ id }: { id: string }) {
  const { client } = useRuntimeClient();
  const navigate = useNavigate();
  const tryIt = useTryInChat();
  const account = useAccount();
  const here = useHere();
  const switchHere = useSwitchHere();
  const data = usePluginsData();
  const [params] = useSearchParams();
  const fromBrowse = params.get("in") === "browse";
  const read = useCall((c) => c.call("plugin.read", { id, ...here }).then((r) => r.plugin), undefined, here.cwd);
  const [uninstalling, setUninstalling] = useState(false);
  const [unshare, setUnshare] = useState<PluginDetail["server_details"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = read.data;
  /** Runs it and reloads; true when it worked, so the page only leaves after what it asked for happened. */
  const act = async (f: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      await Promise.all([read.reload(), data.market.reload(), data.skills.reload()]);
    }
  };
  const installer = useInstall(() => void Promise.all([read.reload(), data.reloadAll()]));
  const markets = data.market.data?.marketplaces ?? [];
  const source = p ? sourceOf(p.marketplace, markets) : undefined;
  // Back to the page it was opened from: the marketplace it is in, when that is not Caveman's.
  const crumbs = [{ label: "Plugins", to: fromBrowse && source && source !== CAVEMAN ? sourcePath(source) : "/plugins" }, { label: p ? displayName(p) : "Plugin" }];
  const canUninstall = p !== null && p.installed && (!p.required || account.admin);
  const actions = p ? (
    <>
      {p.required ? (
        <Tag tone="blue" title="Your team requires it: it cannot be turned off" className="mr-1">
          Required
        </Tag>
      ) : p.installed ? (
        <OnOff checked={p.enabled} label={displayName(p)} onChange={(enabled) => void act(() => client!.call("plugin.set_enabled", { request_id: requestId(), plugin_id: p.id, enabled, ...switchHere }))} />
      ) : (
        <InstallButton
          where={installer.where}
          busy={installer.busy === p.id}
          onInstall={() => installer.install(p)}
          onAsk={() => installer.ask(p)}
          onTry={p.default_prompts[0] ? () => tryIt({ id: p.id, label: displayName(p) }, p.default_prompts[0]!) : undefined}
        />
      )}
      {canUninstall ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <Icon icon={MoreHorizontalIcon} className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
            {p.default_prompts[0] ? <DropdownMenuItem onSelect={() => tryIt({ id: p.id, label: displayName(p) }, p.default_prompts[0]!)}>Try it in a chat</DropdownMenuItem> : null}
            {p.default_prompts[0] ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => setUninstalling(true)}>
              Uninstall…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  ) : null;

  return (
    <Page bar={<Bar crumbs={crumbs} actions={actions} />} rail={p ? <Rail plugin={p} /> : undefined}>
      <Pane>
        <ErrorLine>{read.error ?? error ?? installer.error}</ErrorLine>
        {p === null ? (
          read.error ? null : <div aria-hidden className="h-24 rounded-lg bg-foreground/[0.03]" />
        ) : (
          <>
            <div className="flex items-start gap-4">
              <PluginLogo plugin={p} size="lg" />
              <div className="min-w-0 flex-1 pt-1.5">
                <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">{displayName(p)}</h1>
                <p className="text-[13.5px] text-muted-foreground">{[p.interface.developer, p.interface.category].filter(Boolean).join(" · ") || p.marketplace}</p>
              </div>
            </div>
            <p className="mt-5 text-[14px] leading-[22px]">{p.long_description ?? p.interface.short_description ?? p.description}</p>
            {/* What the runtime left out of it: nothing to do about, so it reads quiet, without the plugin's name again. */}
            {p.problems?.length ? (
              <ul className="mt-3 flex flex-col gap-0.5 text-[12.5px] text-muted-foreground">
                {p.problems.map((problem) => (
                  <li key={problem}>{problem.startsWith(`${p.name}: `) ? problem.slice(p.name.length + 2) : problem}</li>
                ))}
              </ul>
            ) : null}

            {p.server_details.some((s) => s.auth) ? (
              <PaneSection title={p.installed && p.enabled && p.needs_connect ? "Finish setting up" : "Connect"} warn={p.installed && p.enabled && p.needs_connect}>
                <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
                  {p.server_details
                    .filter((s) => s.auth)
                    .map((s) => (
                      <ConnectRow
                        key={s.name}
                        pluginId={p.id}
                        server={s}
                        installed={p.installed}
                        admin={account.admin}
                        onConnected={() => void Promise.all([read.reload(), data.market.reload()])}
                        onDisconnect={account.admin && s.shared && (s.connected || s.shared_by !== undefined) ? () => setUnshare(s) : undefined}
                      />
                    ))}
                </div>
              </PaneSection>
            ) : null}

            {p.installed && p.hooks.length > 0 ? <Hooks plugin={p} onTrust={(trusted) => void act(() => client!.call("plugin.set_trusted", { request_id: requestId(), plugin_id: p.id, trusted, ...here }))} /> : null}

            {p.default_prompts.length > 0 ? (
              <PaneSection title="Try">
                <div className="flex flex-col gap-1.5">
                  {p.default_prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => tryIt({ id: p.id, label: displayName(p) }, prompt)}
                      className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-[13.5px] outline-none transition-colors duration-75 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">{prompt}</span>
                      <span className="shrink-0 text-[12.5px] text-muted-foreground group-hover:text-foreground">Try in chat</span>
                    </button>
                  ))}
                </div>
              </PaneSection>
            ) : null}

            <Includes plugin={p} />
          </>
        )}
      </Pane>
      {installer.dialog}
      {p ? (
        <ConfirmDialog
          open={uninstalling}
          onOpenChange={setUninstalling}
          title={`Uninstall ${displayName(p)}?`}
          description={p.scope === "team" ? "Your team stops getting it, and its sign-ins are forgotten." : p.scope === "project" ? "The project's chats stop loading it." : "Your chats stop loading it. You can install it again from Browse."}
          confirmLabel="Uninstall"
          destructive
          onConfirm={() => void act(() => client!.call("plugin.uninstall", { request_id: requestId(), id: p.id, scope: p.scope ?? "me", ...here })).then((ok) => (ok && !fromBrowse ? navigate("/plugins") : undefined))}
        />
      ) : null}
      {p && unshare ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setUnshare(null)}
          title={`Disconnect ${unshare.shared_by ? `${unshare.shared_by}'s` : "the team's"} ${displayName(p)} account?`}
          description="Everyone using it signs in with their own account until an admin connects the team's again. Caveman revokes its tokens."
          confirmLabel="Disconnect"
          destructive
          onConfirm={() => void act(() => client!.call("plugin.disconnect", { request_id: requestId(), id: p.id, server: unshare.name, ...here }))}
        />
      ) : null}
    </Page>
  );
}

/** The facts: whose it is, which engines get what, its idle cost, where it comes from, its links. */
function Rail({ plugin: p }: { plugin: PluginDetail }) {
  const reached = p.engines.filter((e) => e.gets.length > 0);
  const detail = p.engines.map((e) => `${e.engine}: ${e.gets.length > 0 ? e.gets.join(", ") : "nothing"}`).join("\n");
  return (
    <>
      <RailSection title="Status" className="pt-4">
        <RailRow label="Status">{p.required ? "Required by your team" : p.installed ? (p.enabled ? (p.needs_connect ? <span className="text-warning">Not connected</span> : "On") : "Off") : "Not installed"}</RailRow>
        {p.installed ? (
          <RailRow label="Whose" title={p.scope ? STATUS_WORD[p.scope] : undefined}>
            <ScopeWord scope={pluginScope(p)} />
          </RailRow>
        ) : null}
        {p.version ? <RailRow label="Version">{p.version}</RailRow> : null}
      </RailSection>
      <RailSection title="Reach">
        <RailRow label="Engines" title={detail}>
          <EngineMarks engines={reached.map((e) => e.engine as EngineKey)} />
        </RailRow>
        <RailRow label="Idle cost" title="Estimated from bytes (4 per token), not a measured count">
          {tokenLabel(p.idle_tokens_estimate) ?? <span className="text-muted-foreground">Not measured</span>}
        </RailRow>
        {p.installed ? <CloudRow id={p.id} /> : null}
      </RailSection>
      <RailSection title="Source">
        <p className="break-all font-mono text-[12px] leading-[18px] text-muted-foreground">
          {p.source === "caveman" ? "Caveman catalog" : p.source}
          {p.commit ? ` at ${p.commit.slice(0, 7)}` : ""}
        </p>
        {p.links.website || p.links.privacy || p.links.terms ? (
          <span className="mt-3 flex flex-wrap gap-x-4 gap-y-1 pb-6 text-[13px]">
            {(
              [
                ["Website", p.links.website],
                ["Privacy", p.links.privacy],
                ["Terms", p.links.terms],
              ] as const
            ).map(([label, url]) =>
              url ? (
                <button key={label} type="button" onClick={() => openExternal(url)} className="inline-flex items-center gap-1 rounded text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                  {label} <Icon icon={LinkSquare02Icon} className="size-3" />
                </button>
              ) : null,
            )}
          </span>
        ) : (
          <span className="block pb-6" />
        )}
      </RailSection>
    </>
  );
}

/** Whether your Cloud computers get it too (profile sync); nothing when Cloud is off or does not list it. */
function CloudRow({ id }: { id: string }) {
  const status = useProfileStatus();
  if (!cloudOn(status) || !status.items.some((i) => i.kind === "plugin" && i.id === id)) return null;
  return (
    <RailRow label="Cloud">
      <CloudBadge kind="plugin" ids={[id]} />
    </RailRow>
  );
}

/**
 * Its hooks: the commands it runs around tool calls and sessions, and whether you trust them. Until you do, no engine
 * runs any; trust holds for its files as they are now, and any change asks again.
 */
function Hooks({ plugin: p, onTrust }: { plugin: PluginDetail; onTrust: (trusted: boolean) => void }) {
  const trusted = p.trusted === true;
  const contained = containmentText(p.containment);
  const entries = p.hook_entries ?? p.hooks.map((event) => ({ event }) as { event: string; matcher?: string; command?: string; args?: ReadonlyArray<string>; prompt?: string; type?: string });
  return (
    <PaneSection
      title={trusted ? "Hooks" : p.trust_dropped ? "Its hooks changed: trust them again" : "Hooks wait for your trust"}
      warn={!trusted && p.enabled}
      action={
        <Button size="sm" variant={trusted ? "ghost" : "default"} onClick={() => onTrust(!trusted)}>
          {trusted ? "Stop trusting" : "Trust its hooks"}
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {entries.map((h, i) => (
          <li key={`${h.event}/${i}`} className="flex min-w-0 items-baseline gap-2 text-[13px]">
            <span className="shrink-0 text-foreground">{HOOK_EVENT_LABEL[h.event] ?? h.event}</span>
            {h.matcher ? <span className="shrink-0 text-muted-foreground">on {h.matcher}</span> : null}
            <code className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={h.command !== undefined ? [h.command, ...(h.args ?? [])].join(" ") : h.prompt}>
              {runsOutside(h) ? <span className="text-warning">outside the plugin · </span> : null}
              {h.command !== undefined ? [h.command, ...(h.args ?? [])].join(" ") : (h.prompt ?? `${h.type ?? "command"} hook`)}
            </code>
          </li>
        ))}
      </ul>
      <p className={cn("mt-3 flex items-start gap-1.5 text-[12px]", contained.strong ? "text-muted-foreground" : "text-warning")}>
        <Icon icon={SquareLock02Icon} className="mt-0.5 size-3.5 shrink-0" /> {contained.label}
      </p>
    </PaneSection>
  );
}

/**
 * One service the plugin signs in to. A shared install's server uses the team's account an admin connected:
 * people see whose it is; an admin connects it when it is missing; a member waits for one. Its mark is the
 * install's (ConnectMark): the plus, blinking while the browser is open, flipping into the green check once
 * it connects here.
 */
export function ConnectRow({
  pluginId,
  server: s,
  installed,
  admin,
  onConnected,
  onDisconnect,
}: {
  pluginId: string;
  server: PluginDetail["server_details"][number];
  installed: boolean;
  admin: boolean;
  onConnected: () => void;
  /** An admin's: removes the team's account. */
  onDisconnect: (() => void) | undefined;
}) {
  const signIn = useSignIn({ pluginId, server: s.name, shared: s.shared, onConnected });
  // A Cloud computer that keeps nothing of its person's connects and removes nothing: no button, and the line says where.
  const elsewhere = useConnectsElsewhere();
  const mark: ConnectState =
    s.connected || signIn.phase === "connected" ? "connected" : signIn.phase === "opening" || signIn.phase === "waiting" ? "waiting" : signIn.phase === "failed" ? "failed" : "add";
  const land = useLanded(mark === "connected");
  const status =
    mark === "connected"
      ? s.shared
        ? sharedByLine(s.shared_by)
        : connectedLine(signIn.heldBy ?? s.held_by)
      : signIn.phase === "opening"
        ? "Opening the sign-in page…"
        : signIn.phase === "waiting"
          ? "Waiting for you to sign in in your browser"
          : signIn.phase === "failed"
            ? signIn.problem
            : s.shared
              ? admin
                ? (s.problem ?? "The team's account is not connected yet")
                : (s.problem ?? "Waiting for an admin to connect the team's account")
              : (s.unavailable ?? s.problem ?? (elsewhere ? CONNECT_ELSEWHERE : "Not connected"));
  const again = s.problem !== undefined || signIn.phase === "failed";
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <ConnectMark state={mark} land={land} className={mark === "connected" ? "text-success" : mark === "waiting" ? "text-foreground" : "text-muted-foreground"} />
      <span className="text-[13.5px] font-medium">{s.name}</span>
      <span aria-live="polite" className={cn("line-clamp-2 min-w-0 flex-1 text-[12.5px] text-muted-foreground", signIn.phase === "failed" && "text-destructive")}>
        {status}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {onDisconnect && !elsewhere ? (
          <Button size="sm" variant="secondary" onClick={onDisconnect}>
            Disconnect the team's account
          </Button>
        ) : null}
        {mark === "connected" || (s.shared && !admin) || elsewhere ? null : signIn.reopen ? (
          <Button size="sm" variant="secondary" onClick={signIn.reopen}>
            Open the page again
          </Button>
        ) : (
          <Button size="sm" disabled={!installed || mark === "waiting" || s.unavailable !== undefined} title={installed ? undefined : "Install it first"} onClick={() => void signIn.connect()}>
            {s.shared ? (again ? "Reconnect the team's account" : "Connect the team's account") : again ? "Reconnect" : "Connect"}
          </Button>
        )}
      </span>
    </div>
  );
}

/** Install ▾: Install puts it where the bar says (you everywhere, or the project picked); the menu has the other ways. */
function InstallButton({ where, busy, onInstall, onAsk, onTry }: { where: string | undefined; busy: boolean; onInstall: () => void; onAsk: () => void; onTry: (() => void) | undefined }) {
  return (
    <span className="flex">
      <Button className="rounded-r-none" disabled={busy} onClick={onInstall}>
        {busy ? "Installing…" : where ? `Install for ${where}` : "Install"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="More install options" className="rounded-l-none border-l border-primary-foreground/20 px-2">
            <Icon icon={ArrowDown01Icon} className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={onAsk}>Install for a project or your team…</DropdownMenuItem>
          <DropdownMenuItem disabled={!onTry} onSelect={() => onTry?.()}>
            Try in a chat first
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** "4 skills · Slack MCP server · 1 hook", each part opening to its list. */
function Includes({ plugin: p }: { plugin: PluginDetail }) {
  // Hooks have a section of their own, with their trust.
  const parts = includesLine(p.includes, p.server_details).filter((part) => part.kind !== "hooks");
  const [open, setOpen] = useState<string | null>(null);
  if (parts.length === 0) return null;
  return (
    <PaneSection title="Includes">
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
        {parts.map((part) => (
          <div key={part.kind}>
            <button
              type="button"
              aria-expanded={open === part.kind}
              onClick={() => setOpen(open === part.kind ? null : part.kind)}
              className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-[13.5px] outline-none transition-colors duration-75 hover:bg-accent/40 focus-visible:bg-accent/40"
            >
              <Icon icon={ArrowRight01Icon} className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open === part.kind && "rotate-90")} />
              {part.label}
            </button>
            {open === part.kind ? <div className="px-4 pb-3 pl-[38px]">{partList(p, part.kind)}</div> : null}
          </div>
        ))}
      </div>
    </PaneSection>
  );
}

function partList(p: PluginDetail, kind: string): ReactNode {
  const line = (key: string, name: ReactNode, rest?: ReactNode) => (
    <li key={key} className="flex min-w-0 items-baseline gap-2 py-1 text-[13px]">
      <span className="shrink-0 font-medium">{name}</span>
      {rest ? <span className="min-w-0 truncate text-muted-foreground">{rest}</span> : null}
    </li>
  );
  switch (kind) {
    case "skills":
      return <ul>{p.skill_details.map((s) => line(s.name, s.name, s.description))}</ul>;
    case "mcp_servers":
      return (
        <div className="flex flex-col gap-2">
          {p.server_details.map((s) => (
            <ServerTools key={s.name} plugin={p} server={s.name} />
          ))}
        </div>
      );
    case "commands":
      return <ul>{p.commands.map((c) => line(c, c))}</ul>;
    case "agents":
      return <ul>{p.agents.map((a) => line(a, a))}</ul>;
    case "rules":
      return <ul>{p.rules.map((r) => line(r, r))}</ul>;
    default:
      return null;
  }
}

/** A server's tools, listed through the runtime's hub when opened (mcp.tools). */
function ServerTools({ plugin, server }: { plugin: PluginDetail; server: string }) {
  const tools = useCall((c) => c.call("mcp.tools", { plugin: plugin.id, server }));
  return (
    <div>
      <p className="text-[13px] font-medium">{server}</p>
      {tools.error ? (
        <p className="text-[12.5px] text-muted-foreground">{plugin.installed ? tools.error : "Tools list once it is installed and connected"}</p>
      ) : tools.data === null ? (
        <p className="text-[12.5px] text-muted-foreground">Listing tools…</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {tools.data.tools.map((t) => (
            <li key={t.name} title={t.description} className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11.5px]">
              {t.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

