// One skill: its instructions as the engine reads them, whose it is, which engines load it and what its line in the
// skills index costs. A plugin's skill turns on and off with its plugin; a file of yours or a project's is always on.
import { Button } from "@caveman-app/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Icon, MoreHorizontalIcon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bar, Page, PageEmpty, Pane, RailRow, RailSection } from "../../components/ListFrame.tsx";
import { CloudBadge, cloudOn, useProfileStatus } from "../../components/cloud/trust.tsx";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { usePluginsData } from "./data.tsx";
import { pluginPath } from "./installed.ts";
import { displayName, pluginScope, type Scope, skillEngines, tokenLabel } from "./model.ts";
import {
  DocBody,
  EngineMarks,
  ErrorLine,
  message,
  OnOff,
  PaneSection,
  ScopeWord,
  useSwitchHere,
} from "./shared.tsx";

const HOME = { label: "Plugins", to: "/plugins" };

/** The last folders of a path: enough to find the file, short enough for the rail. */
const tail = (file: string, parts = 3) => file.split("/").slice(-parts).join("/");

export function SkillPage({ path }: { path: string }) {
  const { client } = useRuntimeClient();
  const data = usePluginsData();
  const cloud = cloudOn(useProfileStatus());
  const switchHere = useSwitchHere();
  const navigate = useNavigate();
  const projects = useRuntimeSelector((v) => v.projects);
  const [error, setError] = useState<string | null>(null);
  const skill = data.skills.data?.find((s) => s.path === path);
  if (data.skills.data === null) {
    return (
      <Page bar={<Bar crumbs={[HOME, { label: "Skill" }]} />}>
        {data.skills.error ? (
          <PageEmpty
            icon="record-skill"
            title="Couldn't read your skills"
            actions={
              <Button variant="secondary" onClick={() => void data.skills.reload()}>
                Try again
              </Button>
            }
          >
            {data.skills.error}
          </PageEmpty>
        ) : null}
      </Page>
    );
  }
  if (skill === undefined) {
    return (
      <Page bar={<Bar crumbs={[HOME, { label: "Skill" }]} />}>
        <PageEmpty
          icon="record-skill"
          title="This skill is gone"
          actions={
            <Button variant="secondary" onClick={() => navigate("/plugins")}>
              Back to Plugins
            </Button>
          }
        >
          Its file was moved or deleted, or its plugin was removed.
        </PageEmpty>
      </Page>
    );
  }
  const plugin = skill.plugin_id
    ? data.market.data?.plugins.find((p) => p.id === skill.plugin_id)
    : undefined;
  const scope: Scope =
    skill.scope === "me" || skill.scope === "project" ? skill.scope : pluginScope(plugin);
  const project = projects.find((p) => p.id === skill.project_id)?.name;
  const toggle = (enabled: boolean) =>
    plugin &&
    client!
      .call("plugin.set_enabled", {
        request_id: requestId(),
        plugin_id: plugin.id,
        enabled,
        ...switchHere,
      })
      .then(
        () => Promise.all([data.market.reload(), data.skills.reload()]),
        (e) => setError(message(e)),
      );
  return (
    <Page
      bar={
        <Bar
          crumbs={[
            HOME,
            ...(plugin ? [{ label: displayName(plugin), to: pluginPath(plugin.id) }] : []),
            { label: skill.name },
          ]}
          actions={
            <>
              {plugin && !plugin.required ? (
                <OnOff
                  checked={plugin.enabled}
                  label={`${displayName(plugin)} (brings ${skill.name})`}
                  title={`Comes with ${displayName(plugin)}: this turns the whole plugin on or off`}
                  onChange={(on) => void toggle(on)}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More">
                    <Icon icon={MoreHorizontalIcon} className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  <DropdownMenuItem
                    onSelect={() => void navigator.clipboard?.writeText(skill.path)}
                  >
                    Copy its path
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
      }
      rail={
        <>
          <RailSection title="Status" className="pt-4">
            <RailRow label="Status">
              {skill.enabled ? (plugin ? "On" : "Always on") : "Off"}
            </RailRow>
            <RailRow label="Whose">
              <ScopeWord scope={scope} />
            </RailRow>
            {plugin ? (
              <RailRow label="From">
                <Link
                  to={pluginPath(plugin.id)}
                  className="truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {displayName(plugin)}
                </Link>
              </RailRow>
            ) : skill.scope === "project" ? (
              <RailRow label="Project">{project ?? "A project"}</RailRow>
            ) : null}
          </RailSection>
          <RailSection title="Reach">
            <RailRow label="Engines">
              <EngineMarks engines={skill.enabled ? skillEngines(skill.engines) : []} />
            </RailRow>
            <RailRow
              label="Idle cost"
              title="Its line in the skills index, estimated from bytes (4 per token); the instructions load only when it is used"
            >
              {tokenLabel(skill.idle_tokens_estimate) ?? "None"}
            </RailRow>
            {cloud && skill.scope === "me" ? (
              <RailRow label="Cloud">
                <CloudBadge kind="skill" ids={[skill.name]} path={skill.path} />
              </RailRow>
            ) : null}
          </RailSection>
          <RailSection title="File">
            <p
              className="break-all pb-6 font-mono text-[12px] leading-[18px] text-muted-foreground"
              title={skill.path}
            >
              {tail(skill.path, 4)}
            </p>
          </RailSection>
        </>
      }
    >
      <Pane>
        <h1 className="text-[22px] font-semibold leading-8 tracking-[-0.015em] text-foreground">
          {skill.name}
        </h1>
        {skill.description ? (
          <p className="mt-1 text-[14px] leading-[22px] text-muted-foreground">
            {skill.description}
          </p>
        ) : null}
        {!plugin ? (
          <p className="mt-3 text-[12.5px] text-[hsl(var(--subtle-foreground))]">
            The engines read this file themselves, so it is on while it is there. Move or delete it
            to stop it.
          </p>
        ) : null}
        <ErrorLine>{error}</ErrorLine>
        <PaneSection title="Instructions">
          <DocBody
            read={() => client!.call("skill.read", { path: skill.path }).then((r) => r.markdown)}
          />
        </PaneSection>
      </Pane>
    </Page>
  );
}
