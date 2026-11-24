// The runtime reads every Plugins page shares, made once for the whole frame (PluginsData): the catalog and installs
// (plugin.list, marketplace.list), your MCP servers, the skills and rules engines load. The column and the open page
// read the same copy, so a switch flipped on a page shows in its row at once. Who is asking (useAccount) beside them.
import { createContext, use, useCallback, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { needsSignIn } from "../../state/cloud.ts";
import {
  type ImportSource,
  type MarketplaceInfo,
  type PluginSummary,
  type RuleInfo,
} from "./api.ts";
import type { Server, Skill } from "./installed.ts";
import { useCall, useHere } from "./shared.tsx";

export interface Market {
  readonly marketplaces: ReadonlyArray<MarketplaceInfo>;
  readonly plugins: ReadonlyArray<PluginSummary>;
  readonly featured: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  /** Caveman Cloud could not be read: team and project installs are the last ones it answered. */
  readonly cloudProblem?: string | undefined;
}

type Read<T> = {
  readonly data: T | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
};

export interface PluginsData {
  readonly market: Read<Market>;
  readonly servers: Read<ReadonlyArray<Server>>;
  readonly skills: Read<ReadonlyArray<Skill>>;
  readonly rules: Read<ReadonlyArray<RuleInfo>>;
  /** What Claude Code, Codex and Cursor have that could come in (import.scan): the column's offer reads it. */
  readonly importable: Read<ReadonlyArray<ImportSource>>;
  /** Everything again: after an import or anything that may touch several lists. */
  readonly reloadAll: () => Promise<void>;
}

const CHECKING_OUT = {
  while: (m: Market) => m.marketplaces.some((x) => x.status === "checking_out"),
  ms: 1000,
};
const SIGNING_IN = {
  while: (s: ReadonlyArray<Server>) => s.some((x) => x.status === "signing_in"),
  ms: 2000,
};

const Context = createContext<PluginsData | null>(null);

/** Reads them for the current project (the runtime adds what its repository declares), again when it changes. */
export function PluginsDataProvider({ children }: { children: ReactNode }) {
  const here = useHere();
  const market = useCall<Market>(
    async (client) => {
      const [m, p] = await Promise.all([
        client.call("marketplace.list", here),
        client.call("plugin.list", here),
      ]);
      return {
        marketplaces: m.marketplaces,
        plugins: p.plugins,
        featured: p.featured ?? [],
        categories: p.categories ?? [],
        cloudProblem: p.cloud_problem,
      };
    },
    CHECKING_OUT,
    here.cwd,
  );
  const servers = useCall(
    (c) => c.call("mcp.list", here).then((r) => r.servers),
    SIGNING_IN,
    here.cwd,
  );
  const skills = useCall(
    (c) => c.call("skill.list", {}).then((r) => r.skills),
    undefined,
    here.cwd,
  );
  const rules = useCall((c) => c.call("rule.list", {}).then((r) => r.rules));
  const importable = useCall((c) => c.call("import.scan", {}).then((r) => r.sources));
  const reloadAll = useCallback(async () => {
    await Promise.all([
      market.reload(),
      servers.reload(),
      skills.reload(),
      rules.reload(),
      importable.reload(),
    ]);
  }, [market.reload, servers.reload, skills.reload, rules.reload, importable.reload]);
  const value = useMemo(
    () => ({ market, servers, skills, rules, importable, reloadAll }),
    [market, servers, skills, rules, importable, reloadAll],
  );
  return <Context value={value}>{children}</Context>;
}

export function usePluginsData(): PluginsData {
  const value = use(Context);
  if (value === null) throw new Error("usePluginsData outside PluginsDataProvider");
  return value;
}

/**
 * Signed in to Caveman Cloud (Team installs exist), and whether this person may install for the whole team.
 * `role` is the org role cloud.status reports for the signed-in account; until a runtime sends it, nobody is
 * treated as an admin and Cloud still refuses a Team write without org:update.
 */
export function useAccount() {
  const { data } = useCall(async (client) => {
    const status = await client.call("cloud.status", {}).catch(() => null);
    const role = (status?.account as { role?: string } | undefined)?.role;
    return {
      signedIn: status !== null && status.account !== undefined && !needsSignIn(status),
      admin: role === "owner" || role === "admin",
    };
  });
  return data ?? { signedIn: false, admin: false };
}

/** A new chat with `text` typed in and the plugin mentioned at its start (NewChat reads the state). */
export function useTryInChat() {
  const navigate = useNavigate();
  return (plugin: { id: string; label: string }, text: string) =>
    navigate("/new", { state: { prompt: { plugin, text } } });
}
