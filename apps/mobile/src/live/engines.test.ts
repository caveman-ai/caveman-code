// What a picker lists for a chat's place, pinned: a Mac's own agents and models and nothing it lacks; Cloud's from a
// Cloud computer, else read from a Mac's list of the person's plans and keys, else the agents Cloud runs by name; the
// one line where there is nothing to list; and a new chat's pick settled on its place.
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import {
  catalogOf,
  CLOUD_BY_NAME,
  cloudFromMac,
  cloudNeed,
  NO_AGENT,
  offerOf,
  settlePick,
  stillChecking,
} from "./engines";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const CAPS = {
  structured: true,
  fork: true,
  steer: true,
  interrupt: true,
  tool_hooks: true,
  resume_across_machines: true,
  approvals: true,
  plans: true,
  subagents: true,
  images: true,
  mcp: true,
};
type Auth = EngineDescriptor["auth"];
const engine = (
  id: string,
  label: string,
  auth: Auth,
  models: EngineDescriptor["models"] = [],
  more: Partial<EngineDescriptor> = {},
): EngineDescriptor =>
  ({ id, label, capabilities: CAPS, models, auth, ...more }) as EngineDescriptor;
const signedIn = (accounts: Auth["accounts"] = [], everywhere?: Auth["everywhere"]): Auth => ({
  state: "signed_in",
  accounts,
  ...(everywhere ? { everywhere } : {}),
});
const plan = (
  kind: "claude_plan" | "chatgpt_plan",
  status: "ready" | "used_up" | "expired" | "revoked" = "ready",
  more: object = {},
) =>
  ({
    id: `connection:${kind}`,
    label: "Plan",
    kind: "login",
    active: true,
    where: "everywhere",
    connection: { kind, status, ...more },
  }) as Auth["accounts"][number];
const own = {
  id: "own",
  label: "ada@example.com",
  kind: "login",
  active: true,
  where: "this_mac",
} as Auth["accounts"][number];

const OPUS = {
  id: "claude-opus-5-5",
  label: "Opus 5.5",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "high",
  speeds: ["fast"],
};
const SONNET = {
  id: "claude-sonnet-5-5",
  label: "Sonnet 5.5",
  efforts: ["low", "medium", "high"],
  default_effort: "high",
};
const OLD = {
  id: "claude-opus-4-1",
  label: "Opus 4.1",
  efforts: ["low", "medium", "high"],
  legacy: true,
};
const AUTO = { id: "auto", label: "Auto", efforts: ["low", "medium", "high"] };

const claude = (auth: Auth = signedIn([own], "available"), models = [AUTO, OPUS, SONNET, OLD]) =>
  engine("claude-agent", "Claude Code", auth, models, { default_model: "claude-opus-5-5" });
const codex = (auth: Auth = signedIn([own], "available")) =>
  engine("codex", "Codex", auth, [
    AUTO,
    { id: "gpt-5-5", label: "GPT-5.5", efforts: ["low", "medium", "high"] },
  ]);
const caveman = (auth: Auth = { state: "api_key", accounts: [] }) =>
  engine("caveman", "Caveman", auth, [
    AUTO,
    { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high"] },
    { id: "caveman/moonshot/kimi-k3", label: "Kimi K3", efforts: [] },
  ]);

describe("what a computer offers", () => {
  it("lists the agents it can run now, by the app's names, with their models as it names them", () => {
    const mac = [
      claude(),
      codex({ state: "signed_out", accounts: [] }),
      engine("cursor", "Cursor", {
        state: "unavailable",
        accounts: [],
        message: "Cursor is not installed on this computer.",
      }),
    ];
    const offer = catalogOf(mac);
    // Signed out and not installed are not offered: a chat there would be refused.
    expect(offer.map((e) => e.id)).toEqual(["claude-agent"]);
    // Menus say "Claude Agent", whatever the computer calls it.
    expect(offer[0]).toMatchObject({ label: "Claude Agent", defaultModel: "claude-opus-5-5" });
    expect(offer[0]!.models).toEqual([
      { id: "auto", label: "Auto", efforts: ["low", "medium", "high"] },
      {
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
        speeds: ["fast"],
      },
      {
        id: "claude-sonnet-5-5",
        label: "Sonnet 5.5",
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
      },
      {
        id: "claude-opus-4-1",
        label: "Opus 4.1",
        efforts: ["low", "medium", "high"],
        legacy: true,
      },
    ]);
    // The same list reads as the same offer, so a screen that reads it does not draw again.
    expect(catalogOf(mac)).toBe(offer);
  });

  it("gives an agent that names no model one row by its own name, for its computer's default", () => {
    const [only] = catalogOf([claude(signedIn([own]), [])]);
    expect(only!.models).toEqual([{ id: "", label: "Claude Agent", efforts: [] }]);
    expect(only).not.toHaveProperty("defaultModel");
  });

  it("puts a Caveman engine model under whose key it runs on, and leaves out an agent the board cannot hold a chat on", () => {
    const [mine] = catalogOf([caveman(), engine("muse", "Muse", signedIn())]);
    expect(mine!.id).toBe("caveman");
    expect(mine!.models.map((m) => [m.label, m.source])).toEqual([
      ["Auto", undefined],
      ["Claude Opus 5.5", "Anthropic"],
      ["Kimi K3", "Caveman credits"],
    ]);
  });

  it("knows a computer that is still finding out what it is signed in to", () => {
    expect(stillChecking([claude({ state: "checking", accounts: [] })])).toBe(true);
    expect(stillChecking([claude({ state: "checking", accounts: [] }), codex()])).toBe(false);
    expect(stillChecking([claude({ state: "signed_out", accounts: [] })])).toBe(false);
  });
});

describe("what a chat in Cloud still needs, read from a Mac's list", () => {
  it("is nothing where a plan or key kept by Caveman works there, or will again by itself", () => {
    expect(cloudNeed(claude(signedIn([plan("claude_plan")], "available")), NOW)).toBeNull();
    expect(
      cloudNeed(
        claude(
          signedIn(
            [plan("claude_plan", "used_up", { used_up_until: "2026-11-11T09:00:00.000Z" })],
            "available",
          ),
        ),
        NOW,
      ),
    ).toBeNull();
    // The Caveman engine runs in Cloud on the Caveman plan; before plans connected once, nothing is asked.
    expect(cloudNeed(caveman(), NOW)).toBeNull();
    expect(cloudNeed(claude(signedIn([own])), NOW)).toBeNull();
    expect(cloudNeed(undefined, NOW)).toBeNull();
  });

  it("says the web's sentences in the same cases", () => {
    // Signed in on this Mac only: nothing of it works in Cloud yet.
    expect(cloudNeed(claude(signedIn([own], "available")), NOW)).toEqual({
      kind: "connect",
      line: "Claude isn't connected for Cloud.",
    });
    expect(cloudNeed(codex(signedIn([own], "available")), NOW)).toEqual({
      kind: "connect",
      line: "ChatGPT isn't connected for Cloud.",
    });
    expect(cloudNeed(claude(signedIn([plan("claude_plan", "expired")], "available")), NOW)).toEqual(
      { kind: "reconnect", line: "Your Claude sign-in expired." },
    );
    expect(
      cloudNeed(
        claude(
          signedIn(
            [plan("claude_plan", "ready", { expires_at: "2026-11-01T00:00:00.000Z" })],
            "available",
          ),
        ),
        NOW,
      ),
    ).toEqual({ kind: "reconnect", line: "Your Claude sign-in expired." });
    expect(cloudNeed(claude(signedIn([own], "off")), NOW)).toEqual({
      kind: "admin_off",
      line: "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
    });
    expect(
      cloudNeed(codex(signedIn([plan("chatgpt_plan", "ready", { off: true })], "available")), NOW),
    ).toEqual({
      kind: "admin_off",
      line: "Your admin turned ChatGPT plans off. Add an OpenAI key, or run this chat on your Mac.",
    });
    expect(cloudNeed(engine("cursor", "Cursor", signedIn()), NOW)).toEqual({
      kind: "unsupported",
      line: "Cursor doesn't run in Cloud. Pick Claude Agent, Codex or Caveman.",
    });
  });
});

describe("what Cloud would run, read from a Mac's list", () => {
  it("lists the agents Cloud runs that need nothing more there, without the Mac's own router for Claude Agent and Codex", () => {
    const mac = [
      caveman(),
      claude(signedIn([plan("claude_plan")], "available")),
      codex(signedIn([own], "available")),
      engine("cursor", "Cursor", signedIn()),
    ];
    const read = cloudFromMac(mac, NOW);
    expect(read.engines.map((e) => e.id)).toEqual(["caveman", "claude-agent"]);
    // Auto is the Caveman engine's own in Cloud; a Cloud computer does not run it for Claude Agent.
    expect(read.engines[0]!.models.map((m) => m.id)).toContain("auto");
    expect(read.engines[1]!.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-opus-4-1",
    ]);
    // Why Codex is not there, and where a phone sends its person for it.
    expect(read.missing).toEqual([
      {
        engine: "codex",
        line: "ChatGPT isn't connected for Cloud. Connect it on your Mac (Settings > Models & keys).",
      },
    ]);
    expect(cloudFromMac(mac, NOW)).toBe(read);
  });

  it("offers the Caveman engine by name where the Mac does not run it: Cloud runs it on the Caveman plan", () => {
    const read = cloudFromMac([claude(signedIn([own], "off"))], NOW);
    expect(read.engines).toEqual([
      { id: "caveman", label: "Caveman", models: [{ id: "", label: "Caveman", efforts: [] }] },
    ]);
    expect(read.missing).toEqual([
      {
        engine: "claude-agent",
        line: "Your admin turned Claude plans off. Add an Anthropic key, or run this chat on your Mac.",
      },
    ]);
  });
});

describe("what a picker lists for a place", () => {
  it("lists a Mac's own, and says what it waits for while the Mac has not said", () => {
    const listed = [claude()];
    expect(offerOf({ kind: "mac", name: "Studio", listed, is: "running" }, NOW)).toEqual({
      engines: catalogOf(listed),
      line: null,
      missing: [],
    });
    expect(
      offerOf({ kind: "mac", name: "Studio", listed: undefined, is: "running" }, NOW),
    ).toMatchObject({ engines: [], line: "Loading…" });
    expect(
      offerOf({ kind: "mac", name: "Studio", listed: undefined, is: "asleep" }, NOW),
    ).toMatchObject({ engines: [], line: "Its models show when Studio wakes." });
    expect(
      offerOf({ kind: "mac", name: "Studio", listed: undefined, is: "offline" }, NOW),
    ).toMatchObject({ engines: [], line: "Its models show when Studio is back online." });
    // What it last said stands while it sleeps: its chats' pickers still list it.
    expect(offerOf({ kind: "mac", name: "Studio", listed, is: "asleep" }, NOW).engines).toBe(
      catalogOf(listed),
    );
  });

  it("says what to do on a Mac that has yet to let this phone in, with the code to check", () => {
    expect(
      offerOf(
        {
          kind: "mac",
          name: "Studio",
          listed: undefined,
          is: "running",
          allow: { state: "waiting", code: "4827" },
        },
        NOW,
      ).line,
    ).toBe("On Studio, choose Allow when it shows this code: 4827");
    expect(
      offerOf(
        {
          kind: "mac",
          name: "Studio",
          listed: undefined,
          is: "running",
          allow: { state: "refused", code: "4827" },
        },
        NOW,
      ).line,
    ).toBe("Allow this phone on Studio (Settings > General).");
  });

  it("says where an agent is set up when a place runs none: a phone sets up nothing", () => {
    const none = [claude({ state: "signed_out", accounts: [] })];
    expect(offerOf({ kind: "mac", name: "Studio", listed: none, is: "running" }, NOW)).toEqual({
      engines: [],
      line: "No agent is set up on Studio yet. Set one up there (Settings > Models & keys).",
      missing: [],
      none: true,
    });
    expect(offerOf({ kind: "cloud", listed: none, mac: undefined }, NOW)).toEqual({
      engines: [],
      line: "No agent is connected for Cloud yet. Connect one on your Mac (Settings > Models & keys).",
      missing: [],
      none: true,
    });
    // The chip says the same in two words, in a model's place: never one the place lacks.
    expect(NO_AGENT).toBe("No agent");
    // Still finding out: it says so, never that there is none.
    const checking = offerOf(
      {
        kind: "mac",
        name: "Studio",
        listed: [claude({ state: "checking", accounts: [] })],
        is: "running",
      },
      NOW,
    );
    expect(checking.line).toBe("Loading…");
    expect(checking.none).toBeUndefined();
    // Nothing heard from the place yet (it sleeps, or has not answered): nothing is known, so nothing is said of it.
    expect(
      offerOf({ kind: "mac", name: "Studio", listed: undefined, is: "asleep" }, NOW).none,
    ).toBeUndefined();
    expect(
      offerOf({ kind: "mac", name: "Studio", listed: undefined, is: "running" }, NOW).none,
    ).toBeUndefined();
  });

  it("lists Cloud's own where a Cloud computer has said, else what a Mac says runs there, else the agents Cloud runs by name", () => {
    const box = [claude(signedIn([], "manage"), [OPUS])];
    const mac = [
      claude(signedIn([plan("claude_plan")], "available")),
      codex(signedIn([own], "available")),
    ];
    // A Cloud computer's own word wins; why an agent is missing there is still said, from the Mac's list.
    expect(offerOf({ kind: "cloud", listed: box, mac }, NOW)).toEqual({
      engines: catalogOf(box),
      line: null,
      missing: [
        {
          engine: "codex",
          line: "ChatGPT isn't connected for Cloud. Connect it on your Mac (Settings > Models & keys).",
        },
      ],
    });
    // An agent the Cloud computer does run is never also said to be missing, whatever the Mac's list says of it.
    const both = [claude(signedIn([], "manage"), [OPUS]), codex(signedIn([], "manage"))];
    expect(offerOf({ kind: "cloud", listed: both, mac }, NOW).missing).toEqual([]);
    expect(offerOf({ kind: "cloud", listed: undefined, mac }, NOW)).toEqual({
      engines: cloudFromMac(mac, NOW).engines,
      line: null,
      missing: cloudFromMac(mac, NOW).missing,
    });
    expect(offerOf({ kind: "cloud", listed: undefined, mac: undefined }, NOW)).toEqual({
      engines: CLOUD_BY_NAME,
      line: null,
      missing: [],
    });
    expect(CLOUD_BY_NAME.map((e) => [e.label, e.models.map((m) => m.id)])).toEqual([
      ["Caveman", [""]],
      ["Claude Agent", [""]],
      ["Codex", [""]],
    ]);
  });

  it("says so where no place is picked", () => {
    expect(offerOf(null, NOW, true).line).toBe("Loading…");
    expect(offerOf(null, NOW).line).toBe("No place can take a chat now.");
  });
});

describe("a new chat's pick, settled on its place", () => {
  const offer = catalogOf([claude(), codex()]);

  it("keeps the agent and model wanted where the place has them, by the model's id or its name", () => {
    expect(settlePick(offer, { engine: "claude-agent", model: "claude-sonnet-5-5" })).toEqual({
      engine: "claude-agent",
      model: "claude-sonnet-5-5",
    });
    expect(settlePick(offer, { engine: "claude-agent", model: "Sonnet 5.5" })).toEqual({
      engine: "claude-agent",
      model: "claude-sonnet-5-5",
    });
  });

  it("starts the agent on its own default where the place lacks the model", () => {
    expect(settlePick(offer, { engine: "claude-agent", model: "claude-fable-5-1" })).toEqual({
      engine: "claude-agent",
      model: "claude-opus-5-5",
    });
    // No default named: its first current model.
    expect(settlePick(offer, { engine: "codex", model: "gpt-9" })).toEqual({
      engine: "codex",
      model: "auto",
    });
  });

  it("takes the first agent the place does run where it lacks the one wanted: never one it lacks", () => {
    // The phone's own default is the Caveman engine, which this Mac does not run.
    expect(settlePick(offer, { engine: "caveman", model: "auto" })).toEqual({
      engine: "claude-agent",
      model: "claude-opus-5-5",
    });
    expect(
      settlePick(catalogOf([codex(), caveman()]), { engine: "cursor", model: "composer-2" }),
    ).toEqual({ engine: "caveman", model: "auto" });
    expect(settlePick(offer, null)).toEqual({ engine: "claude-agent", model: "claude-opus-5-5" });
    expect(settlePick([], { engine: "caveman", model: "auto" })).toBeNull();
  });
});
