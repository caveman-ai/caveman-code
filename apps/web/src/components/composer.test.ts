import { pickAccess } from "@caveman-app/ui/components/access-picker";
import { effortLabel, pickEffort } from "@caveman-app/ui/components/effort";
import { favoriteAt, favoriteShortcut, homeModels, matchesQuery, modelKey, moveKey, parseModelKey, pickerGroups, resolveFavorites, type PickerEngine } from "@caveman-app/ui/components/model-picker";
import { expect, test, vi } from "vitest";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { atTrigger, stackWords, chatPickerEngines, chatPickerSection, chiefPlaceholder, chiefSendMode, focusWhenOpened, mergeTurnPick, modelStart, settledPick, turnModelPick, plusTyped, stepEffort, takeFocusRequest, turnOptions, withModelSources, withModelStart } from "./Composer.tsx";
import { instanceOf } from "../state/runner.ts";

// The drag engine's store reads `window` on load; these helpers never drag.
vi.mock("../panes/drag.ts", () => ({}));
import { addVerb, filterAddMenu, type AddSection } from "./ComposerAddMenu.tsx";
import { Attachment01Icon, FireIcon, PuzzleIcon } from "@caveman-app/ui/icons/huge";

const engines: PickerEngine[] = [
  { id: "claude-agent", label: "Claude Agent", models: [{ id: "opus", label: "Opus 5.5", efforts: ["low", "high"] }, { id: "sonnet", label: "Sonnet 5", efforts: [] }] },
  { id: "acp:router", label: "Router", models: [{ id: "openrouter/qwen", label: "Qwen", efforts: [] }] },
];

test("a chat New chat just started takes focus once, when its box first mounts", () => {
  focusWhenOpened("chat:w1");
  expect(takeFocusRequest("chat:w2")).toBe(false);
  expect(takeFocusRequest(undefined)).toBe(false);
  expect(takeFocusRequest("chat:w1")).toBe(true);
  expect(takeFocusRequest("chat:w1")).toBe(false);
});

test("the @ that + typed is taken back when its menu closes untouched, never one typed by hand or a query", () => {
  const at = (start: number, query = "") => ({ kind: "at", start, query });
  // An empty box: + typed "@" at 0.
  expect(plusTyped("@", { at: 0, lead: "@" }, at(0))).toEqual([0, 1]);
  // After a word: + typed " @".
  expect(plusTyped("fix it @", { at: 6, lead: " @" }, at(7))).toEqual([6, 8]);
  // A query after it, a menu that moved, a hand-typed "@" (no + record), the slash menu: left alone.
  expect(plusTyped("@re", { at: 0, lead: "@" }, at(0, "re"))).toBeNull();
  expect(plusTyped("x @", { at: 0, lead: "@" }, at(2))).toBeNull();
  expect(plusTyped("@", null, at(0))).toBeNull();
  expect(plusTyped("/", { at: 0, lead: "@" }, { kind: "slash", start: 0, query: "" })).toBeNull();
});

test("the @ trigger opens at the start or after whitespace, never inside a word", () => {
  expect(atTrigger("@", 1)).toEqual({ start: 0, query: "" });
  expect(atTrigger("fix it @pla", 11)).toEqual({ start: 7, query: "pla" });
  expect(atTrigger("line one\n@sup", 13)).toEqual({ start: 9, query: "sup" });
  expect(atTrigger("mail me@acme.com", 16)).toBeNull();
  expect(atTrigger("@plan mode", 10)).toBeNull(); // a space ends the mention
  expect(atTrigger("@plan then more", 3)).toEqual({ start: 0, query: "pl" }); // caret mid-word
  // An "@" inside a pill (its own, or one in its title) opens nothing.
  const pill = { id: 1, workspace_id: "ws_a", title: "Fix @src/auth.ts", start: 4, end: 21 };
  expect(atTrigger("see @Fix @src/auth.ts", 21, [pill])).toBeNull();
  expect(atTrigger("see @Fix @src/auth.ts @re", 25, [pill])).toEqual({ start: 22, query: "re" });
});

test("turn options carry only what is set", () => {
  expect(turnOptions("opus", "high", "auto")).toEqual({ model: "opus", effort: "high", access: "auto" });
  expect(turnOptions("opus", undefined, undefined)).toEqual({ model: "opus" });
  expect(turnOptions(undefined, undefined, "full")).toEqual({ access: "full" });
  expect(turnOptions(undefined, "high", undefined, undefined, "fast")).toEqual({ effort: "high", speed: "fast" });
});

test("the add menu filters on every token and keeps sections in order", () => {
  const sections: AddSection[] = [
    { title: "Add", items: [{ id: "files", icon: Attachment01Icon, label: "Files", description: "Attach files" }, { id: "grill", icon: FireIcon, label: "Grill mode" }] },
    { title: "Plugins and Spaces", items: [{ id: "p", icon: PuzzleIcon, label: "supabase", description: "Manage and query databases" }] },
  ];
  expect(filterAddMenu(sections, "").map((r) => r.item.id)).toEqual(["files", "grill", "p"]);
  expect(filterAddMenu(sections, "QUERY data").map((r) => [r.section, r.item.id])).toEqual([["Plugins and Spaces", "p"]]);
  expect(filterAddMenu(sections, "nothing")).toEqual([]);
  // Descriptions match from a word's start only: "at" finds "Attach", not "databases".
  expect(filterAddMenu(sections, "at").map((r) => r.item.id)).toEqual(["files"]);
});

test("favorite keys split at the first slash; model ids may hold slashes", () => {
  expect(parseModelKey("acp:router/openrouter/qwen")).toEqual({ engine: "acp:router", model: "openrouter/qwen" });
  expect(modelKey({ engine: "acp:router", model: "openrouter/qwen" })).toBe("acp:router/openrouter/qwen");
  expect(parseModelKey("opus")).toBeNull();
  expect(parseModelKey("codex/")).toBeNull();
});

test("favorites resolve in order, skip models this picker does not offer, and answer ⌘1..⌘9", () => {
  const favs = ["codex/gpt-6", "claude-agent/sonnet", "acp:router/openrouter/qwen", "claude-agent/opus"];
  expect(resolveFavorites(engines, favs).map((f) => f.model.id)).toEqual(["sonnet", "openrouter/qwen", "opus"]);
  expect(favoriteAt(engines, favs, 1)).toEqual({ engine: "claude-agent", model: "sonnet" });
  expect(favoriteAt(engines, favs, 3)).toEqual({ engine: "claude-agent", model: "opus" });
  expect(favoriteAt(engines, favs, 4)).toBeNull();
  expect(favoriteAt(engines, favs, 0)).toBeNull();
  // A workspace's picker offers one engine: numbering follows what it shows.
  expect(favoriteAt([engines[0]!], favs, 2)).toEqual({ engine: "claude-agent", model: "opus" });
});

test("⌘ or Ctrl with 1..9 is a favorite shortcut; Shift or Alt is not", () => {
  const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  expect(favoriteShortcut(k("3", { metaKey: true }))).toBe(3);
  expect(favoriteShortcut(k("9", { ctrlKey: true }))).toBe(9);
  expect(favoriteShortcut(k("0", { metaKey: true }))).toBeNull();
  expect(favoriteShortcut(k("3"))).toBeNull();
  expect(favoriteShortcut(k("3", { metaKey: true, shiftKey: true }))).toBeNull();
  expect(favoriteShortcut(k("3", { metaKey: true, altKey: true }))).toBeNull();
});

test("search matches every token against model, id and engine", () => {
  const opus = { engine: engines[0]!, model: engines[0]!.models[0]! };
  expect(matchesQuery(opus, "opus")).toBe(true);
  expect(matchesQuery(opus, "claude 5.5")).toBe(true);
  expect(matchesQuery(opus, "codex opus")).toBe(false);
});

test("effort keeps the wanted level when offered, else the model default, else the middle stop", () => {
  const levels = ["minimal", "low", "medium", "high", "xhigh"];
  expect(pickEffort(levels, "high", "medium")).toBe("high");
  expect(pickEffort(levels, "max", "low")).toBe("low");
  expect(pickEffort(levels, "max", "max")).toBe("medium");
  expect(pickEffort(["low", "high"])).toBe("low");
  expect(pickEffort([])).toBeUndefined();
  expect(effortLabel("xhigh")).toBe("Extra high");
  expect(effortLabel("turbo")).toBe("Turbo");
});

test("permissions keep an offered choice; one not offered runs Supervised; none means full access", () => {
  expect(pickAccess(undefined, "review")).toBe("review");
  expect(pickAccess(["ask", "full"], "auto")).toBe("ask");
  expect(pickAccess(["ask", "auto", "review", "full"], undefined)).toBe("full");
  expect(pickAccess(["ask", "auto"], undefined)).toBe("ask");
  expect(pickAccess(["full"], "ask")).toBe("full");
  expect(pickAccess([], "ask")).toBe("ask"); // empty means all four
});

test("the Chief's three send keys: Enter decides, ⌥Enter queues, ⌘Enter starts", () => {
  const key = (over: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}, k = "Enter") => ({ key: k, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...over });
  expect(chiefSendMode(key(), "enter")).toBe("decide");
  expect(chiefSendMode(key({ altKey: true }), "enter")).toBe("queue");
  expect(chiefSendMode(key({ metaKey: true }), "enter")).toBe("start");
  expect(chiefSendMode(key({ ctrlKey: true }), undefined)).toBe("start");
  expect(chiefSendMode(key({ shiftKey: true }), "enter")).toBeNull(); // a new line
  expect(chiefSendMode(key({}, "a"), "enter")).toBeNull();
  // ⌘Enter to send: every send takes ⌘, a plain Enter is a new line.
  expect(chiefSendMode(key(), "mod_enter")).toBeNull();
  expect(chiefSendMode(key({ metaKey: true }), "mod_enter")).toBe("decide");
  expect(chiefSendMode(key({ metaKey: true, altKey: true }), "mod_enter")).toBe("queue");
  expect(chiefSendMode(key({ metaKey: true, shiftKey: true }), "mod_enter")).toBe("start");
  expect(chiefSendMode(key({ shiftKey: true }), "mod_enter")).toBeNull();
  // The box says one plain line; the keys stay off it.
  expect(chiefPlaceholder(false)).toBe("Message the Chief");
  expect(chiefPlaceholder(false, "Ugg")).toBe("Message Ugg");
  expect(chiefPlaceholder(false, "Ugg", true)).toBe("Guide Ugg while it works");
  expect(chiefPlaceholder(true, "Ugg")).toBe("Note it for later; Ugg sorts it once it has a key");
});

test("effort steps one level from the keyboard and wraps at either end", () => {
  const levels = ["low", "medium", "high"];
  expect(stepEffort(levels, "medium", 1)).toBe("high");
  expect(stepEffort(levels, "high", 1)).toBe("low");
  expect(stepEffort(levels, "low", -1)).toBe("high");
  expect(stepEffort(levels, "medium", -1)).toBe("low");
});

test("each Caveman model names the key it runs on; a harness's models stay as they are", () => {
  const caveman = {
    id: "caveman",
    models: [{ id: "openai/gpt-6-luna" }, { id: "openai~2/gpt-6-luna" }, { id: "anthropic/claude-sonnet-5-5" }, { id: "auto" }],
    auth: { accounts: [{ id: "caveman:openai", label: "OpenAI personal" }, { id: "caveman:openai~2", label: "OpenAI work" }] },
  };
  const claude = { id: "claude-agent", models: [{ id: "claude-opus-5-5" }], auth: { accounts: [{ id: "a1", label: "Work" }] } };
  const [own, harness] = withModelSources([caveman, claude]);
  // A key with no account of its own is named for its provider; Auto runs on none.
  expect(own!.models.map((m) => (m as { source?: { label: string } }).source?.label)).toEqual(["OpenAI personal", "OpenAI work", "Anthropic", undefined]);
  expect(harness).toBe(claude);
});

test("Caveman stays first; its models sit under their keys, and a search names the harness too", () => {
  const caveman = {
    id: "caveman", label: "Caveman",
    models: ["openai/gpt-6-luna", "openai~2/gpt-6-luna", "anthropic/claude-sonnet-5-5"].map((id) => ({ id, label: id.split("/")[1]!, efforts: [] })),
    auth: { state: "api_key", accounts: [
      { id: "caveman:openai", provider: "openai", label: "OpenAI personal", tag: "PER" },
      { id: "caveman:openai~2", provider: "openai", label: "OpenAI work", tag: "WRK" },
      { id: "caveman:anthropic", provider: "anthropic", label: "Anthropic" },
    ] },
  } as unknown as EngineDescriptor;
  const codex = { id: "codex", label: "Codex", models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", efforts: [] }], auth: { accounts: [] } } as unknown as EngineDescriptor;
  const [own] = chatPickerEngines([codex, caveman]);
  expect(own!.id).toBe("caveman");
  const all = () => true;
  expect(pickerGroups([own!], all).map((g) => [g.title, g.entries.map((e) => e.model.id)])).toEqual([
    ["OpenAI personal", ["openai/gpt-6-luna"]],
    ["OpenAI work", ["openai~2/gpt-6-luna"]],
    ["Anthropic", ["anthropic/claude-sonnet-5-5"]],
  ]);
  const luna = (e: Parameters<typeof matchesQuery>[0]) => matchesQuery(e, "luna work");
  expect(pickerGroups([own!], luna, true).map((g) => [g.title, g.entries.map((e) => modelKey({ engine: e.engine.id, model: e.model.id }))])).toEqual([
    ["Caveman · OpenAI work", ["caveman/openai~2/gpt-6-luna"]],
  ]);
  // A harness's own models sit under its name.
  expect(pickerGroups([codex as unknown as PickerEngine], all, true).map((g) => g.title)).toEqual(["Codex"]);
});

test("Home lists Caveman's own models, favorites and each other harness's first two, in the person's order behind the default", () => {
  const m = (id: string, legacy?: boolean) => ({ id, label: id, efforts: [], ...(legacy ? { legacy } : {}) });
  const caveman = { id: "caveman", label: "Caveman", models: [m("auto"), m("caveman/anthropic/claude-opus-5-5"), m("caveman/deepseek/deepseek-v4", true), m("anthropic/claude-sonnet-5-5")] };
  const claude = { id: "claude-agent", label: "Claude Agent", models: [m("claude-fable-5-1"), m("claude-opus-5-5"), m("claude-sonnet-5-5")] };
  const codex = { id: "codex", label: "Codex", models: [m("gpt-6.1-sol")] };
  const engines: PickerEngine[] = [caveman, claude, codex];
  const key = (e: { engine: PickerEngine; model: { id: string } }) => modelKey({ engine: e.engine.id, model: e.model.id });
  // Caveman's own first (Auto and what credits serve; never a person's own key, never an older model), then the rest.
  expect(homeModels(engines, []).map(key)).toEqual([
    "caveman/auto",
    "caveman/caveman/anthropic/claude-opus-5-5",
    "claude-agent/claude-fable-5-1",
    "claude-agent/claude-opus-5-5",
    "codex/gpt-6.1-sol",
  ]);
  // A favorite comes before the recommendations and is not listed twice.
  const favs = resolveFavorites(engines, ["codex/gpt-6.1-sol", "claude-agent/claude-sonnet-5-5"]);
  expect(homeModels(engines, favs).map(key).slice(2)).toEqual(["codex/gpt-6.1-sol", "claude-agent/claude-sonnet-5-5", "claude-agent/claude-fable-5-1", "claude-agent/claude-opus-5-5"]);
  // The person's order wins; rows it does not name follow; the default leads whatever the order says.
  const order = ["claude-agent/claude-opus-5-5", "codex/gpt-6.1-sol", "claude-agent/gone"];
  expect(homeModels(engines, [], order).map(key)).toEqual([
    "claude-agent/claude-opus-5-5",
    "codex/gpt-6.1-sol",
    "caveman/auto",
    "caveman/caveman/anthropic/claude-opus-5-5",
    "claude-agent/claude-fable-5-1",
  ]);
  expect(homeModels(engines, [], order, { engine: "claude-agent", model: "claude-fable-5-1" }).map(key)).toEqual([
    "claude-agent/claude-fable-5-1",
    "claude-agent/claude-opus-5-5",
    "codex/gpt-6.1-sol",
    "caveman/auto",
    "caveman/caveman/anthropic/claude-opus-5-5",
  ]);
  // A default Home would not list still leads it.
  expect(homeModels(engines, [], [], { engine: "claude-agent", model: "claude-sonnet-5-5" }).map(key)[0]).toBe("claude-agent/claude-sonnet-5-5");
  // A row the person arranged stays on Home though it is neither a favorite nor recommended (a default moved down).
  const arranged = ["claude-agent/claude-opus-5-5", "claude-agent/claude-sonnet-5-5"];
  expect(homeModels(engines, [], arranged, { engine: "claude-agent", model: "claude-opus-5-5" }).map(key).slice(0, 2)).toEqual(arranged);
  // While a row is moved the default is not pinned: it goes where it is carried.
  const carried = ["claude-agent/claude-sonnet-5-5", "claude-agent/claude-fable-5-1"];
  expect(homeModels(engines, [], carried, { engine: "claude-agent", model: "claude-fable-5-1" }, false).map(key).slice(0, 2)).toEqual(carried);
  expect(moveKey(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  expect(moveKey(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
});

test("a harness switch clears the old effort, speed and login, keeps permissions, and preserves the explicit target login", () => {
  const current = { engine: "claude-agent" as const, model: "opus", effort: "high", speed: "fast", account_id: "claude-login", access: "ask" as const };
  expect(mergeTurnPick(current, { engine: "codex", model: "gpt", account_id: "codex-login" }, "claude-agent")).toEqual({
    engine: "codex", model: "gpt", effort: undefined, speed: undefined, account_id: "codex-login", access: "ask",
  });
  expect(mergeTurnPick(current, { engine: "cursor", model: "composer" }, "claude-agent").account_id).toBeUndefined();
  expect(mergeTurnPick(current, { model: "sonnet" }, "claude-agent").effort).toBe("high");
  expect(mergeTurnPick(current, { model: "opus-5" }, "claude-agent").speed).toBe("fast");
});

test("a model starts where the person pinned it, else at an effort saved with its setting, else its own default", () => {
  const opus = { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"], default_effort: "high", speeds: ["fast"] };
  const sonnet = { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "high"], default_effort: "high" };
  expect(modelStart(undefined, "claude-agent", opus, undefined)).toEqual({ effort: "high", speed: "standard" });
  expect(modelStart(undefined, "claude-agent", opus, { model: "claude-opus-5-5", effort: "low" })).toEqual({ effort: "low", speed: "standard" });
  const starts = { "claude-agent/claude-opus-5-5": { effort: "max", speed: "fast" } };
  expect(modelStart(starts, "claude-agent", opus, { model: "claude-opus-5-5", effort: "low" })).toEqual({ effort: "max", speed: "fast" });
  expect(modelStart(starts, "claude-agent", sonnet, undefined)).toEqual({ effort: "high", speed: undefined });
  // Saving keeps every other model's start, and names only what the model offers.
  expect(withModelStart(starts, "claude-agent", sonnet, { effort: "low", speed: "fast" })).toEqual({ ...starts, "claude-agent/claude-sonnet-5-5": { effort: "low" } });
  expect(withModelStart(starts, "claude-agent", opus, { effort: "medium", speed: "standard" })).toEqual({ "claude-agent/claude-opus-5-5": { effort: "medium", speed: "standard" } });
});

test("a pick the chat now runs is dropped, so the box follows changes made on other devices", () => {
  const picked = { model: "opus", effort: "high", access: "ask" as const };
  // The chat now runs it: the box follows the chat again, keeping its other picks.
  expect(settledPick(picked, "opus", "high")).toEqual({ access: "ask" });
  expect(settledPick({ model: "opus" }, "opus", null)).toEqual({});
  // Something else is running: the pick stays, as the same object.
  expect(settledPick(picked, "sonnet", "high")).toBe(picked);
  expect(settledPick(picked, "opus", "low")).toBe(picked);
  const none = { access: "ask" as const };
  expect(settledPick(none, "opus", null)).toBe(none);
});

test("a bare /model keeps a target harness's explicitly chosen login until a different harness is picked", () => {
  const picked = { engine: "codex" as const, model: "first", account_id: "codex-personal" };
  expect(mergeTurnPick(picked, turnModelPick("codex", "second"), "claude-agent").account_id).toBe("codex-personal");
  expect(mergeTurnPick(picked, turnModelPick("claude-agent", "opus"), "claude-agent").account_id).toBeUndefined();
  expect(mergeTurnPick(picked, turnModelPick("codex", "second", "codex-work"), "claude-agent").account_id).toBe("codex-work");
});

test("two Claude logins and two ChatGPT logins are four picker sections, each under its login's name, and a row picks its login", () => {
  const engine = (id: string, label: string, models: string[], accounts: Array<[string, string, boolean]>) =>
    ({
      id,
      label,
      models: models.map((m) => ({ id: m, label: m, efforts: [] })),
      auth: { state: "signed_in", accounts: accounts.map(([account, tag, active]) => ({ id: account, label: `${tag} login`, kind: "login", active, tag })) },
    }) as unknown as EngineDescriptor;
  const list = [
    engine("claude-agent", "Claude Agent", ["claude-opus-5-5", "auto"], [["claudeAgent:default", "CA", true], ["claudeAgent-account-1a2b3c4d", "CM", false]]),
    engine("codex", "Codex", ["gpt-6-astra"], [["codex-account-chatgpt", "CA", false], ["codex-account-chatgpt-5e6f7a8b", "CM", true]]),
    engine("cursor", "Cursor", ["composer-2"], [["cursor:default", "CU", true]]),
  ];
  const picker = chatPickerEngines(list);
  expect(picker.map((e) => [e.id, e.harness, e.account])).toEqual([
    ["claude-agent#claudeAgent:default", "claude-agent", "CA login"],
    ["claude-agent#claudeAgent-account-1a2b3c4d", "claude-agent", "CM login"],
    ["codex#codex-account-chatgpt", "codex", "CA login"],
    ["codex#codex-account-chatgpt-5e6f7a8b", "codex", "CM login"],
    // One login: one section, as before.
    ["cursor", undefined, undefined],
  ]);
  // One harness, one rail tile: its logins are headings over its models.
  expect(pickerGroups(picker.filter((e) => e.harness === "claude-agent"), () => true).map((g) => [g.title, g.entries.length])).toEqual([["CA login", 2], ["CM login", 2]]);
  // A row's section is its login; Auto stays a row of each Claude login.
  expect(instanceOf(list, picker[1]!.id)).toEqual({ engine: "claude-agent", instance_id: "claudeAgent-account-1a2b3c4d" });
  expect(instanceOf(list, picker[3]!.id)).toEqual({ engine: "codex", instance_id: "codex-account-chatgpt-5e6f7a8b" });
  // A chat shows on the login its turn ran on, else the engine's active one.
  expect(chatPickerSection(list, list[0]!, "claudeAgent-account-1a2b3c4d")).toBe("claude-agent#claudeAgent-account-1a2b3c4d");
  expect(chatPickerSection(list, list[1]!, undefined)).toBe("codex#codex-account-chatgpt-5e6f7a8b");
  expect(chatPickerSection(list, list[2]!, undefined)).toBe("cursor");
  // A connection the person made once is never a section: the Mac's own logins are, and a chat that ran on the
  // connection shows on the first of them.
  const placed = (id: string, where: "everywhere" | "this_mac", active: boolean) => ({ id, label: id, kind: "login", active, where });
  const connected = { ...list[0]!, auth: { state: "signed_in", accounts: [placed("connection:c1", "everywhere", true), placed("claudeAgent:default", "this_mac", false)] } } as unknown as EngineDescriptor;
  expect(chatPickerEngines([connected]).map((e) => e.id)).toEqual(["claude-agent"]);
  expect(chatPickerSection([connected], connected, "connection:c1")).toBe("claude-agent");
  const both = { ...connected, auth: { ...connected.auth, accounts: [...connected.auth.accounts, placed("claudeAgent-account-9", "this_mac", false)] } } as unknown as EngineDescriptor;
  expect(chatPickerEngines([both]).map((e) => e.id)).toEqual(["claude-agent#claudeAgent:default", "claude-agent#claudeAgent-account-9"]);
  expect(chatPickerSection([both], both, "connection:c1")).toBe("claude-agent#claudeAgent:default");
  expect(chatPickerSection([both], both, "claudeAgent-account-9")).toBe("claude-agent#claudeAgent-account-9");
  // The Caveman engine with two keys is one section in the picker, so a chat on it shows its model, not "Choose a model".
  const caveman = { id: "caveman", label: "Caveman", models: [{ id: "custom-a/m", label: "m", efforts: [] }], auth: { state: "signed_in", accounts: [{ id: "caveman:custom-a", label: "A", kind: "key", active: true }, { id: "caveman:caveman", label: "Credits", kind: "key", active: false }] } } as unknown as (typeof list)[number];
  expect(chatPickerEngines([caveman]).map((e) => e.id)).toEqual(["caveman"]);
  expect(chatPickerSection([caveman], caveman, undefined)).toBe("caveman");
  // Every harness and login is an in-place choice: none of the rows sends the person to New chat.
  const inClaude = chatPickerEngines([caveman, ...list]);
  expect(inClaude.map((e) => [e.id, e.models[0]!.description ?? null, e.hint !== undefined])).toEqual([
    ["caveman", null, false],
    ["claude-agent#claudeAgent:default", null, false],
    ["claude-agent#claudeAgent-account-1a2b3c4d", null, false],
    ["codex#codex-account-chatgpt", null, false],
    ["codex#codex-account-chatgpt-5e6f7a8b", null, false],
    ["cursor", null, false],
  ]);
  // Only a picked login goes on the turn.
  expect(turnOptions("claude-opus-5-5", undefined, undefined, "claudeAgent-account-1a2b3c4d")).toEqual({ model: "claude-opus-5-5", account_id: "claudeAgent-account-1a2b3c4d" });
  expect(turnOptions("claude-opus-5-5", undefined, undefined)).toEqual({ model: "claude-opus-5-5" });
});

test("the Chief's box puts its words above the controls once they pass one line, and back beside them only when it empties", () => {
  // One line, beside the controls.
  expect(stackWords(false, "fix the wrap", 22, 22)).toBe(false);
  // A new line, or words wrapping to a second line: above them, full width.
  expect(stackWords(false, "fix\nthe wrap", 44, 22)).toBe(true);
  expect(stackWords(false, "a long note that wraps", 44, 22)).toBe(true);
  // Full width it may fit one line again: it stays up, so the layout never flips under the caret.
  expect(stackWords(true, "a long note that wraps", 22, 22)).toBe(true);
  // Sent or cleared: back to one row.
  expect(stackWords(true, "", 22, 22)).toBe(false);
});

test("the + menu's selected row says what Enter does", () => {
  expect(addVerb({ id: "files" })).toBe("Choose");
  expect(addVerb({ id: "plugin:linear" })).toBe("Mention");
  expect(addVerb({ id: "chat:w1" })).toBe("Mention");
  expect(addVerb({ id: "file:src/app.ts" })).toBe("Add");
  expect(addVerb({ id: "cmd:model" })).toBe("");
});
