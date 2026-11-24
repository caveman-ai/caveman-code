import type { Client } from "@caveman-app/session-protocol/client";
import { expect, test, vi } from "vitest";
import { isDirectory, resolveReference, stripRepeatedWorkspacePrefix } from "./workspaceRefs.ts";
import type { Entry } from "./tree.ts";

test("a repository-root path in a subfolder project drops the folder's own names (T3 #14510)", async () => {
  expect(stripRepeatedWorkspacePrefix("apps/web/src/a.ts", "/repo/apps/web")).toBe("src/a.ts");
  expect(stripRepeatedWorkspacePrefix("web/src/a.ts", "/repo/apps/web")).toBe("src/a.ts");
  expect(stripRepeatedWorkspacePrefix("Apps\\Web\\src\\a.ts", "C:\\repo\\apps\\web")).toBe("src/a.ts");
  for (const [path, root] of [["src/a.ts", "/repo/apps/web"], ["/repo/apps/web/a.ts", "/repo/apps/web"], ["apps/web", "/repo/apps/web"]] as const) {
    expect(stripRepeatedWorkspacePrefix(path, root), path).toBeNull();
  }
  const listing: Record<string, ReadonlyArray<Entry>> = {
    "apps/web/src": [],
    apps: [],
    src: [{ path: "src/a.ts", name: "a.ts", type: "file" }],
    "": [{ path: "src", name: "src", type: "dir" }, { path: "web", name: "web", type: "dir" }],
    "web/src": [{ path: "web/src/b.ts", name: "b.ts", type: "file" }],
  };
  const call = vi.fn(async (_method: string, params: { path: string }) => ({ entries: listing[params.path] ?? [], truncated: false }));
  const client = { call } as unknown as Client;
  expect(await resolveReference(client, "w", { path: "apps/web/src/a.ts", line: 4 }, [], "/repo/apps/web")).toEqual({ path: "src/a.ts", line: 4 });
  expect(await resolveReference(client, "w", { path: "apps/web/src" }, [], "/repo/apps/web")).toEqual({ path: "src", directory: true });
  // The literal path wins when it is there, and nothing changes without the folder's path.
  expect(await resolveReference(client, "w", { path: "web/src/b.ts" }, [], "/repo/apps/web")).toEqual({ path: "web/src/b.ts" });
  expect(await resolveReference(client, "w2", { path: "apps/web/src/a.ts" }, [])).toEqual({ path: "apps/web/src/a.ts" });
});
import { TreeStore } from "./treeStore.ts";

const entry = (path: string, type: "file" | "dir" = "dir") => ({ path, name: path.split("/").at(-1)!, type });
const makeClient = (entries: ReadonlyArray<Entry> = [entry("src"), entry("README.md", "file")]) => {
  const call = vi.fn(async (method: string) => method === "fs.list" ? { entries, truncated: false } : { paths: ["lib/retry.ts", "src/longer/retry.ts"], truncated: false });
  return { client: { call } as unknown as Client, call };
};

test("actual directories resolve without trailing slashes, including dotted names", async () => {
  const { client, call } = makeClient([entry("apps/web/src"), entry("apps/web/ui.v2")]);
  expect(await resolveReference(client, "w", { path: "apps/web/src" })).toEqual({ path: "apps/web/src", directory: true });
  expect(await resolveReference(client, "w", { path: "apps/web/ui.v2" })).toEqual({ path: "apps/web/ui.v2", directory: true });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("fs.list", { workspace_id: "w", path: "apps/web", include_ignored: true });
});

test("a folder hint never searches for a file with the same name", async () => {
  const { client, call } = makeClient();
  expect(await resolveReference(client, "w", { path: "src", directory: true })).toEqual({ path: "src", directory: true });
  expect(call).not.toHaveBeenCalled();
});

test("line references stay files and bare names still prefer this chat, then the shortest search match", async () => {
  const { client, call } = makeClient();
  expect(await resolveReference(client, "w", { path: "src", line: 2 }, ["app/src"])).toEqual({ path: "app/src", line: 2 });
  expect(call).not.toHaveBeenCalled();
  expect(await resolveReference(client, "w", { path: "retry.ts", line: 12 })).toEqual({ path: "lib/retry.ts", line: 12 });
  expect(await resolveReference(client, "w", { path: "src/retry.ts", line: 4 })).toEqual({ path: "src/retry.ts", line: 4 });
});

test("concurrent code spans share listings, scopes stay separate, symlinks are not folders", async () => {
  const { client, call } = makeClient([entry("src"), { ...entry("linked"), type: "symlink" }]);
  expect(await Promise.all([isDirectory(client, "a", "src"), isDirectory(client, "a", "identifier"), isDirectory(client, "a", "linked")])).toEqual([true, false, false]);
  expect(call).toHaveBeenCalledTimes(1);
  await isDirectory(client, "b", "src");
  expect(call).toHaveBeenCalledTimes(2);
});

test("failed listing can retry, failed search falls back to a viewer error", async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ entries: [entry("src")] });
  const client = { call } as unknown as Client;
  expect(await isDirectory(client, "w", "src")).toBe(false);
  expect(await isDirectory(client, "w", "src")).toBe(true);
  call.mockRejectedValue(new Error("offline"));
  expect(await resolveReference(client, "w", { path: "missing.ts", line: 1 })).toEqual({ path: "missing.ts", line: 1 });
});

test("opening a folder reveals all ancestors, clears search, expands the folder and focuses its row", async () => {
  const call = vi.fn(async (_method: string, { path }: { path: string }) => ({ entries: path === "" ? [entry("apps")] : path === "apps" ? [entry("apps/web")] : path === "apps/web" ? [entry("apps/web/src")] : [entry("apps/web/src/main.ts", "file")], truncated: false }));
  const store = new TreeStore("w");
  store.reset({ call } as unknown as Client);
  store.setQuery("old search");
  await store.reveal("apps/web/src", true);
  expect([...store.state.expanded]).toEqual(["apps", "apps/web", "apps/web/src"]);
  expect(store.state.query).toBe("");
  expect(store.state.scrollTo).toBe("apps/web/src");
  expect(call).toHaveBeenCalledTimes(4);
});
