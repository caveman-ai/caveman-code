// The ways in, one place for all of them: Add an MCP server, New skill, Add marketplace, Import a folder and Publish to
// team. The bar's + menu, the empty page and any page open them through usePluginsDialogs(), so each lives once and
// every way in looks the same. What another agent already has comes in from its own tab (Home.tsx), a switch at a time.
import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { Icon, Add01Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import {
  createContext,
  use,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { NewSkillDialog, PublishDialog } from "./Create.tsx";
import { usePluginsData } from "./data.tsx";
import { useImportFolder } from "./Import.tsx";
import { sourcePath } from "./browse-model.ts";
import { pluginPath, serverPath, skillPath } from "./installed.ts";
import { serverKind, splitCommand, suggestServerName } from "./model.ts";
import { ErrorLine, message, useConnectsElsewhere } from "./shared.tsx";

export interface PluginsDialogsApi {
  readonly addServer: () => void;
  readonly newSkill: () => void;
  readonly addMarketplace: () => void;
  readonly importFolder: () => void;
  /** One of my plugins, installed for the whole team (admins). */
  readonly publish: () => void;
}

const Context = createContext<PluginsDialogsApi | null>(null);

export function usePluginsDialogs(): PluginsDialogsApi {
  const value = use(Context);
  if (value === null) throw new Error("usePluginsDialogs outside PluginsDialogs");
  return value;
}

type Open = "server" | "skill" | "marketplace" | "publish" | null;

export function PluginsDialogs({ children }: { children: ReactNode }) {
  const data = usePluginsData();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open>(null);
  // What a folder brought opens, once the lists have it: its marketplace, its plugin, or Installed for skills.
  const folder = useImportFolder(
    (_line, added) =>
      void data
        .reloadAll()
        .then(() =>
          navigate(
            added.kind === "marketplace"
              ? sourcePath(added.name)
              : added.kind === "plugin"
                ? pluginPath(added.name)
                : "/plugins",
          ),
        ),
  );
  const api = useMemo<PluginsDialogsApi>(
    () => ({
      addServer: () => setOpen("server"),
      newSkill: () => setOpen("skill"),
      addMarketplace: () => setOpen("marketplace"),
      importFolder: folder.start,
      publish: () => setOpen("publish"),
    }),
    [folder.start],
  );
  const shut = (o: boolean) => !o && setOpen(null);
  return (
    <Context value={api}>
      {children}
      <AddServerDialog
        open={open === "server"}
        onOpenChange={shut}
        onAdded={(name) => void data.servers.reload().then(() => navigate(serverPath(name)))}
      />
      <NewSkillDialog
        open={open === "skill"}
        onOpenChange={shut}
        onSaved={(skill) => void data.skills.reload().then(() => navigate(skillPath(skill.path)))}
      />
      <AddMarketplaceDialog
        open={open === "marketplace"}
        onOpenChange={shut}
        onAdded={(name) => void data.market.reload().then(() => navigate(sourcePath(name)))}
      />
      <PublishDialog
        open={open === "publish"}
        onOpenChange={shut}
        plugins={(data.market.data?.plugins ?? []).filter((p) =>
          data.market.data?.marketplaces.some(
            (m) => m.name === p.marketplace && (m.kind === "personal" || m.kind === "added"),
          ),
        )}
        marketplaces={data.market.data?.marketplaces ?? []}
        onPublished={() => void data.market.reload()}
      />
      {folder.dialog}
    </Context>
  );
}

// ------------------------------------------------------------ add an MCP server

type Key = { readonly id: number; name: string; value: string };

/** What the dialog says under a server's keys where the runtime takes none (shared.tsx useConnectsElsewhere). */
export const SERVER_KEYS_ELSEWHERE = "A key or sign-in it needs is added on your own device.";

/**
 * One field to paste what the server's docs give (its URL, or the command that starts it); the name comes from it and
 * can be changed. The keys it needs go in now, name and value together: values go to the runtime's store and never show
 * again. A URL with no keys signs in through the runtime if its service asks (the runtime knocks first and keeps OAuth
 * only for a server that wants it), so there is nothing to choose about signing in.
 *
 * In a window on a Cloud computer that keeps nothing of its person's the runtime takes no key and no sign-in: a key
 * is named here without its value, and the line under them says where it is added.
 */
export function AddServerDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (name: string) => void;
  onImport?: () => void;
}) {
  const { client } = useRuntimeClient();
  const elsewhere = useConnectsElsewhere();
  const [target, setTarget] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [keys, setKeys] = useState<ReadonlyArray<Key>>([]);
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = serverKind(target);
  const shownName = name ?? suggestServerName(target);
  const named = keys.filter((k) => k.name.trim() !== "");
  const ready = target.trim() !== "" && shownName.trim() !== "";
  const reset = () => (setTarget(""), setName(null), setKeys([]), setError(null));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const words = splitCommand(target.trim());
      const names = named.map((k) => k.name.trim());
      const server = await client!.call("mcp.add", {
        request_id: requestId(),
        name: shownName.trim(),
        ...(kind === "url"
          ? {
              url: target.trim(),
              ...(names.length ? { headers: names } : { auth: "oauth" as const }),
            }
          : {
              command: words[0]!,
              ...(words.length > 1 ? { args: words.slice(1) } : {}),
              ...(names.length ? { env: names } : {}),
            }),
      });
      // Each value under the credential the runtime made for it: a variable keeps its name, a header becomes SERVER_HEADER.
      // The server exists now, so a key that fails to save does not hold the dialog (adding again would be refused):
      // its page opens with that key's field still waiting.
      for (const k of named) {
        if (k.value === "") continue;
        const credential = server.credentials.find((c) => (c.header ?? c.name) === k.name.trim());
        if (credential)
          await client!
            .call("credential.grant", {
              request_id: requestId(),
              marketplace: "personal",
              name: credential.name,
              value: k.value,
            })
            .catch(() => undefined);
      }
      onAdded(server.name);
      onOpenChange(false);
      reset();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : reset(), onOpenChange(o))}>
      <DialogContent
        size="md"
        onOpenAutoFocus={(e) => (e.preventDefault(), field.current?.focus())}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">Add an MCP server</DialogTitle>
          <DialogDescription>
            Paste its URL, or the command that starts it. Every agent gets it.
          </DialogDescription>
        </DialogHeader>
        <form id="add-server" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Input
            ref={field}
            aria-label="URL or command"
            placeholder="https://mcp.linear.app/mcp  or  npx -y @acme/mcp-server"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="font-mono"
          />
          <label className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <span className="w-12 shrink-0">Name</span>
            <Input
              aria-label="Server name"
              placeholder="its name"
              value={shownName}
              onChange={(e) => setName(e.target.value)}
              className="h-8 font-mono"
            />
          </label>
          <div className="flex flex-col gap-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2">
                <Input
                  aria-label={kind === "url" ? "Header name" : "Variable name"}
                  placeholder={
                    kind === "url" ? "Header, like Authorization" : "Variable, like ACME_TOKEN"
                  }
                  value={k.name}
                  onChange={(e) =>
                    setKeys((all) =>
                      all.map((x) => (x.id === k.id ? { ...x, name: e.target.value } : x)),
                    )
                  }
                  className="h-8 w-56 font-mono"
                />
                {elsewhere ? null : (
                  <Input
                    type="password"
                    autoComplete="off"
                    aria-label={`Value for ${k.name || "this key"}`}
                    placeholder="Value (or add it later)"
                    value={k.value}
                    onChange={(e) =>
                      setKeys((all) =>
                        all.map((x) => (x.id === k.id ? { ...x, value: e.target.value } : x)),
                      )
                    }
                    className="h-8 min-w-0 flex-1 font-mono"
                  />
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove this key"
                  onClick={() => setKeys((all) => all.filter((x) => x.id !== k.id))}
                >
                  <Icon icon={Cancel01Icon} className="size-3.5" />
                </Button>
              </div>
            ))}
            <span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="-ml-2"
                onClick={() => setKeys((all) => [...all, { id: Date.now(), name: "", value: "" }])}
              >
                <Icon icon={Add01Icon} className="size-3.5" />
                {kind === "url" ? "Add a header" : "Add a key"}
              </Button>
            </span>
          </div>
          <p className="text-[12px] text-muted-foreground">
            {elsewhere
              ? SERVER_KEYS_ELSEWHERE
              : kind === "url" && named.length === 0
                ? "If it asks you to sign in, its page shows a Sign in button."
                : "Values are kept on this computer and never shown again."}
          </p>
          <ErrorLine>{error}</ErrorLine>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-server" disabled={!ready || busy}>
            {busy ? "Adding…" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ add a marketplace

/** Add marketplace: owner/repo (GitHub), a git URL, or a folder (the desktop's picker, or a typed path). */
function AddMarketplaceDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (name: string) => void;
}) {
  const { client } = useRuntimeClient();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (s: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await client!.call("marketplace.add", { request_id: requestId(), source: s });
      setSource("");
      onOpenChange(false);
      onAdded(r.name);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = window.cavemanDesktop?.pickFolder;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Add marketplace</DialogTitle>
          <DialogDescription>
            A GitHub repository, a git URL or a folder with a marketplace.json. Its plugins show
            under Browse.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-marketplace"
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim()) void add(source.trim());
          }}
        >
          <Input
            autoFocus
            aria-label="Marketplace"
            placeholder="anthropics/claude-plugins-official, a git URL, or /path/to/folder"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="font-mono"
          />
        </form>
        <ErrorLine>{error}</ErrorLine>
        <DialogFooter className="sm:justify-between">
          {pick ? (
            <Button
              variant="ghost"
              onClick={() => void pick().then((p) => (p ? add(p) : undefined))}
            >
              Choose a folder…
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" form="add-marketplace" disabled={busy || source.trim() === ""}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
