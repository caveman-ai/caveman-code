import { expect, test } from "vitest";

import { spaceIdFor } from "../plugins/spaces.ts";
import type { Profile } from "./profile.ts";
import { heldItem, itemsOf, keyOf, type LocalItem } from "./profileMerge.ts";
import { blockedHere, withHeldSpaces } from "./profileSync.ts";

const url = "https://github.com/acme/kit.git";
const sid = spaceIdFor(url);

test("while a marketplace is held here, which of its plugins are off is Cloud's, so none turn on by themselves", () => {
  const remote = itemsOf({
    version: 2,
    plugins: {
      spaces: [{ url, commit: "b".repeat(40), enabled: true }],
      disabled: [`lint@${sid}`, "other@elsewhere"],
      servers: [],
      installed: [],
      trustedHooks: [],
    },
    skills: [],
  } as Profile);
  const local = new Map<string, LocalItem>([
    [
      keyOf("space", url),
      heldItem("space", url, "it is not checked out on This Mac yet", {
        url,
        commit: "b".repeat(40),
      }),
    ],
  ]);
  const out = withHeldSpaces(local, remote);
  expect(out.has(keyOf("disabled", `lint@${sid}`))).toBe(true);
  // Only the held marketplace's: another's turned-off list stays this Mac's own.
  expect(out.has(keyOf("disabled", "other@elsewhere"))).toBe(false);
});

test("a server whose definition here holds a key is never replaced by Cloud's", () => {
  const remote = itemsOf({
    version: 2,
    plugins: {
      spaces: [],
      disabled: [],
      servers: [
        {
          name: "gh",
          command: "npx",
          args: ["gh-mcp"],
          source: "manual",
          enabled: true,
          cloud: "runs",
        },
      ],
      installed: [],
      trustedHooks: [],
    },
    skills: [],
  } as Profile);
  const local = heldItem("server", "gh", "its command line or URL holds a credential", {
    name: "gh",
    command: "npx",
    args: ["gh-mcp", "--token", "x"],
  });
  const blocked = blockedHere(
    { skillFolders: new Map() },
    { claudeDir: "/nonexistent/.claude", codexHome: "/nonexistent/.codex" } as never,
    "/nonexistent",
  );
  expect(blocked(remote.get(keyOf("server", "gh")), local)).toMatch(/holds a key/);
  expect(blocked(remote.get(keyOf("server", "gh")), undefined)).toBeUndefined();
});
