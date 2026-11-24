// Import: what Claude Code, Codex and Cursor already have on this computer (import.scan, read-only, never a secret
// value), as one checklist per kind of thing (import-model.ts). Everything that can come in starts ticked; what is
// already here is a count; what can't come in is folded under its kind with why. Import applies the ticked ones, each
// row says how it went, and the servers that came in needing a key or a sign-in are set up right there.
// A plain folder (a marketplace, a plugin, or skills) comes in through Import a folder.
import { Button } from "@caveman-app/ui/components/button";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import type { Result } from "@caveman-app/session-protocol";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon, Cancel01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type ReactNode } from "react";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { type ImportItem, type ImportSource } from "./api.ts";
import { IMPORT_TIMEOUT_MS, importGroups, type ImportGroup, type ImportRow, initiallyPicked, refOf, SETUP } from "./import-model.ts";
import { serverNeeds, type Server } from "./installed.ts";
import { ServerSetup } from "./ServerSetup.tsx";
import { ErrorLine, focusDialog, message } from "./shared.tsx";
import { IS_WINDOWS } from "../../lib/platform.ts";

type Outcome = { ok: true } | { ok: false; reason: string };

/** import.apply with room for a setup's marketplace clones (several minutes for twenty), not the usual five. */
export const applyImport = (client: NonNullable<ReturnType<typeof useRuntimeClient>["client"]>, items: ReadonlyArray<Pick<ImportItem, "from" | "kind" | "name">>) =>
  client.call("import.apply", { request_id: requestId(), items: items.map(refOf) }, { timeoutMs: IMPORT_TIMEOUT_MS });

/** The checklist itself: the Import dialog, Settings › Import and the first run all show it. */
export function ImportChecklist({
  onImported,
  onBusy,
  footer,
}: {
  onImported?: () => void;
  /** Told when an import starts and ends, so a dialog can stay open until it is done. */
  onBusy?: (busy: boolean) => void;
  footer?: (apply: { count: number; busy: boolean; done: boolean; run: () => void }) => ReactNode;
}) {
  const { client } = useRuntimeClient();
  const [sources, setSources] = useState<ReadonlyArray<ImportSource> | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [servers, setServers] = useState<ReadonlyArray<Server>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    client.call("import.scan", {}).then(
      (r) => {
        setSources(r.sources);
        setPicked(initiallyPicked(importGroups(r.sources)));
      },
      (e) => setError(message(e)),
    );
  }, [client]);

  const groups = importGroups(sources ?? []);
  const rows = groups.flatMap((g) => g.pick);
  const readServers = async () => setServers((await client!.call("mcp.list", {})).servers);

  const run = async () => {
    setBusy(true);
    onBusy?.(true);
    setError(null);
    const chosen = rows.filter((r) => picked.has(r.key));
    try {
      const r = await applyImport(client!, chosen.map((row) => row.item));
      const failed = new Map(r.failed.map((f) => [`${f.ref.from}\u0000${f.ref.kind}\u0000${f.ref.name}`, f.reason]));
      setOutcome(new Map(chosen.map((row) => [row.key, failed.has(row.key) ? { ok: false, reason: failed.get(row.key)! } : { ok: true }])));
      setPicked(new Set());
      await readServers().catch(() => undefined);
      onImported?.();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  // The servers that just came in and still need something: their sign-in and keys, here.
  const came = new Set(rows.filter((r) => r.item.kind === "mcp_server" && outcome.get(r.key)?.ok).map((r) => r.item.name.toLowerCase()));
  const toFinish = servers.filter((s) => came.has(s.name.toLowerCase()) && serverNeeds(s) !== undefined);
  const toggle = (keys: ReadonlyArray<string>, on: boolean) => setPicked((p) => (on ? new Set([...p, ...keys]) : new Set([...p].filter((k) => !keys.includes(k)))));
  return (
    <div className="flex flex-col gap-4">
      <ErrorLine>{error}</ErrorLine>
      {sources === null && !error ? <p className="text-[13px] text-muted-foreground">Looking at this computer…</p> : null}
      {sources !== null && groups.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing from Claude Code, Codex or Cursor on this computer.</p> : null}
      {sources !== null && groups.length > 0 && rows.length === 0 ? <p className="text-[13px] text-muted-foreground">Everything you use there is already here.</p> : null}
      {busy ? <p className="text-[12.5px] text-muted-foreground">Importing. Marketplaces are copied from git, so a big setup takes a minute or two.</p> : null}
      {toFinish.length > 0 ? <FinishSetup servers={toFinish} onChanged={readServers} /> : null}
      {groups.map((g) => (
        <KindGroup key={g.kind} group={g} picked={picked} outcome={outcome} onToggle={toggle} />
      ))}
      {/* Done once it ran, or when there was nothing left to bring in. */}
      {footer?.({ count: rows.filter((r) => picked.has(r.key)).length, busy, done: sources !== null && (outcome.size > 0 || rows.length === 0), run: () => void run() })}
    </div>
  );
}

/** Servers that came in needing a key or a sign-in: done here, without going to each one. */
function FinishSetup({ servers, onChanged }: { servers: ReadonlyArray<Server>; onChanged: () => Promise<void> }) {
  return (
    <section aria-label="Finish setting up" className="overflow-hidden rounded-xl border border-border border-l-[3px] border-l-warning bg-card">
      <h3 className="px-4 pb-1 pt-3 text-[13.5px] font-medium">Finish setting up</h3>
      <p className="px-4 pb-2 text-[12.5px] text-muted-foreground">These came in and need a key or a sign-in before they work. You can also do it later from each server's page.</p>
      <div className="divide-y divide-border/60">
        {servers.map((s) => (
          <div key={s.name} className="flex flex-col gap-2 px-4 py-3">
            <span className="text-[13px] font-medium">{s.name}</span>
            <ServerSetup server={s} onChanged={onChanged} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Rows a kind shows before "Show all": a Mac with hundreds of plugins still reads as a short list. */
const GROUP_LIMIT = 8;

/** One kind: a tick for all of it, its rows, what is already here, and what can't come in (folded). */
function KindGroup({ group, picked, outcome, onToggle }: { group: ImportGroup; picked: ReadonlySet<string>; outcome: ReadonlyMap<string, Outcome>; onToggle: (keys: ReadonlyArray<string>, on: boolean) => void }) {
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState(false);
  const open = group.pick.filter((r) => !outcome.has(r.key));
  const keys = open.map((r) => r.key);
  const ticked = keys.filter((k) => picked.has(k)).length;
  const imported = group.pick.filter((r) => outcome.get(r.key)?.ok === true).length;
  const shown = all ? group.pick : group.pick.slice(0, GROUP_LIMIT);
  return (
    <section aria-label={group.title} className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex min-h-10 items-center gap-3 border-b border-border/60 px-4">
        {keys.length > 0 ? (
          <Checkbox
            checked={ticked === keys.length ? true : ticked === 0 ? false : "indeterminate"}
            onCheckedChange={(v) => onToggle(keys, v === true)}
            aria-label={`Import every one of the ${group.title.toLowerCase()}`}
          />
        ) : group.pick.length > 0 ? (
          <span className="size-4" />
        ) : null}
        <h3 className="text-[13.5px] font-medium">{group.title}</h3>
        <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
          {[open.length > 0 ? `${open.length} to bring in` : null, imported > 0 ? `${imported} imported` : null, group.here.length > 0 ? `${group.here.length} already here` : null].filter(Boolean).join(" · ")}
        </span>
      </header>
      {shown.map((row) => (
        <Row key={row.key} row={row} checked={picked.has(row.key)} outcome={outcome.get(row.key)} onChange={(on) => onToggle([row.key], on)} />
      ))}
      {group.pick.length > GROUP_LIMIT ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="w-full px-4 py-2 text-left text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {all ? "Show fewer" : `Show all ${group.pick.length}`}
        </button>
      ) : null}
      {group.cant.length > 0 ? (
        <div className={cn(group.pick.length > 0 && "border-t border-border/60")}>
          <button
            type="button"
            aria-expanded={why}
            onClick={() => setWhy((w) => !w)}
            className="flex h-9 w-full items-center gap-2 px-4 text-left text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Icon icon={ArrowRight01Icon} className={cn("size-3 transition-transform duration-150", why && "rotate-90")} />
            {group.cant.length === 1 ? "1 can't come in" : `${group.cant.length} can't come in`}
          </button>
          {why ? (
            <ul className="pb-2">
              {group.cant.map((row) => (
                <li key={row.key} className="flex min-w-0 items-baseline gap-2 px-4 py-1 pl-9 text-[12.5px]">
                  <span className="shrink-0 font-medium text-foreground">{row.item.name}</span>
                  <span className="shrink-0 text-muted-foreground">{SETUP[row.item.from]}</span>
                  <span className="min-w-0 text-muted-foreground">{row.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Row({ row, checked, outcome, onChange }: { row: ImportRow; checked: boolean; outcome: Outcome | undefined; onChange: (on: boolean) => void }) {
  const { item } = row;
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-1.5 text-[13px] has-[:disabled]:cursor-default">
      <Checkbox checked={checked || outcome?.ok === true} disabled={outcome !== undefined} onCheckedChange={(v) => onChange(v === true)} aria-label={`Import ${item.name}`} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">{row.from.map((f) => SETUP[f]).join(" · ")}</span>
        </span>
        {item.detail ? (
          <span className="block truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]" title={item.detail}>
            {item.detail}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {outcome?.ok ? (
          <span className="flex items-center gap-1 text-success">
            <Icon icon={Tick02Icon} className="size-3.5" /> Imported
          </span>
        ) : outcome ? (
          <span className="flex max-w-[260px] items-center gap-1 text-destructive" title={outcome.reason}>
            <Icon icon={Cancel01Icon} className="size-3.5 shrink-0" /> <span className="truncate">{outcome.reason}</span>
          </span>
        ) : row.hint ? (
          <span title={item.credentials?.join(", ")}>{row.hint}</span>
        ) : null}
      </span>
    </label>
  );
}

type FolderPreview = NonNullable<Result<"import.folder">["preview"]>;

/**
 * Import a folder: the desktop's folder picker, or a typed absolute path in a browser (a small dialog asks for it).
 * The runtime first says what the folder brings (skills, MCP servers with the commands they run, hooks, rules); it
 * comes in only once the person confirms. Render `dialog` somewhere on the page.
 */
/** Import a folder: the desktop's picker (or a typed path), what it brings, then in. `onAdded` gets a line and what came in. */
export function useImportFolder(onAdded: (line: string, added: { readonly kind: Result<"import.folder">["kind"]; readonly name: string }) => void) {
  const { client } = useRuntimeClient();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<{ path: string; kind: Result<"import.folder">["kind"]; brings: FolderPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const look = async (p: string) => {
    setError(null);
    try {
      const r = await client!.call("import.folder", { request_id: requestId(), path: p });
      setPreview({ path: p, kind: r.kind, brings: r.preview });
      setTyping(false);
      setPath("");
    } catch (e) {
      // A picked folder it can't read says why where the path can be changed, not nowhere.
      setError(message(e));
      setPath(p);
      setTyping(true);
    }
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client!.call("import.folder", { request_id: requestId(), path: preview.path, confirm: true });
      const added = r.added ?? preview.brings.name;
      onAdded(r.kind === "marketplace" ? `Added the ${added} marketplace` : r.kind === "plugin" ? `Added the ${added} plugin` : `Added skills from ${added}`, { kind: r.kind, name: added });
      setPreview(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setError(null);
    setPath("");
    const pick = window.cavemanDesktop?.pickFolder;
    if (!pick) return setTyping(true);
    const p = await pick();
    if (p) await look(p);
  };
  const dialog = (
    <>
      <Dialog open={typing} onOpenChange={(o) => (setTyping(o), setError(null))}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Import a folder</DialogTitle>
            <DialogDescription>A marketplace, a plugin, or a folder of skills. You see what it brings before anything comes in.</DialogDescription>
          </DialogHeader>
          <form
            id="import-folder"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) void look(path.trim());
            }}
          >
            <Input autoFocus aria-label="Folder path" placeholder={IS_WINDOWS ? "C:\\Users\\you\\my-plugins" : "/Users/you/my-plugins"} value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" />
          </form>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <Button type="submit" form="import-folder" disabled={!path.trim()}>
              Look inside
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent size="md" onOpenAutoFocus={focusDialog} className="outline-none focus-visible:ring-0">
          {preview ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-[15px]">Import {preview.brings.name}?</DialogTitle>
                <DialogDescription className="break-all font-mono text-[12px]">{preview.path}</DialogDescription>
              </DialogHeader>
              <FolderBrings brings={preview.brings} />
              <ErrorLine>{error}</ErrorLine>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Cancel
                </Button>
                <Button onClick={() => void confirm()} disabled={busy}>
                  {busy ? "Importing…" : "Import"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
  return { start: () => void start(), dialog, error: preview || typing ? null : error };
}

/** What a folder brings, by kind; an MCP server shows the command it runs or the URL it reaches. */
function FolderBrings({ brings }: { brings: FolderPreview }) {
  const groups: Array<[string, ReadonlyArray<{ key: string; name: string; detail?: string | undefined }>]> = [
    ["MCP servers", brings.mcp_servers.map((s, i) => ({ key: `${s.plugin ?? ""}/${s.name}/${i}`, name: s.name, detail: s.command !== undefined ? [s.command, ...(s.args ?? [])].join(" ") : s.url }))],
    ["Hooks", brings.hooks.map((h, i) => ({ key: `${h.plugin ?? ""}/${h.event}/${i}`, name: h.event, detail: h.command }))],
    ["Skills", brings.skills.map((name) => ({ key: name, name }))],
    ["Rules", brings.rules.map((name) => ({ key: name, name }))],
  ];
  const shown = groups.filter(([, items]) => items.length > 0);
  if (shown.length === 0) return <p className="text-[13px] text-muted-foreground">Nothing to import in this folder.</p>;
  return (
    <div className="flex max-h-[50vh] flex-col overflow-y-auto rounded-xl border border-border bg-card">
      {shown.map(([title, items]) => (
        <div key={title} className="border-b border-border/60 last:border-b-0">
          <h4 className="px-4 pb-1 pt-2.5 text-[12px] text-muted-foreground">{title}</h4>
          <ul className="pb-1.5">
            {items.map((item) => (
              <li key={item.key} className="flex min-h-8 items-baseline gap-3 px-4 py-1 text-[13px]">
                <span className="shrink-0 font-medium">{item.name}</span>
                {item.detail ? (
                  <code className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={item.detail}>
                    {item.detail}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Import, as a dialog over Plugins or the first run: the checklist, with Import pinned under it. */
export function ImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  // It stays open while importing: closing would lose which rows came in and which could not.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent size="lg" onOpenAutoFocus={focusDialog} className="pb-0 outline-none focus-visible:ring-0">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Bring in what you already use</DialogTitle>
          <DialogDescription>From Claude Code, Codex and Cursor on this computer: names, commands and URLs. Keys are never copied; you paste each one after.</DialogDescription>
        </DialogHeader>
        {open ? (
          <ImportChecklist
            onImported={onImported}
            onBusy={setBusy}
            footer={({ count, busy, done, run }) => (
              // Pinned under the list, so Import stays in reach however long it is.
              <DialogFooter className="sticky bottom-0 -mx-5 border-t border-border bg-popover px-5 py-3">
                {done && count === 0 ? (
                  <Button onClick={() => onOpenChange(false)}>Done</Button>
                ) : (
                  <Button onClick={run} disabled={busy || count === 0}>
                    {busy ? "Importing…" : `Import ${count}`}
                  </Button>
                )}
              </DialogFooter>
            )}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings › Import: the same checklist on a page, with Import a folder beside it. The list runs long (every skill and
 * server of three tools), so its two verbs ride the foot of the page instead of waiting under the last row.
 */
export function ImportSettings() {
  const [note, setNote] = useState<string | null>(null);
  const folder = useImportFolder(setNote);
  return (
    <ImportChecklist
      footer={({ count, busy, run }) => (
        <>
          {folder.dialog}
          {note ? <p className="text-[12.5px] text-success">{note}</p> : null}
          <ErrorLine>{folder.error}</ErrorLine>
          <div className="sticky bottom-0 -mx-2 flex items-center justify-between rounded-t-lg border-t border-border bg-background px-2 py-3">
            <Button variant="ghost" onClick={folder.start}>
              Import a folder…
            </Button>
            <Button onClick={run} disabled={busy || count === 0}>
              {busy ? "Importing…" : `Import ${count}`}
            </Button>
          </div>
        </>
      )}
    />
  );
}
