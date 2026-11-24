// Builds src/templates.generated.ts from templates/<id>/ (automation.yaml,
// agents/*.md, template.json). `node scripts/build-templates.ts --write`
// rewrites it; test/templates.test.ts fails when it is stale.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../templates/", import.meta.url);
export const generatedPath = new URL("../src/templates.generated.ts", import.meta.url);

export const buildTemplatesModule = (): string => {
  const templates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const dir = new URL(`${id}/`, root);
      const meta = JSON.parse(readFileSync(new URL("template.json", dir), "utf8")) as { title: string; category: string; summary: string; scope: "me" | "project" };
      const automationDir = meta.scope === "me" ? ".caveman/local/automations" : ".caveman/automations";
      let agents: string[] = [];
      try {
        agents = readdirSync(new URL("agents/", dir)).filter((name) => name.endsWith(".md")).sort();
      } catch {
        agents = [];
      }
      const files = [
        { path: `${automationDir}/${id}.yaml`, text: readFileSync(new URL("automation.yaml", dir), "utf8") },
        ...agents.map((name) => ({ path: `.caveman/agents/${name}`, text: readFileSync(new URL(`agents/${name}`, dir), "utf8") })),
      ];
      return { id, title: meta.title, category: meta.category, summary: meta.summary, scope: meta.scope, files };
    });
  return [
    "// Generated from templates/<id>/ by scripts/build-templates.ts. Do not edit; run `pnpm build:templates`.",
    `export const TEMPLATE_SOURCES = ${JSON.stringify(templates, null, 2)} as const;`,
    "",
  ].join("\n");
};

if (process.argv.includes("--write")) writeFileSync(generatedPath, buildTemplatesModule());
