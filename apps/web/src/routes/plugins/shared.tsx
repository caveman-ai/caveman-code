// The small pieces every Plugins page shares: the bar's On/Off switch, a page's section, the rail's engines and
// whose-it-is, a document's text, the error line, and the runtime reads (useCall, useAct, useHere).
import { Response } from "@caveman-app/ui/ai/response";
import { Switch } from "@caveman-app/ui/components/switch";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@caveman-app/ui/components/button";
import { Icon, ArrowDown01Icon } from "@caveman-app/ui/icons/huge";
import { ProjectPicker, useLastProject } from "../../components/ProjectPicker.tsx";
import { credentialsOutside } from "../../state/engines.ts";
import { useRuntimeClient, useRuntime, useRuntimeSelector } from "../../state/runtime.tsx";
import { ENGINE_LABEL, type EngineKey, SCOPE_TITLE, type Scope } from "./model.ts";
import { useScopeProject } from "./scope.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export const message = (e: unknown) =>
  (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

/** A sign-in the runtime answered "error" for without saying why. */
export const SIGN_IN_UNFINISHED = "The sign-in did not finish. Try again.";

/**
 * Where a Connect or Sign in button would be, in a window on a Cloud computer that keeps nothing of its person's: the
 * runtime there connects and removes no connector (its refusal: "Connectors are connected and removed in Settings on
 * your Mac, never from inside a Cloud computer").
 */
export const CONNECT_ELSEWHERE = "Connect it on your own device.";

/**
 * Where a key's paste field would be, there: the runtime keeps no key for a server (its refusal to credential.grant:
 * "A key for a plugin or an MCP server is never kept inside a Cloud computer").
 */
export const KEY_ELSEWHERE = "Add it on your own device.";

/** Whether this window's runtime is such a computer (state/engines.ts credentialsOutside). */
export const useConnectsElsewhere = (): boolean => credentialsOutside(useRuntimeSelector((v) => v.engines));

const ENGINE_ICON: Record<EngineKey, PixelIconName> = {
  caveman: "engine-caveman",
  "claude-agent": "engine-claude-agent",
  codex: "engine-codex",
  acp: "engine-acp",
};

/** The engines that load it, as their marks in a row (the rail is narrow); their names on hover and for readers. */
export function EngineMarks({ engines }: { engines: ReadonlyArray<EngineKey> }) {
  if (engines.length === 0) return <span className="text-muted-foreground">None</span>;
  const names = engines.map((e) => ENGINE_LABEL[e]).join(", ");
  return (
    <span role="img" aria-label={names} title={names} className="flex items-center gap-1.5">
      {engines.map((e) => (
        <Glyph key={e} name={ENGINE_ICON[e]} />
      ))}
    </span>
  );
}

const SCOPE_WORD: Record<Scope, string> = { me: "Just me", project: "This project", team: "My team" };

/** Whose it is, in the rail: just me, a project's, the team's. */
export function ScopeWord({ scope }: { scope: Scope }) {
  return <span title={SCOPE_TITLE[scope]}>{SCOPE_WORD[scope]}</span>;
}

/** On or off, in the bar: the switch with its word beside it, so the state reads without hovering. */
export function OnOff({ checked, label, title, onChange, disabled }: { checked: boolean; label: string; title?: string | undefined; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className="mr-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[12.5px] text-muted-foreground has-[:disabled]:cursor-default" title={title}>
      {checked ? "On" : "Off"}
      <Switch checked={checked} disabled={disabled} aria-label={`${label}: ${checked ? "on" : "off"}`} onCheckedChange={onChange} />
    </label>
  );
}

/** A part of a page: a quiet heading (with its own verb at the right), then what it holds. `warn` marks one to do. */
export function PaneSection({ title, action, warn, children }: { title: string; action?: ReactNode; warn?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn("mt-8", warn && "rounded-xl border border-border border-l-[3px] border-l-warning bg-card px-4 pb-4 pt-3")}>
      <header className="mb-2.5 flex min-h-7 items-center gap-2">
        <h2 className={cn("text-[13px]", warn ? "font-medium text-foreground" : "text-muted-foreground")}>{title}</h2>
        {action ? <span className="ml-auto flex items-center gap-1">{action}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** A document's text, read once when its page opens; front matter (for the engine) left out. */
export function DocBody({ read }: { read: () => Promise<string> }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `read` is a fresh closure each render; the page reads once per opening.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void read().then(setText, (e) => setError(message(e))), []);
  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (text === null) return <div aria-hidden className="h-24 rounded-lg bg-foreground/[0.03]" />;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return body === "" ? <p className="text-[13px] text-muted-foreground">Empty.</p> : <Response className="text-[14px]">{body}</Response>;
}

/**
 * A dialog that opens without lighting up its first control: focus goes to the dialog itself (Radix gives it
 * tabIndex -1), so keys, Tab and screen readers are inside it, not on the page behind.
 */
export const focusDialog = (event: Event) => {
  event.preventDefault();
  (event.target as HTMLElement | null)?.focus();
};

export function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {children}
    </p>
  ) : null;
}

/** Runs a call, keeps its error for the page to show, and reloads after it either way. */
export function useAct(reload: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(
    async (call: () => Promise<unknown>) => {
      setError(null);
      try {
        await call();
      } catch (e) {
        setError(message(e));
      } finally {
        await reload();
      }
    },
    [reload],
  );
  return { error, act };
}

/** A runtime read, reloaded on demand (and every `pollMs` while `poll` says so), and again when `key` changes. */
export function useCall<T>(read: (client: NonNullable<ReturnType<typeof useRuntime>["client"]>) => Promise<T>, poll?: { while: (data: T) => boolean; ms: number }, key?: string) {
  const { client } = useRuntimeClient();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `read` is a fresh closure each render; the client and `key` are what change the answer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setData(await read(client));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [client, key]);
  useEffect(() => void reload(), [reload]);
  const polling = data !== null && poll !== undefined && poll.while(data);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void reload(), poll!.ms);
    return () => clearInterval(timer);
  }, [polling, reload, poll]);
  return { data, error, reload };
}

/**
 * `{ cwd }` of the project the Plugins pages are about (scope.tsx), for every plugin call: the runtime adds what its
 * repository declares and its project's installs. Empty for everywhere.
 */
export function useHere(): { cwd?: string } {
  const project = useScopeProject();
  return project ? { cwd: project.path } : {};
}

/**
 * What a switch on the Plugins pages turns: with a project picked, that project's own switch (every other project
 * keeps what it has); with none, the everywhere one. Spread into plugin.set_enabled and mcp.set_enabled.
 */
export function useSwitchHere(): { cwd?: string; here?: true } {
  const project = useScopeProject();
  return project ? { cwd: project.path, here: true } : {};
}
