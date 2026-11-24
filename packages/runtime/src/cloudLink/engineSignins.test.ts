import { afterEach, expect, test } from "vitest";

import { FollowedLogins, followedLogins, toolsLoginFiles } from "./engineLogins.ts";
import { enginesSignedIn, followedLogin, loginsFrom, onEnginesChanged, setEnginesSignedIn, setFollowedLogin } from "./engineSignins.ts";

afterEach(() => {
  setEnginesSignedIn(undefined);
  setFollowedLogin(undefined);
  onEnginesChanged(() => {});
});

test("the heartbeat's engines are a sorted set, unknown until first said, and only a change wakes the heartbeat", () => {
  let beats = 0;
  onEnginesChanged(() => beats++);
  expect(enginesSignedIn()).toBeUndefined();
  setEnginesSignedIn(["codex", "claude", "codex"]);
  expect(enginesSignedIn()).toEqual(["claude", "codex"]);
  setEnginesSignedIn(["claude", "codex"]);
  expect(beats).toBe(1);
  setEnginesSignedIn([]);
  expect(enginesSignedIn()).toEqual([]);
  expect(beats).toBe(2);
});

test("a sign-in that follows the person counts once the code that keeps it says so", async () => {
  // engineLogins.ts holds none off a Cloud computer.
  expect(await followedLogin("claude-agent")).toBe(false);
  setFollowedLogin(async (engine) => engine === "codex");
  expect(await followedLogin("codex")).toBe(true);
  expect(await followedLogin("claude-agent")).toBe(false);
});

test("an engine counts when its CLI says it is signed in here, when the runtime holds its vault key, or when a sign-in follows the person", async () => {
  const none = () => false;
  expect(await loginsFrom([], none)).toEqual([]);
  // The CLI's own word: installed and authenticated. Not installed, or signed out, is not a login.
  expect(await loginsFrom([{ engine: "claude-agent", installed: true, authenticated: true }, { engine: "codex", installed: true, authenticated: false }], none)).toEqual(["claude"]);
  expect(await loginsFrom([{ engine: "claude-agent", installed: false, authenticated: true }], none)).toEqual([]);
  // Another engine's login (Cursor, OpenCode) is not one of these.
  expect(await loginsFrom([{ engine: "opencode", installed: true, authenticated: true }], none)).toEqual([]);
  // The person's vault key for Codex, held for a chat here.
  expect(await loginsFrom([], (engine) => engine === "codex")).toEqual(["codex"]);
  // A sign-in made on another of their computers; a check that fails counts as none.
  setFollowedLogin(async (engine) => engine === "claude-agent");
  expect(await loginsFrom([], none)).toEqual(["claude"]);
  setFollowedLogin(async () => {
    throw new Error("Cloud unreachable");
  });
  expect(await loginsFrom([], none)).toEqual([]);
});

test("a sign-in Cloud says follows the person counts on this computer through engineLogins.ts, without a stand-in", async () => {
  const none = () => false;
  // The runtime's own followed sign-ins, joined to a Cloud that lists a ready Codex sign-in for this person.
  const logins = new FollowedLogins();
  setFollowedLogin((engine) => logins.hasLogin(engine));
  expect(await loginsFrom([], none)).toEqual([]);
  const cloud = {
    list: async () => [{ engine: "codex", status: "ready" }, { engine: "claude", status: "revoked" }],
    lanes: async () => ({ followed: [] }),
    get: async () => undefined,
    refresh: async () => Promise.reject(new Error("unused")),
    put: async () => ({ version: 1 }),
    remove: async () => undefined,
  };
  logins.connect({ cloud, files: toolsLoginFiles(undefined), paths: { claude: async () => "/nowhere/claude", codex: async () => "/nowhere/codex" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await loginsFrom([], none)).toEqual(["codex"]);
  // By default the heartbeat asks the runtime's own instance, which holds none off a Cloud computer.
  setFollowedLogin(undefined);
  expect(followedLogins.connected).toBe(false);
  expect(await loginsFrom([], none)).toEqual([]);
});
