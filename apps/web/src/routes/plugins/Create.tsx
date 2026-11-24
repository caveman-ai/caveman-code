// Making things: a new skill (mine, or a project's), and one of my plugins published to the team (admins). The
// Plugins + menu opens them (Dialogs.tsx).
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Input } from "@caveman-app/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Textarea } from "@caveman-app/ui/components/textarea";
import { useState } from "react";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { Segmented } from "../settings/rows.tsx";
import { type MarketplaceInfo, type PluginSummary, saveSkill } from "./api.ts";
import { displayName, teamReach } from "./model.ts";
import { PluginLogo } from "./PluginLogo.tsx";
import { ErrorLine, message, useHere } from "./shared.tsx";

/** Lowercase words joined by hyphens, at most 64: the skill's folder and its name. */
export const skillSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** A SKILL.md: the front matter engines index (the description quoted, as YAML reads JSON), then the instructions. */
export const skillMarkdown = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s+/g, " ").trim())}\n---\n\n${body.trim()}\n`;

export function NewSkillDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved: (skill: { readonly name: string; readonly path: string }) => void }) {
  const { client } = useRuntimeClient();
  const projects = useRuntimeSelector((v) => v.projects);
  const [scope, setScope] = useState<"me" | "project">("me");
  const [projectId, setProjectId] = useState<string | undefined>(projects[0]?.id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = skillSlug(name);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { path } = await saveSkill(client!, { request_id: requestId(), scope, ...(scope === "project" && projectId ? { project_id: projectId } : {}), name: slug, markdown: skillMarkdown(slug, description, body) });
      onSaved({ name: slug, path });
      onOpenChange(false);
      setName("");
      setDescription("");
      setBody("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">New skill</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Segmented label="Whose" value={scope} options={[{ value: "me", label: "Me" }, { value: "project", label: "Project" }]} onChange={setScope} />
            {scope === "project" ? (
              <Select value={projectId ?? ""} onValueChange={setProjectId}>
                <SelectTrigger aria-label="Project" className="h-8 w-auto gap-1.5">
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <Input aria-label="Name" placeholder="Name, like release-notes" value={name} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="When to use it" placeholder="When to use it, in one line" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Textarea aria-label="Instructions" placeholder="The steps, as you would tell a new teammate" rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12.5px]" />
          <ErrorLine>{error}</ErrorLine>
        </div>
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy || slug === "" || description.trim() === "" || body.trim() === "" || (scope === "project" && !projectId)}>
            {busy ? "Saving…" : "Save skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Publish: one of my plugins, installed for the whole team as Available. One from a git marketplace only I have
 * adds that marketplace to the team too; one from a folder cannot reach teammates.
 */
export function PublishDialog({ open, onOpenChange, plugins, marketplaces, onPublished }: { open: boolean; onOpenChange: (open: boolean) => void; plugins: ReadonlyArray<PluginSummary>; marketplaces: ReadonlyArray<MarketplaceInfo>; onPublished: (name: string) => void }) {
  const { client } = useRuntimeClient();
  const here = useHere();
  const [error, setError] = useState<string | null>(null);
  const reachOf = (p: PluginSummary) => teamReach(marketplaces.find((m) => m.name === p.marketplace), true);
  const publish = async (p: PluginSummary) => {
    setError(null);
    const reach = reachOf(p);
    try {
      await client!.call("plugin.install", { request_id: requestId(), id: p.id, scope: "team", policy: "available", ...here, ...(reach.ok && reach.addToTeam ? { add_to_team: true } : {}) });
      onPublished(displayName(p));
      onOpenChange(false);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">Publish to team</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border">
          {plugins.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">None of your plugins to publish yet.</p> : null}
          {plugins.map((p) => {
            const reach = reachOf(p);
            const market = marketplaces.find((m) => m.name === p.marketplace);
            return (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <PluginLogo plugin={p} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{displayName(p)}</span>
                  {!reach.ok ? (
                    <span className="block truncate text-[12.5px] text-muted-foreground">{reach.line}</span>
                  ) : reach.addToTeam ? (
                    <span className="block truncate text-[12.5px] text-muted-foreground">Adds {market?.display_name ?? p.marketplace} to the team</span>
                  ) : null}
                </span>
                <Button size="sm" variant="secondary" disabled={!reach.ok} onClick={() => void publish(p)}>
                  Publish
                </Button>
              </div>
            );
          })}
        </div>
        <ErrorLine>{error}</ErrorLine>
      </DialogContent>
    </Dialog>
  );
}
