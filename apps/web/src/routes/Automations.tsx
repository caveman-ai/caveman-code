// Automations (/automations): the list on the left; on the right nothing open, one automation (/automations/:id) with
// its newest run as a thread or one of its runs (/automations/:id/runs/:runId), or its settings
// (/automations/:id/settings). New automation floats over whichever is open (`?new`). Agents (/automations/agents) is
// the same frame over agent files. The pages live in ./automations/.
import { Button } from "@caveman-app/ui/components/button";
import { Navigate, Outlet, useParams } from "react-router";
import { AgentsPage } from "./automations/Agents.tsx";
import { DetailPage, SettingsPage } from "./automations/Detail.tsx";
import { Page, PageEmpty } from "../components/ListFrame.tsx";
import { Frame } from "./automations/Frame.tsx";
import { AutomationsColumn } from "./automations/List.tsx";
import { NewAutomation, useNewAutomation } from "./automations/New.tsx";

export function AutomationsLayout() {
  return (
    <Frame section="automations" column={<AutomationsColumn />}>
      <Outlet />
      <NewAutomation />
    </Frame>
  );
}

/** Nothing open: what goes here, and the two ways to start one. */
export function IndexRoute() {
  const openNew = useNewAutomation();
  return (
    <Page bar={null}>
      <PageEmpty
        icon="automations"
        title="Automations"
        actions={
          <>
            <Button onClick={() => openNew()}>New automation</Button>
            <Button variant="secondary" onClick={() => openNew("template")}>
              Use a template
            </Button>
          </>
        }
      >
        Pick one on the left to see its last run, or make one that runs on a schedule or when something happens.
      </PageEmpty>
    </Page>
  );
}

export function AgentsRoute() {
  const { projectId, name } = useParams();
  return <AgentsPage open={projectId && name ? { projectId, name } : null} />;
}

export function AutomationRoute() {
  const { id, runId } = useParams();
  if (!id) return <Navigate to="/automations" replace />;
  // Keyed by the automation: another one is a fresh page; another of its runs keeps the page and swaps the thread.
  return <DetailPage key={id} id={id} runId={runId} />;
}

export function SettingsRoute() {
  const { id } = useParams();
  if (!id) return <Navigate to="/automations" replace />;
  return <SettingsPage key={id} id={id} />;
}
