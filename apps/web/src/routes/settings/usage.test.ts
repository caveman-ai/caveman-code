import { expect, test } from "vitest";
import { basisOf, usageRowLabel } from "./Usage.tsx";

const engines = [
  { id: "claude-agent", label: "Claude Agent" },
  { id: "codex", label: "Codex" },
];

test("Usage names an engine row by the engine's label, not its id", () => {
 // As spend.summary answers by engine after a Codex turn on a compact plan: key and label are both "codex".
  expect(usageRowLabel({ key: "codex", label: "codex" }, "engine", engines)).toBe("Codex");
  expect(usageRowLabel({ key: "claude-agent", label: "claude-agent" }, "engine", engines)).toBe("Claude Agent");
  // Buckets the runtime already names, and engines this client does not know, stay as reported.
  expect(usageRowLabel({ key: "chief", label: "Chief" }, "engine", engines)).toBe("Chief");
  expect(usageRowLabel({ key: "acp:gemini", label: "acp:gemini" }, "engine", engines)).toBe("acp:gemini");
  // Other groupings are the runtime's own words (workspace titles, model ids, days).
  expect(usageRowLabel({ key: "codex", label: "codex" }, "model", engines)).toBe("codex");
});

test("Usage labels web searches: counted once (in their column), estimated on an own key, billed on credits", () => {
  // The count is the Web searches column's, not said again in the name.
  const web = { key: "web", label: "Web search", web_searches: 12 };
  const workspace = { key: "ws-1", label: "Fix the parser", web_searches: 1 };
  expect(usageRowLabel(web, "engine", engines)).toBe("Web search");
  expect(usageRowLabel(workspace, "workspace", engines)).toBe("Fix the parser");
  expect(basisOf({ basis: "list_price", bucket: "web" }).label).toBe("Estimated");
  expect(basisOf({ basis: "billed", bucket: "web" }).label).toBe("Billed");
  expect(basisOf({ basis: "list_price" }).label).toBe("List price");
});
