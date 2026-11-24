// The reader's write-back and open-in-editor on the real runtime: fs.write
// replaces a workspace file only when it is still the content the client read,
// and editor.list / editor.open drive upstream ExternalLauncher (a recording fake
// here) with workspace paths only.
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import * as ExternalLauncher from "../process/externalLauncher.ts";
import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";
import { liveOutboxes } from "./server.ts";
import { createAttachmentId } from "../attachmentStore.ts";

const root = tempRoot("sp-files-");
const launches: Array<{ cwd: string; editor: string; reveal?: boolean }> = [];
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let config: Awaited<ReturnType<typeof makeConfig>>;
let client: ReturnType<typeof connect>;
let workspaceId: string;
let worktree: string;

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeAll(async () => {
  const provide = Layer.succeed(ExternalLauncher.ExternalLauncher, {
    resolveAvailableEditors: () => Effect.succeed(["cursor", "zed", "file-manager"] as const),
    resolveFileManagerRevealKind: () => Effect.succeed("finder" as const),
    launchBrowser: () => Effect.void,
    launchEditor: (input) => Effect.sync(() => void launches.push({ cwd: input.cwd, editor: input.editor, ...(input.reveal ? { reveal: true } : {}) })),
  } as ExternalLauncher.ExternalLauncher["Service"]);
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  client = connect(runtime.url, runtime.token);
  const repo = makeRepo(root, { "docs/spec.md": "# Spec\n\n- [ ] one\n", "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "w", repo: { path: repo }, title: "Files", engine: "claude-agent", options: { model: MODEL } });
  workspaceId = w.id;
  worktree = w.root_path!;
});

afterAll(async () => {
  client?.close();
  await runtime?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("fs.write replaces a file only while it is the content the client read", async () => {
  const before = (await client.call("fs.read", { workspace_id: workspaceId, path: "docs/spec.md" })).content;
  const ticked = before.replace("[ ]", "[x]");
  expect(await client.call("fs.write", { request_id: "a", workspace_id: workspaceId, path: "docs/spec.md", content: ticked, if_match: sha(before) })).toEqual({ path: "docs/spec.md", size: Buffer.byteLength(ticked) });
  expect(fs.readFileSync(path.join(worktree, "docs/spec.md"), "utf8")).toBe(ticked);
  // The agent (or anyone) changed it since: the stale write is refused, the file is left alone.
  expect(await reason(client.call("fs.write", { request_id: "b", workspace_id: workspaceId, path: "docs/spec.md", content: before, if_match: sha(before) }))).toBe("invalid_state");
  expect(fs.readFileSync(path.join(worktree, "docs/spec.md"), "utf8")).toBe(ticked);
  // Only existing workspace files, never git's own.
  expect(await reason(client.call("fs.write", { request_id: "c", workspace_id: workspaceId, path: "docs/new.md", content: "x" }))).toBe("not_found");
  expect(await reason(client.call("fs.write", { request_id: "d", workspace_id: workspaceId, path: ".git", content: "x" }))).toBe("invalid_params");
  expect(await reason(client.call("fs.write", { request_id: "d2", workspace_id: workspaceId, path: "./.git", content: "x" }))).toBe("invalid_params");
  expect(fs.readdirSync(path.join(worktree, "docs")).sort()).toEqual(["spec.md"]);
});

test("the Files tree names non-ASCII entries as they are, in the working tree and at a ref, and marks an ignored one", async () => {
  const repo = makeRepo(root, { "café.md": "x\n", "docs/日本.md": "y\n" });
  // Git's default, stated so a global core.quotePath=false can't hide what git prints.
  git(repo, "config", "core.quotePath", "true");
  const w = await client.call("workspace.create", { request_id: "accents", repo: { path: repo }, title: "Accents", engine: "claude-agent", options: { model: MODEL } });
  await until(() => fs.existsSync(path.join(w.root_path!, "café.md")));
  const names = async (params: { path: string; ref?: string }) =>
    (await client.call("fs.list", { workspace_id: w.id, include_ignored: true, ...params })).entries.map((e) => `${e.path}${e.ignored ? " ignored" : ""}`).toSorted();
  expect(await names({ path: "", ref: "HEAD" })).toEqual(["café.md", "docs"]);
  expect(await names({ path: "docs", ref: "HEAD" })).toEqual(["docs/日本.md"]);
  fs.writeFileSync(path.join(w.root_path!, ".gitignore"), "*.log\n");
  fs.writeFileSync(path.join(w.root_path!, "naïve.log"), "noise\n");
  expect(await names({ path: "" })).toEqual([".gitignore", "café.md", "docs", "naïve.log ignored"]);
});

test("editor.open reveals folders as folders and refuses paths outside the workspace", async () => {
  await client.call("editor.open", { request_id: "folder-reveal", workspace_id: workspaceId, path: "docs", reveal: true });
  expect(launches.at(-1)).toEqual({ cwd: fs.realpathSync(path.join(worktree, "docs")), editor: "file-manager", reveal: true });
  expect(await reason(client.call("editor.open", { request_id: "outside-reveal", workspace_id: workspaceId, path: "../", reveal: true }))).toBe("invalid_params");
  launches.length = 0;
});

test("HTML browser reads workspace and explicit temporary HTML without opening general host reads or writes", async () => {
  const html = "<!doctype html><html><head><title>Report</title></head><body><h1>HTML report</h1><script>document.body.dataset.ready='yes'</script></body></html>";
  const report = path.join(root, "agent report.HTML");
  fs.writeFileSync(report, html);
  fs.writeFileSync(path.join(worktree, "report.htm"), html);
  const input = { workspace_id: workspaceId };
  expect(await client.call("browser.readFile", { ...input, path: "report.htm" })).toEqual({ path: fs.realpathSync(path.join(worktree, "report.htm")), html });
  expect(await client.call("browser.readFile", { ...input, path: report })).toEqual({ path: fs.realpathSync(report), html });
  // Like the existing media reader, an explicit host path is read-only and HTML-only.
  const privateFile = path.join(root, "private.txt");
  fs.writeFileSync(privateFile, "not an HTML document");
  for (const file of [privateFile, "../agent report.HTML", "//host/share/report.html", "\\\\host\\share\\report.html", "report.html\0", "README.md"]) {
    expect(await reason(client.call("browser.readFile", { ...input, path: file })), file).toBe("invalid_params");
  }
  expect(await reason(client.call("browser.readFile", { ...input, path: path.join(root, "missing.html") }))).toBe("not_found");
  expect(await reason(client.call("browser.readFile", { workspace_id: "no-such-workspace", path: report }))).toBe("not_found");
  expect(await reason(client.call("fs.read", { ...input, path: report }))).toBe("invalid_params");
  expect(await reason(client.call("fs.write", { ...input, request_id: "html-outside-write", path: report, content: "changed" }))).toBe("invalid_params");
  expect(fs.readFileSync(report, "utf8")).toBe(html);
  // Relative symlinks may not escape. An explicitly selected absolute HTML
  // symlink works, but a .html symlink to a non-HTML file does not.
  fs.symlinkSync(report, path.join(worktree, "escaped.html"));
  expect(await reason(client.call("browser.readFile", { ...input, path: "escaped.html" }))).toBe("invalid_params");
  fs.symlinkSync(privateFile, path.join(root, "secret.html"));
  expect(await reason(client.call("browser.readFile", { ...input, path: path.join(root, "secret.html") }))).toBe("invalid_params");
  const bad = path.join(root, "binary.html");
  fs.writeFileSync(bad, Buffer.from([0xff, 0, 0xfe]));
  expect(await reason(client.call("browser.readFile", { ...input, path: bad }))).toBe("invalid_params");
  fs.writeFileSync(bad, "a\0b");
  expect(await reason(client.call("browser.readFile", { ...input, path: bad }))).toBe("invalid_params");
  fs.mkdirSync(path.join(root, "directory.html"));
  expect(await reason(client.call("browser.readFile", { ...input, path: path.join(root, "directory.html") }))).toBe("invalid_params");
  const large = path.join(root, "large.html");
  fs.writeFileSync(large, "");
  fs.truncateSync(large, (16 << 20) + 1);
  expect(await reason(client.call("browser.readFile", { ...input, path: large }))).toBe("invalid_params");
  // A large but supported page is complete, never a truncated script/document.
  const full = "<p>" + "x".repeat(2 << 20) + "</p>";
  fs.writeFileSync(large, full);
  expect((await client.call("browser.readFile", { ...input, path: large })).html).toBe(full);
});

test("the runtime's own state is never read, whatever its name or bytes (T3 #28041)", async () => {
  const input = { workspace_id: workspaceId };
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const shot = path.join(root, "shot.png");
  fs.writeFileSync(shot, png);
  expect((await client.call("media.read", { ...input, path: shot })).mime_type).toBe("image/png");
  fs.mkdirSync(config.secretsDir, { recursive: true });
  fs.mkdirSync(path.join(config.stateDir, "proxy"), { recursive: true });
  const placed = [path.join(config.secretsDir, "shot.png"), path.join(config.stateDir, "proxy", "notes.md")];
  fs.writeFileSync(placed[0]!, png);
  fs.writeFileSync(placed[1]!, "# notes\n");
  fs.writeFileSync(path.join(config.secretsDir, "page.html"), "<html>secret</html>");
  // A link an agent leaves somewhere ordinary is followed to what it names.
  fs.symlinkSync(placed[0]!, path.join(root, "alias.png"));
  for (const file of [...placed, path.join(root, "alias.png")]) {
    expect(await reason(client.call("media.read", { ...input, path: file })), file).toBe("not_found");
  }
  expect(await reason(client.call("browser.readFile", { ...input, path: path.join(config.secretsDir, "page.html") }))).toBe("not_found");
  expect(await reason(client.call("media.read", { ...input, path: config.dbPath }))).toBe("not_found");
});

test("HTML reads reject a leaf/parent symlink swap and never silently truncate a growing document", async () => {
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "OUTSIDE_NON_HTML_PROBE");
  for (const parentSwap of [false, true]) {
    const dir = path.join(worktree, parentSwap ? "parent-race" : "leaf-race");
    fs.mkdirSync(dir);
    const target = path.join(dir, "report.html");
    fs.writeFileSync(target, "<html>Inside</html>");
    const original = fs.promises.open;
    let swapped = false;
    const hook = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === target && !swapped) {
        swapped = true;
        if (parentSwap) {
          const other = path.join(root, "outside-parent");
          fs.mkdirSync(other);
          fs.writeFileSync(path.join(other, "report.html"), "OUTSIDE_HTML_PROBE");
          fs.renameSync(dir, `${dir}-old`);
          fs.symlinkSync(other, dir);
        } else {
          fs.unlinkSync(target);
          fs.symlinkSync(outside, target);
        }
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await reason(client.call("browser.readFile", { workspace_id: workspaceId, path: path.relative(worktree, target) }))).toBe("invalid_params");
      expect(swapped).toBe(true);
    } finally { hook.mockRestore(); syncBuiltinESMExports(); }
  }
  const growing = path.join(worktree, "growing.html");
  fs.writeFileSync(growing, "<html>A</html>");
  const original = fs.promises.open;
  let appended = false;
  const hook = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === growing) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async () => {
        const result = await stat();
        if (!appended) { appended = true; fs.appendFileSync(growing, "<p>finished while reading</p>"); }
        return result;
      }) as typeof handle.stat;
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    expect(await reason(client.call("browser.readFile", { workspace_id: workspaceId, path: "growing.html" }))).toBe("invalid_params");
    expect(appended).toBe(true);
  } finally { hook.mockRestore(); syncBuiltinESMExports(); }
  // The next read, after the agent finished, returns the whole document.
  expect((await client.call("browser.readFile", { workspace_id: workspaceId, path: "growing.html" })).html).toBe(fs.readFileSync(growing, "utf8"));
});

test("HTML replies at the full 16 MiB cap share the bounded read lane without reconnecting", async () => {
  await client.call("fs.read", { workspace_id: workspaceId, path: "README.md" }); // await checkout when this test runs alone
  const file = path.join(worktree, "full-size.html");
  const full = "<html>" + "x".repeat((16 << 20) - 13) + "</html>";
  fs.writeFileSync(file, full);
  const connections = new Set(liveOutboxes);
  const results = await Promise.all(Array.from({ length: 8 }, () => client.call("browser.readFile", { workspace_id: workspaceId, path: "full-size.html" }).then((r) => r.html === full)));
  expect(results).toEqual(Array(8).fill(true));
  // Excessive JSON escaping gets an explicit error, never a queue overflow or
  // reconnect loop. A normal file can still open on the very same connection.
  fs.writeFileSync(file, String.fromCharCode(34).repeat(16 << 20));
  expect(await reason(client.call("browser.readFile", { workspace_id: workspaceId, path: "full-size.html" }))).toBe("internal");
  fs.writeFileSync(file, "<html>Ready</html>");
  expect((await client.call("browser.readFile", { workspace_id: workspaceId, path: "full-size.html" })).html).toBe("<html>Ready</html>");
  expect(new Set(liveOutboxes)).toEqual(connections);
  for (const outbox of connections) expect(outbox.stats().peakBytes).toBeLessThanOrEqual(outbox.limits.max);
});

test("editor.list and editor.open: installed editors, a line where the editor takes one, a reveal", async () => {
  expect(await client.call("editor.list", {})).toEqual({
    editors: [
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ],
    reveal: true,
  });
  await client.call("editor.open", { request_id: "e1", workspace_id: workspaceId, path: "docs/spec.md", line: 3 });
  await client.call("editor.open", { request_id: "e2", workspace_id: workspaceId, path: "README.md", editor: "zed", line: 1 });
  await client.call("editor.open", { request_id: "e3", workspace_id: workspaceId, path: "docs/spec.md", reveal: true });
  const spec = fs.realpathSync(path.join(worktree, "docs/spec.md"));
  expect(launches).toEqual([
    { cwd: `${spec}:3`, editor: "cursor" },
 // Zed takes a bare path (upstream launch style for it): no `:1` it would read as part of the name.
    { cwd: fs.realpathSync(path.join(worktree, "README.md")), editor: "zed" },
    { cwd: spec, editor: "file-manager", reveal: true },
  ]);
  expect(await reason(client.call("editor.open", { request_id: "e4", workspace_id: workspaceId, path: "README.md", editor: "vscode" }))).toBe("unsupported");
  expect(await reason(client.call("editor.open", { request_id: "e5", workspace_id: workspaceId, path: "missing.md" }))).toBe("not_found");
});

test("htmlRender.read returns this chat's html_render pages and no other chat's", async () => {
  const threadOf = (id: string) => {
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    const row = db.prepare("SELECT thread_id FROM caveman_sp_workspaces WHERE id = ?").get(id) as { thread_id: string };
    db.close();
    return row.thread_id;
  };
  const publish = (threadId: string, html: string) => {
    const id = createAttachmentId(threadId, "html")!;
    fs.mkdirSync(config.attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(config.attachmentsDir, `${id}.html`), html);
    return id;
  };
  const other = await client.call("workspace.create", { request_id: "html-other", repo: { path: makeRepo(root, { "a.txt": "a\n" }) }, title: "Other", engine: "claude-agent", options: { model: MODEL } });
  const mine = publish(threadOf(workspaceId), "<!doctype html><h1>Mine</h1>");
  const theirs = publish(threadOf(other.id), "<!doctype html><h1>Theirs</h1>");
  expect(await client.call("htmlRender.read", { workspace_id: workspaceId, attachment_id: mine })).toEqual({ html: "<!doctype html><h1>Mine</h1>" });
  expect(await client.call("htmlRender.read", { workspace_id: other.id, attachment_id: theirs })).toEqual({ html: "<!doctype html><h1>Theirs</h1>" });
  // Another chat's page reads as missing, never as someone else's.
  expect(await reason(client.call("htmlRender.read", { workspace_id: workspaceId, attachment_id: theirs }))).toBe("not_found");
  // Only stored HTML pages by id: no other extension, no paths.
  const image = createAttachmentId(threadOf(workspaceId), "png")!;
  fs.writeFileSync(path.join(config.attachmentsDir, `${image}.png`), "png");
  expect(await reason(client.call("htmlRender.read", { workspace_id: workspaceId, attachment_id: image }))).toBe("invalid_params");
  expect(await reason(client.call("htmlRender.read", { workspace_id: workspaceId, attachment_id: `../${mine}` }))).toBe("invalid_params");
  // A page removed since (a deleted chat's cleanup) is gone, not an error.
  fs.rmSync(path.join(config.attachmentsDir, `${mine}.html`));
  expect(await reason(client.call("htmlRender.read", { workspace_id: workspaceId, attachment_id: mine }))).toBe("not_found");
});
