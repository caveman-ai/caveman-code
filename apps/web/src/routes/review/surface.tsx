// The "pr" side panel surface: one pull request's review (the Review page's PrPage, embedded) beside the chat it
// was opened from, one tab per pull request. `openPr` is what every widget calls: the chat's panel when there is
// one, else the Review page. Registered on import (panels/surfaces.tsx).
import { Icon, GitPullRequestIcon } from "@caveman-app/ui/icons/huge";
import type { NavigateFunction } from "react-router";
import { loadable } from "../../lib/loadable.ts";
import { defineSurface, type SurfaceProps } from "../../panels/registry.ts";
import { openSurface } from "../../panels/store.ts";
import { prDestination, prKey, type PrAddress } from "./model.ts";

declare module "../../panels/store.ts" {
  interface SurfaceParams {
    /** One pull request, by the address PrPage reads (review/model.ts PrAddress). */
    pr: { project_id: string; number: number; repo?: string | undefined; host?: string | undefined; /** Where it opens; default its guide. */ view?: "guide" | "discussion" | "files" | undefined };
  }
}

const PrPage = loadable(() => import("./PrPage.tsx").then((m) => ({ default: m.PrPage })));

function PrSurface({ tab }: SurfaceProps<"pr">) {
  return <PrPage key={prKey(tab.params)} pr={tab.params} embedded initialTab={tab.params.view} />;
}

defineSurface({
  kind: "pr",
  label: "Pull request",
  icon: ({ className }) => <Icon icon={GitPullRequestIcon} className={className} />,
  identity: (p) => prKey(p),
  title: (tab) => `#${tab.params.number}`,
  // A review wants room: the guide's excerpts and the diff read at half the pane, not a third.
  defaultWidth: "clamp(420px, 50%, 760px)",
  component: PrSurface,
  launcher: false,
  // The same pull request wherever it is read: it can move to another chat's panel.
  portable: () => true,
});

/** Open a pull request where it belongs (model.ts prDestination): in `workspaceId`'s side panel, else the Review page. */
export function openPr(navigate: NavigateFunction, workspaceId: string | null | undefined, pr: PrAddress, open: typeof openSurface = openSurface): void {
  const to = prDestination(workspaceId, pr);
  if (to.kind === "panel") open(to.workspaceId, "pr", { project_id: pr.project_id, number: pr.number, repo: pr.repo, host: pr.host });
  else navigate(to.path);
}
