// Plugins (/plugins): one page. The marketplace is the page, and what you have (installed plugins, MCP servers, skills,
// rules) sits beneath it; the bar's dropdowns pick which marketplace or agent the tiles come from and which project
// they are for. A tile opens a page for the one thing.
//
//   /plugins                   Caveman's marketplace, and what you have beneath it
//   /plugins/browse/:source    the same page on another marketplace
//   /plugins/agent/:agent      the same page on one other agent's own setup (Claude Code, Codex, Cursor)
//   /plugins/p/:id             one plugin
//   /plugins/mcp/:name         one MCP server (?plugin=<id> for one a plugin brings)
//   /plugins/skill?path=       one skill          /plugins/rule?path=   one rule file
//
// The pages live in ./plugins/. Older links (the tabs this page had, Customize, Spaces) land on their place here.
import { Navigate, Outlet, useParams, useSearchParams } from "react-router";
import { isAgent } from "./plugins/agents-model.ts";
import { CAVEMAN, sourceOf, sourcePath } from "./plugins/browse-model.ts";
import { PluginsDataProvider, usePluginsData } from "./plugins/data.tsx";
import { DetailPage } from "./plugins/Detail.tsx";
import { PluginsDialogs } from "./plugins/Dialogs.tsx";
import { PluginsPage } from "./plugins/Home.tsx";
import { oldTabTarget } from "./plugins/model.ts";
import { RulePage } from "./plugins/RulePage.tsx";
import { ServerPage } from "./plugins/ServerPage.tsx";
import { SkillPage } from "./plugins/SkillPage.tsx";

export function PluginsLayout() {
  return (
    <PluginsDataProvider>
      <PluginsDialogs>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </PluginsDialogs>
    </PluginsDataProvider>
  );
}

export function IndexRoute() {
  return <PluginsPage key={CAVEMAN} source={{ kind: "market", source: CAVEMAN }} />;
}

export function AgentRoute() {
  const { agent } = useParams();
  return isAgent(agent) ? (
    <PluginsPage key={agent} source={{ kind: "agent", agent }} />
  ) : (
    <Navigate to="/plugins" replace />
  );
}

export function ServerRoute() {
  const { name = "" } = useParams();
  const [params] = useSearchParams();
  const plugin = params.get("plugin");
  return <ServerPage key={`${plugin ?? ""}/${name}`} name={name} pluginId={plugin} />;
}

export function SkillRoute() {
  const [params] = useSearchParams();
  const path = params.get("path");
  return path ? <SkillPage key={path} path={path} /> : <Navigate to="/plugins" replace />;
}

export function RuleRoute() {
  const [params] = useSearchParams();
  const path = params.get("path");
  return path ? <RulePage key={path} path={path} /> : <Navigate to="/plugins" replace />;
}

export function PluginRoute() {
  const { id = "" } = useParams();
  return <DetailPage key={id} id={id} />;
}

export function BrowseRoute() {
  // A marketplace of Caveman's catalog or the team's, named in an old link, is shown as that source.
  const { source = CAVEMAN } = useParams();
  const shown = sourceOf(source, usePluginsData().market.data?.marketplaces ?? []);
  return <PluginsPage key={shown} source={{ kind: "market", source: shown }} />;
}

/** /plugins/<an old tab>, /plugins/from/<marketplace>, /plugins/manage/<tab>: where each lives now. */
export function OldTabRoute() {
  const { tab, marketplace } = useParams();
  return <Navigate to={marketplace ? sourcePath(marketplace) : oldTabTarget(tab)} replace />;
}

/** /customize/* and /spaces/*: both became Plugins. */
export function OldTabRedirect() {
  const { tab } = useParams();
  return <Navigate to={oldTabTarget(tab)} replace />;
}
