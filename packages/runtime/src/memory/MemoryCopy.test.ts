// The markdown copy (docs/memory.md "Copies and the commit path"): what the runtime makes of what a command left in the
// copy or does to it as the runtime works, what a copy holds as other writers move its notes, and what a resumed session
// is given.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, assert, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseNote,
  runCopyTool,
  startSession,
  turnEndSweep,
  type CopySession,
  type RenderContext,
} from "./MemoryCopy.ts";
import { MemoryStore, newId, type Operation, type WriterContext } from "./MemoryStore.ts";

// The runtime's own file calls, as a command in the copy meets them. Opening a pipe without O_NONBLOCK waits for its
// other end, on the runtime's only thread: here such an open fails instead, so a call that would wait fails the test
// rather than hanging it. And `between.step`, when set, is a command the agent left running in the copy: it gets a turn
// after each call.
const between = vi.hoisted(() => ({ step: undefined as (() => void) | undefined, busy: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { O_CREAT, O_EXCL, O_NONBLOCK = 0 } = actual.constants;
  const flagsOf = (flag: unknown) =>
    typeof flag === "number" ? flag : String(flag).includes("x") ? O_CREAT | O_EXCL : 0;
  const optionFlag = (options: unknown, fallback: string): unknown =>
    typeof options === "object" && options !== null && "flag" in options ? options.flag : fallback;
  const opens: Record<string, (args: unknown[]) => unknown> = {
    openSync: (args) => args[1] ?? "r",
    readFileSync: (args) => optionFlag(args[1], "r"),
    writeFileSync: (args) => optionFlag(args[2], "w"),
    appendFileSync: (args) => optionFlag(args[2], "a"),
  };
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [name, call] of Object.entries(actual)) {
    if (!name.endsWith("Sync") || typeof call !== "function") continue;
    const flag = opens[name];
    wrapped[name] = (...args: unknown[]) => {
      const file = args[0];
      if (
        flag &&
        typeof file === "string" &&
        !(flagsOf(flag(args)) & (O_EXCL | O_NONBLOCK)) &&
        actual.statSync(file, { throwIfNoEntry: false })?.isFIFO()
      )
        throw Object.assign(new Error(`${name} of ${file}, a pipe, waits for its other end`), {
          code: "EWOULDWAIT",
        });
      try {
        return (call as (...a: unknown[]) => unknown)(...args);
      } finally {
        if (between.step && !between.busy) {
          between.busy = true;
          try {
            between.step();
          } finally {
            between.busy = false;
          }
        }
      }
    };
  }
  return { ...wrapped, default: wrapped };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-copy-"));
const key = randomBytes(32);
const repoId = "github.com/acme/app";
let store: MemoryStore;

const context = (overrides: Partial<RenderContext> = {}): RenderContext =>
  ({
    session: `session:${newId()}`,
    kind: "live",
    repoId,
    knownRepos: [repoId],
    teamStores: [],
    userMessages: [],
    brokerSecrets: [],
    instructionFiles: "",
    ...overrides,
  }) as RenderContext;
const user = context({ kind: "user" });
const fresh = () => {
  store?.close();
  store = new MemoryStore(path.join(dir, `store-${newId()}.db`), key);
};
const put = (ctx: WriterContext, text: string, extra: Partial<Operation> = {}) => {
  const result = store.commit(ctx, [{ path: "repo/notes.md", text, ...extra }]);
  expect({ rejected: result.rejected, conflicts: result.conflicts }).toEqual({
    rejected: [],
    conflicts: [],
  });
  return result.saved[0]!;
};
const write = (copy: CopySession, file: string, content: string) => {
  const result = runCopyTool(store, copy, { tool: "Write", file, content });
  assert("saved" in result);
  expect(result.rejected).toEqual([]);
  return result;
};
const inCopy = (copy: CopySession, file: string) => path.join(copy.copyDir, ...file.split("/"));
const note = (name: string, ...facts: string[]) =>
  `---\nname: "${name}"\ndescription: "${name}"\nmetadata:\n  type: project\n---\n\n${facts.join("\n\n")}\n`;

beforeEach(fresh);
afterAll(() => {
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the turn-end sweep", () => {
  it("puts back a note file a command made a folder, a pipe or unreadable, and still sweeps the rest of the copy", () => {
    const copy = startSession(store, context(), path.join(dir, `copy-${newId()}`));
    const files = ["repo/folder.md", "repo/pipe.md", "repo/locked.md"];
    for (const file of files) write(copy, file, note(file, `Fact in ${file}`));
    const posix = process.platform !== "win32";
    // A command in the copy (Codex's writable root) leaves things no read should take on note files' paths.
    fs.rmSync(inCopy(copy, "repo/folder.md"));
    fs.mkdirSync(inCopy(copy, "repo/folder.md"));
    fs.writeFileSync(inCopy(copy, "repo/folder.md/inside.md"), "Hidden in a folder\n");
    // Windows has no pipes in its filesystem.
    if (posix) {
      fs.rmSync(inCopy(copy, "repo/pipe.md"));
      execFileSync("mkfifo", [inCopy(copy, "repo/pipe.md")]);
    }
    // Root reads a 0000 file anyway.
    if (posix && process.getuid?.() !== 0) fs.chmodSync(inCopy(copy, "repo/locked.md"), 0o000);
    fs.writeFileSync(inCopy(copy, "repo/shell.md"), "Shell writes are quarantined\n");
    const swept = turnEndSweep(store, copy).map((r) => r.text);
    expect(
      ["Shell writes are quarantined", "Hidden in a folder"].filter((text) => swept.includes(text)),
    ).toEqual(["Shell writes are quarantined", "Hidden in a folder"]);
    expect(
      files.map((file) => ({
        file,
        isFile: fs.lstatSync(inCopy(copy, file)).isFile(),
        base: fs.readFileSync(inCopy(copy, file), "utf8") === copy.base.get(file)!.content,
      })),
    ).toEqual(files.map((file) => ({ file, isFile: true, base: true })));
    expect(fs.existsSync(inCopy(copy, "repo/shell.md"))).toBe(false);
  });

  // Windows names a folder only by its path, so there a swap right after the runtime's check of it still wins.
  it.skipIf(process.platform === "win32")(
    "never writes or deletes outside the copy, whenever a command running in it swaps a folder for a link",
    () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memory-outside-"));
      // A file a write through the link would clobber, and one a removal through it would delete.
      const before = { "existing.md": "outside content\n", "extra.md": "outside extra\n" };
      // A chat whose agent saved repo/existing.md and repo/missing.md (no namesake outside: a write through the link
      // would create it), then ran a command that changed the first, deleted the second and added repo/extra.md.
      const scene = () => {
        // Hundreds of these: a store in memory keeps them quick.
        store.close();
        store = new MemoryStore(":memory:", key);
        fs.rmSync(outside, { recursive: true, force: true });
        fs.mkdirSync(outside);
        for (const [name, content] of Object.entries(before))
          fs.writeFileSync(path.join(outside, name), content);
        const chat = context();
        const copy = startSession(store, chat, path.join(dir, `copy-${newId()}`));
        write(copy, "repo/existing.md", note("Existing", "Agent chosen payload"));
        write(copy, "repo/missing.md", note("Missing", "Agent chosen payload"));
        fs.appendFileSync(inCopy(copy, "repo/existing.md"), "\nChanged by a command\n");
        fs.rmSync(inCopy(copy, "repo/missing.md"));
        fs.writeFileSync(inCopy(copy, "repo/extra.md"), "Added by a command\n");
        return { chat, copy };
      };
      // What the runtime does to the copy while the command runs: the turn-end sweep, and setting the chat up again.
      const operations: Record<string, (s: ReturnType<typeof scene>) => unknown> = {
        sweep: ({ copy }) => turnEndSweep(store, copy),
        setup: ({ chat, copy }) =>
          startSession(store, context({ session: chat.session }), copy.copyDir),
      };
      // The command's loop: the folder out of the way and a link to outside in its place, then back.
      const swap = (copy: CopySession) => {
        const folder = inCopy(copy, "repo");
        const held = inCopy(copy, "held");
        try {
          if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) {
            fs.unlinkSync(folder);
            fs.renameSync(held, folder);
          } else {
            if (fs.existsSync(folder)) fs.renameSync(folder, held);
            fs.symlinkSync(outside, folder, "dir");
          }
        } catch {
          // Something the runtime did got in its way: it goes round again.
        }
      };
      const run = (
        operation: (s: ReturnType<typeof scene>) => unknown,
        at: number,
        loop: boolean,
      ) => {
        const s = scene();
        let calls = 0;
        between.step = () => {
          calls++;
          if (calls === at || (loop && calls > at)) swap(s.copy);
        };
        try {
          operation(s);
        } catch {
          // Refusing a write the command raced is fine; writing outside is not.
        } finally {
          between.step = undefined;
        }
        return calls;
      };
      try {
        const escaped: Array<{
          operation: string;
          at: number;
          loop: boolean;
          outside: Record<string, string>;
        }> = [];
        for (const [name, operation] of Object.entries(operations)) {
          const calls = run(operation, 0, false);
          for (let at = 1; at <= calls; at++)
            for (const loop of [false, true]) {
              run(operation, at, loop);
              const now = Object.fromEntries(
                fs
                  .readdirSync(outside)
                  .sort()
                  .map((entry) => [entry, fs.readFileSync(path.join(outside, entry), "utf8")]),
              );
              if (JSON.stringify(now) !== JSON.stringify(before))
                escaped.push({ operation: name, at, loop, outside: now });
            }
        }
        expect(escaped).toEqual([]);
      } finally {
        between.step = undefined;
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe("the copy's files", () => {
  it("gives a resumed session each briefed note at the path its frozen index links", () => {
    const briefed = put(user, "Run the tests with TZ=UTC set", {
      path: "repo/testing.md",
      meta: { name: "Testing conventions", description: "how the tests run" },
    });
    const chat = context();
    const copyDir = path.join(dir, `copy-${newId()}`);
    expect(startSession(store, chat, copyDir).files["MEMORY.md"]).toContain(
      "[Testing conventions](repo/testing.md)",
    );
    // Another chat on the repo saves a note in the same file.
    put(user, "Snapshot tests need --update after a schema change", {
      path: "repo/testing.md",
      meta: { name: "Snapshots", description: "updating snapshots" },
    });
    // The app restarts and the chat resumes.
    const resumed = startSession(store, context({ session: chat.session }), copyDir);
    const index = fs.readFileSync(path.join(copyDir, "MEMORY.md"), "utf8");
    const link = index.match(/\[Testing conventions\]\(([^)]+)\)/)![1]!;
    expect({
      link,
      facts: parseNote(fs.readFileSync(path.join(copyDir, ...link.split("/")), "utf8")).facts,
    }).toEqual({ link: "repo/testing.md", facts: [briefed.text] });
    expect(
      Object.values(resumed.files).filter((content) =>
        content.includes("Snapshot tests need --update"),
      ).length,
    ).toBe(1);
    // The person forgets the briefed note: its link then opens nothing, never the other note.
    expect(
      store.commit(user, [{ id: briefed.id, store: "me", baseVid: briefed.vid, type: "forget" }])
        .saved.length,
    ).toBe(1);
    startSession(store, context({ session: chat.session }), copyDir);
    expect(fs.existsSync(path.join(copyDir, "repo", "testing.md"))).toBe(false);
  });

  it("leaves a note another writer moved out of the file whose write was refused, so the next write never moves it back", () => {
    const chat = startSession(store, context(), path.join(dir, `copy-${newId()}`));
    const file = "repo/testing.md";
    const [x, y] = write(
      chat,
      file,
      note("Testing", "Run the tests with TZ=UTC set", "Snapshot tests need --update"),
    ).saved;
    // The person moves the second note to their own notes in Settings.
    const moved = store.commit(user, [
      { id: y!.id, store: "me", baseVid: y!.vid, path: "user/snapshots.md", text: y!.text },
    ]).saved[0]!;
    expect(moved.path).toBe("user/snapshots.md");
    // The chat edits that note from its copy as it was: a conflict.
    const stale = runCopyTool(store, chat, {
      tool: "Edit",
      file,
      old_string: "Snapshot tests need --update",
      new_string: "Snapshot tests need -u",
    });
    assert("conflicts" in stale);
    expect(stale.conflicts.length).toBe(1);
    // Then it rewrites the file from its copy with the first note changed.
    const disk = fs.readFileSync(inCopy(chat, file), "utf8");
    write(
      chat,
      file,
      disk.replace("Run the tests with TZ=UTC set", "Run the tests with TZ=UTC and LANG=C set"),
    );
    expect({ x: store.head("me", x!.id)!.text, y: store.head("me", y!.id)!.path }).toEqual({
      x: "Run the tests with TZ=UTC and LANG=C set",
      y: "user/snapshots.md",
    });
  });
});
