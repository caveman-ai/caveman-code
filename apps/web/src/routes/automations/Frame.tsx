// The frame Automations and Agents share (components/ListFrame.tsx), with their two sections and the notices both show.
import type { ReactNode } from "react";
import { useMatch } from "react-router";
import { ListFrame } from "../../components/ListFrame.tsx";
import { Notices } from "./actions.tsx";
import { HookSecrets } from "./CloudParts.tsx";

export type Section = "automations" | "agents";

const SECTIONS: ReadonlyArray<{ id: Section; label: string; to: string }> = [
  { id: "automations", label: "Automations", to: "/automations" },
  { id: "agents", label: "Agents", to: "/automations/agents" },
];

export function Frame({ section, column, children }: { section: Section; column: ReactNode; children: ReactNode }) {
  // Only the list is open: a section's own page (an agent's project narrows the list, it opens nothing).
  const home = useMatch(SECTIONS.find((s) => s.id === section)!.to) !== null;
  const agentsOfProject = useMatch("/automations/agents/:projectId") !== null;
  // Notices sit outside the frame: on a phone showing only the list, the page (and anything in it) is hidden.
  return (
    <>
      <ListFrame label="Automations and agents" icon="automations" sections={SECTIONS} current={section} listing={home || (section === "agents" && agentsOfProject)} column={column}>
        {children}
      </ListFrame>
      <Notices />
      <HookSecrets />
    </>
  );
}
