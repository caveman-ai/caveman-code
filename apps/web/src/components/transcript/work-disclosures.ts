import { createContext, useContext, useState } from "react";
import type { Row } from "./rows.ts";

export type WorkDisclosures = {
  choices: ReadonlyMap<string, boolean>;
  choose: (id: string, open: boolean) => void;
};
export const WorkDisclosuresContext = createContext<WorkDisclosures | null>(null);

// Separate from run ids: opening a group must not open its first tool's output.
export const detailKey = (id: string) => `detail:${id}`;

export function useWorkDetail(id: string): readonly [boolean, (open: boolean) => void] {
  const shared = useContext(WorkDisclosuresContext);
  const [own, setOwn] = useState(false);
  return [shared?.choices.get(detailKey(id)) ?? own, (open) => shared ? shared.choose(detailKey(id), open) : setOwn(open)];
}

/** An explicitly opened step keeps its parent run and completed work readable. */
export function hasOpenWork(row: Row, choices: ReadonlyMap<string, boolean>): boolean {
  return choices.get(row.id) ?? (row.kind === "work" && row.items.some((item) => choices.get(detailKey(item.id)) === true));
}
