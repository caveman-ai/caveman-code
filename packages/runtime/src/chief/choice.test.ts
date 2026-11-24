// What the Chief runs on: its pick while that account is connected, else Auto from what is connected, else a Claude
// plan, and nothing (capture only) otherwise. A paid key, or Codex, runs a Chief only when it picked them.
import { expect, test } from "vitest";

import { type ChiefLogin, chiefModelChoice } from "./Chief.ts";

const plan = ["chatgpt/openai/gpt-6-luna"];
const deepseek = ["deepseek/deepseek-v4"];
const own: ChiefLogin = { engine: "claude-agent", account_id: "claudeAgent:default", plan: true };
const work: ChiefLogin = { engine: "claude-agent", account_id: "claudeAgent-account-1a2b3c4d", plan: true };
const claudeKey: ChiefLogin = { engine: "claude-agent", account_id: "claudeAgent-account-5e6f7a8b", plan: false };
const chatgpt: ChiefLogin = { engine: "codex", account_id: "codex", plan: true };
const openaiKey: ChiefLogin = { engine: "codex", account_id: "codex-account-9c0d", plan: false };
const opus = { engine: "claude-agent", model: "claude-opus-5-5" };
const astra = { engine: "codex", model: "gpt-6-astra" };

test("with nothing picked: Auto from the connected set, else a Claude plan, else nothing; never a paid key or Codex", () => {
  expect(chiefModelChoice({ pick: undefined, connected: plan, logins: [] })).toEqual({ choice: "auto", dropped: false });
  expect(chiefModelChoice({ pick: null, connected: deepseek, logins: [] })).toEqual({ choice: "auto", dropped: false });
  // The engine's fast floor first; a Claude plan when it is all there is.
  expect(chiefModelChoice({ pick: undefined, connected: deepseek, logins: [own] })).toEqual({ choice: "auto", dropped: false });
  expect(chiefModelChoice({ pick: undefined, connected: [], logins: [own] })).toEqual({ choice: "login", dropped: false, login: own });
  expect(chiefModelChoice({ pick: undefined, connected: [], logins: [claudeKey, own] })).toEqual({ choice: "login", dropped: false, login: own });
  // A paid key or a Codex login alone: nothing runs a Chief that picked nothing (it captures, and offers the pick).
  expect(chiefModelChoice({ pick: undefined, connected: [], logins: [claudeKey] })).toEqual({ choice: "none", dropped: false });
  expect(chiefModelChoice({ pick: undefined, connected: [], logins: [openaiKey, chatgpt] })).toEqual({ choice: "none", dropped: false });
  expect(chiefModelChoice({ pick: undefined, connected: [], logins: [] })).toEqual({ choice: "none", dropped: false });
});

test("a pick holds while its account is connected, and gives way once it is gone", () => {
  expect(chiefModelChoice({ pick: { engine: "caveman", model: deepseek[0]! }, connected: deepseek, logins: [] }).choice).toBe("pick");
  expect(chiefModelChoice({ pick: opus, connected: [], logins: [own] }).choice).toBe("pick");
  // The key was removed: Auto on what is left, and the Chief says so.
  expect(chiefModelChoice({ pick: { engine: "caveman", model: deepseek[0]! }, connected: plan, logins: [] })).toEqual({ choice: "auto", dropped: true });
  // The Claude login is gone: Auto on the engine, or nothing.
  expect(chiefModelChoice({ pick: opus, connected: plan, logins: [] })).toEqual({ choice: "auto", dropped: true });
  expect(chiefModelChoice({ pick: opus, connected: [], logins: [] })).toEqual({ choice: "none", dropped: true });
  // A harness outside Claude Agent and Codex never runs the Chief: its pick is never kept.
  expect(chiefModelChoice({ pick: { engine: "cursor", model: "composer-2" }, connected: plan, logins: [own] })).toEqual({ choice: "auto", dropped: true });
});

test("a Codex pick runs on its login, a ChatGPT plan or an API key", () => {
  expect(chiefModelChoice({ pick: { ...astra, account_id: openaiKey.account_id }, connected: plan, logins: [chatgpt, openaiKey] })).toEqual({ choice: "pick", dropped: false, login: openaiKey });
  // One that names no login runs on Codex's active login, listed first.
  expect(chiefModelChoice({ pick: astra, connected: [], logins: [own, openaiKey] })).toEqual({ choice: "pick", dropped: false, login: openaiKey });
  // Its login gone: what nothing picked runs on, never another Codex login it did not pick.
  expect(chiefModelChoice({ pick: { ...astra, account_id: openaiKey.account_id }, connected: [], logins: [chatgpt] })).toEqual({ choice: "none", dropped: true });
  expect(chiefModelChoice({ pick: { ...astra, account_id: openaiKey.account_id }, connected: [], logins: [chatgpt, own] })).toEqual({ choice: "login", dropped: true, login: own });
});

test("a pick on one of several Claude logins runs on that login, a plan or a key, and gives way once that login is gone", () => {
  expect(chiefModelChoice({ pick: { ...opus, account_id: work.account_id }, connected: [], logins: [own, work] }).login).toBe(work);
  expect(chiefModelChoice({ pick: { ...opus, account_id: claudeKey.account_id }, connected: [], logins: [own, claudeKey] }).login).toBe(claudeKey);
  // The other login is still there, but the pick named this one.
  expect(chiefModelChoice({ pick: { ...opus, account_id: work.account_id }, connected: [], logins: [own] })).toEqual({ choice: "login", dropped: true, login: own });
  // A picked key that is gone never moves the Chief onto another key.
  expect(chiefModelChoice({ pick: { ...opus, account_id: claudeKey.account_id }, connected: [], logins: [{ ...claudeKey, account_id: "claudeAgent-account-other" }] })).toEqual({ choice: "none", dropped: true });
  // A pick that names no login runs on a plan, never on the active Claude login when that one is on an API key.
  expect(chiefModelChoice({ pick: opus, connected: [], logins: [claudeKey, work] })).toEqual({ choice: "pick", dropped: false, login: work });
  // Its engine's one login, a key: the picker names no login then.
  expect(chiefModelChoice({ pick: opus, connected: [], logins: [claudeKey] })).toEqual({ choice: "pick", dropped: false, login: claudeKey });
});
