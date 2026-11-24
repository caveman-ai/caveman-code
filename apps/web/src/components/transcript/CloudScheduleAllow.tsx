// Under an agent's schedule_task with where: "cloud": the schedule waits for the person, so Allow is right where it was
// set. Found among the automations as this chat's waiting Cloud schedule with the same prompt; gone once allowed.
import { Button } from "@caveman-app/ui/components/button";
import { Link } from "react-router";

import { detailPath, useActions } from "../../routes/automations/actions.tsx";
import { useAutomations } from "../../routes/automations/data.ts";
import { awaitingAllow } from "../../routes/automations/model.ts";

export function CloudScheduleAllow({
  workspaceId,
  prompt,
}: {
  workspaceId: string;
  prompt: string;
}) {
  const list = useAutomations();
  const actions = useActions();
  const waiting = list.value?.find(
    (a) => awaitingAllow(a) && a.workspace_id === workspaceId && a.prompt === prompt.trim(),
  );
  if (waiting === undefined) return null;
  return (
    <div className="flex items-center gap-2 py-1 pl-6 text-[13px] text-muted-foreground">
      <span>Runs on a Cloud computer of its own, this Mac closed or not, once you allow it.</span>
      <Button size="sm" onClick={() => void actions.allow(waiting)}>
        Allow
      </Button>
      <Button asChild size="sm" variant="ghost">
        <Link to={detailPath(waiting.id)}>Details</Link>
      </Button>
    </div>
  );
}
