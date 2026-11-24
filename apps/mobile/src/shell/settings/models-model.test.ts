// Settings > Models & keys on a phone: each status an agent's row can say, from what a Mac or Cloud lists of it; the
// one line while nothing is listed; and the times, said in the person's own clock (a time zone is named here so the
// words are the same on any machine that runs the test).
import type { AccountConnection, EngineAccount } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import {
  type Agent,
  agentRow,
  agentRows,
  awayLine,
  CHECKING,
  clock,
  CLOUD_ONLY,
  CONNECT_ON_MAC,
  connectingLine,
  EVERYWHERE,
  EXPIRED,
  LOADING,
  NOT_INSTALLED,
  NOT_SIGNED_IN,
  pageView,
  SCRIPTED_AGENTS,
  TURNED_OFF,
} from "./models-model";

/** Tuesday Nov 10 2026, 3:00 PM in New York (8:00 PM UTC). */
const NOW = Date.parse("2026-11-10T20:00:00.000Z");
const NEW_YORK = "America/New_York";
const DAY = 24 * 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const STUDIO = { from: "Studio", kind: "mac" } as const;
const CLOUD = { from: "Cloud", kind: "cloud" } as const;

const plan = (
  connection: Partial<AccountConnection> = {},
  patch: Partial<EngineAccount> = {},
): EngineAccount => ({
  id: "connection:claude",
  label: "Claude plan",
  kind: "login",
  active: true,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready", ...connection },
  ...patch,
});
const key = (
  connection: Partial<AccountConnection> = {},
  patch: Partial<EngineAccount> = {},
): EngineAccount => ({
  id: "connection:anthropic",
  label: "Anthropic API key",
  kind: "api_key",
  active: false,
  where: "everywhere",
  connection: { kind: "api_key", status: "ready", ...connection },
  ...patch,
});
const own = (patch: Partial<EngineAccount> = {}): EngineAccount => ({
  id: "claudeAgent:default",
  label: "ada@example.com",
  kind: "login",
  active: true,
  where: "this_mac",
  ...patch,
});

const claude = (accounts: EngineAccount[], auth: Partial<Agent["auth"]> = {}): Agent => ({
  id: "claude-agent",
  label: "Claude Agent",
  auth: { state: "signed_in", accounts, everywhere: "available", ...auth },
});
const said = (
  agent: Agent,
  asked: { from: string; kind: "mac" | "cloud" | null } = STUDIO,
  zone = NEW_YORK,
) => {
  const { status, tone, onMac } = agentRow(agent, asked, NOW, zone);
  return [status, tone, onMac];
};

describe("which page", () => {
  it("is the person's agents once they are signed in, whatever the store has heard so far", () => {
    const me = { signedIn: true, scripted: false };
    expect(pageView(me, "ready")).toBe("ready");
    expect(pageView(me, "loading")).toBe("loading");
    expect(pageView(me, "away")).toBe("away");
    expect(pageView(me, "signed-out")).toBe("loading");
  });

  it("is one sign-in row on a board that is their own, and the script only for someone who never signed in", () => {
    expect(pageView({ signedIn: false, scripted: false }, "signed-out")).toBe("sign-in");
    expect(pageView({ signedIn: false, scripted: false }, "ready")).toBe("sign-in");
    expect(pageView({ signedIn: false, scripted: true }, "signed-out")).toBe("scripted");
  });
});

describe("while nothing is listed", () => {
  it("says one line, verb first, of what the list waits for", () => {
    expect(LOADING).toBe("Loading…");
    expect(awayLine({ name: "Studio", state: "Asleep" })).toBe(
      "Your agents show when Studio wakes.",
    );
    expect(awayLine({ name: "Studio", state: "Offline" })).toBe(
      "Your agents show when Studio is back online.",
    );
    expect(awayLine(null)).toBe("Your agents show when one of your computers is on.");
  });
});

describe("a time", () => {
  it("is the person's own clock: the time today, the day and time in the six days after, the date beyond", () => {
    expect(clock(Date.parse("2026-11-11T04:08:00.000Z"), NOW, NEW_YORK)).toBe("11:08 PM");
    expect(clock(Date.parse("2026-11-11T05:30:00.000Z"), NOW, NEW_YORK)).toBe("Wed 12:30 AM");
    expect(clock(Date.parse("2026-11-14T12:44:00.000Z"), NOW, NEW_YORK)).toBe("Sat 7:44 AM");
    expect(clock(Date.parse("2026-11-16T19:00:00.000Z"), NOW, NEW_YORK)).toBe("Mon 2:00 PM");
    // A week on, the weekday would read as today's: the date says it.
    expect(clock(Date.parse("2026-11-17T08:00:00.000Z"), NOW, NEW_YORK)).toBe("Nov 17");
    expect(clock(Date.parse("2026-11-20T12:44:00.000Z"), NOW, NEW_YORK)).toBe("Nov 20");
  });

  it("follows the time zone it is given, and never names one", () => {
    // 4:08 AM on Wednesday in UTC is still Tuesday night in New York.
    expect(clock(Date.parse("2026-11-11T04:08:00.000Z"), NOW, "UTC")).toBe("Wed 4:08 AM");
    expect(clock(Date.parse("2026-11-11T04:08:00.000Z"), NOW, "Europe/Amsterdam")).toBe(
      "Wed 5:08 AM",
    );
  });
});

describe("an agent's status, in the desktop's words for the same case", () => {
  it("is Everywhere on a plan or key kept by Caveman that runs it on the Mac and in Cloud", () => {
    expect(said(claude([plan(), own({ active: false })]))).toEqual([EVERYWHERE, "ok", false]);
    expect(EVERYWHERE).toBe("Everywhere");
    // Cloud's own word for it, when only Cloud answers.
    expect(said(claude([plan()], { everywhere: "manage", no_sign_in_here: true }), CLOUD)).toEqual([
      EVERYWHERE,
      "ok",
      false,
    ]);
  });

  it("is Everywhere when the Mac runs it on its own sign-in and Cloud on a key kept for it", () => {
    expect(said(claude([key({}, { where: "cloud" }), own()]))).toEqual([EVERYWHERE, "ok", false]);
  });

  it("names the Mac when only its own sign-in runs it, and says where to connect it when it can be", () => {
    expect(said(claude([own()]))).toEqual(["Studio only", "ok", true]);
    // Cursor has no plan to connect once: nothing to do on a Mac either.
    expect(
      said({
        id: "cursor",
        label: "Cursor",
        auth: { state: "signed_in", accounts: [own({ id: "cursor:default" })] },
      }),
    ).toEqual(["Studio only", "ok", false]);
    // A computer from before plans were connected once places nothing: its accounts are its own.
    expect(
      said({
        id: "codex",
        label: "Codex",
        auth: {
          state: "api_key",
          accounts: [
            { id: "codex:1", label: "OpenAI API key …4f2a", kind: "api_key", active: true },
          ],
        },
      }),
    ).toEqual(["Studio only", "ok", false]);
    // A Mac's name is said as it is, and a Mac with none is "Your Mac".
    expect(agentRow(claude([own()]), { from: "", kind: "mac" }, NOW, NEW_YORK).status).toBe(
      "Your Mac only",
    );
    expect(
      agentRow(claude([own()]), { from: "Julius's MacBook Pro", kind: "mac" }, NOW, NEW_YORK)
        .status,
    ).toBe("Julius's MacBook Pro only");
  });

  it("says where it runs when a plan or key is kept for Cloud alone", () => {
    expect(said(claude([key({}, { where: "cloud", active: true })]))).toEqual([
      CLOUD_ONLY,
      "ok",
      false,
    ]);
    expect(CLOUD_ONLY).toBe("Cloud");
    // Kept for Cloud while the Mac that answered is not signed in: on that Mac it is not signed in, as the desktop says.
    expect(said(claude([key({}, { where: "cloud" })], { state: "signed_out" }))).toEqual([
      NOT_SIGNED_IN,
      "quiet",
      true,
    ]);
    // What Cloud runs by itself, when only Cloud answers: nothing is known of a Mac.
    expect(
      said(
        {
          id: "caveman",
          label: "Caveman",
          auth: {
            state: "api_key",
            accounts: [
              { id: "caveman:caveman", label: "Caveman credits", kind: "api_key", active: true },
            ],
          },
        },
        CLOUD,
      ),
    ).toEqual(["Cloud only", "ok", false]);
  });

  it("says until when a plan is used up, in the person's clock: the time today, the date and time after", () => {
    expect(
      said(claude([plan({ status: "used_up", used_up_until: "2026-11-11T04:08:00.000Z" })])),
    ).toEqual(["Used up until 11:08 PM", "warn", false]);
    expect(
      said(claude([plan({ status: "used_up", used_up_until: "2026-11-14T12:44:00.000Z" })])),
    ).toEqual(["Used up until Nov 14, 7:44 AM", "warn", false]);
    expect(
      said(
        claude([plan({ status: "used_up", used_up_until: "2026-11-11T04:08:00.000Z" })]),
        STUDIO,
        "UTC",
      ),
    ).toEqual(["Used up until Nov 11, 4:08 AM", "warn", false]);
  });

  it("says what runs it meanwhile: a key kept by Caveman, or the Mac's own sign-in", () => {
    const usedUp = plan(
      { status: "used_up", used_up_until: "2026-11-11T04:08:00.000Z" },
      { active: false },
    );
    expect(said(claude([usedUp, key({}, { active: true })]))).toEqual([
      "Used up until 11:08 PM · now on your Anthropic API key",
      "warn",
      false,
    ]);
    expect(said(claude([usedUp, own()]))).toEqual([
      "Used up until 11:08 PM · now on Studio's login",
      "warn",
      false,
    ]);
    // Nothing else runs it: only until when.
    expect(said(claude([usedUp], { state: "signed_out" }))).toEqual([
      "Used up until 11:08 PM",
      "warn",
      false,
    ]);
    // Without a time when none is known or it has passed.
    expect(said(claude([plan({ status: "used_up" })]))).toEqual(["Used up", "warn", false]);
    expect(said(claude([plan({ status: "used_up", used_up_until: at(-60_000) })]))).toEqual([
      "Used up",
      "warn",
      false,
    ]);
  });

  it("counts the days from a week before a plan ends", () => {
    expect(said(claude([plan({ expires_at: at(5 * DAY) })]))).toEqual([
      "Expires in 5 days",
      "warn",
      true,
    ]);
    expect(said(claude([plan({ expires_at: at(4 * DAY + 3_600_000) })]))).toEqual([
      "Expires in 5 days",
      "warn",
      true,
    ]);
    expect(said(claude([plan({ expires_at: at(7 * DAY) })]))).toEqual([
      "Expires in 7 days",
      "warn",
      true,
    ]);
    expect(said(claude([plan({ expires_at: at(DAY) })]))).toEqual([
      "Expires in 1 day",
      "warn",
      true,
    ]);
    expect(said(claude([plan({ expires_at: at(3_600_000) })]))).toEqual([
      "Expires in 1 day",
      "warn",
      true,
    ]);
    expect(said(claude([plan({ expires_at: at(8 * DAY) })]))).toEqual([EVERYWHERE, "ok", false]);
    // A key is replaced where keys are added: no Reconnect, so nothing to send the person to a Mac for.
    expect(said(claude([key({ expires_at: at(5 * DAY) }, { active: true })]))).toEqual([
      "Expires in 5 days",
      "warn",
      false,
    ]);
  });

  it("is Expired once Caveman says a plan ended, however it ended, or its time has passed", () => {
    expect(said(claude([plan({ status: "expired" })]))).toEqual([EXPIRED, "bad", true]);
    expect(said(claude([plan({ status: "revoked" })]))).toEqual([EXPIRED, "bad", true]);
    expect(said(claude([plan({ expires_at: at(-1000) })]))).toEqual([EXPIRED, "bad", true]);
    expect(EXPIRED).toBe("Expired");
    // With what runs it meanwhile, and from Cloud, where it is connected again.
    expect(said(claude([plan({ status: "expired" }, { active: false }), own()]))).toEqual([
      "Expired · now on Studio's login",
      "bad",
      true,
    ]);
    expect(
      said(
        claude([plan({ status: "expired" }, { active: false })], {
          state: "signed_out",
          everywhere: "manage",
          no_sign_in_here: true,
        }),
        CLOUD,
      ),
    ).toEqual(["Expired · reconnect from the Mac app", "bad", false]);
    expect(
      said(
        claude([plan({ expires_at: at(2 * DAY) })], {
          everywhere: "manage",
          no_sign_in_here: true,
        }),
        CLOUD,
      ),
    ).toEqual(["Expires in 2 days · reconnect from the Mac app", "warn", false]);
  });

  it("leads with what ended, then what is about to end, then what is used up", () => {
    expect(
      said(
        claude([
          plan({ status: "used_up", used_up_until: at(3_600_000) }, { active: false }),
          key({ status: "expired" }),
        ]),
      ),
    ).toEqual([EXPIRED, "bad", false]);
    expect(
      said(
        claude([
          plan({ expires_at: at(2 * DAY) }),
          key({ status: "used_up", used_up_until: "2026-11-11T04:08:00.000Z" }),
        ]),
      ),
    ).toEqual(["Expires in 2 days", "warn", true]);
    // An ended plan says so even while the Mac's own sign-in runs the agent.
    expect(said(claude([plan({ status: "expired" }), own()]))).toEqual([EXPIRED, "bad", true]);
  });

  it("says an admin turned it off, and what the Mac runs it on then", () => {
    expect(
      said(claude([plan({ off: true }, { active: false }), own()], { everywhere: "off" })),
    ).toEqual(["Turned off by your admin · runs on Studio's login", "quiet", false]);
    expect(
      said(
        claude([plan({ off: true, status: "expired" })], {
          state: "signed_out",
          everywhere: "off",
        }),
      ),
    ).toEqual([TURNED_OFF, "quiet", false]);
    // Plans are off and the Mac runs it on its own sign-in: why it is not everywhere.
    expect(said(claude([own()], { everywhere: "off" }))).toEqual([
      "Turned off by your admin · runs on Studio's login",
      "quiet",
      false,
    ]);
    expect(said(claude([], { state: "signed_out", everywhere: "off" }))).toEqual([
      TURNED_OFF,
      "quiet",
      false,
    ]);
    expect(TURNED_OFF).toBe("Turned off by your admin");
  });

  it("is Everywhere on a key while an admin has plans turned off", () => {
    expect(
      said(
        claude([plan({ off: true }, { active: false }), key({}, { active: true })], {
          everywhere: "off",
        }),
      ),
    ).toEqual([EVERYWHERE, "ok", false]);
  });

  it("is Not signed in where nothing runs it, and says where to connect it", () => {
    expect(
      said({ id: "cursor", label: "Cursor", auth: { state: "signed_out", accounts: [] } }),
    ).toEqual([NOT_SIGNED_IN, "quiet", true]);
    expect(said(claude([], { state: "signed_out" }))).toEqual([NOT_SIGNED_IN, "quiet", true]);
    // Cloud lists only what Caveman keeps, and takes no sign-in: the status says where one is made.
    expect(
      said(
        {
          id: "codex",
          label: "Codex",
          auth: { state: "signed_out", accounts: [], everywhere: "manage", no_sign_in_here: true },
        },
        CLOUD,
      ),
    ).toEqual(["Not signed in · connect from the Mac app", "quiet", false]);
    expect(NOT_SIGNED_IN).toBe("Not signed in");
  });

  it("is Not installed for an agent the computer does not have", () => {
    expect(
      said({ id: "opencode", label: "OpenCode", auth: { state: "unavailable", accounts: [] } }),
    ).toEqual([NOT_INSTALLED, "quiet", false]);
    expect(NOT_INSTALLED).toBe("Not installed");
  });

  it("is Checking… while its computer still finds out", () => {
    expect(said(claude([], { state: "checking" }))).toEqual([CHECKING, "quiet", false]);
    expect(said(claude([plan()], { state: "checking" }))).toEqual([CHECKING, "quiet", false]);
    expect(CHECKING).toBe("Checking…");
  });

  it("says a sign-in under way on a Mac, on every device, and where it is approved", () => {
    const connecting = { request_id: "r-1", since: at(-4_000) };
    expect(said(claude([own()], { connecting }))).toEqual([
      "Connecting… approve in the browser on Studio",
      "quiet",
      false,
    ]);
    // Before anything else the agent would say.
    expect(said(claude([plan({ status: "expired" })], { connecting }))).toEqual([
      "Connecting… approve in the browser on Studio",
      "quiet",
      false,
    ]);
    expect(
      agentRow(
        claude([], { state: "signed_out", connecting }),
        { from: "Julius's MacBook Pro", kind: "mac" },
        NOW,
        NEW_YORK,
      ).status,
    ).toBe("Connecting… approve in the browser on Julius's MacBook Pro");
    expect(connectingLine("Studio")).toBe("Connecting… approve in the browser on Studio");
  });

  it("names an agent as its computer does, and Claude Agent never as anything else", () => {
    expect(
      agentRow(
        { id: "claude-agent", label: "Claude Code", auth: { state: "signed_out", accounts: [] } },
        STUDIO,
        NOW,
      ).name,
    ).toBe("Claude Agent");
    expect(
      agentRow(
        { id: "codex", label: "Codex", auth: { state: "signed_out", accounts: [] } },
        STUDIO,
        NOW,
      ).name,
    ).toBe("Codex");
    expect(
      agentRow(
        { id: "acp:gemini", label: "Gemini CLI", auth: { state: "signed_out", accounts: [] } },
        STUDIO,
        NOW,
      ).name,
    ).toBe("Gemini CLI");
    expect(
      agentRow(
        { id: "acp:gemini", label: " ", auth: { state: "signed_out", accounts: [] } },
        STUDIO,
        NOW,
      ).name,
    ).toBe("acp:gemini");
  });
});

describe("the page's rows", () => {
  const every: Agent[] = [
    claude([plan(), own({ active: false })]),
    claude([own()]),
    claude([key({}, { where: "cloud", active: true })]),
    claude([
      plan({ status: "used_up", used_up_until: "2026-11-11T04:08:00.000Z" }, { active: false }),
      key({}, { active: true }),
    ]),
    claude([plan({ status: "used_up" })]),
    claude([plan({ expires_at: at(5 * DAY) })]),
    claude([plan({ status: "revoked" })]),
    claude([plan({ off: true }, { active: false }), own()], { everywhere: "off" }),
    claude([], { state: "signed_out" }),
    claude([], { state: "checking" }),
    claude([own()], { connecting: { request_id: "r-1", since: at(-4_000) } }),
    { id: "opencode", label: "OpenCode", auth: { state: "unavailable", accounts: [] } },
  ];

  it("keep the order the computer lists its agents in, one row each", () => {
    const rows = agentRows(
      [
        { id: "codex", label: "Codex", auth: { state: "signed_out", accounts: [] } },
        claude([plan()]),
        { id: "caveman", label: "Caveman", auth: { state: "signed_out", accounts: [] } },
      ],
      STUDIO,
      NOW,
      NEW_YORK,
    );
    expect(rows.map((r) => r.name)).toEqual(["Codex", "Claude Agent", "Caveman"]);
  });

  it("say one status each, from the one list, with no Ready, no count of more, no UTC, no money and no account", () => {
    const statuses = [
      ...agentRows(every, STUDIO, NOW, NEW_YORK),
      ...agentRows(every, STUDIO, NOW, "UTC"),
      ...agentRows(every, CLOUD, NOW, NEW_YORK),
    ].map((r) => r.status);
    const state =
      "Everywhere|Cloud|(?:Studio|Cloud) only|Used up|Used up until (?:[A-Z][a-z]{2} \\d{1,2}, )?\\d{1,2}:\\d{2} [AP]M|Expires in \\d+ days?|Expired|Turned off by your admin|Not signed in|Not installed|Checking…|Connecting… approve in the browser on (?:Studio|Cloud)";
    const more =
      " · (?:now on (?:your [A-Za-z ]+|(?:Studio|Cloud)'s login)|runs on (?:Studio|Cloud)'s login|reconnect from the Mac app|connect from the Mac app)";
    const allowed = new RegExp(`^(?:${state})(?:${more})?$`);
    for (const status of statuses) {
      expect(status).toMatch(allowed);
      expect(status).not.toMatch(/Ready|more|UTC|\$|@/);
    }
  });

  it("ask for a Mac only where the desktop would offer a button", () => {
    expect(CONNECT_ON_MAC).toBe("Connect it on your Mac (Settings > Models & keys).");
    const needs = agentRows(every, STUDIO, NOW, NEW_YORK).map((r) => [r.status, r.onMac]);
    expect(needs).toEqual([
      ["Everywhere", false],
      ["Studio only", true],
      ["Cloud", false],
      ["Used up until 11:08 PM · now on your Anthropic API key", false],
      ["Used up", false],
      ["Expires in 5 days", true],
      ["Expired", true],
      ["Turned off by your admin · runs on Studio's login", false],
      ["Not signed in", true],
      ["Checking…", false],
      ["Connecting… approve in the browser on Studio", false],
      ["Not installed", false],
    ]);
    // From Cloud, a status that already says where it is done is not followed by the same again.
    expect(
      agentRows(
        [
          claude([plan({ status: "expired" }, { active: false })], {
            state: "signed_out",
            everywhere: "manage",
            no_sign_in_here: true,
          }),
        ],
        CLOUD,
        NOW,
        NEW_YORK,
      ).map((r) => [r.status, r.onMac]),
    ).toEqual([["Expired · reconnect from the Mac app", false]]);
  });
});

describe("the scripted board", () => {
  it("reads as a real one would, for someone who never signed in", () => {
    expect(
      agentRows(SCRIPTED_AGENTS, { from: "MacBook Pro", kind: "mac" }, NOW, NEW_YORK).map((r) => [
        r.name,
        r.status,
        r.onMac,
      ]),
    ).toEqual([
      ["Caveman", "Everywhere", false],
      ["Claude Agent", "Everywhere", false],
      ["Codex", "MacBook Pro only", true],
      ["Cursor", "Not signed in", true],
      ["OpenCode", "Not installed", false],
    ]);
  });
});
