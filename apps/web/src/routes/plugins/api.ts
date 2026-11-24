// The plugins marketplace's wire types, from Session Protocol, by the names the screens use.
import type { Result } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";

export type { MarketplaceInfo, PluginDetail, PluginPolicy as InstallPolicy, PluginScope as InstallScope, PluginSummary } from "@caveman-app/session-protocol";
export type PluginIncludes = import("@caveman-app/session-protocol").PluginSummary["includes"];
export type ConnectTarget = Result<"plugin.install">["needs_connect"][number];
export type ImportSource = Result<"import.scan">["sources"][number];
export type ImportItem = ImportSource["items"][number];
export type RuleInfo = Result<"rule.list">["rules"][number];

/** skill.save into my skills (~/.agents/skills) or a project's (.agents/skills). */
export const saveSkill = (client: Client, params: { request_id: string; scope: "me" | "project"; project_id?: string; name: string; markdown: string }): Promise<{ path: string }> =>
  client.call("skill.save", params);
