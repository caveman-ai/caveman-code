// Plugins: one page, and the marketplace is the page. On Caveman's own it opens on Recommended, a row of large cards
// (Recommended.tsx); then its tiles by category, as many across as fit (native Browse MCPs, compact Apps): a
// plugin's plus installs it in one click and becomes its switch. Beneath the marketplace, on the same page: what you
// have installed, your MCP servers, your skills and your rules, each a grid of the same tile.
//
// Nothing else is a page of its own. The bar holds the search (which looks in every marketplace and in what is
// beneath), and two dropdowns: where the tiles come from (a marketplace, or another agent's own setup on this
// computer) and what they are for (everywhere, or one project). With a project picked the page is what that project's
// chats get, a plus installs for it alone, and a switch turns the thing on or off there alone. What waits on the person
// is one line with one button.
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { SearchField } from "@caveman-app/ui/components/input";
import { Switch } from "@caveman-app/ui/components/switch";
import { Tag } from "@caveman-app/ui/components/tag";
import { Glyph } from "@caveman-app/ui/icons/Glyph";
import {
  Icon,
  Add01Icon,
  ArrowDown01Icon,
  MoreHorizontalIcon,
  Tick02Icon,
} from "@caveman-app/ui/icons/huge";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ConnectMark } from "../../components/ConnectMark.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Highlight } from "../../components/FilterBar.tsx";
import { BarButton, QuietButton } from "../../panels/chrome.tsx";
import { SetupLeftOver } from "./SetupLeftOver.tsx";
import { PageBar } from "../../shell/PageBar.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import {
  AGENT_CHATS,
  AGENT_NAME,
  type AgentId,
  agentPath,
  type AgentRow,
  agentSections,
  agentsWithSetup,
  canTurnOff,
  canTurnOn,
  filterSections,
  turnOnPlan,
} from "./agents-model.ts";
import type { PluginSummary } from "./api.ts";
import {
  type BrowseSource,
  browseSources,
  CAVEMAN,
  sourceOf,
  sourcePath,
  sourcePlugins,
  sourceTitle,
} from "./browse-model.ts";
import { useAccount, usePluginsData } from "./data.tsx";
import { usePluginsDialogs } from "./Dialogs.tsx";
import { filterPlugins, pluginFacets, type PluginMatch, subtitle } from "./filter.ts";
import { applyImport } from "./Import.tsx";
import { useInstall } from "./InstallDialog.tsx";
import {
  blockedRows,
  filterGroups,
  type Group,
  installedGroups,
  type Need,
  needsLine,
  needsOf,
  pluginNeed,
  pluginPath,
  type Row,
} from "./installed.ts";
import { browseSections, displayName, recommended } from "./model.ts";
import { NeedsDialog } from "./Needs.tsx";
import { PluginLogo } from "./PluginLogo.tsx";
import { PICKS, Recommended } from "./Recommended.tsx";
import { ScopePicker, useScopeProject } from "./scope.tsx";
import { ErrorLine, message, useSwitchHere } from "./shared.tsx";

/** What the page's tiles come from: a marketplace, or another agent's own setup on this computer. */
export type PageSource =
  | { readonly kind: "market"; readonly source: BrowseSource }
  | { readonly kind: "agent"; readonly agent: AgentId };

export function PluginsPage({ source }: { source: PageSource }) {
  return source.kind === "agent" ? (
    <AgentView agent={source.agent} />
  ) : (
    <MarketView source={source.source} />
  );
}

const KIND_ICON: Record<
  "plugin" | "server" | "mcp_server" | "skill" | "rule" | "instructions",
  PixelIconName
> = {
  plugin: "spaces",
  server: "tool-mcp",
  mcp_server: "tool-mcp",
  skill: "record-skill",
  rule: "artifact-markdown",
  instructions: "artifact-markdown",
};

/** Tiles a long section shows before "Show all": two to four rows of them, whatever the width. */
const SECTION_LIMIT = 12;

// ------------------------------------------------------------ the bar

/** The + menu: what makes something first, then what brings a folder or a marketplace in. */
function AddMenu() {
  const dialogs = usePluginsDialogs();
  const account = useAccount();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BarButton label="Add">
          <Icon icon={Add01Icon} />
        </BarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={dialogs.addServer}>Add an MCP server…</DropdownMenuItem>
        <DropdownMenuItem onSelect={dialogs.newSkill}>New skill…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={dialogs.importFolder}>Import a folder…</DropdownMenuItem>
        <DropdownMenuItem onSelect={dialogs.addMarketplace}>Add a marketplace…</DropdownMenuItem>
        {account.signedIn ? (
          <DropdownMenuItem disabled={!account.admin} onSelect={dialogs.publish}>
            {account.admin ? "Publish to your team…" : "Publish to your team (ask an admin)"}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where the tiles come from, as one dropdown: the marketplaces, then each other agent that has a setup of its own here,
 * then Add a marketplace. On a marketplace you added, its own verbs follow (Update, Copy its source, Remove at the foot).
 */
function SourceMenu({
  current,
  onNote,
}: {
  current: PageSource;
  onNote: (note: { ok?: string; error?: string }) => void;
}) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const account = useAccount();
  const dialogs = usePluginsDialogs();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const market = data.market.data;
  const markets = market?.marketplaces ?? [];
  const rows = market ? browseSources(market.plugins, markets, account.signedIn) : [];
  const agents = agentsWithSetup(data.importable.data ?? []);
  const label =
    current.kind === "agent" ? AGENT_NAME[current.agent] : sourceTitle(current.source, markets);
  const added =
    current.kind === "market"
      ? markets.find((m) => m.name === current.source && m.kind === "added")
      : undefined;
  const tick = (on: boolean) =>
    on ? (
      <Icon icon={Tick02Icon} className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <span className="size-3.5 shrink-0" />
    );
  const run = async (f: () => Promise<string | undefined>) => {
    try {
      const ok = await f();
      onNote(ok === undefined ? {} : { ok });
    } catch (e) {
      onNote({ error: message(e) });
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="min-w-0 max-w-[200px]"
            aria-label={`Showing ${label}`}
          >
            <span className="truncate">{label}</span>
            <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {rows.map((r) => (
            <DropdownMenuItem
              key={r.source}
              onSelect={() => navigate(r.source === CAVEMAN ? "/plugins" : sourcePath(r.source))}
              className="gap-2"
            >
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span
                className={cn(
                  "shrink-0 text-[12px] tabular-nums",
                  r.tone === "warn" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {r.line.replace(/ plugins?$/, "")}
              </span>
              {tick(current.kind === "market" && current.source === r.source)}
            </DropdownMenuItem>
          ))}
          {agents.length > 0 ? <DropdownMenuSeparator /> : null}
          {agents.map((a) => (
            <DropdownMenuItem key={a} onSelect={() => navigate(agentPath(a))} className="gap-2">
              <span className="min-w-0 flex-1 truncate">{AGENT_NAME[a]}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">its own setup</span>
              {tick(current.kind === "agent" && current.agent === a)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={dialogs.addMarketplace}>Add a marketplace…</DropdownMenuItem>
          {added ? (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  void run(async () => {
                    const r = await client!.call("marketplace.update", {
                      request_id: requestId(),
                      name: added.name,
                    });
                    await data.market.reload();
                    return r.changed.length === 0
                      ? `${added.display_name} is up to date`
                      : `Updated ${r.changed.length} plugin${r.changed.length === 1 ? "" : "s"}${r.trust_dropped.length ? `; ${r.trust_dropped.length} need hooks trusted again` : ""}`;
                  })
                }
              >
                Update {added.display_name}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(added.source)}>
                Copy its source
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                Remove {added.display_name}…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {added ? (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${added.display_name}?`}
          description="Its plugins are uninstalled and stop loading in your chats."
          confirmLabel="Remove"
          destructive
          onConfirm={() =>
            void run(async () => {
              await client!.call("marketplace.remove", {
                request_id: requestId(),
                name: added.name,
              });
              await data.reloadAll();
              navigate("/plugins");
              return undefined;
            })
          }
        />
      ) : null}
    </>
  );
}

/** The bar and the page under it: the search, where the tiles come from, what they are for, and +; then the full-width column. */
function Frame({
  source,
  query,
  onQuery,
  placeholder,
  onNote,
  children,
}: {
  source: PageSource;
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  onNote: (note: { ok?: string; error?: string }) => void;
  children: ReactNode;
}) {
  return (
    <>
      <PageBar icon="spaces" title="Plugins">
        <SearchField
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (onQuery(""), e.currentTarget.blur())}
          placeholder={placeholder}
          aria-label={placeholder}
          containerClassName="ml-2 min-w-0 max-w-[520px] flex-1"
          className="h-8"
        />
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <SourceMenu current={source} onNote={onNote} />
          {source.kind === "market" ? <ScopePicker /> : null}
          <AddMenu />
        </span>
      </PageBar>
      <main
        data-frame-scroller
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="mx-auto w-full max-w-[1680px] px-6 pb-24 max-md:px-4">{children}</div>
      </main>
    </>
  );
}

// ------------------------------------------------------------ the page's parts

/** One row under the bar: the page's sections by name and count (a click scrolls to one), and at the right what waits on the person. */
function Jump({
  items,
  children,
}: {
  items: ReadonlyArray<{ id: string; label: string; count?: number | undefined }>;
  children?: ReactNode;
}) {
  const go = (id: string) =>
    document.getElementById(id)?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  return (
    <div className="-mx-2 flex min-h-10 flex-wrap items-center gap-x-0.5 gap-y-1 pt-1">
      <nav aria-label="On this page" className="flex min-w-0 items-center gap-0.5">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => go(i.id)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {i.label}
            {i.count === undefined ? null : (
              <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{i.count}</span>
            )}
          </button>
        ))}
      </nav>
      {children ? (
        <div className="ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-[12.5px]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A section of the page: its quiet title and count, then its tiles, as many across as fit. */
function Section({
  id,
  title,
  count,
  children,
}: {
  id?: string;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-3 pt-9">
      <h2 className="flex h-8 items-center gap-2 pb-2 text-[16px] font-medium text-foreground">
        {title}
        {count === undefined ? null : (
          <span className="text-[14px] font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">
            {count}
          </span>
        )}
      </h2>
      <div className="-mx-3 grid gap-x-4 gap-y-1 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]">
        {children}
      </div>
    </section>
  );
}

/** A tile's mark when it is not a plugin's logo: the kind's icon on the same 44px square. */
function Mark({ kind, add }: { kind?: keyof typeof KIND_ICON; add?: boolean }) {
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground/[0.05] text-muted-foreground">
      {add ? (
        <Icon icon={Add01Icon} className="size-4" />
      ) : (
        <Glyph name={KIND_ICON[kind ?? "plugin"]} />
      )}
    </span>
  );
}

/**
 * One thing: its mark, its name over one line on what it is, and its control at the end (a plus to install, a switch
 * once it is here). The whole tile opens it; the control sits above that link.
 */
function Tile({
  mark,
  name,
  label,
  to,
  onClick,
  line,
  mono,
  dim,
  warn,
  tag,
  control,
}: {
  mark: ReactNode;
  name: ReactNode;
  /** The name as plain text, when `name` carries marks. */
  label?: string;
  to?: string | undefined;
  onClick?: () => void;
  line: ReactNode;
  mono?: boolean;
  dim?: boolean;
  warn?: boolean;
  tag?: ReactNode;
  control?: ReactNode;
}) {
  const title = cn(
    "block truncate text-[14px] font-medium leading-5 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring",
    dim ? "text-muted-foreground" : "text-foreground",
  );
  return (
    <div className="group relative flex min-w-0 items-center gap-3.5 rounded-xl px-3 py-3 transition-colors duration-75 hover:bg-sidebar-accent/60">
      <span className={cn("shrink-0", dim && "opacity-60")}>{mark}</span>
      <div className="min-w-0 flex-1">
        {to ? (
          <Link to={to} aria-label={label} className={title}>
            {name}
          </Link>
        ) : onClick ? (
          <button type="button" onClick={onClick} className={cn(title, "w-full text-left")}>
            {name}
          </button>
        ) : (
          <span className={title}>{name}</span>
        )}
        <p
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted-foreground",
            mono && "font-mono text-[12px]",
          )}
        >
          {warn ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" /> : null}
          <span className="truncate">{line}</span>
        </p>
      </div>
      {tag ? (
        <span className="relative z-10 shrink-0 text-[12.5px] text-muted-foreground">{tag}</span>
      ) : null}
      {control ? <span className="relative z-10 flex shrink-0 items-center">{control}</span> : null}
    </div>
  );
}

/** "Show all 127" under a section cut short, in the grid's first column. */
function More({ open, total, onToggle }: { open: boolean; total: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="col-span-full mx-3 flex h-9 items-center rounded-md text-left text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {open ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

/** Switch positions asked for and not yet read back: the switch moves at the click, not when the runtime answers. */
function usePending() {
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  return {
    pending,
    set: (keys: ReadonlyArray<string>, on: boolean) =>
      setPending((p) => new Map([...p, ...keys.map((k) => [k, on] as const)])),
    clear: (keys: ReadonlyArray<string>) =>
      setPending((p) => new Map([...p].filter(([k]) => !keys.includes(k)))),
  };
}

const flipIn = (set: ReadonlySet<string>, id: string): ReadonlySet<string> =>
  set.has(id) ? new Set([...set].filter((x) => x !== id)) : new Set([...set, id]);

// ------------------------------------------------------------ a marketplace, and what you have beneath it

function MarketView({ source }: { source: BrowseSource }) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const dialogs = usePluginsDialogs();
  const project = useScopeProject();
  // With a project picked every switch on the page is that project's own: the rest keep what they have.
  const switchHere = useSwitchHere();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The tasks as they were when opened: their rows stay put and turn into checks as they get done.
  const [task, setTask] = useState<ReadonlyArray<Need> | null>(null);
  const [note, setNote] = useState<{ ok?: string; error?: string }>({});
  const { pending, set, clear } = usePending();
  const installer = useInstall(() => void data.reloadAll());

  const market = data.market.data;
  const markets = useMemo(() => market?.marketplaces ?? [], [market]);
  const searching = query.trim() !== "";
  const title = sourceTitle(source, markets);
  const added = markets.find((m) => m.name === source && m.kind !== "caveman" && m.kind !== "team");
  // A search looks in every marketplace: what is wanted is rarely in the one that happens to be open.
  const pool = useMemo(
    () =>
      market ? (searching ? market.plugins : sourcePlugins(source, market.plugins, markets)) : [],
    [market, markets, searching, source],
  );
  const facets = useMemo(
    () => pluginFacets({ categories: market?.categories ?? [], marketplaces: markets }),
    [market, markets],
  );
  const kept = useMemo(
    () => filterPlugins(pool, facets, { query, picked: {}, sort: "catalog" }),
    [pool, facets, query],
  );
  const matches = useMemo(() => new Map(kept.map((s) => [s.plugin.id, s.match])), [kept]);
  const catalog = !market
    ? []
    : searching
      ? kept.length > 0
        ? [{ title: "Plugins", plugins: kept.map((s) => s.plugin) }]
        : []
      : browseSections(
          kept.map((s) => s.plugin),
          market.categories,
        );
  const picks =
    market && !searching && source === CAVEMAN
      ? recommended(market.plugins, market.featured, PICKS)
      : [];

  const groups = useMemo(
    () =>
      installedGroups({
        servers: data.servers.data,
        plugins: market?.plugins ?? null,
        skills: data.skills.data,
        rules: data.rules.data,
        project: project?.id,
      }),
    [data.servers.data, market, data.skills.data, data.rules.data, project?.id],
  );
  const mine = filterGroups(groups, query);
  const group = (id: Group["id"]) => mine.find((g) => g.id === id);
  const needs = useMemo(() => needsOf(groups), [groups]);
  const blocked = blockedRows(needs);
  const loading = market === null || data.servers.data === null;
  const failed = data.market.error ?? data.servers.error ?? data.skills.error ?? data.rules.error;

  const turn = async (
    rows: ReadonlyArray<Pick<Row, "key" | "kind" | "name" | "plugin">>,
    on: boolean,
  ) => {
    const keys = rows.map((r) => r.key);
    set(keys, on);
    setNote({});
    try {
      await Promise.all(
        rows.map((r) =>
          r.kind === "plugin" && r.plugin
            ? client!.call("plugin.set_enabled", {
                request_id: requestId(),
                plugin_id: r.plugin.id,
                enabled: on,
                ...switchHere,
              })
            : client!.call("mcp.set_enabled", {
                request_id: requestId(),
                name: r.name,
                enabled: on,
                ...switchHere,
              }),
        ),
      );
    } catch (e) {
      setNote({ error: message(e) });
    } finally {
      await Promise.all([data.market.reload(), data.servers.reload()]);
      clear(keys);
    }
  };
  const switchOf = (row: Row) => {
    if (!row.toggle) return undefined;
    const on = pending.get(row.key) ?? row.toggle.on;
    return (
      <Switch
        checked={on}
        disabled={row.toggle.locked !== undefined || pending.has(row.key)}
        title={row.toggle.locked}
        aria-label={`${row.name}: ${on ? "on" : "off"}`}
        onCheckedChange={(next) => void turn([row], next)}
      />
    );
  };
  const mineTile = (row: Row) => {
    const on = row.toggle ? (pending.get(row.key) ?? row.toggle.on) : row.tone !== "off";
    return (
      <Tile
        key={row.key}
        mark={
          row.plugin ? <PluginLogo plugin={row.plugin} size="tile" /> : <Mark kind={row.kind} />
        }
        name={row.name}
        to={row.to}
        line={row.line}
        dim={!on}
        warn={row.tone === "warn" && on}
        tag={row.tag}
        control={switchOf(row)}
      />
    );
  };

  // A search lists installed plugins among its results, switch and all: no second section for them then.
  const installed = searching ? undefined : group("plugins");
  const servers = group("servers");
  const skills = group("skills");
  const rules = group("rules");
  // `lead`: tiles the section starts with that are not rows (its Add tile), so a cut section still ends on a full row.
  const cut = (g: Group | undefined, lead = 0) =>
    g && !searching && g.rows.length + lead > SECTION_LIMIT && !open.has(g.id)
      ? g.rows.slice(0, SECTION_LIMIT - lead)
      : (g?.rows ?? []);
  const nothing = !loading && searching && catalog.length === 0 && !servers && !skills && !rules;
  const jump = [
    {
      id: "browse",
      label: searching ? "Plugins" : title,
      count: catalog.reduce((n, s) => n + s.plugins.length, 0),
    },
    ...(installed
      ? [
          {
            id: "installed",
            label: project ? `In ${project.name}` : "Installed",
            count: installed.rows.length,
          },
        ]
      : []),
    { id: "servers", label: "MCP servers", count: servers?.rows.length ?? 0 },
    { id: "skills", label: "Skills", count: skills?.rows.length ?? 0 },
    ...(rules ? [{ id: "rules", label: "Rules", count: rules.rows.length }] : []),
  ].filter((j) => !searching || j.count > 0);

  return (
    <Frame
      source={{ kind: "market", source }}
      query={query}
      onQuery={setQuery}
      placeholder="Search plugins, MCP servers and skills"
      onNote={setNote}
    >
      <Jump items={jump}>
        {needs.length > 0 ? (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
            <span role="status" className="min-w-0 truncate text-foreground">
              {needsLine(needs)}
            </span>
            {blocked.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                title="They do nothing until set up. Turn them back on from their tiles."
                onClick={() => void turn(blocked, false)}
              >
                Turn them off
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setTask(needs)}>
              Set up
            </Button>
          </>
        ) : null}
      </Jump>
      {added && !searching ? (
        <p className="break-all font-mono text-[12px] leading-5 text-muted-foreground">
          {added.source}
          {added.commit ? ` at ${added.commit.slice(0, 7)}` : ""}
          {added.problems.map((p) => (
            <span key={p} className="ml-2 font-sans text-warning">
              {p}
            </span>
          ))}
        </p>
      ) : null}
      {note.ok ? <p className="text-[12.5px] text-success">{note.ok}</p> : null}
      <ErrorLine>{note.error ?? installer.error}</ErrorLine>
      {failed && !loading ? (
        <p role="alert" className="flex items-center gap-2 text-[12.5px] text-warning">
          <span className="min-w-0 flex-1 truncate" title={failed}>
            Part of it couldn't be read: {failed}
          </span>
          <QuietButton onClick={() => void data.reloadAll()}>Try again</QuietButton>
        </p>
      ) : null}
      <SetupLeftOver onChanged={() => void data.reloadAll()} />
      {market?.cloudProblem ? (
        <p role="status" className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            Couldn't reach Caveman. Team and project plugins are the ones it last sent.
          </span>
          <QuietButton onClick={() => void data.market.reload()}>Try again</QuietButton>
        </p>
      ) : null}

      {loading && failed ? (
        <EmptyState
          pose="thinking"
          title="Couldn't read the plugins"
          className="mt-14"
          action={<QuietButton onClick={() => void data.reloadAll()}>Try again</QuietButton>}
        >
          {failed}
        </EmptyState>
      ) : loading ? (
        <div aria-hidden className="mt-6 h-64 rounded-xl bg-foreground/[0.03]" />
      ) : nothing ? (
        <EmptyState
          pose="thinking"
          title="No match"
          className="mt-14"
          action={<QuietButton onClick={() => setQuery("")}>Clear the search</QuietButton>}
        >
          Nothing in any marketplace, or in what you have, matches “{query.trim()}”.
        </EmptyState>
      ) : (
        <>
          <div id="browse" className="scroll-mt-3">
            <Recommended
              plugins={picks}
              busy={(p) => installer.busy === p.id}
              where={installer.where}
              onInstall={(p) => installer.install(p)}
            />
            {catalog.length === 0 && !searching ? (
              <p className="pt-6 text-[13px] text-muted-foreground">
                {added?.status === "checking_out"
                  ? `${title} is still being copied.`
                  : `${title} lists no plugins yet.`}
              </p>
            ) : null}
            {catalog.map((s) => (
              <Section
                key={s.title}
                title={s.title}
                {...(searching ? { count: s.plugins.length } : {})}
              >
                {s.plugins.map((p) => (
                  <CatalogTile
                    key={p.id}
                    plugin={p}
                    match={matches.get(p.id) ?? undefined}
                    from={
                      searching && sourceOf(p.marketplace, markets) !== source
                        ? sourceTitle(sourceOf(p.marketplace, markets), markets)
                        : undefined
                    }
                    on={pending.get(`plugin:${p.id}`) ?? p.enabled}
                    busy={installer.busy === p.id || pending.has(`plugin:${p.id}`)}
                    where={installer.where}
                    onInstall={() => installer.install(p)}
                    onTurn={(next) =>
                      void turn(
                        [
                          {
                            key: `plugin:${p.id}`,
                            kind: "plugin",
                            name: displayName(p),
                            plugin: p,
                          },
                        ],
                        next,
                      )
                    }
                  />
                ))}
              </Section>
            ))}
          </div>

          {installed ? (
            <Section
              id="installed"
              title={project ? `In ${project.name}` : "Installed"}
              count={installed.rows.length}
            >
              {cut(installed).map(mineTile)}
              {!searching && installed.rows.length > SECTION_LIMIT ? (
                <More
                  open={open.has("plugins")}
                  total={installed.rows.length}
                  onToggle={() => setOpen((o) => flipIn(o, "plugins"))}
                />
              ) : null}
            </Section>
          ) : null}

          {servers || !searching ? (
            <Section id="servers" title="MCP servers" count={servers?.rows.length ?? 0}>
              {searching ? null : (
                <Tile
                  mark={<Mark add />}
                  name="Add an MCP server"
                  onClick={dialogs.addServer}
                  line="Paste its URL, or the command that starts it"
                />
              )}
              {cut(servers, 1).map(mineTile)}
              {!searching && servers && servers.rows.length + 1 > SECTION_LIMIT ? (
                <More
                  open={open.has("servers")}
                  total={servers.rows.length}
                  onToggle={() => setOpen((o) => flipIn(o, "servers"))}
                />
              ) : null}
            </Section>
          ) : null}

          {skills || !searching ? (
            <Section id="skills" title="Skills" count={skills?.rows.length ?? 0}>
              {searching ? null : (
                <Tile
                  mark={<Mark add />}
                  name="New skill"
                  onClick={dialogs.newSkill}
                  line={
                    project
                      ? `Steps every agent can follow in ${project.name}`
                      : "Steps every agent can follow, in your words"
                  }
                />
              )}
              {cut(skills, 1).map(mineTile)}
              {!searching && skills && skills.rows.length + 1 > SECTION_LIMIT ? (
                <More
                  open={open.has("skills")}
                  total={skills.rows.length}
                  onToggle={() => setOpen((o) => flipIn(o, "skills"))}
                />
              ) : null}
            </Section>
          ) : null}

          {rules ? (
            <Section id="rules" title="Rules" count={rules.rows.length}>
              {rules.rows.map(mineTile)}
            </Section>
          ) : null}
        </>
      )}
      <NeedsDialog needs={task} onOpenChange={(o) => !o && setTask(null)} />
      {installer.dialog}
    </Frame>
  );
}

/** A plugin in the marketplace: its plus installs it for what the bar says; once here, the plus is its switch. */
function CatalogTile({
  plugin: p,
  match,
  from,
  on,
  busy,
  where,
  onInstall,
  onTurn,
}: {
  plugin: PluginSummary;
  match: PluginMatch | undefined;
  /** The marketplace it is in, when a search found it outside the one open. */
  from: string | undefined;
  on: boolean;
  busy: boolean;
  where: string | undefined;
  onInstall: () => void;
  onTurn: (on: boolean) => void;
}) {
  const here = p.installed || p.required;
  const need = here && on ? pluginNeed(p) : undefined;
  return (
    <Tile
      mark={<PluginLogo plugin={p} size="tile" />}
      name={<Highlight text={displayName(p)} ranges={match?.ranges[0]} />}
      label={displayName(p)}
      to={`${pluginPath(p.id)}?in=browse`}
      line={need ? need.text : <Highlight text={subtitle(p)} ranges={match?.ranges[1]} />}
      warn={need !== undefined}
      dim={here && !on}
      tag={from}
      control={
        p.required ? (
          <Tag tone="blue" title="Your team requires it">
            Required
          </Tag>
        ) : here ? (
          <Switch
            checked={on}
            disabled={busy}
            aria-label={`${displayName(p)}: ${on ? "on" : "off"}`}
            onCheckedChange={onTurn}
          />
        ) : (
          <button
            type="button"
            aria-label={`Install ${displayName(p)}${where ? ` for ${where}` : ""}`}
            title={where ? `Install for ${where}` : "Install"}
            disabled={busy}
            onClick={onInstall}
            className="px-play-hover grid size-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <ConnectMark state={busy ? "waiting" : "add"} />
          </button>
        )
      }
    />
  );
}

// ------------------------------------------------------------ another agent's own setup

function AgentView({ agent }: { agent: AgentId }) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<{ ok?: string; error?: string }>({});
  const { pending, set, clear } = usePending();
  const sections = useMemo(
    () =>
      agentSections(agent, data.importable.data ?? [], {
        plugins: data.market.data?.plugins ?? null,
        servers: data.servers.data,
      }),
    [agent, data.importable.data, data.market.data, data.servers.data],
  );
  const searching = query.trim() !== "";
  const shown = filterSections(sections, query);
  const loading = data.importable.data === null;
  const offs = canTurnOn(sections);
  const ons = canTurnOff(sections);

  const here = (h: NonNullable<AgentRow["here"]>, on: boolean) =>
    h.kind === "plugin"
      ? client!.call("plugin.set_enabled", {
          request_id: requestId(),
          plugin_id: h.id,
          enabled: on,
        })
      : client!.call("mcp.set_enabled", { request_id: requestId(), name: h.name, enabled: on });

  const turn = async (rows: ReadonlyArray<AgentRow>, on: boolean) => {
    const keys = rows.map((r) => r.key);
    set(keys, on);
    setNote({});
    try {
      if (on) {
        const plan = turnOnPlan(rows);
        if (plan.bring.length > 0) {
          const r = await applyImport(client!, plan.bring);
          const lost = r.failed.filter((f) => f.ref.kind !== "marketplace");
          if (lost.length > 0)
            setNote({
              error:
                lost.length === 1
                  ? `${lost[0]!.ref.name}: ${lost[0]!.reason}`
                  : `${lost.length} couldn't be turned on. ${lost[0]!.ref.name}: ${lost[0]!.reason}`,
            });
        }
        await Promise.all(plan.enable.map((h) => here(h, true)));
      } else {
        await Promise.all(rows.flatMap((r) => (r.here ? [here(r.here, false)] : [])));
      }
    } catch (e) {
      setNote({ error: message(e) });
    } finally {
      await data.reloadAll();
      clear(keys);
    }
  };

  return (
    <Frame
      source={{ kind: "agent", agent }}
      query={query}
      onQuery={setQuery}
      placeholder={`Search ${AGENT_NAME[agent]}'s setup`}
      onNote={setNote}
    >
      <Jump items={shown.map((s) => ({ id: s.kind, label: s.title, count: s.rows.length }))}>
        <span className="min-w-0 truncate text-muted-foreground">
          {AGENT_CHATS[agent]} already use these. A switch gives one to every agent.
        </span>
        {offs.length + ons.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton label="All of them" size="sm">
                <Icon icon={MoreHorizontalIcon} />
              </BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem disabled={offs.length === 0} onSelect={() => void turn(offs, true)}>
                {offs.length === 0 ? "Turn on all" : `Turn on all ${offs.length}`}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={ons.length === 0} onSelect={() => void turn(ons, false)}>
                {ons.length === 0 ? "Turn off all" : `Turn off all ${ons.length}`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </Jump>
      <ErrorLine>{data.importable.error ?? note.error}</ErrorLine>
      {loading && !data.importable.error ? (
        <div aria-hidden className="mt-6 h-64 rounded-xl bg-foreground/[0.03]" />
      ) : shown.length === 0 ? (
        <EmptyState
          pose={searching ? "thinking" : "sleeping"}
          title={searching ? "No match" : `${AGENT_NAME[agent]} has nothing of its own here`}
          className="mt-14"
        >
          {searching ? (
            <>Nothing here matches “{query.trim()}”.</>
          ) : (
            "Its plugins, MCP servers and skills show here once it has some."
          )}
        </EmptyState>
      ) : (
        shown.map((s) => {
          const all = searching || s.rows.length <= SECTION_LIMIT || open.has(s.kind);
          return (
            <Section key={s.kind} id={s.kind} title={s.title} count={s.rows.length}>
              {(all ? s.rows : s.rows.slice(0, SECTION_LIMIT)).map((row) => {
                const on = pending.get(row.key) ?? row.state === "on";
                const busy = pending.has(row.key);
                const bringing = busy && on && !row.here;
                return (
                  <Tile
                    key={row.key}
                    mark={
                      row.plugin ? (
                        <PluginLogo plugin={row.plugin} size="tile" />
                      ) : (
                        <Mark kind={row.kind} />
                      )
                    }
                    name={row.name}
                    to={row.to}
                    line={
                      row.state === "cant"
                        ? (row.reason ?? "")
                        : bringing
                          ? "Bringing it in…"
                          : row.line || (row.hint ?? "")
                    }
                    mono={row.kind !== "plugin" && row.state !== "cant" && !bringing}
                    dim={row.state === "cant"}
                    tag={row.state === "off" && !busy ? row.hint : undefined}
                    control={
                      row.state === "on" || row.state === "off" ? (
                        <Switch
                          checked={on}
                          disabled={busy || (row.state === "on" && !row.here)}
                          aria-label={`${row.name}: ${on ? "every agent has it" : `only ${AGENT_NAME[agent]} has it`}`}
                          onCheckedChange={(next) => void turn([row], next)}
                        />
                      ) : undefined
                    }
                  />
                );
              })}
              {!searching && s.rows.length > SECTION_LIMIT ? (
                <More
                  open={open.has(s.kind)}
                  total={s.rows.length}
                  onToggle={() => setOpen((o) => flipIn(o, s.kind))}
                />
              ) : null}
            </Section>
          );
        })
      )}
    </Frame>
  );
}
