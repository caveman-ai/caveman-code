// The built-in automations skill: the format, taught compactly (from the package's README and RULES), and the
// workflow an agent follows (write the files, check, fix, explain, answer with an automation card). It is a
// Claude plugin dir like grill mode's, which the bundle copies beside its chunks (scripts/bundle.ts).
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const AUTOMATIONS_PLUGIN_DIR = fileURLToPath(new URL("./automations-plugin", import.meta.url));
export const AUTOMATIONS_SKILL_PATH = `${AUTOMATIONS_PLUGIN_DIR}/skills/automations/SKILL.md`;

let cached: string | undefined;
/** The skill's text, frontmatter included. */
export const automationsSkill = (): string => (cached ??= fs.readFileSync(AUTOMATIONS_SKILL_PATH, "utf8"));
