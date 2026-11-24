import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createScrubber } from "@caveman-app/session-protocol";
import { afterEach, expect, test, vi } from "vitest";

import {
  claudeProjectKey,
  codexLineForCopy,
  findCodexRollout,
  localNativeIo,
  mergeNative,
  nativeAsKnown,
  nativeOfChat,
  readNativeCopy,
  rolloutDayOk,
  writeNativeCopy,
  type NativeCopy,
  type NativeKnown,
} from "./nativeSessions.ts";

const SECRET = "sk-live-0123456789abcdefSECRET";
const scrubber = createScrubber([{ name: "STRIPE_KEY", value: SECRET }]);
const ID = "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const temp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const lines = (file: string) => fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
const jsonl = (entries: ReadonlyArray<unknown>) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

afterEach(() => vi.restoreAllMocks());

/** A Claude config dir as a signed-in person has one: credentials, settings, other projects, and this chat's session. */
function claudeHome(cwd: string) {
  const home = temp("native-claude-");
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "oauth-never-read" } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "never@read" } }));
  fs.writeFileSync(path.join(home, "settings.json"), "{}");
  const project = path.join(home, "projects", claudeProjectKey(cwd)!);
  fs.mkdirSync(path.join(project, ID, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, "11111111-2222-4333-8444-555555555555.jsonl"), jsonl([{ type: "user", uuid: "other" }]));
  fs.mkdirSync(path.join(home, "projects", "-somewhere-else"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects", "-somewhere-else", `${ID}.jsonl`), jsonl([{ type: "user", uuid: "elsewhere" }]));
  return { home, project, main: path.join(project, `${ID}.jsonl`), subagent: path.join(project, ID, "subagents", "agent-a1.jsonl") };
}

const claudeTurn = (cwd: string) => [
  { type: "user", uuid: "u1", parentUuid: null, cwd, sessionId: ID, message: { role: "user", content: `deploy with ${SECRET}` } },
  { type: "assistant", uuid: "t1", parentUuid: "u1", cwd, sessionId: ID, message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: `the key is ${SECRET}`, signature: "sig-1" }] } },
  { type: "assistant", uuid: "a1", parentUuid: "t1", cwd, sessionId: ID, message: { id: "m1", role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "Deployed." }] } },
];

test("a Claude Agent chat's copy: its own session file and subagents only, thinking dropped, children re-pointed, secrets scrubbed", async () => {
  const cwd = temp("native-cwd-");
  const { home, main, subagent } = claudeHome(cwd);
  fs.writeFileSync(main, jsonl(claudeTurn(cwd)));
  fs.writeFileSync(subagent, jsonl([{ type: "assistant", uuid: "s1", parentUuid: null, isSidechain: true, message: { content: [{ type: "text", text: "sub done" }] } }]));
  // Never a credentials file, settings, another project or another session: every read and listing is the session's own.
  // Every file the copy opens (it opens without following symlinks, then reads the handle).
  const reads = vi.spyOn(fs.promises, "open");
  const lists = vi.spyOn(fs.promises, "readdir");
  const out = await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber });
  expect(reads.mock.calls.map((c) => String(c[0])).toSorted()).toEqual([main, subagent].toSorted());
  expect(lists.mock.calls.map((c) => String(c[0]))).toEqual([path.join(path.dirname(main), ID, "subagents")]);
  const text = JSON.stringify(out);
  expect(text).not.toContain("oauth-never-read");
  expect(text).not.toContain("never@read");
  expect(text).not.toContain("elsewhere");
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('"thinking"');
  expect(text).not.toContain("redacted_thinking");
  expect(text).not.toContain("sig-1");
  const copy = out!.copy;
  expect(copy).toMatchObject({ kind: "claude", id: ID, head: "a1", cwd });
  const mainFile = copy.files.find((f) => f.path === `${ID}.jsonl`)!;
  const entries = mainFile.lines.map((l) => JSON.parse(l) as Record<string, any>);
  // The thinking-only entry is gone; the reply points to the person's message instead.
  expect(entries.map((e) => e.uuid)).toEqual(["u1", "a1"]);
  expect(entries[1]).toMatchObject({ parentUuid: "u1", message: { content: [{ type: "text", text: "Deployed." }] } });
  expect(entries[0]!.message.content).toBe("deploy with [secret:STRIPE_KEY]");
  expect(copy.files.find((f) => f.path === `${ID}/subagents/agent-a1.jsonl`)?.lines).toHaveLength(1);
});

test("copies carry only what was added since the last, and merge back into the whole file; a rewritten file goes whole", async () => {
  const cwd = temp("native-cwd-");
  const { home, main } = claudeHome(cwd);
  const first = claudeTurn(cwd);
  // A line still being written (no newline yet) waits.
  fs.writeFileSync(main, jsonl(first) + JSON.stringify({ type: "user", uuid: "u2" }).slice(0, 10));
  const one = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber }))!;
  expect(one.copy.files[0]).toMatchObject({ from: 0 });
  expect(one.copy.files[0]!.lines).toHaveLength(2);
  const second = [
    { type: "user", uuid: "u2", parentUuid: "a1", cwd, message: { role: "user", content: "and again" } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", cwd, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Again." }] } },
  ];
  fs.writeFileSync(main, jsonl([...first, ...second]));
  const two = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, known: one.known, scrubber }))!;
  // Only the new lines, after the two kept (three read, one left out).
  expect(two.copy.files).toEqual([{ path: `${ID}.jsonl`, from: 2, lines: second.map((e) => JSON.stringify(e)) }]);
  expect(two.copy.head).toBe("a2");
  // Nothing new: nothing to carry.
  const three = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, known: two.known, scrubber }))!;
  expect(three.changed).toBe(false);
  const merged = mergeNative([one.copy, two.copy, three.copy])!;
  expect(merged.files[0]!.lines.map((l) => JSON.parse(l).uuid)).toEqual(["u1", "a1", "u2", "a2"]);
  // A copy that skips one cannot be made whole: none of it travels (the chat hands over its context, K8), never a throw.
  expect(mergeNative([two.copy])).toBeUndefined();
  // A part sent whole again afterwards (another computer's first copy) makes it whole again.
  expect(mergeNative([two.copy, one.copy, two.copy])!.files[0]!.lines.map((l) => JSON.parse(l).uuid)).toEqual(["u1", "a1", "u2", "a2"]);
  // The file's start changed (rewritten): it goes whole again.
  fs.writeFileSync(main, jsonl(second));
  const four = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, known: two.known, scrubber }))!;
  expect(four.copy.files[0]).toMatchObject({ from: 0 });
  expect(mergeNative([one.copy, two.copy, four.copy])!.files[0]!.lines.map((l) => JSON.parse(l).uuid)).toEqual(["u2", "a2"]);
});

test("written where it lands: under the target's own project key, its cwd re-pointed; never outside the session's place", async () => {
  const from = temp("native-from-");
  const { home, main, subagent } = claudeHome(from);
  fs.writeFileSync(main, jsonl(claudeTurn(from)));
  fs.writeFileSync(subagent, jsonl([{ type: "assistant", uuid: "s1", cwd: from }]));
  const copy = mergeNative([(await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd: from, scrubber }))!.copy])!;
  const target = temp("native-target-home-");
  const cwd = temp("native-workspace-");
  const written = await writeNativeCopy(localNativeIo, copy, { home: target, cwd });
  expect(written).toBe(path.join(target, "projects", claudeProjectKey(cwd)!, `${ID}.jsonl`));
  expect(lines(written).map((e) => [e.uuid, e.cwd])).toEqual([
    ["u1", cwd],
    ["a1", cwd],
  ]);
  // Windows has no mode bits: the engine home's place in the person's profile (its ACL) keeps it private.
  if (process.platform !== "win32") expect((fs.statSync(written).mode & 0o777).toString(8)).toBe("600");
  expect(lines(path.join(target, "projects", claudeProjectKey(cwd)!, ID, "subagents", "agent-a1.jsonl"))[0]!.cwd).toBe(cwd);
  // A copy can only name the files the engine writes.
  const evil = (name: string): NativeCopy => ({ ...copy, files: [{ path: name, from: 0, lines: ["{}"] }] });
  await expect(writeNativeCopy(localNativeIo, evil(`../../.credentials.json`), { home: target, cwd })).rejects.toThrow("never writes");
  await expect(writeNativeCopy(localNativeIo, evil(`${ID}/subagents/../../x.jsonl`), { home: target, cwd })).rejects.toThrow("never writes");
  await expect(writeNativeCopy(localNativeIo, { ...copy, id: "../x" }, { home: target, cwd })).rejects.toThrow("not one it mints");
  expect(fs.existsSync(path.join(target, ".credentials.json"))).toBe(false);
});

test("a Codex chat's copy: its rollout found by thread id, encrypted reasoning kept exactly, the rest scrubbed, auth.json never read", async () => {
  const home = temp("native-codex-");
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-never-read" }));
  fs.writeFileSync(path.join(home, "config.toml"), "model = 'x'\n");
  const day = path.join(home, "sessions", "2026", "10", "21");
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions", "2026", "10", "20"), { recursive: true });
  fs.writeFileSync(path.join(home, "sessions", "2026", "10", "20", "rollout-2026-10-20T09-00-00-99999999-0000-4000-8000-000000000000.jsonl"), "{}\n");
  const cwd = temp("native-codex-cwd-");
  const name = `rollout-2026-10-21T10-11-12-${THREAD}.jsonl`;
  // Encrypted reasoning that happens to hold the secret's text: Codex alone reads it, so it travels as it is.
  const sealed = `gAAAA${SECRET}xyz==`;
  const rollout = [
    { timestamp: "t", type: "session_meta", payload: { id: THREAD, cwd, originator: "codex" } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `use ${SECRET}` }] } },
    { timestamp: "t", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: `thought about ${SECRET}` }], encrypted_content: sealed } },
    { timestamp: "t", type: "turn_context", payload: { cwd, model: "gpt-5" } },
  ];
  fs.writeFileSync(path.join(day, name), jsonl(rollout));
  // Every file the copy opens (it opens without following symlinks, then reads the handle).
  const reads = vi.spyOn(fs.promises, "open");
  expect(await findCodexRollout(localNativeIo, home, THREAD)).toBe(`2026/10/21/${name}`);
  const out = (await readNativeCopy(localNativeIo, { kind: "codex", id: THREAD, home, cwd, scrubber }))!;
  expect(reads.mock.calls.map((c) => String(c[0]))).toEqual([path.join(day, name)]);
  const entries = out.copy.files[0]!.lines.map((l) => JSON.parse(l) as Record<string, any>);
  expect(out.copy.files[0]!.path).toBe(`2026/10/21/${name}`);
  expect(entries[2]!.payload.encrypted_content).toBe(sealed);
  expect(entries[2]!.payload.summary[0].text).toBe("thought about [secret:STRIPE_KEY]");
  expect(entries[1]!.payload.content[0].text).toBe("use [secret:STRIPE_KEY]");
  expect(JSON.stringify(out)).not.toContain("sk-never-read");
  // Placed under the target's CODEX_HOME on the same day, its working directory re-pointed.
  const target = temp("native-codex-target-");
  const workspace = temp("native-codex-ws-");
  const written = await writeNativeCopy(localNativeIo, mergeNative([out.copy])!, { home: target, cwd: workspace });
  expect(written).toBe(path.join(target, "sessions", "2026", "10", "21", name));
  const landed = lines(written);
  expect(landed[0]!.payload.cwd).toBe(workspace);
  expect(landed[3]!.payload.cwd).toBe(workspace);
  expect(landed[2]!.payload.encrypted_content).toBe(sealed);
});

test("no session file, an id the engine never mints, or a session too large: nothing to carry (the chat hands over its context)", async () => {
  const cwd = temp("native-cwd-");
  const { home } = claudeHome(cwd);
  expect(await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber })).toBeUndefined();
  expect(await readNativeCopy(localNativeIo, { kind: "claude", id: "../../.credentials", home, cwd, scrubber })).toBeUndefined();
  expect(await readNativeCopy(localNativeIo, { kind: "codex", id: THREAD, home: temp("native-codex-empty-"), cwd, scrubber })).toBeUndefined();
  expect(claudeProjectKey(`/${"a".repeat(250)}`)).toBeUndefined();
  const known: NativeKnown = { files: {} };
  expect(known.files).toEqual({});
});

test("a session is as the copies left it only while every file holds exactly the lines they read (K15), Claude and Codex", async () => {
  const cwd = temp("native-cwd-");
  const { home, main, subagent } = claudeHome(cwd);
  fs.writeFileSync(main, jsonl(claudeTurn(cwd)));
  const { known } = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber }))!;
  const asKnown = () => nativeAsKnown(localNativeIo, { kind: "claude", id: ID, home, cwd, known });
  expect(await asKnown()).toBe(true);
  // A line on its way (the CLI writing), a line added, a line changed, a subagent file that appeared: not as it left.
  fs.appendFileSync(main, '{"type":"user"');
  expect(await asKnown()).toBe(false);
  fs.writeFileSync(main, jsonl([...claudeTurn(cwd), { type: "user", uuid: "u2", message: { role: "user", content: "typed in a terminal" } }]));
  expect(await asKnown()).toBe(false);
  fs.writeFileSync(main, jsonl(claudeTurn(cwd)).replace("Deployed.", "Deployed!"));
  expect(await asKnown()).toBe(false);
  fs.writeFileSync(main, jsonl(claudeTurn(cwd)));
  expect(await asKnown()).toBe(true);
  fs.writeFileSync(subagent, jsonl([{ type: "assistant", uuid: "s1" }]));
  expect(await asKnown()).toBe(false);
  fs.rmSync(subagent);
  // Gone, or another id: not as it left.
  expect(await nativeAsKnown(localNativeIo, { kind: "claude", id: "11111111-2222-4333-8444-555555555555", home, cwd, known })).toBe(false);
  fs.rmSync(main);
  expect(await asKnown()).toBe(false);
  // Codex: its rollout, found by thread id.
  const codexHome = temp("native-codex-");
  const day = path.join(codexHome, "sessions", "2026", "10", "21");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-10-21T10-11-12-${THREAD}.jsonl`);
  fs.writeFileSync(rollout, jsonl([{ timestamp: "t", type: "session_meta", payload: { id: THREAD, cwd } }]));
  const codex = (await readNativeCopy(localNativeIo, { kind: "codex", id: THREAD, home: codexHome, cwd, scrubber }))!;
  expect(await nativeAsKnown(localNativeIo, { kind: "codex", id: THREAD, home: codexHome, cwd, known: codex.known })).toBe(true);
  fs.appendFileSync(rollout, jsonl([{ timestamp: "t", type: "response_item", payload: { type: "message", role: "user" } }]));
  expect(await nativeAsKnown(localNativeIo, { kind: "codex", id: THREAD, home: codexHome, cwd, known: codex.known })).toBe(false);
});

test("a copy made mid-turn resumes at its last entry that leaves nothing open, never a tool call without its result", async () => {
  const cwd = temp("native-cwd-");
  const { home, main } = claudeHome(cwd);
  const midTurn = [
    ...claudeTurn(cwd),
    { type: "user", uuid: "u2", parentUuid: "a1", cwd, message: { role: "user", content: "run the tests" } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", cwd, message: { id: "m2", content: [{ type: "text", text: "Running them." }] } },
    { type: "assistant", uuid: "a3", parentUuid: "a2", cwd, message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } }] } },
  ];
  fs.writeFileSync(main, jsonl(midTurn));
  expect((await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber }))!.copy.head).toBe("a2");
  fs.writeFileSync(main, jsonl([...midTurn, { type: "user", uuid: "r1", parentUuid: "a3", cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } }]));
  expect((await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber }))!.copy.head).toBe("r1");
});

test("symlinks are never followed: a session path that is a link reads as nothing, and a write never goes through one", async () => {
  const cwd = temp("native-cwd-");
  const { home, main } = claudeHome(cwd);
  // A link where the session file should be, to a file outside the config dir.
  const outside = path.join(temp("native-outside-"), "private.txt");
  fs.writeFileSync(outside, `${JSON.stringify({ type: "user", uuid: "u1", message: { content: "OUTSIDE-SECRET" } })}\n`);
  fs.symlinkSync(outside, main);
  expect(await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber })).toBeUndefined();
  // A write onto a link is refused, and the file it points at is untouched.
  const copy: NativeCopy = { kind: "claude", id: ID, head: null, cwd, files: [{ path: `${ID}.jsonl`, from: 0, lines: ['{"type":"user"}'] }] };
  await expect(writeNativeCopy(localNativeIo, copy, { home, cwd, mayReplace: () => true })).rejects.toThrow(/not a regular file/);
  expect(fs.readFileSync(outside, "utf8")).toContain("OUTSIDE-SECRET");
  // A plain write lands whole through a temporary file: nothing else is left beside it.
  fs.rmSync(main);
  const written = await writeNativeCopy(localNativeIo, copy, { home, cwd });
  expect(fs.lstatSync(written).isFile()).toBe(true);
  expect(fs.readdirSync(path.dirname(written)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a line that is not JSON never travels", async () => {
  const cwd = temp("native-cwd-");
  const { home, main } = claudeHome(cwd);
  fs.writeFileSync(main, `${JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } })}\nNOT-JSON ${SECRET} raw text\n`);
  const out = (await readNativeCopy(localNativeIo, { kind: "claude", id: ID, home, cwd, scrubber }))!;
  expect(out.copy.files[0]!.lines).toHaveLength(1);
  expect(JSON.stringify(out)).not.toContain("NOT-JSON");
  expect(codexLineForCopy("plain text line", scrubber)).toBeUndefined();
});

test("only a reasoning or compaction item's own base64 encrypted_content passes unscrubbed; the key anywhere else is scrubbed", () => {
  const sealed = "gAAAAABmZm9vYmFyYmF6cXV4cXV1eA==";
  const reasoning = JSON.parse(codexLineForCopy(JSON.stringify({ type: "response_item", payload: { type: "reasoning", encrypted_content: sealed } }), scrubber)!);
  expect(reasoning.payload.encrypted_content).toBe(sealed);
  // Smuggled: the same key nested elsewhere, or on another item, or holding non-base64 text.
  const nested = codexLineForCopy(JSON.stringify({ type: "event_msg", payload: { type: "x", note: { encrypted_content: `token ${SECRET}` } } }), scrubber)!;
  expect(nested).not.toContain(SECRET);
  const otherItem = codexLineForCopy(JSON.stringify({ type: "response_item", payload: { type: "message", encrypted_content: SECRET } }), scrubber)!;
  expect(otherItem).not.toContain(SECRET);
  const notBase64 = codexLineForCopy(JSON.stringify({ type: "response_item", payload: { type: "reasoning", encrypted_content: `key: ${SECRET}` } }), scrubber)!;
  expect(notBase64).not.toContain(SECRET);
});

test("a session file is tied to its chat: another thread's id is refused, another conversation's file is never overwritten, no future day folder", async () => {
  const copy: NativeCopy = { kind: "claude", id: ID, head: null, cwd: "/w", files: [] };
  expect(nativeOfChat({ native_thread_id: ID, native: copy })).toBe(copy);
  expect(nativeOfChat({ native_thread_id: THREAD, native: copy })).toBeUndefined();
  expect(nativeOfChat({ native_thread_id: ID })).toBeUndefined();
  // A file already there that this chat did not place stays as it is.
  const home = temp("native-target-home-");
  const cwd = temp("native-workspace-");
  const theirs = path.join(home, "projects", claudeProjectKey(cwd)!, `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, '{"type":"user","message":{"content":"their own history"}}\n');
  const placing: NativeCopy = { ...copy, cwd, files: [{ path: `${ID}.jsonl`, from: 0, lines: ['{"type":"user","message":{"content":"planted"}}'] }] };
  await expect(writeNativeCopy(localNativeIo, placing, { home, cwd })).rejects.toThrow(/did not place/);
  expect(fs.readFileSync(theirs, "utf8")).toContain("their own history");
  await writeNativeCopy(localNativeIo, placing, { home, cwd, mayReplace: (file) => file === theirs });
  expect(fs.readFileSync(theirs, "utf8")).toContain("planted");
  // Codex: a day folder in the future would sort first and shadow the real rollout.
  const codex: NativeCopy = { kind: "codex", id: THREAD, head: null, cwd, files: [{ path: `9999/12/31/rollout-x-${THREAD}.jsonl`, from: 0, lines: ["{}"] }] };
  await expect(writeNativeCopy(localNativeIo, codex, { home, cwd })).rejects.toThrow(/never writes/);
  expect(rolloutDayOk("2026/10/21", Date.parse("2026-10-21T12:00:00Z"))).toBe(true);
  expect(rolloutDayOk("2026/10/23", Date.parse("2026-10-21T12:00:00Z"))).toBe(false);
  expect(rolloutDayOk("2026/02/31", Date.parse("2026-10-21T12:00:00Z"))).toBe(false);
});
