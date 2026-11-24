import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("./npm-launcher.mjs", import.meta.url));
const KEY = `${process.platform}-${process.arch}`;
const VERSION = "1.2.3";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

/** `<top>/app/node_modules/@caveman-ai/code` as npm installs the launcher. */
function installLauncher(optional: Record<string, string> = { [`@caveman-ai/code-${KEY}`]: VERSION }): { top: string; scope: string; root: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-launcher-"));
  roots.push(top);
  const scope = path.join(top, "app", "node_modules", "@caveman-ai");
  const root = path.join(scope, "code");
  writeJson(path.join(root, "package.json"), { name: "@caveman-ai/code", version: VERSION, optionalDependencies: optional });
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(LAUNCHER, path.join(root, "bin", "caveman-code.mjs"));
  return { top, scope, root };
}

/** A platform package whose bin.mjs prints where it ran from. */
function platformPackage(dir: string, pkg: { name?: string; version?: string } = {}): void {
  writeJson(path.join(dir, "package.json"), { name: `@caveman-ai/code-${KEY}`, version: VERSION, ...pkg });
  fs.writeFileSync(path.join(dir, "bin.mjs"), `console.log("ran " + ${JSON.stringify(dir)} + " " + process.argv.slice(2).join(" "));\n`);
}

const launch = (root: string, cwd = os.tmpdir()) =>
  spawnSync(process.execPath, [path.join(root, "bin", "caveman-code.mjs"), "--help"], { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });

it("runs the platform package npm put beside it, or in its own node_modules", () => {
  const flat = installLauncher();
  platformPackage(path.join(flat.scope, `code-${KEY}`));
  expect(launch(flat.root).stdout.trim()).toBe(`ran ${path.join(flat.scope, `code-${KEY}`)} code --help`);

  const nested = installLauncher();
  platformPackage(path.join(nested.root, "node_modules", "@caveman-ai", `code-${KEY}`));
  expect(launch(nested.root).stdout.trim()).toBe(`ran ${path.join(nested.root, "node_modules", "@caveman-ai", `code-${KEY}`)} code --help`);
});

it("refuses one at another version or name, one it does not list, and one only Node's module search would find", () => {
  const refused = (result: ReturnType<typeof launch>) => {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`no Caveman Code build for ${KEY} is installed`);
  };
  const otherVersion = installLauncher();
  platformPackage(path.join(otherVersion.scope, `code-${KEY}`), { version: "6.6.6" });
  refused(launch(otherVersion.root));

  const otherName = installLauncher();
  platformPackage(path.join(otherName.scope, `code-${KEY}`), { name: "@caveman-ai/code-evil" });
  refused(launch(otherName.root));

  const unlisted = installLauncher({});
  platformPackage(path.join(unlisted.scope, `code-${KEY}`));
  refused(launch(unlisted.root));

  // A node_modules above the install, or above the folder it is run in: require.resolve's search, never the launcher's.
  const above = installLauncher();
  platformPackage(path.join(above.top, "node_modules", "@caveman-ai", `code-${KEY}`));
  refused(launch(above.root));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-project-"));
  roots.push(project);
  platformPackage(path.join(project, "node_modules", "@caveman-ai", `code-${KEY}`));
  refused(launch(above.root, project));
});
