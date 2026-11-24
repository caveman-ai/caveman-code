import { expect, test } from "vitest";
import { agentsSummary } from "./AgentsCard.tsx";

const row = (mark: "working" | "needs" | "done" | "failed" | "waiting") => ({ state: { label: mark, mark } });

test("the Agents card counts a stopped agent as stopped, never as done", () => {
  expect(agentsSummary([row("failed")])).toBe("1 stopped");
  expect(agentsSummary([row("done"), row("failed"), row("done")])).toBe("2 done, 1 stopped");
  expect(agentsSummary([row("done"), row("done")])).toBe("2 done");
  expect(agentsSummary([row("working"), row("failed")])).toBe("1 working");
  expect(agentsSummary([row("needs"), row("working")])).toBe("1 needs you");
});
