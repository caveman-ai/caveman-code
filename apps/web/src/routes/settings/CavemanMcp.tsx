import type { McpClientId, OutsideAgent, OutsideAgentLevel, OutsideAgentList } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { BrandMark, type BrandName } from "@caveman-app/ui/icons/brand";
import { Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useState } from "react";
import { unserved } from "../../components/cloud/trust.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { agentLine, agentMark, installRows, LEVELS, levelOf, levelScope, patchAgent, sortAgents, withAgent, withClient, type InstallRow } from "./caveman-mcp-model.ts";
import { SettingRow, SettingsCard } from "./rows.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const message = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

/** A runtime from before outside agents: nothing has connected, and there is no command to offer yet. */
const NONE: OutsideAgentList = { agents: [], command: [] };

/** outside_agent.list from this computer's runtime, kept live by outside_agent.changed. */
function useOutsideAgents() {
  const { client, connection } = useRuntimeClient();
  const [list, setList] = useState<OutsideAgentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const off = client.on("outside_agent.changed", (next) => {
      if (!live) return;
      setList(next);
      setError(null);
    });
    client.call("outside_agent.list", {}).then(
      (next) => {
        if (!live) return;
        setList(next);
        setError(null);
      },
      (e: unknown) => {
        if (!live) return;
        // A runtime from before it answers "unknown method": the page shows its empty state, quietly.
        if (unserved(e)) setList(NONE);
        else setError(message(e));
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [client, connection, tick]);
  return { client, list, setList, error, retry: useCallback(() => setTick((n) => n + 1), []) };
}

/** An install's answer can take two CLI runs of up to 20 s each (the runtime's limit), and a little more. */
const INSTALL_TIMEOUT_MS = 60_000;

/**
 * Settings > Work > Caveman MCP: one click adds `caveman-code mcp` to each agent on this Mac (Claude Code, Codex,
 * Cursor, VS Code, Grok Build; the runtime does it, outside_agent.install), or the line to add by hand; then every
 * agent that has connected, with its level and Disconnect (docs/ §1, §4).
 * Never any spend.
 */
export function CavemanMcpSettings() {
  const { client, list, setList, error, retry } = useOutsideAgents();
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);
  const [installing, setInstalling] = useState<ReadonlySet<McpClientId>>(new Set());
  const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});

  const install = async (id: McpClientId) => {
    if (!client) return;
    setInstalling((now) => new Set(now).add(id));
    setInstallErrors((now) => Object.fromEntries(Object.entries(now).filter(([k]) => k !== id)));
    try {
      const next = await client.call("outside_agent.install", { request_id: requestId(), client: id }, { timeoutMs: INSTALL_TIMEOUT_MS });
      setList((now) => (now ? withClient(now, next) : now));
    } catch (e) {
      setInstallErrors((now) => ({ ...now, [id]: message(e) }));
    } finally {
      setInstalling((now) => {
        const rest = new Set(now);
        rest.delete(id);
        return rest;
      });
    }
  };

  const update = async (agent: OutsideAgent, patch: { level?: OutsideAgentLevel; blocked?: boolean }) => {
    if (!client || !list) return;
    const before = list;
    setRowError(null);
    // The control moves at once; the runtime's answer (and its outside_agent.changed) settles it.
    setList(patchAgent(list, agent.name, patch));
    try {
      const next = await client.call("outside_agent.update", { request_id: requestId(), name: agent.name, ...patch });
      setList((now) => (now ? withAgent(now, next) : now));
    } catch (e) {
      setList(before);
      setRowError({ name: agent.name, message: message(e) });
    }
  };

  const rows = installRows(list?.command ?? [], list?.clients, list?.agents);
  const agents = list ? sortAgents(list.agents) : [];
  return (
    <>
      {rows.length > 0 ? (
        <SettingsCard title="Install" description="Lets other agents on this Mac start chats here, follow them and answer their questions.">
          {rows.map((row) => (
            <InstallClientRow
              key={row.id}
              row={row}
              busy={row.id !== "any" && installing.has(row.id)}
              error={row.id === "any" ? null : (installErrors[row.id] ?? null)}
              onInstall={() => {
                if (row.id === "any") return;
 // bot: the server goes on the clipboard first, to paste in bot once it opens.
                if (row.copies) void navigator.clipboard.writeText(row.manual.text).catch(() => undefined);
                void install(row.id);
              }}
            />
          ))}
        </SettingsCard>
      ) : null}
      <SettingsCard title="Connected agents" description="A new agent starts at Supervised.">
        {error ? (
          <SettingRow label="Couldn't load the agents" description={<span className="text-destructive">{error}</span>}>
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          </SettingRow>
        ) : list === null ? (
          <SettingRow label="Loading…" />
        ) : agents.length === 0 ? (
          <SettingRow
            label="No agent has connected yet"
            description="One shows here once it connects."
          />
        ) : (
          agents.map((agent) => <AgentRow key={agent.name} agent={agent} error={rowError?.name === agent.name ? rowError.message : null} onUpdate={(patch) => void update(agent, patch)} />)
        )}
      </SettingsCard>
    </>
  );
}

/** Every row's verb is as wide as the next one's, so the card's right column is one edge. */
const ACTION = "min-w-28";

const CLIENT_BRAND: Partial<Record<InstallRow["id"], BrandName>> = { "claude-code": "claude", codex: "openai", cursor: "cursor", grok: "grok", "grok-bot": "grok" };

/** Copy, then Copied for a moment; says so when the clipboard is out of reach. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => (setFailed(false), setCopied(true)),
      () => setFailed(true),
    );
  return { copied, failed, copy };
}

/**
 * One client: its mark and name, one muted line, and on the right Install (here, without it), Installed with Install
 * again (it holds the server), or Copy for the line to add by hand (not here, any other client, an older runtime). The
 * line itself stays off the page until it is needed: a failed install says why and shows it, and so does a clipboard
 * that could not be reached.
 */
export function InstallClientRow({ row, busy, error, onInstall }: { row: InstallRow; busy: boolean; error: string | null; onInstall: () => void }) {
  const { copied, failed, copy } = useCopy(row.manual.text);
  const brand = CLIENT_BRAND[row.id];
  const showLine = error !== null || failed;
  const copyButton = (
    <Button variant="secondary" aria-label={copied ? `Copied the line for ${row.client}` : `Copy the line for ${row.client}`} title={row.manual.text} onClick={copy} className={ACTION}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
  return (
    <SettingRow
      icon={brand ? <BrandMark name={brand} size={16} /> : <Glyph name={row.id === "vscode" ? "artifact-code" : "tool-mcp"} className="text-muted-foreground" />}
      label={row.client}
      description={
        <>
          {row.line ? <span className="block">{row.line}</span> : null}
          {error ? <span className="block text-destructive">{error}</span> : null}
          {showLine ? (
            <code className="mt-0.5 block select-all whitespace-pre-wrap font-mono text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{row.manual.text}</code>
          ) : null}
          {failed ? <span className="mt-0.5 block text-destructive">The clipboard is not reachable here. Select the line and copy it.</span> : null}
        </>
      }
    >
      {row.state === "ready" ? (
        <>
          {error ? copyButton : null}
          <Button variant="secondary" disabled={busy} aria-label={busy ? `Installing Caveman MCP in ${row.client}` : row.copies ? `Copy the server and open ${row.client}` : `Install Caveman MCP in ${row.client}`} onClick={onInstall} className={ACTION}>
            {busy ? (row.copies ? "Opening…" : "Installing…") : row.action}
          </Button>
        </>
      ) : row.state === "installed" ? (
        <>
          {error ? copyButton : null}
          <span className="flex items-center gap-1 text-[12.5px] text-muted-foreground">
            <Icon icon={Tick02Icon} className="size-3.5" aria-hidden />
            {row.copies ? "Connected" : "Installed"}
          </span>
          <Button variant="ghost" disabled={busy} aria-label={busy ? `Installing Caveman MCP in ${row.client}` : `Install Caveman MCP in ${row.client} again`} onClick={onInstall} className={ACTION}>
            {busy ? (row.copies ? "Opening…" : "Installing…") : row.copies ? row.action : "Install again"}
          </Button>
        </>
      ) : (
        copyButton
      )}
    </SettingRow>
  );
}

/** One agent: its name and mark, connected or last seen, its chats; its level, and Disconnect or Allow again. */
export function AgentRow({ agent, error, onUpdate }: { agent: OutsideAgent; error: string | null; onUpdate: (patch: { level?: OutsideAgentLevel; blocked?: boolean }) => void }) {
  const mark = agentMark(agent.name);
  const level = levelOf(agent.level);
  return (
    <SettingRow
      icon={mark ? <EngineLogo engine={mark} size={16} className={agent.blocked ? "opacity-50" : undefined} /> : <Glyph name="tool-mcp" className="text-muted-foreground" />}
      label={<span className={agent.blocked ? "text-muted-foreground" : undefined}>{agent.name}</span>}
      description={
        <>
          <span className="tabular-nums">{agentLine(agent)}</span>
          {/* The boundary, said where it is in force, not only in the menu. */}
          {agent.level === "full" && !agent.blocked ? <span className="block">{level.line}</span> : null}
          {error ? <span className="block text-destructive">{error}</span> : null}
        </>
      }
    >
      <Select value={agent.level} onValueChange={(next) => onUpdate({ level: next as OutsideAgentLevel })}>
        <SelectTrigger aria-label={`What ${agent.name} may do`} title={levelScope(agent.name)} className="w-40">
          <SelectValue>{level.label}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end" className="w-[380px]">
          <SelectGroup>
            {/* A level is kept by name: every client that connects as this agent shares it. */}
            <SelectLabel>{levelScope(agent.name)}</SelectLabel>
            {LEVELS.map((l) => (
              <SelectItem key={l.value} value={l.value} className="h-auto items-start py-1.5">
                <span className="flex items-start gap-2">
                  <Glyph name={l.icon} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{l.label}</span>
                    <span className="block text-[12px] leading-[18px] text-muted-foreground">{l.line}</span>
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {agent.blocked ? (
        <Button variant="secondary" aria-label={`Allow ${agent.name} again`} onClick={() => onUpdate({ blocked: false })} className={ACTION}>
          Allow again
        </Button>
      ) : (
        <Button variant="secondary" aria-label={`Disconnect ${agent.name}`} onClick={() => onUpdate({ blocked: true })} className={ACTION}>
          Disconnect
        </Button>
      )}
    </SettingRow>
  );
}
