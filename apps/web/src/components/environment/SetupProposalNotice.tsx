// A change to the repo's Cloud setup this chat's agent proposed (propose_setup_change, docs/
// environments-best-2026-10-23 D9), as a card at the end of its transcript: Apply hands it to the repo's setup
// chat (its fix waits in the Computer tab for the person to publish), Dismiss drops it. Read once when the chat
// opens from the runtime alone (environment.proposals: no Cloud call) and kept fresh by environment.proposed;
// the same proposals show in Settings, Environments.
import type { SetupProposal } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useState } from "react";
import { openSurface } from "../../panels/store.ts";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { ProposalCard } from "./parts.tsx";

export function SetupProposalNotice({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const { client } = useRuntimeClient();
  // Only a project with a GitHub remote has a Cloud setup to change, and only then is Cloud asked.
  const github = useRuntimeSelector((v) => v.projects.find((p) => p.id === projectId)?.repository?.host === "github.com");
  const [proposals, setProposals] = useState<ReadonlyArray<SetupProposal>>([]);
  const load = useCallback(async () => {
    if (!client || !projectId || !github) return;
    const answer = await client.call("environment.proposals", { project_id: projectId }).catch(() => null);
    setProposals((answer?.proposals ?? []).filter((p) => p.workspace_id === workspaceId));
  }, [client, projectId, github, workspaceId]);
  useEffect(() => {
    if (!client || !projectId || !github) return;
    void load();
    return client.on("environment.proposed", (u) => {
      if (u.project_id !== projectId || u.proposal.workspace_id !== workspaceId) return;
      setProposals((list) => [u.proposal, ...list.filter((p) => p.id !== u.proposal.id && p.summary !== u.proposal.summary)]);
    });
  }, [client, projectId, github, workspaceId, load]);
  if (!projectId || proposals.length === 0) return null;
  return (
    <div className="mt-3 flex w-full flex-col gap-2">
      {proposals.map((p) => (
        <ProposalCard key={p.id} projectId={projectId} proposal={p} here onDone={load} onApplied={() => openSurface(workspaceId, "computer", {})} />
      ))}
    </div>
  );
}
